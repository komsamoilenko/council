// Owns win32.js runtime behavior; port specification §§2–6.
'use strict';
/**
 * lib/procwin.js — Windows process identity and tree kill (SPEC §9).
 * Owns: PID inspection via `Get-CimInstance Win32_Process`, the runner/leaf
 * identity checks that gate EVERY kill, `taskkill /PID <pid> /T /F`, and the
 * `tasklist` death verification behind it. Identity checks run on kill paths and
 * the lost derivation only — never on a poll.
 * It spawns nothing but the three System32 binaries named in config.json
 * (powershell, taskkill, tasklist), always by absolute path. It deletes nothing.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { APP_VERSION } = require('../version');

/** Wall-clock bounds for the helper processes; none of them ever waits on a model. */
const PS_TIMEOUT_MS = 10000;
const TASKLIST_TIMEOUT_MS = 8000;
const TASKKILL_TIMEOUT_MS = 15000;
/** SPEC §9 step 4 says "wait 1 s, verify via tasklist"; we poll so a fast kill returns fast. */
const DEATH_WAIT_MS = 1000;
const DEATH_POLL_MS = 150;
/**
 * A leaf is genuine only if it was created at or after the job. Same machine, same
 * clock, so the tolerance only absorbs CreationDate rounding — never a whole second
 * of drift that could let an older, unrelated process pass the check.
 */
const CREATION_SKEW_MS = 1000;

/* ---------------- helpers */

/**
 * Environment for the three helper binaries: the SPEC §6.0 allowlist and the fixed
 * PATH, without the COUNCIL_* variables (these are tools, not consultation leaves).
 * @returns {Record<string,string>}
 */
function toolEnv() {
  const out = {};
  for (const k of childEnvAllow()) {
    const v = process.env[k];
    if (typeof v === 'string' && v.length) out[k] = v;
  }
  out.PATH = childPath(path.dirname(process.execPath));
  return out;
}

/**
 * Coerce anything to a usable Windows PID, or null.
 * @param {*} pid @returns {number|null}
 */
function toPid(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (i <= 0 || i > 0xffffffff) return null;
  return i;
}

/**
 * NOT unref'd on purpose: an unref'd timer lets the process exit in the middle of a
 * kill when nothing else holds the event loop (observed 2026-09-07 in a self-test —
 * the caller vanished between taskkill and the tasklist verification).
 * @param {number} ms @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Run one helper binary. Never throws, never rejects.
 * @param {string} file absolute path @param {string[]} args @param {number} timeoutMs
 * @returns {Promise<{ok:boolean, exit:number|null, stdout:string, stderr:string, error:string|null}>}
 */
function run(file, args, timeoutMs) {
  return new Promise((resolve) => {
    if (!file) { resolve({ ok: false, exit: null, stdout: '', stderr: 'binary path missing', error: 'binary path missing' }); return; }
    const opts = { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024, env: toolEnv() };
    try {
      execFile(file, args, opts, (err, stdout, stderr) => {
        const exit = err ? (typeof err.code === 'number' ? err.code : null) : 0;
        resolve({
          ok: exit === 0,
          exit,
          stdout: String(stdout == null ? '' : stdout),
          stderr: String(stderr == null ? '' : stderr),
          error: err ? String(err.message) : null,
        });
      });
    } catch (e) {
      resolve({ ok: false, exit: null, stdout: '', stderr: String(e.message), error: String(e.message) });
    }
  });
}

/**
 * `ConvertTo-Json` on Windows PowerShell 5.1 renders a DateTime as "/Date(<epoch ms>)/"
 * (verified live on this machine, 2026-09-07). ISO strings are accepted as a fallback.
 * @param {*} value @returns {number|null}
 */
function creationMs(value) {
  if (value == null) return null;
  const s = String(value);
  const m = s.match(/\/Date\((-?\d+)/);
  if (m) { const n = Number(m[1]); return Number.isFinite(n) ? n : null; }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/**
 * True when a `tasklist /FO CSV /NH` body actually lists that PID.
 * "INFO: No tasks are running..." does not start with a quote, so it never matches.
 * @param {string} stdout @param {number} pid @returns {boolean}
 */
function tasklistHasPid(stdout, pid) {
  const want = String(pid);
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = line.match(/^"[^"]*","(\d+)"/);
    if (m && m[1] === want) return true;
  }
  return false;
}

/* ---------------- public */

/**
 * Probe one PID (SPEC §9 identity command, verbatim, plus a UTF-8 output pin).
 *
 * The result is DISCRIMINATED on purpose. "The probe ran and the process is gone" and
 * "the probe could not run" are different facts, and collapsing both into null told
 * every caller `not-running`, i.e. PROOF OF DEATH, when powershell.exe was missing, the
 * 10 s budget elapsed, PowerShell exited non-zero, or the JSON did not parse. On a
 * loaded machine those failures correlate with a stale heartbeat, so the old code could
 * finalise a job `lost`, report the legs verified_dead, kill nothing, and leave live
 * leaves burning quota.
 *
 * `[Console]::OutputEncoding` is pinned because a redirected PowerShell stdout is
 * written in the OEM code page, which turns every non-ASCII CommandLine character into
 * "?" (measured 2026-09-07). The runner identity substrings must therefore stay ASCII.
 * @param {Object} ctx @param {*} pid
 * @returns {Promise<{state:'found'|'gone'|'unknown', info:Object|null, error:string|null}>}
 */
async function probe(ctx, pid) {
  const n = toPid(pid);
  if (n === null) return { state: 'unknown', info: null, error: 'invalid pid' };
  const ps = ctx && ctx.paths && ctx.paths.binaries ? ctx.paths.binaries.powershell : null;
  if (!ps) return { state: 'unknown', info: null, error: 'powershell path missing' };
  const command =
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' +
    "Get-CimInstance Win32_Process -Filter 'ProcessId=" + n + "' | " +
    'Select ProcessId,Name,ParentProcessId,CreationDate,CommandLine | ConvertTo-Json';
  const r = await run(ps, ['-NoProfile', '-NonInteractive', '-Command', command], PS_TIMEOUT_MS);
  if (r.exit !== 0) return { state: 'unknown', info: null, error: 'powershell exit ' + r.exit + ': ' + (r.error || r.stderr || '').slice(0, 200) };
  const text = String(r.stdout || '').trim();
  if (!text) return { state: 'gone', info: null, error: null };   // ran, exit 0, no such process
  let obj = null;
  try { obj = JSON.parse(text); } catch (e) { return { state: 'unknown', info: null, error: 'unparsable CIM json: ' + String(e.message).slice(0, 120) }; }
  if (Array.isArray(obj)) obj = obj.length ? obj[0] : null;
  if (!obj || obj.ProcessId == null) return { state: 'gone', info: null, error: null };
  return {
    state: 'found',
    error: null,
    info: {
      ProcessId: Number(obj.ProcessId),
      Name: obj.Name == null ? null : String(obj.Name),
      ParentProcessId: obj.ParentProcessId == null ? null : Number(obj.ParentProcessId),
      CreationDate: obj.CreationDate == null ? null : String(obj.CreationDate),
      CommandLine: obj.CommandLine == null ? null : String(obj.CommandLine),
      creation_ms: creationMs(obj.CreationDate),
    },
  };
}

/**
 * Backwards-compatible wrapper: the process record, or null when it is gone OR the
 * probe could not run. Only use it where the difference does not matter; every kill
 * path goes through probe()/verifyRunner()/verifyLeaf() instead.
 * @param {Object} ctx @param {*} pid @returns {Promise<Object|null>}
 */
async function inspect(ctx, pid) {
  const r = await probe(ctx, pid);
  return r.state === 'found' ? r.info : null;
}

/**
 * Liveness with the three honest answers: 'alive' | 'gone' | 'unknown'.
 * @param {Object} ctx @param {*} pid @returns {Promise<'alive'|'gone'|'unknown'>}
 */
async function livenessOf(ctx, pid) {
  const n = toPid(pid);
  if (n === null) return 'unknown';
  const tl = ctx && ctx.paths && ctx.paths.binaries ? ctx.paths.binaries.tasklist : null;
  if (!tl) {
    const r = await probe(ctx, n);
    return r.state === 'found' ? 'alive' : (r.state === 'gone' ? 'gone' : 'unknown');
  }
  const r = await run(tl, ['/FI', 'PID eq ' + n, '/FO', 'CSV', '/NH'], TASKLIST_TIMEOUT_MS);
  // tasklist prints "INFO: No tasks..." on stdout with exit 0 when nothing matches, so a
  // non-zero exit or a spawn error means the CHECK failed, not that the process is gone.
  if (r.exit !== 0 || r.error) return 'unknown';
  return tasklistHasPid(r.stdout, n) ? 'alive' : 'gone';
}

/**
 * Cheap liveness check (no identity). `true` only when the process was actually seen;
 * an unevaluable probe answers `false` here, so never use it to prove death — use
 * livenessOf() when the difference matters (treeKill does).
 * @param {Object} ctx @param {*} pid @returns {Promise<boolean>}
 */
async function isAlive(ctx, pid) {
  return (await livenessOf(ctx, pid)) === 'alive';
}

/**
 * Runner identity: Name === node.exe AND CommandLine names runner.js AND the job id.
 * @param {Object} ctx @param {*} pid @param {{jobId:string}} o
 * @returns {Promise<{ok:boolean, reason:string|null, info:Object|null}>}
 */
async function verifyRunner(ctx, pid, o) {
  const jobId = String((o && o.jobId) || '');
  const n = toPid(pid);
  if (n === null) return { ok: false, reason: 'no-pid', info: null };
  const r = await probe(ctx, n);
  if (r.state === 'unknown') return { ok: false, reason: 'identity_unevaluable', info: null, error: r.error };
  const info = r.info;
  if (!info) return { ok: false, reason: 'not-running', info: null };
  const name = String(info.Name || '').toLowerCase();
  const cmd = String(info.CommandLine || '');
  const ok = name === 'node.exe' && cmd.toLowerCase().indexOf('runner.js') !== -1 &&
    jobId !== '' && cmd.indexOf(jobId) !== -1;
  return ok ? { ok: true, reason: null, info } : { ok: false, reason: 'pid-identity-mismatch', info };
}

/**
 * Leaf identity: Name === expectedImage AND ParentProcessId === runnerPid AND
 * CreationDate >= the job's created_at.
 * @param {Object} ctx @param {*} pid
 * @param {{expectedImage:string, runnerPid:*, createdAtMs:*}} o
 * @returns {Promise<{ok:boolean, reason:string|null, info:Object|null}>}
 */
async function verifyLeaf(ctx, pid, o) {
  const opts = o || {};
  const n = toPid(pid);
  if (n === null) return { ok: false, reason: 'no-pid', info: null };
  const r = await probe(ctx, n);
  if (r.state === 'unknown') return { ok: false, reason: 'identity_unevaluable', info: null, error: r.error };
  const info = r.info;
  if (!info) return { ok: false, reason: 'not-running', info: null };

  const mismatch = { ok: false, reason: 'pid-identity-mismatch', info };
  const want = String(opts.expectedImage || '').toLowerCase();
  if (!want) return mismatch;                                   // unverifiable => refuse
  if (String(info.Name || '').toLowerCase() !== want) return mismatch;

  const parent = toPid(opts.runnerPid);
  if (parent === null || info.ParentProcessId !== parent) return mismatch;

  const createdAtMs = Number(opts.createdAtMs);
  if (Number.isFinite(createdAtMs)) {
    if (info.creation_ms === null) return mismatch;             // unverifiable => refuse
    if (info.creation_ms < createdAtMs - CREATION_SKEW_MS) return mismatch;
  }
  return { ok: true, reason: null, info };
}

/**
 * Poll tasklist until the PID is gone or the budget runs out.
 * @param {Object} ctx @param {*} pid @param {number} [timeoutMs]
 * @returns {Promise<boolean>} true when the PID is no longer listed
 */
async function waitForDeath(ctx, pid, timeoutMs) {
  const budget = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : DEATH_WAIT_MS;
  const deadline = Date.now() + Math.max(0, budget);
  for (;;) {
    const l = await livenessOf(ctx, pid);
    if (l === 'gone') return true;
    // 'unknown' is NOT death: keep polling, and report false when the budget runs out,
    // which surfaces as orphan_suspected rather than as a clean kill (SPEC §9).
    if (Date.now() >= deadline) return false;
    await sleep(DEATH_POLL_MS);
  }
}

/**
 * `taskkill /PID <pid> /T /F`, then verify death with tasklist. The caller NEVER calls
 * this before an identity check passed. `verified_dead:false` after /F is the
 * orphan_suspected signal (SPEC §9); it is never reported as a clean kill.
 * @param {Object} ctx @param {*} pid
 * @returns {Promise<{ok:boolean, exit:number|null, stdout:string, stderr:string, verified_dead:boolean}>}
 */
async function treeKill(ctx, pid) {
  const n = toPid(pid);
  if (n === null) return { ok: false, exit: null, stdout: '', stderr: 'invalid pid', verified_dead: false };
  const tk = ctx && ctx.paths && ctx.paths.binaries ? ctx.paths.binaries.taskkill : null;
  if (!tk) return { ok: false, exit: null, stdout: '', stderr: 'taskkill path missing', verified_dead: false };
  const r = await run(tk, ['/PID', String(n), '/T', '/F'], TASKKILL_TIMEOUT_MS);
  const dead = await waitForDeath(ctx, n, DEATH_WAIT_MS);
  return { ok: dead, exit: r.exit, stdout: r.stdout, stderr: r.stderr, verified_dead: dead };
}

// Owns Windows paths, ACLs and encrypted credential transport; specification §§3–4,6,8.
function homeDir() { return process.env.USERPROFILE || os.homedir(); }
function tokens() {
  const env = Object.fromEntries(Object.entries(process.env).map(([k,v]) => [k.toUpperCase(), v]));
  return Object.assign(Object.fromEntries(['LOCALAPPDATA','APPDATA','USERPROFILE','SYSTEMROOT','PROGRAMFILES','PROGRAMW6432'].map(k => [k, env[k] || ''])), { COUNCIL_APP: path.resolve(__dirname, '..'), COUNCIL_VAULT: '' });
}
function appDirs() {
  const stateAnchor = tokens().LOCALAPPDATA || path.join(homeDir(), 'AppData', 'Local');
  const root = path.join(stateAnchor, 'council');
  return { root, app: path.join(root, 'app', APP_VERSION), etc: path.join(root, 'etc'), run: path.join(root, 'run'), stateAnchor };
}
function real(p) { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } }
function caseFold(p) { return String(p).toLowerCase(); }
function under(p, root) { if (!p || !root) return false; const a = caseFold(path.resolve(p)), b = caseFold(path.resolve(root)); return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep); }
function isAbsoluteNative(p) { return typeof p === 'string' && path.win32.isAbsolute(p) && !/^[\\/](?![\\/])/.test(p); }
function childEnvAllow() { return ['SystemRoot','windir','SystemDrive','COMSPEC','PATHEXT','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE','PROCESSOR_IDENTIFIER','OS','TEMP','TMP','USERPROFILE','HOMEDRIVE','HOMEPATH','USERNAME','COMPUTERNAME','APPDATA','LOCALAPPDATA','PROGRAMDATA','ALLUSERSPROFILE','PUBLIC','ProgramFiles','ProgramFiles(x86)','ProgramW6432','CommonProgramFiles']; }
function childPath(nodeDir) { const sys = tokens().SYSTEMROOT; return [sys && path.join(sys,'System32'),sys,sys && path.join(sys,'System32','Wbem'),sys && path.join(sys,'System32','WindowsPowerShell','v1.0'),nodeDir].filter(Boolean).join(path.delimiter); }
// Deliberate split: profile paths are installer-controlled data; ps() and dpapi() bind to known-good System32 binaries.
function systemBinaries() { const sys = tokens().SYSTEMROOT; if (!sys || !isAbsoluteNative(sys)) return {}; return { powershell: path.join(sys,'System32','WindowsPowerShell','v1.0','powershell.exe'), taskkill: path.join(sys,'System32','taskkill.exe'), tasklist: path.join(sys,'System32','tasklist.exe') }; }
function npmRootInfo(machine = {}) {
  const t = tokens(), candidate = machine.npm_root_g;
  const fallback = t.APPDATA && path.join(t.APPDATA,'npm','node_modules');
  const forbidden = [...(machine.profileVaults || []), process.env.TEMP, process.env.TMP, path.join(homeDir(),'Downloads')].filter(Boolean);
  const anchors = [t.APPDATA,t.LOCALAPPDATA,t.PROGRAMFILES,t.PROGRAMW6432].filter(Boolean);
  let good = candidate && isAbsoluteNative(candidate) && !candidate.startsWith('\\\\');
  if (good) { try { const rp = fs.realpathSync.native(candidate); good = !rp.startsWith('\\\\') && anchors.some(a => under(rp, real(a))) && !forbidden.some(a => under(candidate,a) || under(rp,real(a))); } catch { good = false; } }
  return { root: good ? candidate : fallback, warning: candidate && !good ? 'npm_root_ignored' : null };
}
function agyBinaryRoot() { return tokens().LOCALAPPDATA ? path.join(tokens().LOCALAPPDATA,'agy','bin') : null; }
function allowedRootsBase(machine) { const npm = npmRootInfo(machine).root, sys = tokens().SYSTEMROOT; return [npm && path.join(npm,'@anthropic-ai'),npm && path.join(npm,'@openai'),path.dirname(real(process.execPath)),sys && path.join(sys,'System32'),path.join(appDirs().root,'app'),agyBinaryRoot()].filter(Boolean); }
function hostConfigPaths() {
  const t = tokens(); const desktop = t.APPDATA ? [path.join(t.APPDATA,'Claude','claude_desktop_config.json')] : [];
  if (t.LOCALAPPDATA) { const packages = path.join(t.LOCALAPPDATA,'Packages'); try { for (const name of fs.readdirSync(packages)) if (/^Claude_/i.test(name)) desktop.push(path.join(packages,name,'LocalCache','Roaming','Claude','claude_desktop_config.json')); } catch {} }
  return { claudeCode: path.join(homeDir(),'.claude.json'), codex: path.join(homeDir(),'.codex','config.toml'), claudeDesktop: desktop };
}
function psQuote(s) { return "'" + String(s).replace(/'/g,"''") + "'"; }
async function ps(command) { const file = systemBinaries().powershell; if (!file) throw new Error('system helper unavailable'); const r = await run(file, ['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; "+command], 15000); if (!r.ok) throw new Error('system helper failed'); return r.stdout.trim(); }
async function fileAttributes(p) { const bits = Number(await ps('[int64](Get-Item -LiteralPath ' + psQuote(p) + ' -Force -ErrorAction Stop).Attributes')); return { bits, offline: !!(bits & 0x1000), recallOnDataAccess: !!(bits & 0x400000), pinned: !!(bits & 0x80000), reparsePoint: !!(bits & 0x400) }; }
async function isCloudSynced(p) { const evidence = []; for (const name of ['OneDrive','OneDriveConsumer','OneDriveCommercial','Dropbox']) if (process.env[name] && under(p,process.env[name])) evidence.push(name + ' root'); if (/(?:^|[\\/])(OneDrive|Dropbox|Google Drive)(?:[\\/]|$)/i.test(p)) evidence.push('path-name heuristic'); let attributes = null; try { attributes = await fileAttributes(p); if (attributes.offline || attributes.recallOnDataAccess) evidence.push('cloud recall attributes'); } catch {} return { synced: evidence.length > 0, evidence, attributes, unknown: !attributes }; }
function aclPostCheck(dir) {
  fs.readdirSync(dir);
  const probeFile = path.join(dir, '.acl-' + require('crypto').randomBytes(6).toString('hex'));
  let created = false;
  try {
    fs.writeFileSync(probeFile, 'ok', { flag: 'wx' });
    created = true;
    if (fs.readFileSync(probeFile, 'utf8') !== 'ok') throw new Error('ACL post-check failed');
  } finally {
    if (created) fs.unlinkSync(probeFile);
  }
}
async function restrictToOwner(dir) {
  let saved, binary, failure;
  const remember = e => {
    if (!failure) failure = e;
    else { let tail = failure; while (tail.cause) tail = tail.cause; tail.cause = e; }
  };
  try {
    // Snapshot before mutation; even setup failures still run the post-check below.
    saved = await ps('(Get-Acl -LiteralPath ' + psQuote(dir) + ').GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)');
    const sid = await ps('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value');
    if (!/^S-1-[0-9-]+$/.test(sid)) throw new Error('owner identity unavailable');
    binary = path.join(tokens().SYSTEMROOT, 'System32', 'icacls.exe');
    const r = await run(binary, [dir, '/inheritance:r', '/grant:r', '*' + sid + ':(OI)(CI)F'], 15000);
    if (!r.ok) throw new Error('ACL owner grant failed');
    // Set-Acl needs SeSecurityPrivilege; use the .NET static or, in PowerShell 7, the extension method.
    // RemoveAccessRuleSpecific returns void on .NET: check any false result AND prove the rule count decreased.
    await ps('$p=' + psQuote(dir) + '; $a=Get-Acl -LiteralPath $p; foreach($r in @($a.Access)){if($r.IsInherited){continue}; try{$id=$r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}catch [Security.Principal.IdentityNotMappedException]{continue}; if($id -in @(' + psQuote(sid) + ",'S-1-5-18','S-1-5-32-544')){continue}; $before=$a.Access.Count; $removed=$a.RemoveAccessRuleSpecific($r); if($removed -eq $false -or $a.Access.Count -ge $before){throw 'ACL rule removal failed'}}; if([IO.Directory].GetMethod('SetAccessControl')){[IO.Directory]::SetAccessControl($p,$a)}else{[System.IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($p),$a)}");
  } catch (e) { remember(e); }
  // Always prove listing and probe read/write, including after a failed owner grant.
  try { aclPostCheck(dir); } catch (e) { remember(e); }
  if (!failure) return { ok: true };

  let reverted = false;
  // Reject missing/empty DACLs, including D:PAI. Parsing inside PowerShell validates the rest.
  if (typeof saved === 'string' && /^D:(?:P|AI|AR)*\([^()]+\)(?:\([^()]+\))*$/.test(saved)) {
    try {
      // Set-Acl needs SeSecurityPrivilege; use the .NET static or, in PowerShell 7, the extension method.
      await ps('$a=Get-Acl -LiteralPath ' + psQuote(dir) + '; $p=' + psQuote(dir) + '; $a.SetSecurityDescriptorSddlForm(' + psQuote(saved) + ",[Security.AccessControl.AccessControlSections]::Access); if([IO.Directory].GetMethod('SetAccessControl')){[IO.Directory]::SetAccessControl($p,$a)}else{[System.IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($p),$a)}");
      aclPostCheck(dir);
      reverted = true;
    } catch (e) { remember(e); }
  }
  if (!reverted) {
    for (const option of ['/reset', '/inheritance:e']) {
      try {
        binary = binary || path.join(tokens().SYSTEMROOT, 'System32', 'icacls.exe');
        const r = await run(binary, [dir, option], 15000);
        if (!r.ok) remember(new Error('ACL recovery failed: ' + option));
      } catch (e) { remember(e); }
      try { aclPostCheck(dir); reverted = true; break; } catch (e) { remember(e); }
    }
  }
  // Preserve the original diagnosis and recovery causes without changing the result contract.
  return Object.defineProperty({ ok: false, reason: 'backup_acl_not_restricted', reverted }, 'error', { value: failure });
}

function secretPath(name) { if (!name || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name.profile || '')) throw new Error('bad_profile_name'); const root=name.runtimeRoot || path.join(appDirs().run,name.profile); if(!isAbsoluteNative(root) || !under(real(root),real(appDirs().stateAnchor)))throw new Error('secret location rejected'); return path.join(root,'secrets','gemini-api-key.dpapi'); }
function dpapi(name, operation, input) {
  const file = name.binary || systemBinaries().powershell;
  if (!file || !under(real(file),real(path.join(tokens().SYSTEMROOT,'System32')))) throw new Error('secret helper rejected');
  const op = operation === 'protect' ? 'Protect' : 'Unprotect';
  const command = "$ErrorActionPreference='Stop'; " + 'Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[Security.Cryptography.ProtectedData]::' + op + '($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))';
  const r = require('child_process').spawnSync(file,['-NoProfile','-NonInteractive','-Command',command],{input,encoding:'utf8',env:toolEnv(),windowsHide:true,timeout:15000,maxBuffer:65536});
  if (r.status !== 0 || r.error) throw new Error('credential store operation failed');
  return r.stdout.trim();
}
// Encoded transport keeps plaintext handling in lib/secrets.js; helpers use only pipes.
function secretGet(name) { return dpapi(name,'unprotect',fs.readFileSync(secretPath(name),'utf8')); }
function secretSet(name,value) { const p = secretPath(name); const blob = dpapi(name,'protect',value); fs.mkdirSync(path.dirname(p),{recursive:true}); fs.writeFileSync(p,blob,{mode:0o600}); }
function secretDelete(name) { const p = secretPath(name); try { fs.unlinkSync(p); } catch(e) { if(e.code !== 'ENOENT') throw e; } }
module.exports = {
  id:'win32', implemented:{proc:true,secrets:true,fileAttributes:true}, notImplementedReason:null,
  appDirs, homeDir, tokens, caseFold, isAbsoluteNative, sameFile:(a,b) => caseFold(real(a)) === caseFold(real(b)), childEnvAllow, childPath, nullDevice:() => 'NUL', allowedRootsBase, systemBinaries,
  longLivedChildArgv:() => ({file:path.join(tokens().SYSTEMROOT,'System32','cmd.exe'),args:['/c','timeout','300','||','ping','-n','300','127.0.0.1','>','nul']}),
  credentialProbePaths:() => ({claude:path.join(homeDir(),'.claude','.credentials.json'),codex:path.join(homeDir(),'.codex')}),
  probe,inspect,isAlive,livenessOf,verifyRunner,verifyLeaf,waitForDeath,treeKill,spawnDetachedOpts:() => ({detached:true,windowsHide:true}),
  fileAttributes,isCloudSynced,restrictToOwner,secretGet,secretSet,secretDelete,hostConfigPaths,
  rgVendorDir:js => path.resolve(path.dirname(js),'..','node_modules','@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc','codex-path'),
  planUsagePath:() => tokens().APPDATA ? path.join(tokens().APPDATA,'Claude','plan-usage-history.json') : null,
  secretHelper:bins => bins.powershell,
  expectedImage:name => name + '.exe', agyBinaryRoot, npmRootInfo,
};
