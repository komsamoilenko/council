// Entry-level migration transactions. A-43's pair is atomic only after recovery.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {doctorProbe} from './verify-trust.mjs';
import platform from '../../src/platform/index.js';
import {readJSON,exists,linked,hostPaths,realFuture,under} from './survey.mjs';
import {sha256,entryHash,validateManifest} from './manifest.mjs';
import {buildPlan,publishPlan} from './planning.mjs';
import {planFileHash} from './report.mjs';
import {apply} from './apply.mjs';
import {verify} from './verify.mjs';
import {registrationEdit,registrationMatches} from './registration.mjs';
import {spliceJsonEntry} from './host-json.mjs';
import {councilSpan,tokenizeToml} from './tomlblock.mjs';
import {scanMarkers} from './markers.mjs';
import {safewrite,writeHostSplice} from './safewrite.mjs';
import {journal,readJournal,openJournals} from './journal.mjs';
import {backupFiles} from './backup.mjs';
import {acquireLock,releaseLock} from './lock.mjs';
import {requireTTY,confirm,streams} from './attended.mjs';
import {assertStoreShape} from './store-shape.mjs';
import {fail} from './dialogue.mjs';

const bytes=file=>exists(file)?fs.readFileSync(file):Buffer.alloc(0);
const json=value=>JSON.stringify(value,null,2)+'\n';
const source=fileURLToPath(new URL('../../src/',import.meta.url));
function tableRange(b) {
  const span=councilSpan(b);if(!span.ok)throw fail('E-TOML-CONFLICT');
  const scan=scanMarkers(b,{style:'hash',ignoreLines:tokenizeToml(b).ignoreLines});
  if(!scan.ok)throw fail('E-TOML-CONFLICT');
  if(scan.block&&span.headers.some(h=>h.start>=scan.block.start&&h.start<scan.block.end&&!(h.names[0]==='mcp_servers'&&h.names[1]==='council')))throw fail('E-TOML-CONFLICT');
  return scan.block?{start:scan.block.start,end:scan.block.end}:span.span;
}
function value(op,b=bytes(op.path)) {
  if(op.type==='file')return b.length?b.toString('base64'):null;
  if(op.host==='codex'){const r=tableRange(b);return r?b.subarray(r.start,r.end).toString('utf8'):null;}
  return b.length?JSON.parse(b.toString('utf8').replace(/^\ufeff/,'')).mcpServers?.[op.name]??null:null;
}
function edit(op,b,target) {
  if(op.host!=='codex')return spliceJsonEntry(b,op.name,target);
  const r=tableRange(b)||{start:b.length,end:b.length},body=Buffer.from(target||'');
  return {ok:true,bytes:Buffer.concat([b.subarray(0,r.start),body,b.subarray(r.end)]),oldRange:r,newRange:{start:r.start,end:r.start+body.length}};
}
const hash=value=>entryHash(value);
const opHash=(op,v)=>op.type==='file'?(v===null?null:sha256(Buffer.from(v,'base64'))):hash(op.host==='codex'&&typeof v==='string'?v.trimEnd():v);
async function checkPlan(p,ctx) {
  if(p.schema!==1||!p.migration||p.profile!==path.basename(ctx.dirs.profileDir)||!Array.isArray(p.ops)||!under(p.file,ctx.dirs.plans)||await linked(p.file,ctx))throw fail('E-USAGE','Invalid migration plan.');
  if(!path.isAbsolute(p.from)||path.basename(p.from)!=='council'||path.basename(path.dirname(p.from))!=='bin'||realFuture(path.dirname(path.dirname(p.from)))!==realFuture(p.vault)||await linked(p.from,ctx))throw fail('E-USAGE','Invalid previous install.');
  for(const op of p.ops) {
    if(await linked(op.path,ctx))throw fail('E-REPARSE-TARGET',op.path);
    if(op.type==='file') {
      if(![ctx.dirs.manifest,path.join(p.from,'FROZEN.md')].includes(op.path))throw fail('E-USAGE','Migration file out of scope.');
      if(op.after===null)throw fail('E-USAGE','Migration never deletes a file.');
      if(op.path===ctx.dirs.manifest)validateManifest(JSON.parse(Buffer.from(op.after,'base64')));
    }else if(op.type!=='host'||!['council','council-next'].includes(op.name)||!(hostPaths(ctx)[op.host]||[]).includes(op.path))throw fail('E-USAGE','Migration host out of scope.');
  }
}
async function publishOp(op,target,ctx,p) {
  const b=bytes(op.path);
  if(op.type==='file'){await safewrite(op.path,Buffer.from(target,'base64'),{exclusive:!exists(op.path)});return;}
  const e=edit(op,b,target);if(!e.ok)throw fail('E-HOST-WRITE');
  const writer=async(file,content)=>{
    if(op.host!=='claude-code'||op.surgical){await safewrite(file,content);return;}
    const cli=p.claude;
    if(!cli||!path.isAbsolute(cli)||/\.(cmd|bat|ps1)$/i.test(cli))throw fail('E-CMD-SHIM');
    // Every remove and add is a separate durable intent. council-next stays last.
    const args=target===null?['mcp','remove',op.name,'-s','user']:['mcp','add-json',op.name,JSON.stringify(target),'-s','user'];
    if(ctx.run(cli,args).status!==0)throw fail('E-HOST-WRITE','Claude Code migration command failed.');
  };
  const backup=readJournal(path.join(ctx.dirs.journal,path.basename(p.file,'.json')+'.jsonl')).records.find(r=>r.t==='backup'&&r.path===op.path)?.backup;
  await writeHostSplice(op.path,b,e,{dryRun:false,backup,writer,serializedByHost:op.host==='claude-code'&&!op.surgical,verify:live=>opHash(op,value(op,live))===opHash(op,target),recover:live=>edit(op,live,value(op,b))});
}
export async function resumeMigration(p,ctx,{reverse=false,confirmed=false}={}) {
  await checkPlan(p,ctx);
  const ts=path.basename(p.file,'.json'),file=path.join(ctx.dirs.journal,ts+'.jsonl');
  const state=exists(file)?readJournal(file):null;
  if(state?.corrupt||state&&state.records[0].plan_sha256!==planFileHash(p))throw fail('E-JOURNAL-OPEN','Migration journal does not match its plan.');
  if(state&&!state.open&&!reverse)return {phase:p.phase,unchanged:true,exitCode:0};
  if(openJournals(ctx.dirs.journal).some(j=>j.path!==file&&j.path!==p.recovery_of&&!(reverse&&j.path===path.join(ctx.dirs.journal,ts+'-recovery.jsonl'))))throw fail('E-JOURNAL-OPEN');
  if(!confirmed&&!await confirm(ctx,reverse?'Roll back this migration step?':'Resume this migration step?'))return {exitCode:5};
  const lock=await acquireLock(ctx.dirs.etc,ctx.lockOptions);if(!lock.ok)throw Object.assign(new Error(lock.reason),lock);
  try {
    if(reverse) {
      const recoveryFile=path.join(ctx.dirs.plans,ts+'-recovery.json');
      if(exists(recoveryFile)){await releaseLock(lock,ctx.lockOptions);return resumeMigration(readJSON(recoveryFile),ctx,{confirmed:true});}
      const ops=[],firsts=p.ops.filter((o,i)=>!p.ops.slice(0,i).some(n=>n.path===o.path&&n.name===o.name));
      const add=(op,before,after)=>ops.push({...op,before,after});
      // Restore the coverage entry before touching the primary Claude Code entry.
      firsts.sort((a,b)=>(a.type==='file'?2:a.name==='council-next'?0:1)-(b.type==='file'?2:b.name==='council-next'?0:1));
      for(const original of firsts) {
        if(original.type==='file'&&original.before===null)continue;
        const current=value(original),target=original.before;
        if(opHash(original,current)===opHash(original,target))continue;
        const variants=p.ops.filter(o=>o.path===original.path&&o.name===original.name).flatMap(o=>[o.before,o.after]);
        if(!variants.some(v=>opHash(original,v)===opHash(original,current)))throw fail('E-PLAN-STALE','Human edit blocks migration recovery.');
        add({...original,surgical:original.type==='host'},current,target);
      }
      const recovery={...p,file:recoveryFile,ops,rollback:true,recovery_of:file};
      await safewrite(recovery.file,json(recovery),{exclusive:true});
      const rj=journal(path.join(ctx.dirs.journal,ts+'-recovery.jsonl'));
      await rj.before({t:'begin',plan_sha256:planFileHash(recovery),plan:recovery.file,migration:true});
      for(const [i,o] of ops.entries())await rj.before({t:'pre',path:o.path,op:i,sha256_before:opHash(o,o.before),sha256_expected:opHash(o,o.after)});
      if(state?.open)await journal(file).before({t:'commit',outcome:'recovery_pending',recovery:recovery.file});
      await releaseLock(lock,ctx.lockOptions);return resumeMigration(recovery,ctx,{confirmed:true});
    }
    const j=journal(file),records=state?.records||[];
    if(!state) {
      await j.before({t:'begin',plan_sha256:planFileHash(p),plan:p.file,migration:true,profile:p.profile});
    }
    {
      const recorded=readJournal(file).records;
      const targets=[...new Set(p.ops.map(o=>o.path))];
      const files=[];
      for(const [i,f] of targets.entries()) {
        if(!exists(f))continue;
        const backup=recorded.find(r=>r.t==='backup'&&r.path===f);
        if(backup) {
          if(exists(backup.backup)){if(sha256(bytes(backup.backup))!==backup.sha256_before)throw fail('E-PLAN-STALE','Migration backup changed.');continue;}
          if(sha256(bytes(f))!==backup.sha256_before)throw fail('E-PLAN-STALE','Interrupted backup source changed.');
        }
        files.push({source:f,mirror:path.join('migration',String(i)+'-'+path.basename(f))});
      }
      if(files.length)await backupFiles({etc:ctx.dirs.etc,profile:p.profile,timestamp:ts,vault:p.vault,files,platform:ctx.platform||platform,journal:j});
    }
    // All intents, including both halves of council-next removal, precede any edit.
    for(const [i,op] of p.ops.entries())if(!records.some(r=>r.t==='pre'&&r.op===i))await j.before({t:'pre',path:op.path,op:i,sha256_before:opHash(op,op.before),sha256_expected:opHash(op,op.after)});
    if(p.recovery_of&&readJournal(p.recovery_of).open)await journal(p.recovery_of).before({t:'commit',outcome:'recovery_pending',recovery:p.file});
    for(const [i,op] of p.ops.entries()) {
      const actual=value(op),posts=readJournal(file).records;
      // A later operation on this entry may already have superseded this intent.
      if(posts.some(r=>r.t==='post'&&r.op===i))continue;
      if(opHash(op,actual)!==opHash(op,op.after)) {
        if(opHash(op,actual)!==opHash(op,op.before))throw fail('E-PLAN-STALE','Migration entry changed; human review required.');
        await ctx.migrationMutation?.('pre',i,op);
        await publishOp(op,op.after,ctx,p);
        await ctx.migrationMutation?.('written',i,op);
      }
      if(opHash(op,value(op))!==opHash(op,op.after))throw fail('E-HOST-READBACK');
      await j.before({t:'post',path:op.path,op:i,sha256_after:opHash(op,op.after)});
    }
    for(const op of p.ops.filter((o,i)=>!p.ops.slice(i+1).some(n=>n.path===o.path&&n.name===o.name)))if(opHash(op,value(op))!==opHash(op,op.after))throw fail('E-HOST-READBACK');
    await j.before({t:'commit'});
    return {phase:p.phase,host:p.host||null,rollback:!!p.rollback,changed:p.ops.map(o=>o.path+(o.name?' :: '+o.name:'')),journal:file,exitCode:0};
  }finally{await releaseLock(lock,ctx.lockOptions);}
}
async function transaction(p,ctx,options) {
  await checkPlan(p,ctx);
  const {output}=streams(ctx);output.write('Migration '+(p.rollback?'rollback':'phase '+p.phase+(p.host?' · '+p.host:''))+'\n');
  for(const op of p.ops)output.write('WILL '+(op.before===null?'CREATE ':'REWRITE ')+op.path+(op.name?' :: '+op.name:'')+'\n');
  if(options['dry-run'])return {dryRun:true,phase:p.phase,operations:p.ops.map(o=>({path:o.path,name:o.name})),exitCode:0};
  if(!await confirm(ctx,'Perform this migration step?'))return {exitCode:5};
  await safewrite(p.file,json(p),{exclusive:true});
  return resumeMigration(p,ctx,{confirmed:true});
}
export async function migrate(options,ctx) {
  if(options.phase!==undefined&&!/^[0-3]$/.test(String(options.phase)))throw fail('E-USAGE','--phase must be 0, 1, 2 or 3.');
  const m=readJSON(ctx.dirs.manifest),config=readJSON(ctx.dirs.config);
  const from=path.resolve(options.from||m?.migration?.from||(config?.vault?path.join(config.vault,'bin','council'):''));
  const vault=path.dirname(path.dirname(from)),phase=options.phase===undefined?null:Number(options.phase);
  if(!options.from&&!config||path.basename(from)!=='council'||path.basename(path.dirname(from))!=='bin'||!exists(path.join(from,'server.js'))||await linked(from,ctx))throw fail('E-USAGE','--from must name the previous vault/bin/council installation.');
  if(config&&realFuture(config.vault)!==realFuture(vault))throw fail('E-PROFILE-EXISTS');
  const pending=openJournals(ctx.dirs.journal);
  if(pending.length) {
    if(options['dry-run'])return {dryRun:true,open_journals:pending.map(j=>j.path),exitCode:5};
    const recovery=pending.find(j=>readJSON(j.records[0]?.plan)?.recovery_of);
    if(options.rollback&&recovery){const restored=await resumeMigration(readJSON(recovery.records[0].plan),ctx);return restored.exitCode?restored:migrate(options,ctx);}
    if(options.rollback&&pending.length===1&&pending[0].records[0]?.migration){const plan=readJSON(pending[0].records[0].plan);const restored=await resumeMigration(plan,ctx,{reverse:!plan.recovery_of});return restored.exitCode?restored:migrate(options,ctx);}
    throw fail('E-JOURNAL-OPEN');
  }
  const {output}=streams(ctx);
  const oldAgy=readJSON(path.join(from,'config.json'),{}).gemini?.provider==='agy';
  const reportAgy=async()=>{
    if(!oldAgy)return;
    const state=(await doctorProbe(ctx)).agy;
    if(!state.ok&&/^agy_[a-z_]+$/.test(state.reason))output.write('gemini: '+state.reason+' — see NOTICE.md\n');
  };
  if(config)await reportAgy();
  if(phase===0&&!options.rollback) {
    assertStoreShape(from,source);
    const old=readJSON(path.join(from,'config.json'),{});
    for(const [key,expected] of [['jobs_dir','work/jobs'],['ledger_dir','ledger']])if(path.resolve(vault,old.layout?.[key]||expected)!==path.resolve(vault,expected))throw fail('E-USAGE','Previous store layout needs explicit review.');
    output.write('Phase 0: snapshot the vault with your own version-control workflow before continuing.\n');
    const built=await buildPlan({vault,'large-vault':true,profile:options.profile||'default',merge:'none',hosts:'none',conventions:false,'relocate-runtime':false,json:true},ctx);
    // Only the pointer may be published in the old vault, even if a contract is missing.
    for(const step of built.plan.steps)if(step.id==='S6')step.writes=step.writes.filter(w=>w.path===path.join(vault,'.council','vault.json')||w.directory&&under(path.join(vault,'.council','vault.json'),w.path));
    built.plan.file_sha256=planFileHash(built.plan);
    if(options['dry-run'])return {phase:0,dryRun:true,plan:built.plan,exitCode:0};
    requireTTY(ctx);await publishPlan(built);const r=await apply({plan:built.plan.file},ctx);
    if(!config&&r.exitCode===0)await reportAgy();
    return {phase:0,changed:r.changed,registered:[],journal:r.journal,exitCode:r.exitCode};
  }
  if(!m)throw fail('E-NO-MANIFEST');validateManifest(m);
  if(phase===1&&!options.rollback) {
    if(m.registrations.some(r=>r.name==='council-next'))return {phase:1,unchanged:true,exitCode:0};
    if(options['dry-run'])return {phase:1,dryRun:true,steps:['verify','plan --hosts claude-code --register-as council-next','apply'],exitCode:0};
    requireTTY(ctx);const checked=await (ctx.migrationVerify||verify)({profile:m.profile},{...ctx,verifyUnregistered:true});if(checked.exitCode)throw fail('E-TIER0-FAILED');
    const built=await buildPlan({vault,'large-vault':true,profile:m.profile,merge:'none',hosts:'claude-code','register-as':'council-next',conventions:false,json:true},ctx);
    if(built.plan.registrations.length!==1)throw fail('E-USAGE','Claude Code is required for side-by-side proof.');
    await publishPlan(built);const r=await apply({plan:built.plan.file},ctx);
    return {phase:1,journal:r.journal,registered:['claude-code :: council-next'],next:'Compare council_doctor on both servers; run an echo consultation through council-next (zero quota).',exitCode:r.exitCode};
  }
  const machine=readJSON(ctx.dirs.machine),ts=ctx.now().toISOString().replace(/[^0-9]/g,'')+'-migrate';
  const p={schema:1,migration:true,profile:m.profile,phase,host:options.host,rollback:!!options.rollback,from,vault,claude:machine?.binaries?.claude,file:path.join(ctx.dirs.plans,ts+'.json'),ops:[]};
  const next=structuredClone(m);next.migration={...m.migration,from};
  const hostOp=(host,file,name,before,after)=>p.ops.push({type:'host',host,path:file,name,before,after});
  if(options.rollback) {
    // A phase-2/Claude rollback before cutover means remove the side-by-side entry only.
    const onlyNext=phase===2&&options.host==='claude-code'&&!m.migration?.hosts?.includes('claude-code');
    const selected=m.registrations.filter(r=>(!onlyNext||r.name==='council-next')&&(r.name==='council-next'||r.pre_existing_entry||r.pre_existing_table));
    for(const r of selected) {
      const op={type:'host',host:r.host,path:r.file,name:r.name},before=value(op);
      if(!registrationMatches(bytes(r.file),r))throw fail('E-PLAN-STALE','Registration changed since migration.');
      const target=r.host==='codex'?r.pre_existing_table:r.pre_existing_entry;
      hostOp(r.host,r.file,r.name,before,target);p.ops.at(-1).surgical=true;
    }
    next.registrations=next.registrations.filter(r=>!selected.some(s=>s.file===r.file&&s.name===r.name));next.migration.hosts=[];
  }else if(phase===2) {
    const order=['codex','claude-desktop','claude-code'],host=options.host;
    if(!order.includes(host))throw fail('E-USAGE','Phase 2 requires one --host.');
    if(m.migration?.hosts?.includes(host))return {phase,host,unchanged:true,exitCode:0};
    if(!m.registrations.some(r=>r.name==='council-next'))throw fail('E-USAGE','Run Phase 1 first.');
    if(order.slice(0,order.indexOf(host)).some(h=>!m.migration?.hosts?.includes(h)))throw fail('E-USAGE','Cut over Codex, then Claude Desktop, then Claude Code.');
    const files=hostPaths(ctx)[host].filter(exists);if(files.length!==1)throw fail('E-USAGE','Migration needs one unambiguous host configuration.');
    const file=files[0],before=bytes(file),op={type:'host',host,path:file,name:'council'},old=value(op);
    if(old===null||(host!=='codex'&&old.args?.[0]!==path.join(from,'server.js')))throw fail('E-HOST-NAME-TAKEN','Expected previous council registration.');
    if(host==='codex'&&!old.includes(JSON.stringify(path.join(from,'server.js'))))throw fail('E-HOST-NAME-TAKEN','Expected previous council table.');
    const descriptor={surface:host,path:file,name:'council',command:ctx.node,args:[ctx.dirs.launcher],env:{COUNCIL_HOST:host,COUNCIL_PROFILE:m.profile},adoptExisting:true};
    const changed=registrationEdit(descriptor,before),target=value(op,changed.edit.bytes);
    if(host==='claude-code'){hostOp(host,file,'council',old,null);hostOp(host,file,'council',null,target);}else hostOp(host,file,'council',old,target);
    const backup=path.join(ctx.dirs.backups,ts,'migration','0-'+path.basename(file));
    next.registrations.push({...changed.record,backup});next.migration.hosts=[...(m.migration?.hosts||[]),host];
    if(host==='claude-code') {
      const r=m.registrations.find(r=>r.name==='council-next'&&r.file===file);
      if(!r||!registrationMatches(before,r))throw fail('E-PLAN-STALE','Side-by-side registration changed.');
      hostOp(host,file,'council-next',value({...op,name:'council-next'}),null);
      next.registrations=next.registrations.filter(r=>r.name!=='council-next');
    }
  }else if(phase===3) {
    if(!['codex','claude-desktop','claude-code'].every(h=>m.migration?.hosts?.includes(h)))throw fail('E-USAGE','Complete all cutovers before freezing.');
    const file=path.join(from,'FROZEN.md');if(exists(file))return {phase:3,unchanged:true,leftovers:['Previous in-vault install retained; review each leftover separately.'],exitCode:0};
    const content='Snapshot of the previous in-vault install, frozen '+ctx.now().toISOString().slice(0,10)+'; the live server is '+ctx.dirs.app+'; nothing loads this directory.\n';
    p.ops.push({type:'file',path:file,before:null,after:Buffer.from(content).toString('base64')});
    next.entries.push({path:file,kind:'file',created:true,template:'frozen',sha256:sha256(content),removal:'never'});
    output.write('Leftovers (retained; decide per item):\n'+fs.readdirSync(from).map(n=>'  '+n).join('\n')+'\n');
  }else throw fail('E-USAGE','Specify --phase 0|1|2|3 or --rollback.');
  p.ops.push({type:'file',path:ctx.dirs.manifest,before:bytes(ctx.dirs.manifest).toString('base64'),after:Buffer.from(json(next)).toString('base64')});
  return transaction(p,ctx,options);
}
