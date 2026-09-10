// Installer trust facts come only from the installed runtime's stdio doctor (A-48).
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {context,nativeProbe,readJSON,exists,linked,under} from './survey.mjs';
import platform from '../../src/platform/index.js';
import {safewrite} from './safewrite.mjs';

export async function doctorProbe(ctx) {
  const started=Date.now(), attributes=new Map();
  // Shared ancestors need one attribute probe per validation pass. Cleanup gets
  // fresh attributes; linked still lstat-checks every ancestor on every call.
  const scope={...ctx,attributes:async file=>{
    if(!attributes.has(file))attributes.set(file,await ctx.attributes(file));
    return attributes.get(file);
  }};
  const prefetch=targets=>{
    if(ctx.probe!==nativeProbe||ctx.dirs.id!=='win32')return;
    const files=new Set();
    for(const target of targets)for(let p=path.resolve(target);;p=path.dirname(p)){
      if(exists(p))files.add(p);
      if(path.dirname(p)===p)break;
    }
    const list=[...files],probes=list.map(file=>platform.fileAttributesProbe(file,ctx.env));
    const first=probes[0];if(!first)return;
    if(probes.some(p=>p.file!==first.file||JSON.stringify(p.args.slice(0,-1))!==JSON.stringify(first.args.slice(0,-1))))throw new Error('attribute_probe_mismatch');
    const command="$ErrorActionPreference='Stop'; @("+probes.map(p=>'(& { '+p.args.at(-1)+' })').join('\n')+') | ConvertTo-Json -Compress';
    const result=ctx.run(first.file,[...first.args.slice(0,-1),command],{timeout:4000});
    if(result.status!==0)throw new Error('attribute_probe_failed');
    const bits=JSON.parse(result.stdout);
    if(!Array.isArray(bits)||bits.length!==list.length||bits.some(n=>!Number.isFinite(n)))throw new Error('attribute_probe_payload');
    list.forEach((file,i)=>attributes.set(file,{bits:bits[i]}));
  };
  const d=ctx.dirs,config=readJSON(d.config),current=readJSON(d.current);
  if(!config||!current?.version)throw new Error('profile_not_installed');
  const expand=s=>String(s||'').replace(/%([^%]+)%/g,(_,k)=>k==='COUNCIL_VAULT'?config.vault:k==='COUNCIL_APP'?path.join(d.root,'app',current.version):ctx.env[k]||'%'+k+'%');
  const vault=expand(config.vault),runtime=expand(config.runtime_root);
  const jobs=path.resolve(vault,expand(config.layout?.jobs_dir||'work/jobs'));
  const ledger=path.resolve(vault,expand(config.layout?.ledger_dir||'ledger'));
  if(!path.isAbsolute(vault)||!path.isAbsolute(runtime)||under(runtime,vault)||under(d.root,vault)||under(vault,d.root))throw new Error('zone_separation_failed');
  for(const p of [jobs,ledger])if(!under(p,vault)&&!under(p,runtime))throw new Error('derived_root_failed');
  const sandbox=path.join(runtime,'sandbox');
  const directories=[jobs,path.join(jobs,'.idem'),ledger,runtime,sandbox,...['claude','codex','gemini','echo'].map(x=>path.join(sandbox,x))];
  prefetch([...directories,d.launcher]);
  for(const p of directories)
    if(!exists(p)||!fs.statSync(p).isDirectory()||await linked(p,scope))throw new Error('unsafe_runtime_directory');
  if(await linked(d.launcher,scope))throw new Error('unsafe_launcher');
  const names=[...new Set([new Date(),new Date(Date.now()+60000)].map(date=>'verify-council-'+date.toISOString().slice(0,7)+'.jsonl').concat(['verify-ledger-errors.log','verify-spawns.jsonl']))];
  const owned=[];
  try {
    if(names.some(n=>exists(path.join(ledger,n))))throw new Error('existing_probe_ledger');
    if(Date.now()-started>=10000)throw new Error('doctor_probe_timeout');
    for(const name of names){const file=path.join(ledger,name);await safewrite(file,'',{exclusive:true});owned.push({file,ino:fs.statSync(file).ino});}
    return await new Promise((resolve,reject)=>{
      const env={...ctx.env,COUNCIL_PROFILE:path.basename(d.profileDir),COUNCIL_HOST:ctx.env.COUNCIL_HOST||'claude-code',COUNCIL_LEDGER_PREFIX:'verify-',COUNCIL_SMOKE_RUN:'1'};
      delete env.COUNCIL_CONFIG;
      const child=spawn(ctx.node,[d.launcher],{env,cwd:runtime,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
      let buffer='',report,error;
      const stop=e=>{error||=e;child.stdin.end();if(e)child.kill();};
      // Leave cleanup time inside the caller's 15-second native-probe deadline.
      const timer=setTimeout(()=>stop(new Error('doctor_probe_timeout')),Math.max(1,10000-(Date.now()-started)));
      child.once('error',e=>{clearTimeout(timer);reject(e);});
      child.stderr.resume();child.stdin.on('error',e=>{if(e.code!=='EPIPE')stop(e);});
      child.once('close',(code,signal)=>{clearTimeout(timer);if(!report||code!==0||signal)error||=new Error('doctor_probe_exit');error?reject(error):resolve(report);});
      const send=x=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',...x})+'\n');
      child.stdout.on('data',data=>{
        buffer+=data;if(buffer.length>2*1024**2)return stop(new Error('doctor_probe_size'));
        for(let i;(i=buffer.indexOf('\n'))>=0;) {
          const line=buffer.slice(0,i);buffer=buffer.slice(i+1);
          try {
            const msg=JSON.parse(line);if(msg.error)throw new Error('doctor_probe_rpc');
            if(msg.id===1){if(!msg.result?.protocolVersion)throw new Error('doctor_probe_initialize');send({method:'notifications/initialized'});send({id:2,method:'tools/call',params:{name:'council_doctor',arguments:{deep:true}}});}
            if(msg.id===2) {
              const doc=msg.result?.structuredContent;
              if(typeof doc?.config?.trust?.ok!=='boolean'||!Array.isArray(doc.config.trust.failures)||!Array.isArray(doc.config.trust.allowed_roots)||typeof doc.agy?.reason!=='string')throw new Error('doctor_probe_payload');
              if(doc.profile!==env.COUNCIL_PROFILE||doc.vault?.path!==vault||doc.layout?.jobs_dir!==jobs||doc.layout?.ledger_dir!==ledger||doc.reaper!=='suppressed (COUNCIL_SMOKE_RUN)')throw new Error('doctor_probe_drift');
              report=doc;stop();
            }
          }catch(e){stop(e);}
        }
      });
      send({id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'council-verify',version:'0.1.0'}}});
    });
  } finally {
    attributes.clear();
    const failures=[];
    if(owned.length)prefetch(owned.map(item=>item.file));
    for(const {file,ino} of owned)try {
      if(path.dirname(file)!==ledger||await linked(file,scope)||fs.statSync(file).ino!==ino)throw new Error('identity_changed');
      fs.unlinkSync(file);
    }catch{failures.push(file);}
    if(failures.length)throw new Error('doctor_probe_cleanup_left: '+failures.join(', '));
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const doc=await doctorProbe(context({profile:process.env.COUNCIL_PROFILE||'default'}));
    const trust=doc.config.trust;
    process.stdout.write(JSON.stringify({ok:trust.ok,failures:trust.failures,allowed_roots:trust.allowed_roots,agy:doc.agy})+'\n');
  }catch(e){process.stderr.write(e.message+'\n');process.exitCode=1;}
}
