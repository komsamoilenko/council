// Owns the ordered read-only survey and native probe boundary; specification §7.2.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import platform from '../../src/platform/index.js';
import secrets from '../../src/lib/secrets.js';
import { appdirs } from './appdirs.mjs';
import { cloudsync } from './cloudsync.mjs';
import { scanMarkers } from './markers.mjs';
import { councilSpan, tokenizeToml } from './tomlblock.mjs';
import { openJournals } from './journal.mjs';
import { fail, errorObject } from './dialogue.mjs';

export const REGION_NOTE = 'Gemini API: users in the EEA, Switzerland and the UK must check vendor regional eligibility and billing requirements; see NOTICE.md.';
export const CONTRACT_FILES = ['AGENTS.md','CLAUDE.md','INDEX.md','.gitignore','.council/vault.json'];
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const stable = value => JSON.stringify(sort(value));
function sort(value) { return Array.isArray(value) ? value.map(sort) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sort(value[k])])) : value; }
export const exists = file => { try { fs.lstatSync(file); return true; } catch (e) { if (['ENOENT','ENOTDIR'].includes(e.code)) return false; throw e; } };
export function readJSON(file, fallback = null) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw fail('E-STEP', 'Cannot read JSON: ' + file); } }
export function realFuture(file) {
  let p = path.resolve(file), suffix = [];
  while (!exists(p)) { suffix.unshift(path.basename(p)); const parent = path.dirname(p); if (parent === p) break; p = parent; }
  return path.join(fs.realpathSync(p), ...suffix);
}
export const under = (file, root) => { const rel = path.relative(root, file); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };
export function which(name, env = process.env) {
  const vars = Object.fromEntries(Object.entries(env).map(([k,v]) => [k.toUpperCase(),v]));
  const extensions = path.extname(name) ? [''] : ['', ...(vars.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')];
  const found = [];
  for (const dir of (vars.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of extensions) {
      const file = path.resolve(dir.replace(/^"|"$/g, ''), name + ext);
      try { if (fs.statSync(file).isFile() && !found.some(f => fs.realpathSync(f) === fs.realpathSync(file))) found.push(file); } catch {}
    }
  }
  return found;
}
export function nativeProbe(file, args, options) {
  if (!path.isAbsolute(file) || /\.(cmd|bat|ps1)$/i.test(file)) throw fail('E-CMD-SHIM');
  const r = spawnSync(file, args, { ...options, encoding: 'utf8', shell: false, windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
  return { status: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error?.code };
}
export function context(overrides = {}) {
  const env = overrides.env || process.env;
  const dirs = appdirs({ env, profile: overrides.profile || 'default' });
  const ctx = { env, dirs, node: process.execPath, nodeVersion: process.version, probe: nativeProbe, now: () => new Date(), ...overrides };
  ctx.run = (file, args, extra = {}) => ctx.probe(file, args, { ...extra, cwd: os.tmpdir(), env: ctx.env, shell: false });
  // Do not use platform.fileAttributes here: its internal probe uses the caller's cwd.
  ctx.attributes ||= async file => {
    if (dirs.id !== 'win32') return null;
    const ps = path.join(env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const r = ctx.run(ps, ['-NoProfile','-NonInteractive','-Command', "[int64](Get-Item -LiteralPath '" + file.replaceAll("'", "''") + "' -Force -ErrorAction Stop).Attributes"]);
    const bits = r.status === 0 ? Number(r.stdout.trim()) : NaN;
    return Number.isFinite(bits) ? { bits } : null;
  };
  return ctx;
}
export async function cloud(file, ctx) { return cloudsync(file, { env: ctx.env, providerPaths: ctx.dirs.providerPaths, platform: { fileAttributes: ctx.attributes } }); }
export async function linked(file, ctx) {
  for (let p = path.resolve(file); ; p = path.dirname(p)) {
    if (exists(p)) {
      if (fs.lstatSync(p).isSymbolicLink()) return true;
      const a = await ctx.attributes(p); if (a?.reparsePoint || (a?.bits & 0x400)) return true;
    }
    if (path.dirname(p) === p) return false;
  }
}
function semver(text) { return /(?:^|[^\d])(\d+)\.(\d+)\.(\d+)\b/.exec(text)?.slice(1).map(Number); }
function below(text, floor) { const v = semver(text); return !v || v[0] < floor[0] || v[0] === floor[0] && (v[1] < floor[1] || v[1] === floor[1] && v[2] < floor[2]); }
function invocation(file, args, ctx) { return /\.[cm]?js$/i.test(file) ? ctx.run(ctx.node, [file, ...args]) : ctx.run(file, args); }
export function hostPaths(ctx) {
  const { env, dirs: d } = ctx;
  const desktop = d.id === 'win32' ? [path.join(env.APPDATA || path.join(d.home, 'AppData','Roaming'), 'Claude','claude_desktop_config.json')] :
    d.id === 'darwin' ? [path.join(d.home, 'Library','Application Support','Claude','claude_desktop_config.json')] : [];
  const packages = path.join(env.LOCALAPPDATA || d.home, 'Packages');
  if (d.id === 'win32' && exists(packages)) for (const name of fs.readdirSync(packages).sort()) if (/^Claude_|Anthropic/i.test(name)) desktop.push(path.join(packages,name,'LocalCache','Roaming','Claude','claude_desktop_config.json'));
  return { 'claude-code': [path.join(env.CLAUDE_CONFIG_DIR || d.home, '.claude.json')],
    codex: [path.join(env.CODEX_HOME || path.join(d.home, '.codex'), 'config.toml')], 'claude-desktop': desktop };
}
export async function survey(options, ctx) {
  const blocks = [], warnings = [];
  const add = (name, facts, errors = []) => blocks.push({ name, ...facts, errors: errors.map(e => errorObject(e)) });
  add('platform', { id: ctx.dirs.id, capabilities: Object.fromEntries(['proc','secrets','fileAttributes'].map(k => [k, ctx.dirs.id === 'win32' ? 'implemented' : 'not implemented'])) }, ctx.dirs.id === 'win32' ? [] : [fail('E-PLATFORM')]);
  add('node', { path: ctx.node, version: ctx.nodeVersion, floor: '20.11.0' }, below(ctx.nodeVersion, [20,11,0]) ? [fail('E-NODE-OLD')] : []);
  if (below(ctx.nodeVersion, [24,0,0])) warnings.push('Node: untested below 24.');
  const gitPaths = which('git', ctx.env).filter(p => !/\.(cmd|bat|ps1)$/i.test(p));
  const gitResult = gitPaths.length ? ctx.run(gitPaths[0], ['--version']) : null;
  add('git', { path: gitPaths[0] || null, version: gitResult?.status === 0 ? gitResult.stdout.trim() : null, available: gitResult?.status === 0 });
  const npmCli = path.join(path.dirname(ctx.node), 'node_modules','npm','bin','npm-cli.js');
  const npm = {};
  for (const verb of ['prefix','root','--version']) {
    // npm normally creates its cache, writes logs, prunes old logs and checks for updates,
    // even for root/prefix. Cache mkdir is a no-op on existing TEMP; logs-dir deliberately
    // names an existing regular file so neither log creation nor cleanup can touch a tree.
    const r = ctx.run(ctx.node, [npmCli, verb, ...(verb === '--version' ? [] : ['-g']),
      '--cache',os.tmpdir(),'--logs-dir',ctx.node,'--logs-max=0','--update-notifier=false','--timing=false']);
    npm[verb === '--version' ? 'version' : verb] = r.status === 0 ? r.stdout.trim() : null;
  }
  add('npm', { ...npm, path: npmCli });
  if (!npm.root) warnings.push('npm root -g unavailable; using Node PATH/PATHEXT search.');
  const candidates = {}, cliErrors = [], clis = {};
  for (const name of ['claude','codex','agy']) {
    const authoritative = name === 'claude' && npm.root ? path.join(npm.root,'@anthropic-ai','claude-code','bin','claude.exe') :
      name === 'codex' && npm.root ? path.join(npm.root,'@openai','codex','bin','codex.js') :
      name === 'agy' && ctx.env.LOCALAPPDATA ? path.join(ctx.env.LOCALAPPDATA,'agy','bin','agy.exe') : null;
    candidates[name] = authoritative && exists(authoritative) ? [authoritative] : which(name, ctx.env);
    const list = candidates[name];
    if (list.length > 1) cliErrors.push(fail('E-AMBIGUOUS-BINARY', name + ': ' + list.join(', ')));
    const file = list.length === 1 ? list[0] : null;
    clis[name] = { path: file, candidates: list, version: null, usable: false, disabled: name === 'agy' };
    if (file && /\.(cmd|bat|ps1)$/i.test(file)) { cliErrors.push(fail('E-CMD-SHIM', file)); continue; }
    if (!file) continue;
    const r = invocation(file, ['--version'], ctx);
    clis[name].version = semver(r.stdout)?.join('.') || null;
    clis[name].usable = r.status === 0 && !!clis[name].version && name !== 'agy';
    if (name === 'claude' && below(r.stdout, [2,1,263])) { clis[name].usable = false; warnings.push('claude below 2.1.263; upgrade with npm install -g @anthropic-ai/claude-code.'); }
    if (name === 'codex') {
      const help = invocation(file, ['--help'], ctx);
      const accepts = invocation(file, ['--ignore-user-config','--version'], ctx);
      clis[name].ignoreUserConfig = help.status === 0 && help.stdout.includes('--ignore-user-config') && accepts.status === 0;
      clis[name].usable &&= clis[name].ignoreUserConfig;
      warnings.push('Codex version floor UNVERIFIED; --ignore-user-config support was probed.');
    }
    if (name === 'agy') { const help = invocation(file, ['--help'], ctx); clis[name].printTimeout = help.status === 0 && help.stdout.includes('--print-timeout'); warnings.push('agy --print-timeout version floor UNVERIFIED; disabled by policy.'); }
  }
  const desktopBin = path.join(ctx.env.LOCALAPPDATA || ctx.dirs.home, 'OpenAI','Codex','bin');
  const desktopClis = [];
  if (exists(desktopBin)) for (const name of fs.readdirSync(desktopBin).sort()) { const file = path.join(desktopBin,name,'codex.exe'); if (exists(file)) desktopClis.push({ path: file, status: 'found, not usable by 0.1.0' }); }
  add('clis', { clis, desktopClis }, cliErrors);
  const hosts = [], hostErrors = [];
  for (const [surface, paths] of Object.entries(hostPaths(ctx))) for (const file of paths) {
    const item = { surface, path: file, exists: exists(file), entries: {}, selectedEntryHash: null };
    if (item.exists) {
      if (await linked(file, ctx)) { hostErrors.push(fail('E-REPARSE-TARGET', file)); hosts.push(item); continue; }
      try {
        if (surface === 'codex') {
          const bytes = fs.readFileSync(file), tokens = tokenizeToml(bytes);
          const names = new Set(tokens.headers.filter(h => h.names[0] === 'mcp_servers' && /^council/.test(h.names[1])).map(h => h.names[1]));
          names.add(options['register-as'] || 'council');
          for (const name of names) {
            const span = councilSpan(bytes, { name }); if (!span.ok) throw fail('E-TOML-CONFLICT', file);
            if (span.span) {
              const text = bytes.subarray(span.span.start,span.span.end).toString('utf8');
              item.entries[name] = { hash: sha256(text), pointsTo: text.match(/^\s*command\s*=\s*(.+)$/m)?.[1] || null };
            }
          }
        } else {
          const json = readJSON(file);
          for (const [name, entry] of Object.entries(json.mcpServers || {})) if (/^council/.test(name) || name === options['register-as']) item.entries[name] = { hash: sha256(stable(entry)), pointsTo: { command: entry.command, args: entry.args } };
        }
        item.selectedEntryHash = item.entries[options['register-as'] || 'council']?.hash || null;
      } catch (e) { hostErrors.push(e.exitCode ? e : fail('E-TOML-CONFLICT', file)); }
    }
    hosts.push(item);
  }
  if (hosts.filter(h => h.surface === 'claude-desktop' && h.exists).length > 1) warnings.push('MSIX ambiguity: select which Claude Desktop config in the hosts answer.');
  add('hosts', { hosts }, hostErrors);
  const credentials = platform.credentialProbePaths();
  // Credential paths are probed for existence only. No size, content or hash is read.
  credentials.claude = path.join(ctx.env.CLAUDE_CONFIG_DIR || path.join(ctx.dirs.home,'.claude'), '.credentials.json');
  credentials.codex = ctx.env.CODEX_HOME || path.join(ctx.dirs.home,'.codex');
  const login = clis.codex.path && !/\.(cmd|bat|ps1)$/i.test(clis.codex.path) ? invocation(clis.codex.path, ['login','status'], ctx) : null;
  const installErrors = [];
  const installJSON = file => { try { return readJSON(file); } catch (e) { installErrors.push(e); return null; } };
  const localConfig = installJSON(ctx.dirs.config);
  const runtimeRoot = (localConfig?.runtime_root || ctx.dirs.runtimeRoot).replace(/%([^%]+)%/g, (_,key) => ctx.env[key] || '%'+key+'%');
  const keyPresent = ctx.env === process.env ? secrets.present({config:{profile:options.profile || 'default',runtime_root:runtimeRoot}}) :
    !!ctx.env.COUNCIL_GEMINI_API_KEY || ctx.dirs.id === 'win32' && exists(path.join(runtimeRoot,'secrets','gemini-api-key.dpapi'));
  add('logins', { codex: login ? login.status === 0 ? 'signed in' : 'not signed in' : 'not found',
    credentialPaths: Object.fromEntries(Object.entries(credentials).map(([k,p]) => [k, { path: p, present: exists(p) }])),
    geminiKey: { present: keyPresent } });
  let vault, vaultErrors = [];
  try { vault = await inspectVault(options.vault || resolveVault(ctx), ctx); if (vault.error) vaultErrors.push(fail(vault.error,vault.path)); }
  catch (e) { vault={path:options.vault || null,contracts:{}};vaultErrors.push(e); }
  add('vault', { vault }, vaultErrors);
  const config = localConfig, manifest = installJSON(ctx.dirs.manifest), current = installJSON(ctx.dirs.current);
  add('install', { current, configPresent: !!config, manifestPresent: !!manifest,
    foreignConfigIgnored: !!vault.path && exists(path.join(vault.path,'bin','council','config.json')) }, installErrors);
  let journals = [], journalErrors = [];
  try { journals = openJournals(ctx.dirs.journal).map(j => ({ path: j.path, corrupt: j.corrupt, resume: 'apply --plan <same> --resume', rollback: 'rollback --journal ' + path.basename(j.path, '.jsonl') })); }
  catch (e) { journalErrors.push(e); }
  if (journals.length) journalErrors.push(fail('E-JOURNAL-OPEN', journals.map(j => j.path).join('\n')));
  add('journal', { journals }, journalErrors);
  add('region', { note: REGION_NOTE });
  return { schema: 1, verb: 'detect', profile: options.profile || 'default', blocks, warnings, exitCode: blocks.find(b => b.errors.length)?.errors[0].exitCode || 0 };
}
export function resolveVault(ctx) {
  for (let p = process.cwd(); ; p = path.dirname(p)) {
    if (exists(path.join(p,'.council','vault.json'))) return p;
    if (path.dirname(p) === p) break;
  }
  return readJSON(ctx.dirs.config)?.vault || null;
}
export async function inspectVault(value, ctx) {
  if (!value) return { path: null, exists: false, contracts: {} };
  const file = path.resolve(value), present = exists(file);
  const result = { path: present ? fs.realpathSync(file) : realFuture(file), exists: present, directory: !present || fs.statSync(file).isDirectory(), contracts: {}, fileCount: 0 };
  if (!result.directory) return { ...result, error: 'E-VAULT-NOT-A-DIR' };
  result.git = false;
  for (let p = result.path; ; p = path.dirname(p)) { if (exists(path.join(p,'.git'))) { result.git = true; break; } if (path.dirname(p) === p) break; }
  result.obsidian = exists(path.join(file,'.obsidian'));
  let ancestor = file; while (!exists(ancestor)) ancestor = path.dirname(ancestor);
  result.cloud = await cloud(ancestor, ctx);
  if (!present) return result;
  for (const name of CONTRACT_FILES) {
    const target = path.join(file,name); const item = { exists: exists(target) }; result.contracts[name] = item;
    if (!item.exists) continue;
    item.reparse = await linked(target, ctx);
    if (item.reparse || !fs.statSync(target).isFile()) continue;
    const a = await ctx.attributes(target);
    if (a?.offline || a?.recallOnDataAccess || (a?.bits & 0x401000)) { item.notHashed = 'cloud-only'; continue; }
    const bytes = fs.readFileSync(target); item.bytes = bytes.length;
    if (name.endsWith('.json')) {
      const c = readJSON(target);
      item.contract = { schema:Number.isInteger(c?.schema)?c.schema:null, contract_version:Number.isInteger(c?.contract_version)?c.contract_version:null,
        profile:/^[a-z0-9][a-z0-9_-]{0,31}$/.test(c?.profile)?c.profile:null, vault_id:/^[a-zA-Z0-9-]{1,64}$/.test(c?.vault_id)?c.vault_id:null };
      continue;
    }
    const scan = scanMarkers(bytes, { style: name === '.gitignore' ? 'hash' : 'markdown' });
    Object.assign(item, { marker: !!scan.block, markerVersion: scan.block?.version || null, unversioned: !!scan.block?.upgraded, protocol: !!scan.contractPresent, error: scan.ok ? null : scan.code, lines: bytes.toString('utf8').split('\n').length });
  }
  const walk = async dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir,entry.name), st = fs.lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { const a = await ctx.attributes(p); if (!(a?.reparsePoint || (a?.bits & 0x400))) await walk(p); }
      else if (st.isFile()) result.fileCount++;
    }
  };
  await walk(file);
  return result;
}
export function fingerprint(detect, registerAs = 'council') {
  const get = name => detect.blocks.find(b => b.name === name);
  const inputs = { vault: get('vault').vault.path, node: { path: get('node').path, version: get('node').version },
    npm: { path: get('npm').path, prefix: get('npm').prefix, root: get('npm').root, version: get('npm').version },
    clis: Object.fromEntries(Object.entries(get('clis').clis).map(([k,v]) => [k, { path: v.path, version: v.version }])),
    hosts: get('hosts').hosts.map(h => ({ surface: h.surface, path: h.path, hash: h.selectedEntryHash })),
    contracts: Object.fromEntries(CONTRACT_FILES.map(n => [n, !!get('vault').vault.contracts[n]?.exists])), registerAs };
  return { inputs, sha256: sha256(stable(inputs)) };
}
