// Isolated installed runtime and stdio client for T-22 through T-37.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
const require = createRequire(import.meta.url);
export const put = (file, bytes) => {
  fs.mkdirSync(path.dirname(file), {recursive:true});
  fs.writeFileSync(file, bytes);
  return file;
};
export const json = (file, value) => put(file, JSON.stringify(value));
export function files(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, {withFileTypes:true}).flatMap(e => {
    const file = path.join(root, e.name);
    if (e.isSymbolicLink()) throw new Error('unexpected fixture link: ' + file);
    return e.isDirectory() ? files(file) : [file];
  });
}
export const snapshot = root => Object.fromEntries(files(root).sort().map(file =>
  [path.relative(root, file), fs.readFileSync(file).toString('base64')]));
export async function inEnv(env, fn) {
  const saved = {...process.env};
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  try { return await fn(); }
  finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}
export async function installed(tmp, repo, source, label) {
  const root = fs.mkdtempSync(path.join(tmp, label + '-'));
  const env = {...process.env};
  for (const key of Object.keys(env)) if (/^(COUNCIL_|GEMINI_|GOOGLE_|OPENAI_|ANTHROPIC_)/.test(key) ||
    ['HTTPS_PROXY','HTTP_PROXY','NO_PROXY','NODE_EXTRA_CA_CERTS','NODE_OPTIONS'].includes(key)) delete env[key];
  for (const key of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','CODEX_HOME','CLAUDE_CONFIG_DIR']) {
    env[key] = path.join(root, key.toLowerCase());
    fs.mkdirSync(env[key], {recursive:true});
  }
  env.COUNCIL_SMOKE_RUN = '1';
  env.COUNCIL_HOST = 'smoke';
  env.COUNCIL_LEDGER_PREFIX = 'smoke-';
  env.COUNCIL_TEST_MIN_TIMEOUT_S = '5';
  const platform = require(path.join(source, 'platform'));
  let dirs, app, binaries;
  await inEnv(env, () => {
    dirs = platform.appDirs();
    app = dirs.app;
    fs.cpSync(source, app, {recursive:true});
    binaries = {node:process.execPath, ...platform.systemBinaries(),
      claude:put(path.join(app, platform.expectedImage('claude')), 'Inert fixture.\n'),
      codex_js:put(path.join(app, 'codex-fixture.js'), "if(process.argv[2]!=='--version')process.exit(97);console.log('fixture');\n"),
      gemini_api_js:path.join(app, 'backends', 'gemini-api-run.js')};
    const agyRoot = platform.agyBinaryRoot();
    if (agyRoot) binaries.agy = put(path.join(agyRoot, platform.expectedImage('agy')), 'Inert fixture.\n');
  });
  const load = name => require(path.join(app, name));
  const version = load('version.js').APP_VERSION;
  const manifest = path.join(dirs.etc, 'manifests', 'app-' + version + '.json');
  const seal = () => json(manifest, {files:Object.fromEntries(files(app).map(file =>
    [path.relative(app, file).split(path.sep).join('/'), crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]))});
  json(path.join(dirs.etc, 'machine.json'), {schema:2, binaries});
  put(path.join(dirs.root, 'bin', 'council-server.js'), fs.readFileSync(path.join(repo, 'bin', 'council-server.js')));
  json(path.join(dirs.root, 'current.json'), {version});
  seal();
  const template = JSON.parse(fs.readFileSync(path.join(repo, 'installer', 'templates', 'profile', 'config.template.json')));
  const profiles = new Map();
  const profile = (id, change = {}) => {
    const config = {...template, profile:id, vault:path.join(root, 'vault-' + id),
      runtime_root:path.join(dirs.run, id), gemini:{provider:'agy'}, prompt_form:'split',
      server_name:'council', created_at:new Date().toISOString(),
      layout:{work_dir:'work',jobs_dir:'work/jobs',ledger_dir:'ledger'}, ...change};
    fs.mkdirSync(config.vault, {recursive:true});
    const configPath = json(path.join(dirs.etc, 'profiles', id, 'config.json'), config);
    json(path.join(path.dirname(configPath), 'accounts.json'), {accounts:{echo:{label:'local:echo'},gemini:{label:'google:default'}}});
    const p = {id, config, configPath, env:{...env, COUNCIL_PROFILE:id}};
    profiles.set(id, p);
    return p;
  };
  const boot = p => inEnv(p.env, () => load('server.js').boot());
  return {root, env, dirs, app, binaries, load, seal, profile, boot, profiles,
    launcher:path.join(dirs.root, 'bin', 'council-server.js')};
}
export class Wire {
  constructor(child) {
    this.child = child; this.stderr = ''; this.stdout = ''; this.buffer = ''; this.next = 0; this.pending = new Map();
    this.closed = new Promise(resolve => child.once('close', resolve));
    child.stderr.on('data', data => { this.stderr += data; });
    child.stdout.on('data', data => {
      this.stdout += data; this.buffer += data;
      let i;
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, i); this.buffer = this.buffer.slice(i + 1);
        let frame; try { frame = JSON.parse(line); } catch { continue; }
        this.pending.get(frame.id)?.(frame);
      }
    });
    child.on('error', e => { this.error = e; });
  }
  async rpc(method, params = {}, ms = 20000) {
    const id = ++this.next;
    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + ' timed out: ' + (this.error?.message || this.stderr))); }, ms);
      this.pending.set(id, frame => { clearTimeout(timer); this.pending.delete(id); resolve(frame); });
    });
    this.child.stdin.write(JSON.stringify({jsonrpc:'2.0', id, method, params}) + '\n');
    return answer;
  }
  async tool(name, args = {}) {
    const frame = await this.rpc('tools/call', {name, arguments:args}, 60000);
    if (frame.error) throw new Error(JSON.stringify(frame.error));
    return {payload:frame.result?.structuredContent || {}, screen:frame.result?.content?.[0]?.text || '', isError:frame.result?.isError, frame};
  }
  async stop() {
    this.child.stdin.end();
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
    await this.closed;
  }
  static async start(file, env) {
    const wire = new Wire(spawn(process.execPath, [file], {env, cwd:path.dirname(file), windowsHide:true, stdio:['pipe','pipe','pipe']}));
    try {
      wire.init = await wire.rpc('initialize', {protocolVersion:'2025-06-18', capabilities:{}, clientInfo:{name:'smoke',version:'1'}});
      wire.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'}) + '\n');
      return wire;
    } catch (error) { await wire.stop(); throw error; }
  }
}
