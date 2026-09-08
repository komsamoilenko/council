// Owns env.js runtime behavior; port specification §§2–6.
'use strict';
/**
 * lib/env.js — the child-environment allowlist (SPEC §6.0).
 * A leaf process gets ONLY the variables listed in ALLOW, a fixed PATH, and the
 * council-added variables below. Everything else — CLAUDECODE, CLAUDE_CODE_*,
 * ANTHROPIC_*, OPENAI_*, GOOGLE_*, GEMINI_*, OTEL_*, NODE_OPTIONS,
 * RIPGREP_CONFIG_PATH, MCP_* — is never forwarded.
 * Pure: builds objects, spawns nothing.
 */

const paths = require('./paths.js');

/** SPEC §6.0 verbatim. */
const platform = require('../platform');
const path = require('path');
const ALLOW = platform.childEnvAllow();
const CHILD_PATH = platform.childPath(path.dirname(process.execPath));
const PROXY_NAMES = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS'];

/** Documented for council_doctor / README: never forwarded, whatever the parent holds. */
const DENIED_PREFIXES = ['ANTHROPIC_', 'OPENAI_', 'GOOGLE_', 'GEMINI_', 'OTEL_', 'MCP_', 'CLAUDE_'];
const DENIED_EXACT = ['COUNCIL_GEMINI_API_KEY', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'NODE_OPTIONS', 'RIPGREP_CONFIG_PATH'];

/**
 * Build the environment for one leaf process.
 * @param {Object} o
 * @param {string} o.backend        'claude' | 'codex' | 'gemini' | 'echo'
 * @param {number} o.depth          the SERVER's COUNCIL_DEPTH (children get depth+1)
 * @param {string} o.jobId
 * @param {string} o.rootJobId
 * @param {Record<string,string>} [o.extra]  extra council-owned, non-secret variables
 * @returns {Record<string,string>} a complete env for child_process.spawn
 */
function childEnv(o) {
  const out = {};
  for (const k of ALLOW) {
    const v = process.env[k];
    if (typeof v === 'string' && v.length) out[k] = v;
  }
  out.PATH = platform.childPath(path.dirname((o.binaries || {}).node || process.execPath));
  out.COUNCIL_DEPTH = String((Number(o.depth) || 0) + 1);
  out.COUNCIL_JOB_ID = String(o.jobId || '');
  out.COUNCIL_ROOT_JOB = String(o.rootJobId || o.jobId || '');
  out.COUNCIL_HOST = 'child';

  if (o.backend === 'claude') {
    out.DISABLE_AUTOUPDATER = '1';
    out['CLAUDE_CODE_DISABLE_' + 'NONESSENTIAL_TRAFFIC'] = '1';
  }
  if (o.backend === 'codex') {
    out.CODEX_HOME = codexHome();
  }
  if (o.extra && typeof o.extra === 'object') {
    for (const k of Object.keys(o.extra)) {
      if (o.extra[k] == null) continue;
      if (!extraAllowed(k, o)) { warnOnce(k); continue; }
      out[k] = String(o.extra[k]);
    }
  }
  return out;
}

/**
 * `extra` comes from spawn.json (runner.js) and from an adapter's envExtra, i.e. from a
 * file inside the Vault. The DENIED lists above were documentation only until this
 * check: nothing may re-open the CLAUDE_, ANTHROPIC_ or NODE_OPTIONS door through it, and
 * PATH stays the fixed CHILD_PATH. What remains is the council's own namespace plus the
 * three variables SPEC §6.0 names by hand.
 * @param {string} key @returns {boolean}
 */
function extraAllowed(key, o = {}) {
  const k = String(key);
  if (/KEY|SECRET|TOKEN|PASS/i.test(k)) return false;
  if (PROXY_NAMES.includes(k)) return o.backend === 'gemini' && o.provider === 'api';
  if (k === 'PATH' || k === 'Path' || k === 'path') return false;
  if (DENIED_EXACT.includes(k)) return false;
  // The three §6.0 variables the council sets itself stay legal even though one of them
  // starts with a denied prefix.
  if (['DISABLE_AUTOUPDATER', 'CLAUDE_CODE_DISABLE_' + 'NONESSENTIAL_TRAFFIC', 'CODEX_HOME'].includes(k)) return true;
  const upper = k.toUpperCase();
  if (DENIED_PREFIXES.some((p) => upper.startsWith(p))) return false;
  return /^COUNCIL_[A-Z0-9_]+$/.test(k);
}

const WARNED = new Set();
function warnOnce(key) {
  if (WARNED.has(key)) return;
  WARNED.add(key);
  try { process.stderr.write('[council] child env: refused to forward "' + key + '" (denied by lib/env.js)\n'); } catch { /* stderr only */ }
}

/** `%USERPROFILE%\.codex` — auth still resolves there; the server never opens it. */
function codexHome() {
  return require('path').join(paths.homeDir(), '.codex');
}

/**
 * The council-added keys of an env, for spawn.json / the ledger row's env_added.
 * @param {Record<string,string>} env
 * @returns {string[]}
 */
function addedKeys(env) {
  const known = new Set(ALLOW.concat(['PATH']));
  return Object.keys(env || {}).filter((k) => !known.has(k)).sort();
}

module.exports = { ALLOW, CHILD_PATH, DENIED_PREFIXES, DENIED_EXACT, childEnv, codexHome, addedKeys, extraAllowed };

// Values originate in the server/runner environment, never the mutable job document.
function proxyEnvFor(ctx) {
  const out={},ignored=[]; const fs=require('fs');
  const m=ctx.config._machine || {};
  const zones=[ctx.config.vault,ctx.config.runtime_root,...(m.profileVaults || []),...(m.profileRuntimeRoots || [])].filter(Boolean);
  for(const key of PROXY_NAMES) {
    const v=process.env[key]; if(v===undefined) continue;
    let ok=typeof v==='string' && v.length>0 && v.length<=2048;
    if(ok && key==='NODE_EXTRA_CA_CERTS') { try {const real=fs.realpathSync(v); ok=platform.isAbsoluteNative(v) && fs.statSync(real).isFile() && !zones.some(z=>paths.isUnder(v,z) || paths.isUnder(real,require('./guard').canonical(z)));fs.accessSync(real,fs.constants.R_OK);} catch {ok=false;} }
    else if(ok) { try {const u=new URL(v);ok=['http:','https:'].includes(u.protocol);} catch {ok=false;} }
    if(ok) out[key]=v; else ignored.push('proxy_env_ignored:'+key);
  }
  return {env:out,ignored};
}
module.exports.proxyEnvFor=proxyEnvFor;
