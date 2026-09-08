// Owns claude.js runtime behavior; port specification §§2–6.
'use strict';
/**
 * backends/claude.js — the Anthropic leg (SPEC §6.1; contract SPEC §6; env §6.0).
 * Owns: the exact claude binary argv (--safe-mode + --restricted + empty MCP + --tools
 * + --effort + --max-budget-usd + --resume), the stdin prompt form (nothing of the
 * prompt ever reaches the command line, so there is no positional to inject into),
 * and the JSON result parse including the §6.1 token formula, which is delegated to
 * ledger.tokenTotals — the one normative implementation.
 * buildSpawn is pure: T-03 asserts the argv without spawning anything.
 */

const fs = require('fs');
const platform = require('../platform');
const guard = require('../lib/guard.js');
const envlib = require('../lib/env.js');
const jobstore = require('../lib/jobstore.js');
const ledger = require('../lib/ledger.js');
const router = require('../lib/router.js');

const ID = 'claude';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** @param {Object} ctx @returns {string|null} absolute claude binary from config.binaries */
function binaryPath(ctx) {
  return (ctx && ctx.config && ctx.config.binaries && ctx.config.binaries.claude) || null;
}

/** council_doctor{deep} probe: --version only, zero quota. */
function versionSpec(ctx) {
  const file = binaryPath(ctx);
  return file ? { file, args: ['--version'] } : null;
}

/** Resolve the router alias (opus|sonnet|fable) through config.models.claude. */
function resolveModel(ctx, model) {
  const table = (ctx && ctx.config && ctx.config.models && ctx.config.models.claude) || {};
  const alias = String(model || 'opus');
  return String(table[alias] || alias);
}

/** Claude accepts all five levels; anything else falls back to medium. */
function clampEffort(effort) {
  const e = String(effort || 'medium').toLowerCase();
  return EFFORTS.includes(e) ? e : 'medium';
}

/**
 * Binary present, and a resume is only offered when the parent leg persisted a session
 * (SPEC §6.1 "Resumability"). Called with {} by council_doctor, so every field is optional.
 * @returns {{ok:boolean, reason?:string}}
 */
function available(ctx, o) {
  const opts = o || {};
  const file = binaryPath(ctx);
  if (!file || !jobstore.exists(file)) return { ok: false, reason: 'claude binary missing: ' + file };
  const parent = opts.parent || null;
  const wantsResume = !!(opts.continueFrom || (opts.leg && opts.leg.session_id));
  if (wantsResume && parent && parent.result && Array.isArray(parent.result.legs)) {
    const rec = parent.result.legs.find((l) => l && l.backend === ID);
    if (rec && rec.resumable === false) return { ok: false, reason: 'claude_session_not_persisted' };
  }
  // Pre-spawn re-check of the untrusted session id (see lib/router.js SESSION_ID_RE).
  const sid = (opts.leg && opts.leg.session_id) || null;
  if (sid && !router.isSessionId(sid)) return { ok: false, reason: 'session_id_malformed' };
  return { ok: true };
}

/**
 * SPEC §6.1 argv, in that order.
 * @returns {{file:string,args:string[],cwd:string,env:Object,envExtra:Object,
 *            promptVia:string,expectedImage:string}}
 */
function buildSpawn(ctx, o) {
  const job = o.job || {};
  const leg = o.leg || {};
  const file = binaryPath(ctx);
  if (!file) throw new Error('claude binary not configured');

  const args = [
    '-p',
    '--output-format', 'json',
    '--safe-mode',
    '--restricted',
    '--strict-mcp-config',
    '--mcp-config', ctx.paths.emptyMcp,
    '--tools', String(leg.tools == null ? '' : leg.tools),
    '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none',
    '--disable-slash-commands',
    '--model', resolveModel(ctx, o.model || leg.model),
    '--effort', clampEffort(o.effort || leg.effort),
  ];

  const budget = Number(o.budgetUsd);
  if (Number.isFinite(budget) && budget > 0) args.push('--max-budget-usd', String(budget));

  args.push('--system-prompt', String(job.guard_paragraph || ''));

  const readPaths = Array.isArray(o.readPaths) ? o.readPaths.filter(Boolean) : [];
  if (readPaths.length) args.push('--add-dir', ...readPaths.map(String));

  if (leg.resumable === false) args.push('--no-session-persistence');

  const session = o.continueFrom || leg.session_id || null;
  if (session) {
    // Never let an unvalidated vendor id reach the command line, even though commander
    // would consume it as the --resume VALUE: the id comes from a rewritable file.
    if (!router.isSessionId(session)) throw new Error('session_id_malformed: ' + String(session).slice(0, 40));
    args.push('--resume', String(session));
  }

  const envExtra = {};
  const env = envlib.childEnv({
    backend: ID, binaries: ctx.config.binaries,
    depth: Number.isFinite(ctx.depth) ? ctx.depth : 0,
    jobId: job.job_id,
    rootJobId: job.root_job_id || job.job_id,
    extra: envExtra,
  });

  guard.assertArgvSafe(args, ctx.config);
  return {
    file,
    args,
    cwd: ctx.paths.sandboxFor(ID),
    env,
    envExtra,
    promptVia: 'stdin',
    expectedImage: platform.expectedImage('claude'),
    // SPEC §10 sample row: the short names of the safety posture this argv encodes.
    flags: ['safe_mode', 'restricted', 'no_mcp', 'stdin_prompt']
      .concat(leg.resumable === false ? ['no_session_persistence'] : [])
      .concat(session ? ['resumed'] : [])
      .concat(readPaths.length ? ['add_dir'] : []),
  };
}

/** Read a file as text; never throws. */
function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

/** Last {...} block of a noisy stdout, for the exit-0-but-not-pure-JSON case. */
function lastJsonObject(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

/**
 * SPEC §6.1 parse. exit 0 with unparsable JSON => ok:true, raw text,
 * meta.parse_failed:true — an answer we cannot decorate is still an answer.
 * @returns {{ok:boolean, text:string, meta:Object}}
 */
function parse(ctx, o) {
  const stdout = readText(o.stdoutPath);
  const stderrTail = jobstore.readTail(o.stderrPath, 4000).slice(-800) || null;
  const promptChars = Number(o.promptChars) || 0;
  const exit = o.exitCode;
  const leg = o.leg || {};
  const meta = {
    session_id: null,
    raw_ids: null,
    resumable: leg.resumable !== false,
    model: null,
    num_turns: null,
    usage: null,
    model_usage: null,
    est_cost_usd: null,
    cost_is_estimate: true,
    cost_source: null,
    total_input_tokens: null,
    overhead_input_tokens: null,
    budget_hit: false,
    parse_failed: false,
    parse_error: null,
    stderr_tail: stderrTail,
    child_enumeration: null,
  };

  if (o.spawnError) {
    meta.parse_error = String(o.spawnError);
    return { ok: false, text: '', meta };
  }

  let j = null;
  try { j = JSON.parse(stdout.trim()); } catch (e) { meta.parse_error = String(e && e.message); }
  if (!j || typeof j !== 'object') j = lastJsonObject(stdout);

  if (!j || typeof j !== 'object') {
    meta.parse_failed = true;
    return { ok: exit === 0 && !o.timedOut && !o.cancelled, text: stdout, meta };
  }
  meta.parse_error = null;

  const usage = (j.usage && typeof j.usage === 'object') ? j.usage : null;
  meta.usage = usage;
  meta.model_usage = (j.modelUsage && typeof j.modelUsage === 'object') ? j.modelUsage : null;
  meta.session_id = j.session_id || null;
  meta.raw_ids = meta.session_id ? { session_id: meta.session_id } : null;
  meta.num_turns = j.num_turns == null ? null : Number(j.num_turns);
  meta.model = j.model || (meta.model_usage ? Object.keys(meta.model_usage)[0] : null) || null;
  if (j.total_cost_usd != null) {
    meta.est_cost_usd = Number(j.total_cost_usd);
    meta.cost_source = 'total_cost_usd';
  }
  // --max-budget-usd stops the leaf; claude reports it in the result subtype.
  meta.budget_hit = /budget/i.test(String(j.subtype || ''));

  const tokens = ledger.tokenTotals(usage, promptChars);
  meta.total_input_tokens = tokens.total_input_tokens;
  meta.overhead_input_tokens = tokens.overhead_input_tokens;

  const text = typeof j.result === 'string' ? j.result : JSON.stringify(j);
  const ok = exit === 0 && j.is_error !== true && !o.timedOut && !o.cancelled;
  return { ok, text, meta };
}

module.exports = {
  id: ID,
  expectedImageFor: () => platform.expectedImage('claude'),
  vendor: 'anthropic',
  expectedImage: platform.expectedImage('claude'),
  effortLevels: EFFORTS.slice(),
  defaultTimeoutS: 900,
  maxTimeoutS: 1800,
  binaryPath,
  versionSpec,
  available,
  buildSpawn,
  parse,
};
