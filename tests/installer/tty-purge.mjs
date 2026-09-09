// Attended integration driven via a real PTY; all state is below OS temp.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {context} from '../../installer/lib/survey.mjs';
import {sha256} from '../../installer/lib/manifest.mjs';
import {uninstall} from '../../installer/lib/uninstall.mjs';
import {put} from './fixtures.mjs';
if(!process.stdin.isTTY||!process.stdout.isTTY)throw new Error('PTY required');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'council-purge-'));
const env={...process.env};
for(const key of Object.keys(env))if(key.startsWith('COUNCIL_'))delete env[key];
for(const key of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','CODEX_HOME','CLAUDE_CONFIG_DIR','XDG_STATE_HOME']) {env[key]=path.join(root,key.toLowerCase());fs.mkdirSync(env[key]);}
const ctx=context({env}),d=ctx.dirs,vault=path.join(root,'vault');fs.mkdirSync(vault);
put(d.manifest,JSON.stringify({schema:1,profile:'default',server_name:'council',app_version:'0.1.0',installed_at:'fixture',last_apply_at:'fixture',runtime_root:d.runtimeRoot,backups_dir:d.backups,plan_sha256:sha256('fixture'),vault:{path:vault,real:fs.realpathSync(vault),vault_id:'fixture'},entries:[],registrations:[],pending_hosts:[],left_alone:[],observed:{}}));
put(d.config,JSON.stringify({schema:2,vault,runtime_root:d.runtimeRoot,layout:{jobs_dir:d.jobs,ledger_dir:d.ledger}}));
put(path.join(d.secrets,'gemini.bin'),'DPAPI fixture');put(path.join(d.jobs,'job-1','state.json'),'{}');put(path.join(d.ledger,'council-fixture.jsonl'),'{}\n{}\n');
put(d.stop,'retain');put(d.agyGate,'inert fixture');put(path.join(d.sandbox,'echo','keep'),'retain');
console.log('Sandbox: '+root);
const result=await uninstall({'purge-runtime':true},ctx);
console.log(JSON.stringify(result,null,2));
assert.equal(result.exitCode,0);assert.equal(fs.existsSync(d.secrets),false);assert.equal(fs.existsSync(d.ledger),false);assert.equal(fs.existsSync(path.join(d.jobs,'job-1','state.json')),true);
assert.equal(fs.existsSync(d.stop)&&fs.existsSync(d.agyGate)&&fs.existsSync(d.sandbox),true);
console.log('--yes refusal: '+JSON.stringify(await uninstall({'purge-runtime':true,yes:true},ctx)));
console.log('non-TTY refusal: '+JSON.stringify(await uninstall({'purge-runtime':true},{...ctx,input:{isTTY:false},output:{isTTY:false}})));
console.log('PASS real PTY purge; declined jobs retained; STOP, agy-enabled, sandbox retained.');
console.log('Fixture retained: '+root);
