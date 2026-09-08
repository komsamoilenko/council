// Isolated installed tree and fail-closed process/network interception; zero vendor quota.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
export const repo = path.resolve(import.meta.dirname, '../..');
export function files(dir) {
  return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e => {
    const p=path.join(dir,e.name); return e.isDirectory() ? files(p) : [p];
  });
}
export function put(p, bytes) { fs.mkdirSync(path.dirname(p),{recursive:true}); fs.writeFileSync(p,bytes); return p; }
export function json(p, value) { return put(p,JSON.stringify(value)); }
export function fixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'council-trust-'));
  const saved={...process.env}, restores=[];
  for(const k of Object.keys(process.env)) if(k.startsWith('COUNCIL_') || /^(GEMINI|GOOGLE|OPENAI|ANTHROPIC)_/.test(k)) delete process.env[k];
  for(const k of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','CODEX_HOME','CLAUDE_CONFIG_DIR']) {
    process.env[k]=path.join(root,k.toLowerCase()); fs.mkdirSync(process.env[k],{recursive:true});
  }
  let spawns=0, networks=0;
  for(const [mod,names] of [['child_process',['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']],['http',['request','get']],['https',['request','get']],['net',['connect','createConnection']],['tls',['connect']]]) {
    const object=require(mod);
    for(const name of names) { const old=object[name]; restores.push(()=>object[name]=old); object[name]=()=>{if(mod==='child_process') spawns++; else networks++; throw new Error('trust test blocked external I/O');}; }
  }
  const oldFetch=globalThis.fetch; restores.push(()=>globalThis.fetch=oldFetch);
  globalThis.fetch=()=>{networks++; throw new Error('trust test blocked network');};
  const platform=require('../../src/platform');
  const dirs=platform.appDirs(), app=path.join(dirs.root,'app','trust');
  fs.cpSync(path.join(repo,'src'),app,{recursive:true});
  const load=rel=>require(path.join(app,rel));
  const vault=path.join(root,'vault'), runtime=path.join(dirs.run,'default');
  fs.mkdirSync(vault,{recursive:true}); fs.mkdirSync(runtime,{recursive:true});
  const binaries={node:process.execPath,codex_js:path.join(app,'backends','echo.js')};
  const config={schema:2,vault,runtime_root:runtime,binaries,gemini:{provider:'agy'},layout:{work_dir:'work',jobs_dir:'work/jobs',ledger_dir:'ledger'}};
  const configPath=json(path.join(dirs.etc,'profiles','default','config.json'),config);
  json(path.join(dirs.etc,'machine.json'),{schema:2,binaries});
  json(path.join(path.dirname(configPath),'accounts.json'),{accounts:{echo:{label:'trusted'}}});
  const manifest=path.join(dirs.etc,'manifests','app-'+load('version.js').APP_VERSION+'.json');
  json(manifest,{files:Object.fromEntries(files(app).map(p=>[path.relative(app,p).split(path.sep).join('/'),crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')]))});
  return {root,app,dirs,vault,runtime,binaries,config,configPath,manifest,load,
    get spawns(){return spawns;},get networks(){return networks;},
    close(){for(const restore of restores.reverse())restore(); for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k]; Object.assign(process.env,saved); for(const k of Object.keys(require.cache))if(k.startsWith(app+path.sep))delete require.cache[k]; fs.rmSync(root,{recursive:true,force:true});}
  };
}
