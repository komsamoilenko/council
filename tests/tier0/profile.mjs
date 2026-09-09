// Owns the generated, zero-quota runtime fixture; specification §16.1.
import fs from 'node:fs';
import {tempRoot} from '../temp-root.mjs';
let profileRoot;
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export function makeProfile(repo, platform, appSource = path.join(repo,'src')) {
  const verifying=process.argv.includes('--verify-profile');
  const explicitRg = process.env.COUNCIL_SMOKE_RG;
  const originalNpm = process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules');
  profileRoot = tempRoot('tier0', 'council-smoke-');
  const tmp = profileRoot.root;
  const put = (p, bytes) => { fs.mkdirSync(path.dirname(p), {recursive:true}); fs.writeFileSync(p, bytes); return p; };
  for (const key of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','CODEX_HOME','CLAUDE_CONFIG_DIR']) {
    process.env[key] = path.join(tmp, key.toLowerCase());
    fs.mkdirSync(process.env[key], {recursive:true});
  }
  for (const key of Object.keys(process.env)) if (key.startsWith('COUNCIL_')) delete process.env[key];
  process.env.COUNCIL_PROFILE = 'default';
  const dirs = platform.appDirs(), app = path.join(dirs.root, 'app', 'smoke-fixtures');
  const vault = path.join(tmp, 'vault');
  put(path.join(vault, 'AGENTS.md'), '# Debate protocol\nFixture notes only.\n');
  fs.mkdirSync(path.join(vault, 'bin'), {recursive:true});
  const stub = dest => put(dest, 'Inert vendor fixture; execution must be refused.\n');
  // Existence and adapter paths are tested; doctor tolerates refused version probes.
  const binaries = {node:process.execPath, ...platform.systemBinaries(),
    claude:stub(path.join(app, platform.expectedImage('claude'))),
    codex_js:put(path.join(app, 'codex.js'), "if(process.argv.slice(2).join(' ') !== '--version') process.exit(97); console.log('codex fixture');\n")};
  if (platform.agyBinaryRoot()) binaries.agy = stub(path.join(platform.agyBinaryRoot(), platform.expectedImage('agy')));
  else binaries.agy = stub(path.join(app, platform.expectedImage('agy')));
  const candidates = [explicitRg,
    originalNpm && path.join(platform.rgVendorDir(path.join(originalNpm, '@openai', 'codex', 'bin', 'codex.js')), platform.expectedImage('rg')),
    ...(process.env.PATH || '').split(path.delimiter).map(p => path.join(p, platform.expectedImage('rg')))];
  const rg = candidates.find(p => p && fs.existsSync(p));
  if (rg) { binaries.rg = path.join(app, platform.expectedImage('rg')); fs.copyFileSync(rg, binaries.rg); }
  const template = JSON.parse(fs.readFileSync(path.join(repo, 'installer', 'templates', 'profile', 'config.template.json'), 'utf8'));
  const config = {...template, profile:'default', vault,
    runtime_root:path.join(dirs.run, (verifying?'_verify-':'_smoke-') + process.pid), binaries,
    layout:{work_dir:'work', jobs_dir:'work/jobs', ledger_dir:'ledger'},
    gemini:{provider:'agy'}, prompt_form:'split', created_at:new Date().toISOString(), server_name:'council', created_by:'smoke'};
  const configPath = put(path.join(dirs.etc, 'profiles', 'default', 'config.json'), JSON.stringify(config));
  // Real-host tests resolve this machine file; COUNCIL_CONFIG carries test binaries.
  put(path.join(dirs.etc, 'machine.json'), JSON.stringify({schema:2,binaries}));
  const accounts = {accounts:Object.fromEntries(['claude','codex','gemini','echo'].map((id,i) => [id,{label:['anthropic:default','openai:default','google:default','echo:default'][i]}]))};
  put(path.join(path.dirname(configPath), 'accounts.json'), JSON.stringify(accounts));
  put(path.join(tmp, 'accounts.json'), JSON.stringify(accounts));
  const files = {};
  function walk(dir) { for (const e of fs.readdirSync(dir, {withFileTypes:true})) {
    const p = path.join(dir,e.name);
    if (e.isDirectory()) walk(p); else files[path.relative(appSource,p).replaceAll('\\','/')] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  } }
  walk(appSource);
  put(path.join(dirs.etc, 'manifests', 'app-' + require(path.join(appSource,'version.js')).APP_VERSION + '.json'), JSON.stringify({files}));
  const ackPath = put(path.join(tmp, 'acknowledged-gate'), 'I have read NOTICE.md and I accept that using agy with council may breach Antigravity Additional Terms of Service section 6.\n');
  return {tmp, configPath, ackPath, rg:!!rg,ledgerPrefix:verifying?'verify-':'smoke-'};
}

export function finishProfile(root, success) {
  if (root !== profileRoot?.root) throw new Error('unsafe_smoke_cleanup');
  profileRoot.finish(success||process.argv.includes('--verify-profile'));
}
