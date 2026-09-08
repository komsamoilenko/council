// Owns search.js runtime behavior; port specification §§2–6.
'use strict';
/**
 * lib/search.js — council_search: ripgrep over the Vault (SPEC §11, §5.6).
 * Owns the exact rg argv, the caps (50 matches/file, 2M filesize, 400 columns,
 * 2 threads, 512 KB stdout, 15 s wall clock with a tree kill), path containment
 * and junction rejection, the include_jobs switch, and the per-hit `untrusted`
 * classification that §5.6 turns into an untrusted wrapper (render.js draws it).
 * Never spawns anything but rg, never writes a file except one `search` ledger row.
 */

const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const paths = require('./paths.js');
const jobstore = require('./jobstore.js');
const envmod = require('./env.js');
const ledger = require('./ledger.js');
const procwin = require('../platform');

/* ---------------- constants */

/** SPEC §11 caps. Timing may be overridden by config.timing.search_timeout_s. */
const SEARCH_TIMEOUT_S = 15;
const STDOUT_CAP_BYTES = 512 * 1024;
const STDERR_CAP_BYTES = 64 * 1024;
const STDERR_TAIL_CHARS = 800;
const MAX_COUNT_PER_FILE = 50;      // rg -m is PER FILE; the total cap is applied in JS
const MAX_FILESIZE = '2M';
const MAX_COLUMNS = '400';
const THREADS = '2';
const MODES = ['content', 'files', 'count'];

/* ---------------- arg handling */

/**
 * Re-validate and clamp the caller's arguments (schemas are documentation, code
 * is enforcement — SPEC §5). Returns a normalised bag or a refusal.
 * @param {Object} args raw tool arguments
 * @returns {{ok:true, value:Object}|{ok:false, reason:string, detail:string}}
 */
function normalizeArgs(args) {
  const a = args && typeof args === 'object' ? args : {};
  const pattern = typeof a.pattern === 'string' ? a.pattern : '';
  if (!pattern.length) return { ok: false, reason: 'bad_pattern', detail: 'pattern is required' };
  if (pattern.length > 500) return { ok: false, reason: 'bad_pattern', detail: 'pattern longer than 500 chars' };
  if (pattern.indexOf('\0') !== -1) return { ok: false, reason: 'bad_pattern', detail: 'NUL byte in pattern' };

  const globIn = Array.isArray(a.glob) ? a.glob : [];
  const glob = [];
  for (const g of globIn.slice(0, 5)) {
    if (typeof g !== 'string' || !g.length) continue;
    if (g.length > 100 || g.indexOf('\0') !== -1) return { ok: false, reason: 'bad_glob', detail: 'glob too long or contains NUL' };
    glob.push(g);
  }

  const mode = MODES.includes(a.mode) ? a.mode : 'content';
  return {
    ok: true,
    value: {
      pattern,
      regex: a.regex === true,
      path: typeof a.path === 'string' && a.path.length ? a.path : null,
      glob,
      mode,
      context: clampInt(a.context, 0, 5, 1),
      max_results: clampInt(a.max_results, 1, 300, 60),
      include_jobs: a.include_jobs === true,
    },
  };
}

/** @returns {number} n clamped to [lo,hi], or def when not a finite number */
function clampInt(n, lo, hi, def) {
  const v = Number(n);
  if (!Number.isFinite(v)) return def;
  return Math.min(hi, Math.max(lo, Math.trunc(v)));
}

/**
 * Resolve the search root. Default = the Vault. A caller path must exist, must
 * not traverse a junction/symlink (SPEC §11), and must pass paths.resolveVaultPath
 * (inside the Vault; out of ledger and bin\council; out of work\jobs unless
 * include_jobs).
 * @param {Object} ctx @param {string|null} input @param {boolean} includeJobs
 * @returns {{ok:true, path:string}|{ok:false, reason:'path_outside_vault', detail:string}}
 */
function resolveRoot(ctx, input, includeJobs) {
  const P = ctx.paths;
  if (input == null || String(input).trim() === '') {
    return { ok: true, path: P.vaultReal || P.vault };
  }
  const s = String(input);
  if (s.indexOf('\0') !== -1) return { ok: false, reason: 'path_outside_vault', detail: 'NUL in path' };

  const abs = path.isAbsolute(s) ? path.resolve(s) : path.resolve(P.vault, s);
  const real = paths.realpathSafe(abs);
  if (!real) return { ok: false, reason: 'path_outside_vault', detail: 'does not exist: ' + abs };
  // Junction rejection: the literal path must BE its own realpath. A reparse point
  // anywhere along it (even one landing back inside the Vault) is refused.
  if (paths.normCase(real) !== paths.normCase(abs)) {
    return { ok: false, reason: 'path_outside_vault', detail: 'path traverses a junction or symlink: ' + abs + ' -> ' + real };
  }
  try {
    if (fs.lstatSync(abs).isSymbolicLink()) {
      return { ok: false, reason: 'path_outside_vault', detail: 'path is a junction or symlink: ' + abs };
    }
  } catch { /* the realpath above already proved it exists; a stat race is not fatal */ }

  // allowAncestors: a search root that CONTAINS work\jobs / ledger / bin\council is
  // legal here (and is the default root), because every hit is post-filtered by
  // keepHit — SPEC §11 calls that JS containment "the authority". read_paths has no
  // such filter, which is why lib/paths.js refuses ancestors by default.
  if (includeJobs && paths.isUnder(real, P.jobsRoot)) return {ok:true,path:real};
  const r = paths.resolveVaultPath(s, P, { allowJobs: !!includeJobs, allowAncestors: true });
  if (!r.ok) return { ok: false, reason: r.reason || 'path_outside_vault', detail: r.detail || 'not inside the Vault' };
  return { ok: true, path: r.path };
}

/**
 * The exclusion globs, SPEC §11 order. Each is emitted twice: the literal spec
 * form, then a `**\/`-anchored companion. ripgrep matches a glob containing `/`
 * against the whole candidate path, so with an ABSOLUTE search root the literal
 * `!work/jobs/**` never fires (measured on rg 15.2.0, 2026-09-07); the anchored
 * form is what actually excludes. JS containment (keepHit) is still the authority.
 * @param {boolean} includeJobs @returns {string[]}
 */
function excludeGlobs(includeJobs, P) {
  const base = ['.git/**'];
  if (!includeJobs && (!P || paths.isUnder(P.jobsRoot,P.vault))) base.push((P ? path.relative(P.vault,P.jobsRoot).split(path.sep).join('/') : 'work/jobs') + '/**');
  if (!P || paths.isUnder(P.ledgerDir,P.vault)) base.push((P ? path.relative(P.vault,P.ledgerDir).split(path.sep).join('/') : 'ledger') + '/**');
  base.push('node_modules/**');
  const out = [];
  for (const g of base) { out.push('!' + g); out.push('!**/' + g); }
  return out;
}

/**
 * The rg argv, exactly SPEC §11 (pure — no spawn, so a test can assert it).
 * @param {Object} ctx @param {Object} o normalised args plus {root}
 * @returns {string[]}
 */
function buildArgv(ctx, o) {
  const args = [
    '--json', '--no-config', '--line-number', '--with-filename', '--smart-case',
    '--no-ignore-vcs', '--hidden',
    '--max-count', String(MAX_COUNT_PER_FILE),
    '--max-filesize', MAX_FILESIZE,
    '--max-columns', MAX_COLUMNS, '--max-columns-preview',
    '--threads', THREADS,
  ];
  for (const g of excludeGlobs(o.include_jobs, ctx.paths)) args.push('-g', g);
  for (const g of o.glob) args.push('-g', g);
  if (!o.regex) args.push('-F');
  if (o.mode === 'files') args.push('--files-with-matches');
  else if (o.mode === 'count') args.push('--count-matches');
  else args.push('-C', String(o.context));
  args.push('--', o.pattern, o.root);
  if(o.include_jobs && !paths.isUnder(ctx.paths.jobsRoot,ctx.paths.vault) && !paths.isUnder(ctx.paths.jobsRoot,o.root) && jobstore.exists(ctx.paths.jobsRoot)) args.push(ctx.paths.jobsRoot);
  return args;
}

/* ---------------- hit handling */

/**
 * Is this hit third-party leaf output (SPEC §5.6)? A hit under Vault\work\jobs
 * is untrusted; `job` comes from the path segment matching the job-id regex and
 * `leg` from the segment after `legs`; either falls back to 'unknown'.
 * @param {Object} ctx @param {string} file absolute path
 * @returns {{untrusted:boolean, job?:string, leg?:string}}
 */
function classifyHit(ctx, file) {
  const P = ctx.paths;
  if (!excludedRoots(P).jobs.some((r) => paths.isUnder(file, r))) return { untrusted: false };

  let job = 'unknown';
  let leg = 'unknown';
  const segs = String(file).split(/[\\/]+/);
  for (let i = 0; i < segs.length; i += 1) {
    if (jobstore.JOB_ID_RE.test(segs[i])) job = segs[i];
    if (segs[i].toLowerCase() === 'legs' && segs[i + 1]) leg = segs[i + 1];
  }
  return { untrusted: true, job, leg };
}

/**
 * The authority on exclusion: rg's globs are advisory, containment is checked here.
 * @param {Object} ctx @param {string} file @param {boolean} includeJobs
 * @returns {boolean}
 */
function keepHit(ctx, file, includeJobs) {
  const P = ctx.paths;
  if (excludedRoots(P).ledger.some((r) => paths.isUnder(file, r))) return false;
  if (!includeJobs && classifyHit(ctx, file).untrusted) return false;
  return true;
}

/**
 * The excluded trees, each in BOTH its configured and its realpath'd spelling.
 * P.jobsRoot/P.ledgerDir are built from the raw config.vault while rg prints hits under
 * the realpath'd root, so a Vault reached through a junction would otherwise make the JS
 * authority (SPEC §11) stop matching while only rg's advisory globs kept ledger content
 * out of a result. Cheap: two realpath calls per search, not per hit.
 * @param {Object} P @returns {{jobs:string[], ledger:string[]}}
 */
function excludedRoots(P) {
  const jobs = [P.jobsRoot];
  const ledgerDirs = [P.ledgerDir];
  const rj = paths.realpathSafe(P.jobsRoot);
  if (rj) jobs.push(rj);
  const rl = paths.realpathSafe(P.ledgerDir);
  if (rl) ledgerDirs.push(rl);
  return { jobs, ledger: ledgerDirs };
}

/* ---------------- rg stream decoding */

/** rg JSON carries either `text` or base64 `bytes`; both become a JS string. */
function decodeField(o) {
  if (!o || typeof o !== 'object') return '';
  if (typeof o.text === 'string') return o.text;
  if (typeof o.bytes === 'string') { try { return Buffer.from(o.bytes, 'base64').toString('utf8'); } catch { return ''; } }
  return '';
}

function stripEol(s) { return String(s).replace(/\r?\n$/, ''); }

/** Absolute, backslash-normalised path as rg printed it (it mixes separators). */
function normPath(p) { try { return path.resolve(String(p)); } catch { return String(p); } }

/**
 * Parse rg's `--json` stream (content mode) into matches with before/after context.
 * Events for one file always arrive contiguously between `begin` and `end`, so the
 * file is finalised on `end` — that is when the trailing context lines are known.
 * @param {Object} ctx @param {string} stdout @param {Object} o normalised args
 * @returns {{matches:Object[], total:number, unparseable:number}}
 */
function parseContentStream(ctx, stdout, o) {
  const matches = [];
  let total = 0;
  let unparseable = 0;
  let cur = null;   // {file, keep, lines:Map<number,string>, hits:number[]}

  const finish = () => {
    if (!cur) return;
    if (cur.keep) {
      const cls = classifyHit(ctx, cur.file);
      for (const n of cur.hits) {
        total += 1;
        if (matches.length >= o.max_results) continue;
        matches.push({
          file: cur.file,
          line: n,
          text: cur.lines.get(n) || '',
          before: contextRange(cur.lines, n - o.context, n - 1),
          after: contextRange(cur.lines, n + 1, n + o.context),
          untrusted: cls.untrusted === true,
          job: cls.job || null,
          leg: cls.leg || null,
        });
      }
    }
    cur = null;
  };

  for (const raw of String(stdout).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { unparseable += 1; continue; }
    const type = ev && ev.type;
    const d = (ev && ev.data) || {};
    if (type === 'begin') {
      finish();
      const file = normPath(decodeField(d.path));
      cur = { file, keep: keepHit(ctx, file, o.include_jobs), lines: new Map(), hits: [] };
    } else if (type === 'match' || type === 'context') {
      if (!cur) continue;
      const n = Number(d.line_number);
      if (!Number.isFinite(n)) continue;
      cur.lines.set(n, stripEol(decodeField(d.lines)));
      if (type === 'match') cur.hits.push(n);
    } else if (type === 'end') {
      finish();
    }
  }
  finish();
  return { matches, total, unparseable };
}

/** @returns {string[]} the texts of lines lo..hi that rg actually printed */
function contextRange(lines, lo, hi) {
  const out = [];
  for (let n = Math.max(1, lo); n <= hi; n += 1) {
    if (lines.has(n)) out.push(lines.get(n));
  }
  return out;
}

/**
 * `--files-with-matches` and `--count-matches` ignore `--json` (measured on rg
 * 15.2.0): they print plain lines — a path, or `path:count`. Windows paths carry
 * a drive colon, so the count is split off at the LAST colon.
 * @param {Object} ctx @param {string} stdout @param {Object} o
 * @returns {{matches:Object[], total:number, unparseable:number}}
 */
function parsePlainStream(ctx, stdout, o) {
  const matches = [];
  let total = 0;
  for (const raw of String(stdout).split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    let file = line;
    let count = null;
    if (o.mode === 'count') {
      const i = line.lastIndexOf(':');
      const tail = i === -1 ? '' : line.slice(i + 1);
      if (i > 1 && /^[0-9]+$/.test(tail)) { file = line.slice(0, i); count = Number(tail); }
    }
    file = normPath(file);
    if (!keepHit(ctx, file, o.include_jobs)) continue;
    total += 1;
    if (matches.length >= o.max_results) continue;
    const cls = classifyHit(ctx, file);
    matches.push({
      file,
      line: null,
      text: count == null ? '' : String(count),
      count,
      before: [],
      after: [],
      untrusted: cls.untrusted === true,
      job: cls.job || null,
      leg: cls.leg || null,
    });
  }
  return { matches, total, unparseable: 0 };
}

/* ---------------- spawn */

/**
 * Run rg with a 512 KB stdout cap and a wall-clock timeout enforced by a tree kill.
 * @returns {Promise<{exit:number|null, stdout:string, stderr:string,
 *                    timedOut:boolean, stdoutCapped:boolean, spawnError:string|null}>}
 */
function runRg(ctx, file, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    const out = [];
    const err = [];
    let outBytes = 0;
    let errBytes = 0;
    let stdoutCapped = false;
    let timedOut = false;
    let settled = false;
    let timer = null;

    const kill = () => {
      if (!child || !child.pid) return;
      Promise.resolve()
        .then(() => procwin.treeKill(ctx, child.pid))
        .catch(() => {})
        .then(() => { try { child.kill(); } catch { /* already gone */ } });
    };
    const done = (exit, spawnError) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ exit, stdout: out.join(''), stderr: err.join(''), timedOut, stdoutCapped, spawnError: spawnError || null });
    };

    try {
      child = cp.spawn(file, args, {
        cwd,
        env: envmod.childEnv({ backend: 'echo', depth: Number(ctx.depth) || 0, jobId: 'search', rootJobId: 'search' }),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      done(null, String((e && e.message) || e));
      return;
    }

    timer = setTimeout(() => { timedOut = true; kill(); done(null, null); }, timeoutMs);

    child.stdout.on('data', (buf) => {
      if (stdoutCapped) return;
      outBytes += buf.length;
      out.push(buf.toString('utf8'));
      if (outBytes >= STDOUT_CAP_BYTES) { stdoutCapped = true; kill(); }
    });
    child.stderr.on('data', (buf) => {
      if (errBytes >= STDERR_CAP_BYTES) return;
      errBytes += buf.length;
      err.push(buf.toString('utf8'));
    });
    child.on('error', (e) => done(null, String((e && e.message) || e)));
    child.on('close', (code) => done(typeof code === 'number' ? code : null, null));
  });
}

/**
 * The rg binary, plus plausible alternatives when it is missing. Read-only probes.
 * @param {Object} ctx @returns {string[]}
 */
function rgCandidates(ctx) {
  const seen = new Set();
  const found = [];
  const dirs = String(envmod.CHILD_PATH + path.delimiter + (process.env.PATH || '')).split(path.delimiter);
  const extra = ctx.config && ctx.config.binaries && ctx.config.binaries.codex_js;
  if (typeof extra === 'string' && extra.length) {
    // the codex package vendors the only rg on this machine (SPEC §0)
    dirs.push(procwin.rgVendorDir(extra));
  }
  for (const d of dirs) {
    const dir = String(d || '').trim();
    if (!dir) continue;
    const p = path.join(dir, procwin.expectedImage('rg'));
    const key = paths.normCase(p);
    if (seen.has(key)) continue;
    seen.add(key);
    if (jobstore.exists(p)) found.push(p);
  }
  return found;
}

/* ---------------- ledger row */

/** One `search` row per call (SPEC §10 events). A ledger fault never fails a call. */
function appendSearchRow(ctx, o, extra) {
  try {
    const row = ledger.baseRow(ctx, Object.assign({
      event: 'search',
      pattern_sha256: crypto.createHash('sha256').update(o.pattern, 'utf8').digest('hex'),
      pattern_preview: o.pattern.slice(0, 60),
      mode: o.mode,
      regex: o.regex,
      include_jobs: o.include_jobs,
      root: o.root || null,
    }, extra || {}));
    ledger.append(ctx, row);
  } catch (e) {
    try { ctx.log('search: ledger row failed: ' + ((e && e.message) || e)); } catch { /* stderr only */ }
  }
}

/* ---------------- the tool */

/**
 * council_search (SPEC §5.6, §11).
 * @param {Object} ctx @param {Object} args tool arguments
 * @returns {Promise<Object>} see INTERFACES.md §4.5
 */
async function run(ctx, args) {
  const started = Date.now();
  const norm = normalizeArgs(args);
  if (!norm.ok) {
    // A caller-side argument fault is NOT a ripgrep failure: reporting it as rg_failed
    // told the reader "the search tool is broken" for a bad pattern. Its own reason
    // reaches render.searchScreen, which asks the caller to fix the pattern.
    return { ok: false, reason: norm.reason || 'bad_pattern', rg_exit: null, detail: norm.detail, stderr_tail: null };
  }
  const o = norm.value;

  const root = resolveRoot(ctx, o.path, o.include_jobs);
  if (!root.ok) {
    appendSearchRow(ctx, o, { outcome: 'refused', refuse_reason: 'path_outside_vault', detail: root.detail, elapsed_ms: Date.now() - started });
    return { ok: false, reason: 'path_outside_vault', detail: root.detail };
  }
  o.root = root.path;

  const rgPath = (ctx.paths && ctx.paths.binaries && ctx.paths.binaries.rg) || null;
  if (!rgPath || !jobstore.exists(rgPath)) {
    const candidates = rgCandidates(ctx);
    appendSearchRow(ctx, o, { outcome: 'refused', refuse_reason: 'rg_missing', elapsed_ms: Date.now() - started });
    return { ok: false, reason: 'rg_missing', expected_path: rgPath, candidates };
  }

  const trusted = require('./guard').checkBinaryPath('rg',rgPath,ctx.config._machine,ctx.config);
  if(!trusted.ok) return {ok:false,reason:'rg_missing',expected_path:rgPath,candidates:[]};
  const argv = buildArgv(ctx, o);
  const timing = (ctx.config && ctx.config.timing) || {};
  const timeoutMs = (Number(timing.search_timeout_s) || SEARCH_TIMEOUT_S) * 1000;
  const cwd = pickCwd(ctx, o.root);

  const res = await runRg(ctx, rgPath, argv, cwd, timeoutMs);
  const elapsed_ms = Date.now() - started;
  const stderrTail = res.stderr ? res.stderr.slice(-STDERR_TAIL_CHARS) : null;

  if (res.spawnError) {
    appendSearchRow(ctx, o, { outcome: 'error', detail: res.spawnError, elapsed_ms });
    return { ok: false, reason: 'rg_failed', rg_exit: null, stderr_tail: res.spawnError };
  }
  if (res.timedOut) {
    appendSearchRow(ctx, o, { outcome: 'timeout', elapsed_ms });
    return {
      ok: false, reason: 'rg_failed', rg_exit: res.exit,
      stderr_tail: 'search timed out after ' + Math.round(timeoutMs / 1000) + ' s; rg was tree-killed' + (stderrTail ? ' | ' + stderrTail : ''),
    };
  }
  // rg exit 1 = "no matches", a normal empty result. 2 and above are real failures.
  if (res.exit !== 0 && res.exit !== 1 && !res.stdoutCapped) {
    appendSearchRow(ctx, o, { outcome: 'error', rg_exit: res.exit, elapsed_ms });
    return { ok: false, reason: 'rg_failed', rg_exit: res.exit, stderr_tail: stderrTail };
  }

  const parsed = o.mode === 'content'
    ? parseContentStream(ctx, res.stdout, o)
    : parsePlainStream(ctx, res.stdout, o);

  const truncated = parsed.total > parsed.matches.length || res.stdoutCapped;
  appendSearchRow(ctx, o, {
    outcome: 'done', rg_exit: res.exit, matches: parsed.total,
    returned: parsed.matches.length, truncated, elapsed_ms,
  });

  return {
    ok: true,
    matches: parsed.matches,
    total: parsed.total,
    truncated,
    elapsed_ms,
    rg_exit: res.exit,
    root: o.root,
    mode: o.mode,
    include_jobs: o.include_jobs,
    stdout_capped: res.stdoutCapped,
    unparseable: parsed.unparseable,
  };
}

/** An empty scratch cwd when it exists, otherwise the root's own directory. */
function pickCwd(ctx, root) {
  try {
    const sandbox = ctx.paths.sandboxFor('echo');
    if (jobstore.exists(sandbox)) return sandbox;
  } catch { /* fall through */ }
  try {
    return fs.statSync(root).isDirectory() ? root : path.dirname(root);
  } catch { return ctx.paths.vault; }
}

module.exports = {
  SEARCH_TIMEOUT_S, STDOUT_CAP_BYTES, MAX_COUNT_PER_FILE,
  normalizeArgs, resolveRoot, excludeGlobs, buildArgv,
  classifyHit, keepHit, parseContentStream, parsePlainStream,
  rgCandidates, run,
};
