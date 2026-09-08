// Owns codex.js runtime behavior; port specification §§2–6.
'use strict';
/**
 * backends/codex.js — the OpenAI leg (SPEC §6.2; contract SPEC §6; env §6.0).
 * Owns: `node binary codex.js exec` argv with --ignore-user-config / --ignore-rules /
 * --skip-git-repo-check / --sandbox read-only / -C sandbox / --json / -o last.md and
 * the bare `-` stdin terminator; the resume argv (which cannot take -C or --sandbox,
 * so it re-pins them with -c sandbox_mode / -c windows.sandbox); the JSONL parse that
 * recovers the answer, the session id and the token counts.
 * RESUME_ENABLED below is the single switch T-13b flips (SPEC §6.2 probe).
 */

const fs = require('fs');
const platform = require('../platform');
const path = require('path');
const guard = require('../lib/guard.js');
const envlib = require('../lib/env.js');
const jobstore = require('../lib/jobstore.js');
const ledger = require('../lib/ledger.js');
const router = require('../lib/router.js');

const ID = 'codex';
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];

/**
 * SPEC §6.2 probe T-13b: a RESUMED codex session must still refuse a write. It ships
 * ENABLED because the resume argv re-pins the sandbox with -c sandbox_mode="read-only".
 * If T-13b shows a resumed session can write, set this to false — that one edit makes
 * every codex `continue_from` refuse with backend_unavailable:codex_resume_unpinned,
 * with no other change anywhere.
 */
const RESUME_ENABLED = true;

/** @param {Object} ctx @returns {string|null} absolute codex.js from config.binaries */
function binaryPath(ctx) {
  return (ctx && ctx.config && ctx.config.binaries && ctx.config.binaries.codex_js) || null;
}

/** @param {Object} ctx @returns {string|null} absolute node binary */
function nodePath(ctx) {
  return (ctx && ctx.config && ctx.config.binaries && ctx.config.binaries.node) || null;
}

/** council_doctor{deep} probe: --version only, zero quota. */
function versionSpec(ctx) {
  const node = nodePath(ctx);
  const js = binaryPath(ctx);
  return node && js ? { file: node, args: [js, '--version'] } : null;
}

/** Default model is the live pin (config.models.codex = gpt-6-astra, SPEC §7). */
function resolveModel(ctx, model) {
  const cfg = (ctx && ctx.config && ctx.config.models) || {};
  return String(model || cfg.codex || 'gpt-6-astra');
}

/** SPEC §7 clamp: codex has no `max`; it maps to xhigh. */
function clampEffort(effort) {
  const e = String(effort || 'medium').toLowerCase();
  if (e === 'max') return 'xhigh';
  return EFFORTS.includes(e) ? e : 'medium';
}

/**
 * Binaries present; resume only when RESUME_ENABLED.
 * Called with {} by council_doctor, so every field is optional.
 * @returns {{ok:boolean, reason?:string}}
 */
function available(ctx, o) {
  const opts = o || {};
  const node = nodePath(ctx);
  const js = binaryPath(ctx);
  if (!node || !jobstore.exists(node)) return { ok: false, reason: 'node binary missing: ' + node };
  if (!js || !jobstore.exists(js)) return { ok: false, reason: 'codex.js missing: ' + js };
  const wantsResume = !!(opts.continueFrom || (opts.leg && opts.leg.session_id));
  if (wantsResume && !RESUME_ENABLED) return { ok: false, reason: 'codex_resume_unpinned' };
  // `exec resume <SESSION_ID>` is a clap POSITIONAL: one token that starts with `-` IS a
  // flag (`-cnotify=[...]`, `--last`, `--ephemeral`). Refuse pre-spawn, never at spawn.
  const sid = (opts.leg && opts.leg.session_id) || null;
  if (sid && !router.isSessionId(sid)) return { ok: false, reason: 'session_id_malformed' };
  return { ok: true };
}

/**
 * SPEC §6.2 argv. Fresh run and resume differ: `exec resume` accepts neither -C nor
 * --sandbox, so the sandbox is re-pinned with `-c sandbox_mode="read-only"`.
 * `-c` values are TOML, hence the literal quotes around string values.
 * @returns {{file:string,args:string[],cwd:string,env:Object,envExtra:Object,
 *            promptVia:string,expectedImage:string}}
 */
function buildSpawn(ctx, o) {
  const job = o.job || {};
  const leg = o.leg || {};
  const node = nodePath(ctx);
  const js = binaryPath(ctx);
  if (!node) throw new Error('node binary not configured');
  if (!js) throw new Error('codex.js not configured');

  // -o writes the final answer to legs\<legId>\last.md. The job dir is the directory
  // holding prompt.md; jobDirFor is the fallback when promptPath was not supplied.
  const legId = leg.leg_id || ID;
  const jobDir = o.promptPath ? path.dirname(String(o.promptPath)) : jobDirOf(ctx, job);
  const outPath = path.join(jobDir, 'legs', legId, 'last.md');

  const cwd = ctx.paths.sandboxFor(ID);
  const model = resolveModel(ctx, o.model || leg.model);
  const effort = clampEffort(o.effort || leg.effort);
  const session = o.continueFrom || leg.session_id || null;

  const args = [js, 'exec'];
  if (session) {
    if (!RESUME_ENABLED) throw new Error('codex_resume_unpinned');
    // The positional session id is the one place a rewritten result.json could turn a
    // stored string into a codex FLAG; the UUID shape is re-checked here on purpose.
    if (!router.isSessionId(session)) throw new Error('session_id_malformed: ' + String(session).slice(0, 40));
    args.push('resume', String(session), '--all');
  }
  args.push('--ignore-user-config', '--ignore-rules', '--skip-git-repo-check');
  if (!session) args.push('--sandbox', 'read-only', '-C', cwd);
  args.push('--json', '-o', outPath, '-m', model);
  args.push('-c', 'model_reasoning_effort="' + effort + '"');
  if (session) args.push('-c', 'sandbox_mode="read-only"');
  args.push('-c', 'windows.sandbox="elevated"');
  args.push('-c', 'mcp_servers={}');
  args.push('-');

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
    file: node,
    args,
    cwd,
    env,
    envExtra,
    promptVia: 'stdin',
    expectedImage: platform.expectedImage('node'),
    // SPEC §10 sample row.
    flags: ['ignore_user_config', 'ignore_rules', 'read_only', 'no_mcp', 'stdin_prompt']
      .concat(session ? ['resumed'] : []),
  };
}

/** `<jobsRoot>\<YYYY-MM-DD>\<job_id>` without importing the job store's date logic twice. */
function jobDirOf(ctx, job) {
  const id = String(job.job_id || '');
  return jobstore.jobDirFor(ctx.paths, id);
}

/** Read a file as text; never throws. */
function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

const UUIDISH = /^[0-9a-fA-F-]{16,}$/;

/**
 * Walk one parsed JSONL event for the four id spellings SPEC §6.2 names.
 * @param {Object} obj @param {Object} into raw_ids accumulator
 */
function collectIds(obj, into) {
  const holders = [obj, obj.msg, obj.item, obj.thread, obj.info, obj.session];
  for (const h of holders) {
    if (!h || typeof h !== 'object') continue;
    for (const k of ['thread_id', 'session_id', 'id', 'conversation_id']) {
      const v = h[k];
      if (typeof v !== 'string' || !v) continue;
      // A bare `id` is only a session id when it looks like one; codex also uses
      // `id` for per-item ("item_0") and per-event ("9") counters.
      if (k === 'id' && !UUIDISH.test(v)) continue;
      if (into[k] == null) into[k] = v;
    }
  }
}

/** The answer text carried by one event, if any (three known codex shapes). */
function eventText(obj) {
  if (obj.msg && obj.msg.type === 'agent_message' && typeof obj.msg.message === 'string') return obj.msg.message;
  if (obj.type === 'agent_message' && typeof obj.message === 'string') return obj.message;
  if (obj.type === 'item.completed' && obj.item && typeof obj.item.text === 'string') {
    const kind = obj.item.item_type || obj.item.type || '';
    if (!kind || kind === 'agent_message') return obj.item.text;
  }
  return null;
}

/** The token usage carried by one event, if any (`token_count` / `turn.completed`). */
function eventUsage(obj) {
  if (obj.usage && typeof obj.usage === 'object') return obj.usage;
  if (obj.info && obj.info.total_token_usage) return obj.info.total_token_usage;
  if (obj.msg && obj.msg.info && obj.msg.info.total_token_usage) return obj.msg.info.total_token_usage;
  if (obj.msg && obj.msg.usage && typeof obj.msg.usage === 'object') return obj.msg.usage;
  return null;
}

/**
 * SPEC §6.2 parse. Answer preference: last.md, then the last agent_message /
 * item.completed event, then raw stdout. Cost is always null for codex.
 * @returns {{ok:boolean, text:string, meta:Object}}
 */
function parse(ctx, o) {
  const stdout = readText(o.stdoutPath);
  const stderrTail = jobstore.readTail(o.stderrPath, 4000).slice(-800) || null;
  const promptChars = Number(o.promptChars) || 0;
  const meta = {
    session_id: null,
    raw_ids: null,
    resumable: RESUME_ENABLED,
    model: (o.leg && o.leg.model) || null,
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

  const rawIds = {};
  let lastText = null;
  let usage = null;
  let events = 0;
  for (const line of stdout.split('\n')) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    let obj = null;
    try { obj = JSON.parse(s); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;
    events++;
    collectIds(obj, rawIds);
    const t = eventText(obj);
    if (t) lastText = t;
    const u = eventUsage(obj);
    if (u) usage = u;
  }
  meta.raw_ids = events ? rawIds : null;
  meta.num_turns = events ? 1 : null;

  for (const k of ['thread_id', 'session_id', 'conversation_id', 'id']) {
    const v = rawIds[k];
    if (typeof v === 'string' && UUIDISH.test(v)) { meta.session_id = v; break; }
  }
  if (!meta.session_id) {
    for (const k of ['thread_id', 'session_id', 'conversation_id']) {
      if (rawIds[k]) { meta.session_id = rawIds[k]; break; }
    }
  }

  if (usage) {
    meta.usage = usage;
    const tokens = ledger.tokenTotals(usage, promptChars);
    meta.total_input_tokens = tokens.total_input_tokens;
    meta.overhead_input_tokens = tokens.overhead_input_tokens;
  }

  const lastMd = readText(o.legDir ? path.join(o.legDir, 'last.md') : '');
  let text = lastMd.trim() ? lastMd : (lastText || '');
  if (!text) { text = stdout; meta.parse_failed = true; }

  const ok = o.exitCode === 0 && !!text.trim() && !o.timedOut && !o.cancelled;
  return { ok, text, meta };
}

module.exports = {
  id: ID,
  expectedImageFor: () => platform.expectedImage('node'),
  vendor: 'openai',
  expectedImage: platform.expectedImage('node'),
  effortLevels: EFFORTS.slice(),
  defaultTimeoutS: 900,
  maxTimeoutS: 1800,
  RESUME_ENABLED,
  binaryPath,
  versionSpec,
  available,
  buildSpawn,
  parse,
};
