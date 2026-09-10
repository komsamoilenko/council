// Read-only integrity checks and isolated, bounded real-profile MCP probes (§7.5).
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {context,readJSON,exists,linked,under,hostPaths} from './survey.mjs';
import {readManifest,entryState} from './manifest.mjs';
import {registrationMatches} from './registration.mjs';
import {scanMarkers} from './markers.mjs';
import {tokenizeToml} from './tomlblock.mjs';
import {safewrite} from './safewrite.mjs';
import {tier0} from './apply.mjs';
import {NOTICE} from './report.mjs';
import integrity from '../../src/lib/integrity.js';
import redact from '../../src/lib/redact.js';
import platform from '../../src/platform/index.js';

export function registrationValue(r) {
  const bytes=fs.readFileSync(r.file);
  if(r.host!=='codex')return JSON.parse(bytes.toString('utf8').replace(/^\ufeff/,'')).mcpServers?.[r.name];
  const scan=scanMarkers(bytes,{style:'hash',ignoreLines:tokenizeToml(bytes).ignoreLines});
  if(!scan.ok||!scan.block)throw new Error('registration_missing');
  const text=scan.block.body.toString('utf8');
  const value=key=>{const rows=text.split(/\r?\n/).filter(l=>new RegExp('^\\s*'+key+'\\s*=').test(l));if(rows.length!==1)throw new Error('invalid_registration');return JSON.parse(rows[0].slice(rows[0].indexOf('=')+1).trim());};
  return {command:value('command'),args:value('args'),env:{COUNCIL_HOST:value('COUNCIL_HOST'),COUNCIL_PROFILE:value('COUNCIL_PROFILE')}};
}
export async function verifyHandshake(r,ctx,expected) {
  const start=Date.now();
  return new Promise((resolve,reject)=>{
    const env={...ctx.env,...r.env,COUNCIL_LEDGER_PREFIX:'verify-',COUNCIL_SMOKE_RUN:'1'};delete env.COUNCIL_CONFIG;
    const child=spawn(r.command,r.args,{env,cwd:ctx.dirs.runtimeRoot,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let buffer='',error,report,ended=false;
    const stop=e=>{error||=e;child.stdin.end();if(e)child.kill();};
    const timer=setTimeout(()=>stop(new Error('E-VERIFY-SLOW: '+(Date.now()-start)+' ms; re-run when the machine is idle')),30000);
    child.once('error',e=>{clearTimeout(timer);reject(e);});
    child.stdin.on('error',e=>{if(e.code!=='EPIPE')stop(e);});child.stderr.resume();
    child.once('close',(code,signal)=>{
      clearTimeout(timer);const elapsed=Date.now()-start;
      if(elapsed>=30000)error=new Error('E-VERIFY-SLOW: '+elapsed+' ms; re-run when the machine is idle');
      if(!report||code!==0||signal)error||=new Error('verify_pipe_exit: '+code+' '+signal);
      error?reject(error):resolve({elapsed_ms:elapsed,doctor:report});
    });
    const send=x=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',...x})+'\n');
    child.stdout.on('data',data=>{
      buffer+=data;if(buffer.length>2*1024**2)return stop(new Error('verify_rpc_size'));
      for(let i;(i=buffer.indexOf('\n'))>=0;) {
        const line=buffer.slice(0,i);buffer=buffer.slice(i+1);
        try {
          const msg=JSON.parse(line);if(msg.error)throw new Error('verify_rpc_error');
          if(msg.id===1){if(!msg.result?.protocolVersion)throw new Error('verify_initialize');send({method:'notifications/initialized'});send({id:2,method:'tools/list'});}
          if(msg.id===2){if(!msg.result?.tools?.some(t=>t.name==='council_doctor'))throw new Error('verify_tools');send({id:3,method:'tools/call',params:{name:'council_doctor',arguments:{}}});}
          if(msg.id===3&&!ended) {
            if(msg.result?.isError)throw new Error('verify_doctor_error');
            report=msg.result.structuredContent;
            if(!report||typeof report!=='object')throw new Error('verify_doctor_payload_missing');
            if(report.mode!=='normal'||report.profile!==expected.profile||report.vault?.path!==expected.vault||report.layout?.jobs_dir!==expected.jobs||report.layout?.ledger_dir!==expected.ledger||report.reaper!=='suppressed (COUNCIL_SMOKE_RUN)')throw new Error('verify_doctor_drift');
            ended=true;stop();
          }
        }catch(e){stop(e);}
      }
    });
    send({id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'council-verify',version:'0.1.0'}}});
  });
}

export async function verify(options={},overrides={}) {
  const ctx=context({...overrides,profile:options.profile||'default'}),d=ctx.dirs;
  const result={profile:options.profile||'default',drift:[],warnings:[],registrations:[],created:[],cleanup_left:[],notice:NOTICE,
    note:'Direct server probes prove the server, not host wiring. Claude Desktop needs the project text and a full restart.',exitCode:0};
  // Verify must never call restrictToOwner: it changes permissions and creates probes.
  const backups=path.join(d.etc,'backups');
  if(exists(backups)) {
    let state;try{state=await (ctx.platform||platform).ownerAclState(backups,ctx.env,ctx.run);}catch{state={ok:false};}
    if(!state?.ok)result.warnings.push({reason:'backup_acl_not_restricted',path:backups,detail:'Owner-only ACL restriction could not be confirmed; protected only by the surrounding local application-data profile permissions.'});
  }
  if(!exists(d.manifest))return {...result,reason:'E-NO-MANIFEST',exitCode:4};
  if(await linked(d.manifest,ctx))return {...result,reason:'E-REPARSE-TARGET',exitCode:4};
  const m=readManifest(d.manifest),current=readJSON(d.current),config=readJSON(d.config),machine=readJSON(d.machine);
  const drift=x=>result.drift.push(x);
  if(!current?.version||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(current.version))return {...result,drift:['invalid_current'],exitCode:7};
  const app=path.join(d.root,'app',current.version);
  result.drift.push(...integrity.check(app,path.join(d.manifests,'app-'+current.version+'.json')).failures);
  if(!config||!machine)return {...result,drift:[...result.drift,'profile_missing'],exitCode:7};
  const expand=s=>String(s||'').replace(/%([^%]+)%/g,(_,k)=>k==='COUNCIL_VAULT'?config.vault:k==='COUNCIL_APP'?app:ctx.env[k]||'%'+k+'%');
  const vault=expand(config.vault),runtime=expand(config.runtime_root),jobs=path.resolve(vault,expand(config.layout?.jobs_dir||'work/jobs')),ledger=path.resolve(vault,expand(config.layout?.ledger_dir||'ledger'));
  if(vault!==m.vault.path||runtime!==m.runtime_root||under(runtime,vault)||under(d.root,vault)||under(vault,d.root))drift('zone_separation_failed');
  for(const p of [jobs,ledger])if((!under(p,vault)&&!under(p,runtime))||await linked(p,ctx))drift('derived_root_failed:'+p);
  for(const [name,doc] of [['config',config],['machine',machine],['accounts',readJSON(d.accounts,{})]])for(const key of redact.findSecrets(doc))drift('secret_in_config:'+name+'.'+key);
  // Run the existing trust checker in the profile's own environment, without booting.
  const probeFile=new URL('./verify-trust.mjs',import.meta.url);
  try {
    const check=ctx.trustCheck?await ctx.trustCheck():ctx.run(ctx.node,[fileURLToPath(probeFile)],{env:{...ctx.env,COUNCIL_PROFILE:m.profile,COUNCIL_CONFIG:''}});
    if(check.status!==0)drift('config_trust_check_failed');else {const parsed=JSON.parse(check.stdout);result.trust=parsed;for(const f of parsed.failures||[])drift(f.key+':'+f.reason);}
  }catch{drift('config_trust_check_failed');}
  result.agy=result.trust?.agy||{reason:'policy_check_unavailable',notice:'see NOTICE.md'};
  for(const e of [...m.entries,...m.registrations]) {
    try{if(entryState(e,m).state!=='unchanged')drift('manifest_hash_failed:'+(e.path||e.file));}catch{drift('manifest_hash_failed:'+(e.path||e.file));}
  }
  const registrations=[];
  for(const r of m.registrations) {
    try {
      if(!(hostPaths(ctx)[r.host]||[]).includes(r.file)||await linked(r.file,ctx))throw new Error('out_of_scope');
      const value=registrationValue(r);
      if(value.command!==ctx.node||/\.(cmd|bat|ps1)$/i.test(value.command)||value.args?.length!==1||value.args[0]!==d.launcher||value.env?.COUNCIL_HOST!==r.host||value.env?.COUNCIL_PROFILE!==m.profile||Object.keys(value.env).some(k=>!['COUNCIL_HOST','COUNCIL_PROFILE'].includes(k)))throw new Error('E_SHIM_REGISTRATION');
      if(!registrationMatches(fs.readFileSync(r.file),r))throw new Error('registration_hash_failed');
      registrations.push({r,value});
    }catch(e){drift(e.message+':'+r.host);}
  }
  if(ctx.verifyUnregistered&&!registrations.length)registrations.push({r:{host:'migration-proof'},value:{command:ctx.node,args:[d.launcher],env:{COUNCIL_HOST:'claude-code',COUNCIL_PROFILE:m.profile}}});
  // Missing runtime dirs are drift: boot would otherwise create non-ledger state.
  const sandbox=path.join(runtime,'sandbox');
  if(registrations.length)for(const p of [jobs,path.join(jobs,'.idem'),ledger,runtime,sandbox,...['claude','codex','gemini','echo'].map(x=>path.join(sandbox,x))])if(!exists(p)||await linked(p,ctx))drift('runtime_directory_'+'missing_or_unsafe:'+p);
  if(!result.drift.length) {
    try{result.tier0=await (ctx.tier0||tier0)({...ctx,dirs:{...d,app},verifyMode:true,full:options.full});}catch(e){drift(e.message);}
  }
  if(!result.drift.length&&registrations.length) {
    // Reserve exact names exclusively before boot; existing verify rows are never adopted.
    const dates=[new Date(),new Date(Date.now()+Math.max(60000,registrations.length*35000))];
    const names=[...new Set([...dates.map(date=>'verify-council-'+date.toISOString().slice(0,7)+'.jsonl'),'verify-ledger-errors.log','verify-spawns.jsonl'])];
    const owned=[];
    try {
      if(names.some(n=>exists(path.join(ledger,n))))throw new Error('existing_verify_'+'ledger_preserved');
      for(const name of names){const file=path.join(ledger,name);await safewrite(file,'',{exclusive:true});owned.push({file,ino:fs.statSync(file).ino});result.created.push(file);}
      for(const {r,value} of registrations)try {const report=await (ctx.verifyHandshake||verifyHandshake)(value,{...ctx,dirs:{...d,runtimeRoot:runtime}},{profile:m.profile,vault,jobs,ledger});result.registrations.push({host:r.host,...report});}catch(e){drift(e.message+':'+r.host);}
    }catch(e){drift(e.message);}finally {
      for(const {file,ino} of owned)try{if(path.dirname(file)!==ledger||await linked(file,ctx)||fs.statSync(file).ino!==ino)throw new Error('identity_changed');fs.unlinkSync(file);}catch(e){result.cleanup_left.push({path:file,reason:e.code||e.message});}
    }
  }
  result.exitCode=result.drift.length||result.cleanup_left.length?7:0;return result;
}
