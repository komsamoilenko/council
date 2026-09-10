// Owns paths.js runtime behavior; port specification §§2–6.
'use strict';
/**
 * lib/paths.js — config.json loading, %NAME% expansion, on-disk layout, containment.
 * Owns SPEC §12.1: the ONLY place a %NAME% token is ever expanded (LOCALAPPDATA,
 * APPDATA, USERPROFILE — nothing else), once, at boot, before any path is used.
 * Owns the SPEC §2 layout (computePaths) and the containment helpers used by
 * council_start.read_paths (§5) and council_search (§11).
 * Pure: no spawning, no stdout, no MCP. Failures are returned in errors[], not thrown.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const platform = require('../platform');
const COUNCIL_VERSION = require('../version').APP_VERSION;

/** The only environment names a config path may reference (SPEC §12.1). */
const EXPANDABLE = Object.keys(platform.tokens());

/** Keys inside config.json whose values are paths and therefore get expanded. */
const PATH_KEYS = ['vault', 'runtime_root', 'layout.work_dir', 'layout.jobs_dir', 'layout.ledger_dir', 'binaries.*'];

const PERCENT_RE = /%([A-Za-z_][A-Za-z0-9_()]*)%/g;

/**
 * Expand %LOCALAPPDATA% / %APPDATA% / %USERPROFILE% in one string.
 * @param {string} value
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ok:boolean, value:string, bad:string[]}} bad = disallowed or unset names
 */
function expandPercentNames(value, env) {
  const source = env || platform.tokens();
  const bad = [];
  const out = String(value).replace(PERCENT_RE, (whole, name) => {
    const upper = String(name).toUpperCase();
    if (!EXPANDABLE.includes(upper)) { bad.push(whole); return whole; }
    const v = source[upper] || source[name];
    if (!v) { bad.push(whole + ' (unset)'); return whole; }
    return v;
  });
  return { ok: bad.length === 0, value: out, bad };
}

/**
 * Strip a leading UTF-8 BOM (U+FEFF). Windows platform helper 5.1 `Set-Content -Encoding UTF8`
 * and Notepad's "UTF-8 with BOM" both write one, and JSON.parse rejects it — SPEC §16
 * has the user hand-editing config.json twice (prompt_form after T-16, ask_max_block_s
 * after T-20c), so one BOM would otherwise drop the whole server into doctor-only.
 * @param {string} text @returns {string}
 */
function stripBom(text) {
  const s = String(text == null ? '' : text);
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * COUNCIL_CONFIG is a TEST aid (T-03b boots against a mutated COPY), so it follows the
 * same rule as COUNCIL_TEST_MIN_TIMEOUT_S (SPEC §16 T-08): honoured only when
 * COUNCIL_HOST is unset or exactly "smoke". Under a real host it is ignored and the
 * reason is reported, so a host registration cannot repoint the server at another config.
 * @returns {{path:string|null, ignored:string|null}}
 */
/**
 * COUNCIL_LEDGER_PREFIX is a TEST aid: the smoke suite sets it to "smoke-" so its
 * hundreds of echo legs land in `ledger\smoke-spawns.jsonl` / `smoke-council-YYYY-MM.jsonl`
 * instead of the real files, where they would (a) eat the real hourly/daily caps and
 * (b) bury real spend rows. Same trust rule as COUNCIL_CONFIG: honoured only when
 * COUNCIL_HOST is unset or exactly "smoke"; under a real host it is ignored and the
 * reason is reported. The value is restricted to a short filename-safe token.
 * @returns {{prefix:string, ignored:string|null}}
 */
function testLedgerPrefix() {
  const raw = String(process.env.COUNCIL_LEDGER_PREFIX || '').trim();
  if (!raw) return { prefix: '', ignored: null };
  const host = String(process.env.COUNCIL_HOST || '').trim();
  // COUNCIL_SMOKE_RUN=1 is set by smoke.mjs for its whole process tree so the tests that
  // deliberately run a server under a real host value still write to the test files.
  // A host registration never sets it; council_doctor still reports the active prefix.
  const smokeRun = String(process.env.COUNCIL_SMOKE_RUN || '') === '1';
  if (host && host !== 'smoke' && !smokeRun) {
    return { prefix: '', ignored: 'COUNCIL_LEDGER_PREFIX ignored under COUNCIL_HOST=' + host + ' (test-only env)' };
  }
  if (!/^[a-z0-9_-]{1,20}$/i.test(raw)) {
    return { prefix: '', ignored: 'COUNCIL_LEDGER_PREFIX ignored: must match [a-z0-9_-]{1,20}' };
  }
  return { prefix: raw, ignored: null };
}

function envConfigPath() {
  const raw = process.env.COUNCIL_CONFIG;
  if (!raw) return { path: null, ignored: null };
  const host = String(process.env.COUNCIL_HOST || '').trim();
  if (host && host !== 'smoke') {
    return { path: null, ignored: 'COUNCIL_CONFIG ignored under COUNCIL_HOST=' + host + ' (test-only env)' };
  }
  return { path: raw, ignored: null };
}

/**
 * Read and expand config.json.
 * Path resolution order: explicit argument, then $COUNCIL_CONFIG (test-only, see
 * envConfigPath), then the installed external machine/profile configuration.
 * @param {string} [configPath]
 * @returns {{ok:boolean, path:string, raw:Object|null, config:Object|null,
 *            expanded:Record<string,string>, env_ignored:string|null,
 *            errors:Array<{key:string,value:*,reason:string}>}}
 */
function loadConfig(configPath) { return require('./profile').resolve(configPath); }

/**
 * The whole SPEC §2 on-disk layout, derived from an already-expanded config.
 * @param {Object} config expanded config object from loadConfig().config
 * @returns {Object} paths bag (see INTERFACES.md "Paths bag")
 */
function computePaths(config) {
  const councilDir = path.join(__dirname, '..');
  const vault = String(config.vault || '');
  const runtimeRoot = String(config.runtime_root || '');
  const layout = config.layout || {};
  const workDir = path.resolve(vault, layout.work_dir || 'work');
  const jobsRoot = path.resolve(vault, layout.jobs_dir || 'work/jobs');
  const ledgerDir = path.resolve(vault, layout.ledger_dir || 'ledger');
  const controlDir = path.join(runtimeRoot, 'control');
  const lp = testLedgerPrefix();
  const pfx = lp.prefix;
  return {
    workDir,
    profile: config.profile || 'default',
    ledgerPrefix: pfx,
    ledgerPrefixIgnored: lp.ignored,
    councilDir,
    libDir: __dirname,
    backendsDir: path.join(councilDir, 'backends'),
    etcDir: path.join(councilDir, 'etc'),
    emptyMcp: path.join(councilDir, 'etc', 'empty-mcp.json'),
    accountsPath: path.join(config._profileDir || path.join(platform.appDirs().etc, 'profiles', config.profile || 'default'), 'accounts.json'),
    serverJs: path.join(councilDir, 'server.js'),
    runnerJs: path.join(councilDir, 'runner.js'),

    vault,
    vaultReal: realpathSafe(vault) || vault,
    jobsRoot,
    ledgerDir,
    ledgerErrors: path.join(ledgerDir, pfx + 'ledger-errors.log'),
    spawnsPath: path.join(controlDir, pfx + 'spawns.jsonl'),
    /** @param {Date} d @returns {string} absolute path of [prefix]council-YYYY-MM.jsonl */
    ledgerFileFor(d) {
      const dt = d || new Date();
      const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
      return path.join(ledgerDir, `${pfx}council-${dt.getUTCFullYear()}-${m}.jsonl`);
    },

    reaperLock: path.join(controlDir, '.reaper.lock'),
    rateLock: path.join(controlDir, '.rate.lock'),
    idemDir: path.join(controlDir, 'idem'),

    controlDir,
    sessionsDir: path.join(controlDir, 'sessions'),
    cancelFor(jobId) { if (!require('./jobstore').isJobId(jobId)) throw new Error('invalid_job_id'); return path.join(controlDir, jobId + '.cancel.json'); },
    readsFor(jobId) { if (!require('./jobstore').isJobId(jobId)) throw new Error('invalid_job_id'); return path.join(runtimeRoot, 'reads', jobId); },
    runtimeRoot,
    sandboxRoot: path.join(runtimeRoot, 'sandbox'),
    /** @param {string} backend @returns {string} */
    sandboxFor(backend) { return path.join(runtimeRoot, 'sandbox', String(backend)); },
    stopVault: path.join(vault, 'STOP'),
    stopLocal: path.join(runtimeRoot, 'STOP'),
    stopGlobal: path.join(platform.appDirs().root, 'STOP'),
    agyGate: path.join(runtimeRoot, 'agy-enabled'),

    binaries: Object.assign({}, config.binaries),
  };
}

/**
 * Create every directory the server needs. Never deletes anything.
 * @param {Object} P paths bag
 * @returns {{created:string[], errors:Array<{path:string,reason:string}>}}
 */
function ensureRuntimeDirs(P) {
  const created = [];
  const errors = [];
  const wanted = [
    P.jobsRoot, P.controlDir, P.sessionsDir, path.join(P.runtimeRoot, 'reads'), P.idemDir, P.ledgerDir, P.runtimeRoot, P.sandboxRoot,
    P.sandboxFor('claude'), P.sandboxFor('codex'), P.sandboxFor('gemini'), P.sandboxFor('echo'),
  ];
  for (const d of wanted) {
    try {
      if (!fs.existsSync(d)) { fs.mkdirSync(d, { recursive: true }); created.push(d); }
    } catch (e) {
      errors.push({ path: d, reason: String(e && e.message || e) });
    }
  }
  return { created, errors };
}

/** @param {string} p @returns {string|null} native realpath, or null when absent/unreadable */
function realpathSafe(p) {
  try { return fs.realpathSync.native(p); } catch { return null; }
}

/** Windows-style case-insensitive path normalisation (no trailing separator). */
function normCase(p) {
  let s = path.resolve(String(p));
  while (s.length > 3 && (s.endsWith('\\') || s.endsWith('/'))) s = s.slice(0, -1);
  return platform.caseFold(s);
}

/**
 * True when child is parent itself or lives under it (case-insensitive).
 * @param {string} child @param {string} parent @returns {boolean}
 */
function isUnder(child, parent) {
  const c = normCase(child);
  const p = normCase(parent);
  return c === p || c.startsWith(p.endsWith(path.sep.toLowerCase()) ? p : p + path.sep);
}

/**
 * Resolve a caller-supplied path for read_paths / council_search.
 * Must exist, realpath inside the Vault, and stay out of work\jobs, ledger and bin\council.
 *
 * Refusing only paths UNDER those three trees is not enough for read_paths (SPEC §5):
 * `--add-dir <Vault>` hands the claude/gemini leaf every excluded tree at once, because
 * an ancestor CONTAINS them. So an ancestor of any excluded tree is refused too, unless
 * the caller post-filters the hits itself (council_search does, via keepHit — §11 calls
 * that JS containment "the authority" — so it passes allowAncestors).
 * @param {string} input
 * @param {Object} P paths bag
 * @param {{allowJobs?:boolean, allowAncestors?:boolean}} [opts]
 * @returns {{ok:boolean, path?:string, reason?:string, detail?:string}}
 */
function resolveVaultPath(input, P, opts) {
  const o = opts || {};
  const s = String(input == null ? '' : input);
  if (!s) return { ok: false, reason: 'path_outside_vault', detail: 'empty path' };
  if (s.indexOf('\0') !== -1) return { ok: false, reason: 'path_outside_vault', detail: 'NUL in path' };
  const abs = platform.isAbsoluteNative(s) ? path.resolve(s) : path.resolve(P.vault, s);
  const real = realpathSafe(abs);
  if (!real) return { ok: false, reason: 'path_outside_vault', detail: 'does not exist: ' + abs };
  try {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink() || normCase(abs) !== normCase(real)) return { ok: false, reason: 'path_outside_vault', detail: 'junction_or_symlink' };
    if (st.isFile() && st.nlink > 1) return { ok: false, reason: 'path_outside_vault', detail: 'hard_link' };
  } catch { return { ok: false, reason: 'path_outside_vault', detail: 'unreadable' }; }
  if (!o.allowAncestors && isUnder(P.vaultReal || P.vault, real)) return { ok: false, reason: 'vault_root_not_grantable', detail: 'Name a narrower directory or file.' };
  if (!isUnder(real, P.vaultReal) && !isUnder(real, P.vault)) {
    return { ok: false, reason: 'path_outside_vault', detail: 'resolves outside the Vault: ' + real };
  }
  if (!o.allowJobs && isUnder(real, P.jobsRoot)) return { ok: false, reason: 'path_outside_vault', detail: 'work\\jobs is not readable through this tool' };
  if (isUnder(real, P.ledgerDir)) return { ok: false, reason: 'path_outside_vault', detail: 'ledger is not readable through this tool' };
  if (isUnder(real, path.join(P.vault, 'bin', 'council')) || isUnder(real, P.councilDir)) return { ok: false, reason: 'path_outside_vault', detail: 'bin\\council is not readable through this tool' };
  if (!o.allowAncestors) {
    const contains = [];
    if (!o.allowJobs && isUnder(P.jobsRoot, real)) contains.push('work\\jobs');
    if (isUnder(P.ledgerDir, real)) contains.push('ledger');
    if (isUnder(path.join(P.vault, 'bin', 'council'), real) || isUnder(P.councilDir, real)) contains.push('bin\\council');
    if (contains.length) {
      return {
        ok: false, reason: 'path_outside_vault',
        detail: real + ' contains ' + contains.join(' / ') + '; name a narrower directory or file',
      };
    }
  }
  return { ok: true, path: real };
}

/** Best-effort home directory, used for CODEX_HOME and the codex rollout scan. */
function homeDir() {
  return platform.homeDir();
}

module.exports = {
  COUNCIL_VERSION,
  EXPANDABLE,
  PATH_KEYS,
  expandPercentNames,
  stripBom,
  envConfigPath,
  testLedgerPrefix,
  loadConfig,
  computePaths,
  ensureRuntimeDirs,
  realpathSafe,
  normCase,
  isUnder,
  resolveVaultPath,
  homeDir,
};
