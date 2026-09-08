// Owns guard.js runtime behavior; port specification §§2–6.
'use strict';
/**
 * lib/guard.js — the trust boundary around config.json (SPEC §12.2, §6 "Forbidden flags").
 * Minimum forbidden flags are fixed in code; executable roots are derived from
 * trusted machine locations. Configuration lives outside the vault and can only
 * narrow the executable policy.
 * Effective forbidden set = MIN_FORBIDDEN_FLAGS ∪ config.forbidden_flags (union).
 * Any binaries.* failure puts the server in doctor-only mode (SPEC §5, §8 fuse 0).
 */

const fs = require('fs');
const path = require('path');
const paths = require('./paths.js');

const MIN_FORBIDDEN_FLAGS = [
  '--bare',
  '--dangerously-skip-permissions',
  '--allow-dangerously-' + 'skip-permissions',
  '--dangerously-bypass-' + 'approvals-and-sandbox',
  '--dangerously-bypass-hook-trust',
  '--approve-for-me',
  '--bg',
  // Verified from `codex exec --help` / `claude --help` on 2026-09-07: every one of these
  // either widens the sandbox, re-enables user config, drops the rollout the quota
  // snapshot depends on, or picks a session the caller never named. No shipped adapter
  // emits any of them, so the list can only ever catch a rewritten adapter or config.
  '--full-auto',
  '--yolo',
  '--ephemeral',
  '--last',
  '--enable',
  '--disable',
  '--profile',
  '--settings',
  '--plugin-dir',
  '--plugin-url',
  '--agent',
  '--allowedtools',
];

/** Adjacent-token pairs; the attached form `--sandbox=danger-full-access` matches too. */
const MIN_FORBIDDEN_PAIRS = [['--sandbox', 'danger-full-access']];

/**
 * `-c KEY=VALUE` / `--config KEY=VALUE` overrides that widen what a leaf may do.
 * Matched against the VALUE token of a `-c`/`--config` pair, case-insensitively, as a
 * prefix (so `sandbox_permissions=[...]` matches `sandbox_permissions=`). The shipped
 * codex adapter emits only model_reasoning_effort=, sandbox_mode="read-only",
 * windows.sandbox="elevated" and mcp_servers={} — none of which is on this list.
 */
const MIN_FORBIDDEN_CONFIG = [
  'sandbox_mode="danger-full-access"',
  'sandbox_mode=danger-full-access',
  'sandbox_permissions=',
  'notify=',
  'shell_environment_policy',
  'mcp_servers.',
  'approval_policy="never"',
  'approval_policy=never',
];

/** Tokens that introduce a config override; the NEXT token is the value to scan. */
const CONFIG_FLAGS = ['-c', '--config'];

const roots = require("./roots.js");
const platform = require("../platform");

class GuardError extends Error {
  /**
   * @param {string} code 'forbidden_flag' | 'forbidden_pair'
   * @param {string} message
   * @param {Object} [data]
   */
  constructor(code, message, data) {
    super(message);
    this.name = 'GuardError';
    this.code = code;
    this.data = data || {};
  }
}

/**
 * @param {Object} config expanded config
 * @returns {string[]} MIN_FORBIDDEN_FLAGS ∪ config.forbidden_flags, lowercased, unique
 */
function effectiveForbiddenFlags(config) {
  const extra = Array.isArray(config && config.forbidden_flags) ? config.forbidden_flags : [];
  const all = MIN_FORBIDDEN_FLAGS.concat(extra.filter((x) => typeof x === 'string'));
  return Array.from(new Set(all.map((f) => f.toLowerCase())));
}

/**
 * Scan an argv for forbidden flags and pairs. Never scans prompt bytes: it is run on the
 * argv exactly as buildSpawn() returned it, i.e. with the `<prompt.md>` placeholder still
 * in place, so a prompt that merely mentions a flag cannot trip it.
 * @param {string[]} argv
 * @param {Object} config
 * @returns {{ok:boolean, violations:Array<{kind:string, arg:string, index:number}>}}
 */
function checkArgv(argv, config) {
  const forbidden = effectiveForbiddenFlags(config);
  const violations = [];
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const arg = String(list[i]);
    const lower = arg.toLowerCase();
    const head = lower.indexOf('=') === -1 ? lower : lower.slice(0, lower.indexOf('='));
    for (const f of forbidden) {
      if (lower === f || head === f) violations.push({ kind: 'forbidden_flag', arg, index: i });
    }
    for (const [a, b] of MIN_FORBIDDEN_PAIRS) {
      if (lower === a.toLowerCase() && i + 1 < list.length && String(list[i + 1]).toLowerCase() === b.toLowerCase()) {
        violations.push({ kind: 'forbidden_pair', arg: a + ' ' + b, index: i });
      }
      if (lower === (a + '=' + b).toLowerCase()) violations.push({ kind: 'forbidden_pair', arg, index: i });
    }
    // clap accepts `-cKEY=VALUE` as ONE token, which is how a value smuggled into a
    // positional (a vendor session id, say) turns into a config override. No adapter
    // ever emits the attached form, so the whole shape is refused.
    if (/^-c.+/.test(lower)) violations.push({ kind: 'forbidden_config', arg, index: i });
    // `-c KEY=VALUE` split form: scan the value token.
    if (CONFIG_FLAGS.includes(lower) && i + 1 < list.length) {
      const val = String(list[i + 1]).toLowerCase().replace(/\s+/g, '');
      for (const bad of MIN_FORBIDDEN_CONFIG) {
        if (val.startsWith(bad)) violations.push({ kind: 'forbidden_config', arg: arg + ' ' + list[i + 1], index: i });
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Same as checkArgv but throws. Called by every adapter at the end of buildSpawn()
 * and again by runner.js immediately before spawn.
 * @param {string[]} argv @param {Object} config
 * @throws {GuardError}
 */
function assertArgvSafe(argv, config) {
  const r = checkArgv(argv, config);
  if (!r.ok) {
    const first = r.violations[0];
    throw new GuardError(first.kind, `forbidden argv token at index ${first.index}: ${first.arg}`, { violations: r.violations });
  }
  return true;
}

/**
 * Validate one binaries.* value: absolute, no traversal, under an ALLOWED_ROOT
 * (before and after realpath, so a junction cannot escape), and present on disk.
 * @param {string} key @param {string} value
 * @returns {{ok:boolean, key:string, value:string, reason?:string, real?:string}}
 */
function canonical(p) {
  let current=path.resolve(p), suffix=[];
  for (;;) { const real=paths.realpathSafe(current); if(real) return path.join(real,...suffix); const parent=path.dirname(current); if(parent===current) return path.resolve(p); suffix.unshift(path.basename(current)); current=parent; }
}
function checkBinaryPath(key, value, machine={}, config={}) {
  const fail=reason=>({ok:false,key,value,reason});
  if(typeof value!=='string' || !value) return fail('not_a_string');
  if(!platform.isAbsoluteNative(value)) return fail('not_absolute_native_path');
  if(value.split(/[\\/]/).includes('..')) return fail('traversal');
  const resolved=path.resolve(value), real=paths.realpathSafe(resolved);
  const zones=[config.vault,config.runtime_root,...(machine.profileVaults || []),...(machine.profileRuntimeRoots || [])].filter(Boolean);
  if(zones.some(z=>paths.isUnder(resolved,z) || paths.isUnder(real || resolved,canonical(z)))) return fail('writable_zone');
  const allowed=roots.allowedRoots(machine);
  if(!allowed.some(r=>paths.isUnder(resolved,r))) return fail('outside_allowed_roots');
  if(!real) return fail('missing_on_disk');
  if(!allowed.some(r=>paths.isUnder(real,r))) return fail('junction_escapes_allowed_roots');
  try { if(!fs.statSync(real).isFile()) return fail('not_a_file'); } catch { return fail('unresolvable'); }
  return {ok:true,key,value,real};
}
function checkConfigTrust(loaded) {
  const failures=(loaded.errors || []).map(e=>({key:e.key,reason:e.reason}));
  const cfg=loaded.config || {}, machine=loaded.machine || cfg._machine || {}, bins=cfg.binaries || {};
  const fail=(key,reason)=>failures.push({key,reason});
  let binariesOk=Object.keys(bins).length>0;
  if(!binariesOk) fail('binaries','empty');
  for(const [k,v] of Object.entries(bins)) { const r=checkBinaryPath('binaries.'+k,v,machine,cfg); if(!r.ok) {binariesOk=false;fail(r.key,r.reason);} }
  for(const key of ['vault','runtime_root']) if(!platform.isAbsoluteNative(cfg[key])) fail(key,'not_absolute_native_path');
  if(cfg.vault && cfg.runtime_root) {
    const vault=canonical(cfg.vault),run=canonical(cfg.runtime_root),dirs=platform.appDirs();
    if(paths.isUnder(run,vault)) fail('runtime_root','inside_vault');
    if(!paths.isUnder(run,canonical(dirs.stateAnchor)) || !paths.isUnder(cfg.runtime_root,dirs.stateAnchor)) fail('runtime_root','outside_state_anchor');
    const forbidden=[platform.homeDir(),...Object.entries(platform.tokens()).filter(([k])=>['APPDATA','LOCALAPPDATA','HOME'].includes(k)).map(([,v])=>v)].filter(Boolean);
    if(paths.isUnder(canonical(dirs.root),vault) || path.parse(vault).root===vault || forbidden.some(p=>paths.normCase(canonical(p))===paths.normCase(vault))) fail('vault','vault_contains_app_data');
    if(loaded.path && (paths.isUnder(loaded.path,cfg.vault) || paths.isUnder(canonical(loaded.path),vault))) fail('config','config_inside_vault');
    for(const [k,def] of Object.entries({work_dir:'work',jobs_dir:'work/jobs',ledger_dir:'ledger'})) {
      const literal=path.resolve(cfg.vault,(cfg.layout || {})[k] || def),p=canonical(literal),app=path.resolve(__dirname,'..');
      if((!paths.isUnder(literal,cfg.vault) && !paths.isUnder(literal,cfg.runtime_root)) || (!paths.isUnder(p,vault) && !paths.isUnder(p,run)) || paths.isUnder(p,canonical(app)) || paths.isUnder(canonical(app),p)) fail('layout.'+k,'layout_outside_known_roots');
    }
    for(const other of machine.profileVaults || []) if(paths.isUnder(run,canonical(other))) fail('runtime_root','inside_vault');
    for(const root of [...(machine.profileRuntimeRoots || []),dirs.etc,path.join(dirs.root,'app')]) if(root && paths.isUnder(vault,canonical(root))) fail('vault','vault_contains_app_data');
  }
  return {ok:!failures.length,binaries_ok:binariesOk,forbidden_flags_source:'min+config',failures,allowed_roots:roots.allowedRoots(machine),min_forbidden_flags:MIN_FORBIDDEN_FLAGS.slice(),effective_forbidden_flags:effectiveForbiddenFlags(cfg)};
}

module.exports = {
  MIN_FORBIDDEN_FLAGS,
  MIN_FORBIDDEN_PAIRS,
  MIN_FORBIDDEN_CONFIG,
  CONFIG_FLAGS,
  allowedRoots: roots.allowedRoots,
  canonical,
  GuardError,
  effectiveForbiddenFlags,
  checkArgv,
  assertArgvSafe,
  checkBinaryPath,
  checkConfigTrust,
};
