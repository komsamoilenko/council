// Owns echo.js runtime behavior; port specification §§2–6.
'use strict';
/**
 * backends/echo.js — the zero-quota test leaf (SPEC §6.4; contract §6; env §6.0).
 * Owns the grammar `sleep:<n>[;exit:<code>][;spawn-grandchild][;stderr:<text>]`,
 * order-free and semicolon-separated, and the tiny `node -e` script that implements it.
 * DECISION: the grammar arrives on STDIN (promptVia:'stdin'), inside the ordinary
 * prompt.md bytes, so no <prompt.md> argv token is needed and no prompt ever reaches
 * the command line. expectedImage is node binary; `spawn-grandchild` starts a `cmd /c
 * timeout 300` grandchild so T-06 can prove the tree kill reaches two levels down.
 * PER-LEG OVERRIDE (integrator, 2026-09-07): one prompt.md is shared by every leg of a
 * fan-out, so a line `@leg <leg_id>: <grammar>` lets one leg of an ["echo","echo"] pair
 * fail while the other succeeds — the only zero-cost route to SPEC §2.1 `partial`
 * (T-04b). A leg with no matching override reads the prompt with every `@leg` line
 * stripped. The convention is documented in README ("The echo backend and its grammar").
 */

const fs = require('fs');
const platform = require('../platform');
const guard = require('../lib/guard.js');
const envlib = require('../lib/env.js');
const jobstore = require('../lib/jobstore.js');

const ID = 'echo';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * The grandchild command line. `timeout` needs a console and the leaf is spawned with
 * windowsHide, so on this machine `timeout 300` exits immediately with "input
 * redirection is not supported" — the `|| ping -n 300` tail keeps a real live process
 * in the tree either way, so tree-kill always has something to kill. The head is
 * literally `cmd /c timeout 300`, as T-06 expects.
 */
const GRANDCHILD_ARGS = platform.longLivedChildArgv().args;

/** The whole leaf, as one `node -e` argument. Single quotes only: no shell, no escaping. */
const SCRIPT = [
  "let s='';let done=false;",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data',function(d){s+=d;});",
  "process.stdin.on('end',function(){run(s);});",
  "process.stdin.on('error',function(){run(s);});",
  "setTimeout(function(){run(s);},10000);",
  'function run(t){',
  'if(done)return;done=true;',
  "var lg=String(process.argv[1]||'');",
  'var lines=String(t).split(/\\r?\\n/);',
  'var ov=null;var rest=[];',
  'for(var i=0;i<lines.length;i++){',
  'var mm=/^@leg\\s+(\\S+)\\s*:(.*)$/.exec(lines[i]);',
  'if(mm){if(mm[1]===lg&&ov===null)ov=mm[2];}else{rest.push(lines[i]);}',
  '}',
  "t=(ov!==null)?ov:rest.join('\\n');",
  'const m=/sleep:\\s*(\\d+)/.exec(t);',
  'const sec=m?Math.min(3600,parseInt(m[1],10)):0;',
  'const e=/exit:\\s*(\\d+)/.exec(t);',
  'const code=e?parseInt(e[1],10):0;',
  'const se=/stderr:([^;\\r\\n]*)/.exec(t);',
  "if(/spawn-grandchild/.test(t)){try{var cmd=JSON.parse(process.argv[2]);require('child_process').spawn(cmd.file,cmd.args,",
  "{stdio:'ignore',windowsHide:true}).unref();}catch(x){}}",
  'setTimeout(function(){',
  "if(se)process.stderr.write(se[1]+'\\n');",
  "process.stdout.write(JSON.stringify({result:'echo ok sleep='+sec+' exit='+code,",
  "leg:process.argv[1]||null,prompt_chars:t.length})+'\\n');",
  'process.exit(code);',
  '},sec*1000);',
  '}',
].join('');

/** @param {Object} ctx @returns {string|null} absolute node binary from config.binaries */
function binaryPath(ctx) {
  return (ctx && ctx.config && ctx.config.binaries && ctx.config.binaries.node) || null;
}

/** council_doctor{deep} probe: node --version, zero quota. */
function versionSpec(ctx) {
  const file = binaryPath(ctx);
  return file ? { file, args: ['--version'] } : null;
}

/**
 * Echo needs nothing but node binary. Called with {} by council_doctor.
 * @returns {{ok:boolean, reason?:string}}
 */
function available(ctx) {
  const file = binaryPath(ctx);
  if (!file || !jobstore.exists(file)) return { ok: false, reason: 'node binary missing: ' + file };
  return { ok: true };
}

/**
 * `node binary -e <script> <leg_id>` in the echo sandbox. The grammar is read from stdin.
 * @returns {{file:string,args:string[],cwd:string,env:Object,envExtra:Object,
 *            promptVia:string,expectedImage:string}}
 */
function buildSpawn(ctx, o) {
  const job = (o && o.job) || {};
  const leg = (o && o.leg) || {};
  const file = binaryPath(ctx);
  if (!file) throw new Error('node binary not configured');

  const args = ['-e', SCRIPT, String(leg.leg_id || ID), JSON.stringify(platform.longLivedChildArgv())];

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
    expectedImage: platform.expectedImage('node'),
    flags: ['zero_quota', 'stdin_prompt'],
  };
}

/** Read a file as text; never throws. */
function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

/**
 * The echo leaf prints one `{"result":…}` line. A non-zero exit (grammar `exit:<code>`)
 * is a failed leg, which is exactly how T-04b reaches `partial`.
 * @returns {{ok:boolean, text:string, meta:Object}}
 */
function parse(ctx, o) {
  const stdout = readText(o.stdoutPath);
  const stderrTail = jobstore.readTail(o.stderrPath, 4000).slice(-800) || null;
  const meta = {
    session_id: null,
    raw_ids: null,
    resumable: false,
    model: null,
    num_turns: 1,
    usage: null,
    model_usage: null,
    est_cost_usd: 0,
    cost_is_estimate: false,
    cost_source: 'zero_quota',
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

  let text = stdout;
  try {
    const j = JSON.parse(stdout.trim());
    if (j && typeof j === 'object' && typeof j.result === 'string') text = j.result;
    else meta.parse_failed = true;
  } catch (e) {
    meta.parse_failed = true;
    meta.parse_error = String(e && e.message);
  }

  const ok = o.exitCode === 0 && !o.timedOut && !o.cancelled;
  return { ok, text, meta };
}

module.exports = {
  id: ID,
  expectedImageFor: () => platform.expectedImage('node'),
  vendor: 'local',
  expectedImage: platform.expectedImage('node'),
  effortLevels: EFFORTS.slice(),
  defaultTimeoutS: 60,
  maxTimeoutS: 1800,
  SCRIPT,
  GRANDCHILD_ARGS,
  binaryPath,
  versionSpec,
  available,
  buildSpawn,
  parse,
};
