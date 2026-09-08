// Owns gemini-agy.js runtime behavior; port specification §§2–6.
'use strict';
/**
 * backends/gemini.js — the Google/Antigravity leg (SPEC §6.3; contract §6; env §6.0).
 * Owns: the agy binary argv (--output-format json, --print-timeout timeout_s+30, --effort,
 * --mode plan, --sandbox, --disable-slash-commands, optional --model/--add-dir/
 * --conversation) and the three prompt forms from config.json.prompt_form; the gate on
 * protected runtime state; the 20,000-character prompt cap;
 * and the parse of the verified success JSON {conversation_id,status,response,usage}.
 * The prompt is the one adapter that puts prompt bytes in argv, via the <prompt.md> token.
 */

const fs = require('fs');
const platform = require('../platform');
const guard = require('../lib/guard.js');
const envlib = require('../lib/env.js');
const jobstore = require('../lib/jobstore.js');
const ledger = require('../lib/ledger.js');
const router = require('../lib/router.js');

const ACKNOWLEDGEMENT = 'I have read NOTICE.md and I accept that using agy with council may breach Antigravity Additional Terms of Service section 6.';
const ID = 'gemini';
const EFFORTS = ['low', 'medium', 'high'];
const PROMPT_TOKEN = '<prompt.md>';
const PROMPT_FORMS = ['attached', 'split', 'positional'];

/** @param {Object} ctx @returns {string|null} absolute agy binary from config.binaries */
function binaryPath(ctx) {
  return (ctx && ctx.config && ctx.config.binaries && ctx.config.binaries.agy) || null;
}

/** council_doctor{deep} probe: --version only, zero quota. */
function versionSpec(ctx) {
  const file = binaryPath(ctx);
  return file ? { file, args: ['--version'] } : null;
}

/** SPEC §7 clamp: agy has no xhigh/max; both map to high. */
function clampEffort(effort) {
  const e = String(effort || 'medium').toLowerCase();
  if (e === 'xhigh' || e === 'max') return 'high';
  return EFFORTS.includes(e) ? e : 'medium';
}

/** config.json.prompt_form, validated. `null` (or junk) means "unknown", which refuses. */
function promptForm(ctx) {
  const v = ctx && ctx.config ? ctx.config.prompt_form : null;
  return PROMPT_FORMS.includes(v) ? v : null;
}

/** The agy prompt cap (SPEC §6.3): conservative 20,000 chars, never raised past 24,000. */
function maxPromptChars(ctx) {
  const f = (ctx && ctx.config && ctx.config.fuses) || {};
  const n = Number(f.agy_max_prompt_chars);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 20000) : 20000;
}

/**
 * Approximate the composed prompt.md length from what request.json already knows,
 * so an over-cap prompt is refused before the job dir is even written.
 * @returns {number}
 */
function composedChars(job) {
  const guardLen = String((job && job.guard_paragraph) || '').length;
  const noteLen = String((job && job.context_note) || '').length;
  const promptLen = Number(job && job.prompt_chars) || 0;
  const markers = 120; // <<<COUNCIL_GUARD …>>> + the two CONSULTATION markers + newlines
  return guardLen + noteLen + promptLen + markers;
}

/** The hard Windows command-line ceiling (32,767) with headroom for flags and quoting. */
const QUOTED_LIMIT = 30000;

/**
 * What the prompt actually costs on the command line, not what it costs in characters.
 * Node quotes an argv token by wrapping it in double quotes, escaping every `"` and
 * doubling the backslashes that precede one — so a prompt full of `\"` pairs can double
 * in length and blow the 32,767-char Windows limit while still being far inside
 * agy_max_prompt_chars (measured 2026-09-07: 20,000 chars of `\"` => spawn ENAMETOOLONG,
 * 20,000 chars of prose => fine). The estimate is deliberately generous.
 * @param {string} text @returns {number}
 */
function quotedChars(text) {
  const s = String(text == null ? '' : text);
  const specials = (s.match(/["\\]/g) || []).length;
  return s.length + specials + 400;   // 400 = the flags, the binary path and the quotes
}

function available(ctx, o) {
  const opts = o || {};
  if ((ctx.config.gemini || {}).provider !== 'agy' || !ctx.paths || !jobstore.exists(ctx.paths.agyGate)) return { ok: false, reason: 'agy_gate_missing' };
  let first; try { first = fs.readFileSync(ctx.paths.agyGate, 'utf8').split(/\r?\n/).map(s => s.trim()).find(Boolean); } catch {}
  if (first !== ACKNOWLEDGEMENT) return { ok: false, reason: 'agy_notice_not_acknowledged' };
  if (!promptForm(ctx)) return { ok: false, reason: 'agy_prompt_form_unknown' };
  const file = binaryPath(ctx);
  const root = platform.agyBinaryRoot();
  const P = require('../lib/paths');
  if (!file || !root || !jobstore.exists(file) || !P.isUnder(file, root) || !P.isUnder(P.realpathSafe(file) || '', P.realpathSafe(root) || root)) return { ok: false, reason: 'agy_binary_missing' };
  if (opts.job) {
    const chars = composedChars(opts.job);
    const cap = maxPromptChars(ctx);
    if (chars > cap) return { ok: false, reason: 'prompt_too_large: composed prompt ~' + chars + ' chars > agy cap ' + cap };
    // Same quoted-length estimate buildSpawn enforces, so a quote-heavy prompt refuses
    // BEFORE the job dir is written and an hour/day fuse leg is burned.
    const quoted = quotedChars(opts.promptText || '') || 0;
    if (opts.promptText && quoted > QUOTED_LIMIT) {
      return { ok: false, reason: 'prompt_too_large: quoted command line ~' + quoted + ' chars > Windows-safe limit ' + QUOTED_LIMIT };
    }
  }
  const sid = (opts.leg && opts.leg.session_id) || null;
  if (sid && !router.isSessionId(sid)) return { ok: false, reason: 'session_id_malformed' };
  return { ok: true };
}

/**
 * SPEC §6.3 argv. The prompt tail is the LAST thing on the line in all three forms;
 * runner.js substitutes the <prompt.md> token with the prompt bytes just before spawn
 * (guard.assertArgvSafe runs on the pre-substitution argv only, §1.4).
 * @returns {{file:string,args:string[],cwd:string,env:Object,envExtra:Object,
 *            promptVia:string,expectedImage:string}}
 */
function buildSpawn(ctx, o) {
  const job = o.job || {};
  const leg = o.leg || {};
  const file = binaryPath(ctx);
  if (!file) throw new Error('agy binary not configured');

  const form = promptForm(ctx);
  if (!form) throw new Error('agy_prompt_form_unknown');

  const promptText = String(o.promptText == null ? '' : o.promptText);
  const cap = maxPromptChars(ctx);
  if (promptText.length > cap) {
    throw new Error('prompt_too_large: composed prompt ' + promptText.length + ' chars > agy cap ' + cap);
  }
  const quoted = quotedChars(promptText);
  if (quoted > QUOTED_LIMIT) {
    throw new Error('prompt_too_large: quoted command line ' + quoted + ' chars > Windows-safe limit '
      + QUOTED_LIMIT + ' (quotes and backslashes are escaped by the spawner)');
  }

  const timeoutS = Number(o.timeoutS) || 900;
  const args = [
    '--output-format', 'json',
    '--print-timeout', String(timeoutS + 30) + 's',
    '--effort', clampEffort(o.effort || leg.effort),
    '--mode', 'plan',
    '--sandbox',
    '--disable-slash-commands',
  ];

  const cfgModel = (ctx.config && ctx.config.models && ctx.config.models.gemini) || null;
  const model = o.model || leg.model || cfgModel;
  if (model) args.push('--model', String(model));

  // Go's flag package takes one value per occurrence, so --add-dir is repeated.
  for (const p of (Array.isArray(o.readPaths) ? o.readPaths.filter(Boolean) : [])) {
    args.push('--add-dir', String(p));
  }

  const session = o.continueFrom || leg.session_id || null;
  if (session) {
    if (!router.isSessionId(session)) throw new Error('session_id_malformed: ' + String(session).slice(0, 40));
    args.push('--conversation', String(session));
  }

  // The prompt tail, per config.json.prompt_form (SPEC §6.3 table).
  // `split` is the verified live form (agy -p "<prompt>" --output-format json works).
  // `positional` differs from `split` only in spelling: with Go flag parsing a boolean
  // --print followed by a bare positional produces the same two tokens.
  if (form === 'attached') args.push('--print=' + PROMPT_TOKEN);
  else if (form === 'split') args.push('-p', PROMPT_TOKEN);
  else args.push('--print', PROMPT_TOKEN);

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
    promptVia: 'argv',
    expectedImage: platform.expectedImage('agy'),
    // SPEC §10 sample row.
    flags: ['plan_mode', 'sandbox', 'no_slash_commands', 'argv_prompt', 'prompt_form:' + form]
      .concat(session ? ['resumed'] : []),
  };
}

/** Read a file as text; never throws. */
function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

/** Last {...} block of a noisy stdout. */
function lastJsonObject(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

/**
 * Map the verified agy usage object onto the canonical Anthropic spellings so the one
 * normative token formula (ledger.tokenTotals) sees the cached input tokens.
 * Verified shape: {input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens}.
 */
function canonicalUsage(u) {
  if (!u || typeof u !== 'object') return null;
  return {
    input_tokens: Number(u.input_tokens) || 0,
    output_tokens: Number(u.output_tokens) || 0,
    cache_read_input_tokens: Number(u.cache_read_tokens || u.cache_read_input_tokens) || 0,
    cache_creation_input_tokens: Number(u.cache_creation_tokens || u.cache_creation_input_tokens) || 0,
  };
}

/**
 * SPEC §6.3 parse of the verified success JSON. session_id = conversation_id
 * (resume with --conversation <id>).
 * @returns {{ok:boolean, text:string, meta:Object}}
 */
function parse(ctx, o) {
  const stdout = readText(o.stdoutPath);
  const stderrTail = jobstore.readTail(o.stderrPath, 4000).slice(-800) || null;
  const promptChars = Number(o.promptChars) || 0;
  const meta = {
    session_id: null,
    raw_ids: null,
    resumable: true,
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

  let j = null;
  try { j = JSON.parse(stdout.trim()); } catch (e) { meta.parse_error = String(e && e.message); }
  if (!j || typeof j !== 'object') j = lastJsonObject(stdout);

  if (!j || typeof j !== 'object') {
    meta.parse_failed = true;
    return { ok: o.exitCode === 0 && !o.timedOut && !o.cancelled, text: stdout, meta };
  }
  meta.parse_error = null;

  meta.session_id = j.conversation_id || null;
  meta.raw_ids = meta.session_id ? { conversation_id: meta.session_id } : null;
  meta.num_turns = j.num_turns == null ? null : Number(j.num_turns);
  meta.usage = (j.usage && typeof j.usage === 'object') ? j.usage : null;
  if (meta.usage) {
    const tokens = ledger.tokenTotals(canonicalUsage(meta.usage), promptChars);
    meta.total_input_tokens = tokens.total_input_tokens;
    meta.overhead_input_tokens = tokens.overhead_input_tokens;
  }

  const text = typeof j.response === 'string' ? j.response : JSON.stringify(j);
  const status = String(j.status || '').toUpperCase();
  const ok = o.exitCode === 0 && status === 'SUCCESS' && !o.timedOut && !o.cancelled;
  return { ok, text, meta };
}

module.exports = {
  id: ID,
  expectedImageFor: () => platform.expectedImage('agy'),
  vendor: 'google',
  expectedImage: platform.expectedImage('agy'),
  effortLevels: EFFORTS.slice(),
  defaultTimeoutS: 900,
  maxTimeoutS: 1800,
  PROMPT_FORMS,
  PROMPT_TOKEN,
  binaryPath,
  versionSpec,
  available,
  buildSpawn,
  parse,
};
