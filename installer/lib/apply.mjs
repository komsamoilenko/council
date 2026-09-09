// Owns the twelve-stage reversible installation transaction; specification §7.4.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import platform from '../../src/platform/index.js';
import integrity from '../../src/lib/integrity.js';
import { sanity } from './planning.mjs';
import { survey, fingerprint, readJSON, exists, linked, under, realFuture } from './survey.mjs';
import { fail } from './dialogue.mjs';
import { planFileHash, planReport, NOTICE } from './report.mjs';
import { probeVault } from './preflight.mjs';
import { acquireLock, releaseLock } from './lock.mjs';
import { journal, readJournal, openJournals } from './journal.mjs';
import { backupFiles } from './backup.mjs';
import { safewrite, writeSplice, byteEdit } from './safewrite.mjs';
import { sha256, validateManifest, entryState } from './manifest.mjs';
import { scanMarkers, hashBody } from './markers.mjs';
import { registrationEdit, publishRegistration, doctorHandshake, registrationMatches } from './registration.mjs';

export {byteEdit} from './safewrite.mjs';

const repo=fileURLToPath(new URL('../../',import.meta.url));
export const directoryHash=sha256('directory');
export function diskHash(file) {if(!exists(file))return null;return fs.statSync(file).isDirectory()?directoryHash:sha256(fs.readFileSync(file));}
export async function cleanupSetup(files,ledgerDir,ctx) {
  for(const file of files) {
    if(path.dirname(file)!==ledgerDir||!/^setup-(?:council-\d{4}-\d{2}\.jsonl|ledger-errors\.log|spawns\.jsonl)$/.test(path.basename(file))||await linked(file,ctx))throw new Error('unsafe_setup_cleanup');
    if(exists(file))fs.unlinkSync(file);
  }
}
async function finishCleanup(file,records,ledgerDir,ctx) {
  // Backup helpers also append records; disk is the authoritative complete stream.
  const state=readJournal(file);
  if(state.corrupt||state.open)throw new Error('cleanup requires committed journal');
  records=state.records;
  if(records.at(-1)?.cleanup_done)return;
  await cleanupSetup(records[0].setup_files||[],ledgerDir,ctx);
  records[records.length-1]={...records.at(-1),cleanup_done:true};
  await safewrite(file,records.map(r=>JSON.stringify(r)+'\n').join(''));
}
export async function validatePlan(plan,ctx) {
  if(plan.schema!==1||plan.profile!==ctx.dirs.profileDir.split(path.sep).at(-1)||!Array.isArray(plan.steps)||!Array.isArray(plan.registrations))throw fail('E-USAGE','Invalid plan/profile.');
  const hosts=Object.values((await import('./survey.mjs')).hostPaths(ctx)).flat();
  for(const w of plan.steps.flatMap(s=>s.writes||[])) {
    if(!path.isAbsolute(w.path)||(!under(w.path,ctx.dirs.root)&&!under(w.path,plan.answers.vault)&&!hosts.includes(w.path)&&!(w.directory&&(under(ctx.dirs.root,w.path)||under(plan.answers.vault,w.path)))))throw fail('E-USAGE','Out-of-scope plan path: '+w.path);
    if(await linked(w.path,ctx))throw fail('E-REPARSE-TARGET',w.path);
    if(w.backup&& !under(w.backup,ctx.dirs.backups))throw fail('E-USAGE','Invalid backup path.');
  }
  for(const s of plan.steps)for(const w of s.writes)if(hosts.includes(w.path)&&s.id!=='S8')throw fail('E-USAGE','Host edits belong only to S8.');
  for(const w of plan.steps.flatMap(s=>s.writes))if(hosts.includes(w.path)&&(!plan.registrations.some(r=>r.path===w.path)||w.content!==undefined))throw fail('E-USAGE','Host writes require a registration descriptor, never file content.');
  for(const r of plan.registrations)if(!hosts.includes(r.path)||r.command!==ctx.node||r.args?.[0]!==ctx.dirs.launcher||r.env?.COUNCIL_PROFILE!==plan.profile)throw fail('E-USAGE','Invalid registration.');
}
export async function tier0(ctx) {
  return new Promise((resolve,reject)=>{
    const env={...ctx.env,COUNCIL_SMOKE_TMP:os.tmpdir()};
    const child=spawn(ctx.node,[path.join(repo,'tests','tier0','smoke.mjs'),'--fast','--app',ctx.dirs.app],{env,cwd:repo,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
    child.on('error',reject);child.on('exit',code=>code===0?resolve(output):reject(Object.assign(new Error('S7 failed\n'+output),{exitCode:1})));
  });
}
export function applyReport(result) {
  if(result.dryRun)return planReport(result.plan);
  return [`council-setup 0.1.0 · apply (profile: ${result.profile})`,NOTICE,
    result.unchanged?`no changes (${result.verified} entries verified)`:`Completed S0–S11; ${result.changed.length} paths published.`,
    `Registered and verified: ${result.registrations.map(r=>r.host).join(', ')||'none'}`,
    ...result.backups.map(b=>'Whole-file backup (human recovery only for hosts): '+b.backup),
    ...result.warnings.map(w=>'WARNING: '+(typeof w==='string'?w:JSON.stringify(w))+(w.reason==='backup_acl_not_restricted'?' — protected only by the surrounding local application-data profile permissions.':'')),
    `Pending hosts: ${result.pending_hosts.join(', ')||'none'}`,
    'Logins remain yours. Run: council-setup login --profile '+result.profile,
    'Claude Desktop registrations require a full quit and relaunch.',
    'Journal: '+result.journal,
    ...(result.proposals||[]).map(p=>'User edit retained; proposal: '+p.sibling+'\n--- '+p.path+'\n+++ '+p.sibling+'\n@@ -1,'+p.before.split('\n').length+' +1,'+p.after.split('\n').length+' @@\n'+p.before.split('\n').map(l=>'-'+l).join('\n')+'\n'+p.after.split('\n').map(l=>'+'+l).join('\n'))].join('\n')+'\n';
}

export async function apply(options,ctx) {
  if(!options.plan)throw fail('E-USAGE','apply requires --plan <file>.');
  const plan=readJSON(path.resolve(options.plan));if(!plan)throw fail('E-USAGE','Plan not found.');
  await validatePlan(plan,ctx);
  const hash=planFileHash(plan), timestamp=path.basename(plan.file,'.json');
  if(!/^[A-Za-z0-9_-]+$/.test(timestamp)||path.resolve(plan.file)!==path.resolve(options.plan))throw fail('E-USAGE','Invalid plan location.');
  const journalPath=path.join(ctx.dirs.journal,timestamp+'.jsonl');
  const old=exists(journalPath)?readJournal(journalPath):null;
  if(options['dry-run'])return {dryRun:true,plan};
  if(plan.registrations.some(r=>r.adoptExisting)&&!options['adopt-existing']&&!options['no-register'])throw fail('E-HOST-NAME-TAKEN','This plan needs explicit --adopt-existing confirmation.');
  if(!options.yes&&!options.resume) {
    const input=ctx.input||process.stdin,output=ctx.output||process.stderr;
    if(!input.isTTY)throw Object.assign(new Error('Plan confirmation requires --yes when unattended.'),{exitCode:5});
    const rl=readline.createInterface({input,output});
    try{if(!/^y(?:es)?$/i.test((await rl.question(planReport(plan)+'Apply this plan? [y/N] ')).trim()))throw Object.assign(new Error('Plan declined.'),{exitCode:5});}finally{rl.close();}
  }
  if(old&&!!old.records[0].no_register!==!!options['no-register'])throw fail('E-PLAN-STALE','Resume must preserve --no-register.');
  if(old?.corrupt||old&&old.records[0].plan_sha256!==hash)throw fail('E-PLAN-STALE','Journal/plan mismatch.');
  const previous=readJSON(ctx.dirs.manifest);
  if(previous)validateManifest(previous);
  const noPlannedChange=previous&&!old&&!plan.steps.filter(s=>['S3','S4','S5','S6','S8'].includes(s.id)).some(s=>s.writes.length);
  const same=noPlannedChange||previous?.plan_sha256===hash && old && !old.open && old.records.at(-1).outcome!=='rollback';
  if(same) {
    if([...previous.entries,...previous.registrations].some(e=>entryState(e,previous).state!=='unchanged'))throw fail('E-PLAN-STALE','Installed entries changed.');
    if(old)await finishCleanup(journalPath,old.records,path.resolve(plan.answers.vault,plan.layout.ledger_dir),ctx);
    const result={profile:plan.profile,unchanged:true,verified:previous.entries.length+previous.registrations.length,changed:[],registrations:previous.registrations,backups:[],warnings:previous.warnings||[],pending_hosts:previous.pending_hosts.map(p=>p.host),journal:previous.journal||journalPath};
    if(options.log)await writeLog(options.log,applyReport(result),ctx);
    return result;
  }
  if(old&&!old.open)throw fail('E-USAGE','This journal is already closed; create a new plan.');
  const opens=openJournals(ctx.dirs.journal);
  if(opens.some(j=>j.path!==journalPath)||old?.open&&!options.resume)throw fail('E-JOURNAL-OPEN',journalPath);
  const resume=!!old?.open;
  const ledgerDir=path.resolve(plan.answers.vault,plan.layout.ledger_dir);
  const now=ctx.now?.()||new Date();
  const months=[now,new Date(now.getTime()+86400000)].map(d=>d.toISOString().slice(0,7));
  const currentSetupFiles=[...new Set(months)].map(month=>path.join(ledgerDir,'setup-council-'+month+'.jsonl')).concat(['setup-ledger-errors.log','setup-spawns.jsonl'].map(n=>path.join(ledgerDir,n)));
  const setupFiles=[...new Set([...(old?.records[0].setup_files||[]),...currentSetupFiles])];
  if(plan.registrations.length&&!options['no-register']&&setupFiles.some(p=>!old?.records[0].setup_files?.includes(p)&&exists(p)))throw fail('E-USAGE','Existing setup ledger; retain it and resolve the prior run first.');
  const detected=await survey(plan.answers,ctx);
  if(!resume && fingerprint(detected,plan.answers['register-as']||'council').sha256!==plan.detect_fingerprint.sha256)throw fail('E-PLAN-STALE','Detection fingerprint changed.');
  const vaultInfo=await sanity(plan.answers.vault,ctx,plan.answers);
  const hostFiles=new Set(Object.values((await import('./survey.mjs')).hostPaths(ctx)).flat());
  const owned=p=>!hostFiles.has(p)&&(under(p,ctx.dirs.root)||under(p,plan.answers.vault)); 
  // Content guard is separate from the existence-only fingerprint (A-33).
  if(!resume)for(const w of plan.steps.flatMap(s=>s.writes))if(owned(w.path)&&!w.directory&&!w.transient&&w.before_sha256!==undefined&&diskHash(w.path)!==w.before_sha256)throw fail('E-PLAN-STALE',w.path);
  const probe=await probeVault(plan.answers.vault,{platform:ctx.platform||platform,io:ctx.probeIo||fs});
  await ctx.boundary?.('S0');
  fs.mkdirSync(ctx.dirs.etc,{recursive:true});
  const lock=await acquireLock(ctx.dirs.etc,ctx.lockOptions);if(!lock.ok)throw Object.assign(new Error(lock.reason),lock);
  let released=false;
  try {
  const result={profile:plan.profile,changed:[],registrations:[],backups:[],warnings:[...plan.warnings,...probe.warnings],pending_hosts:plan.pending_hosts,journal:journalPath,proposals:(plan.proposals||[]).map(p=>({...p,before:fs.readFileSync(p.before_source||p.path,'utf8')})),exitCode:plan.proposals?.length?4:0};
  const host=ctx.platform||platform;
  let records=old?.records||[];
  fs.mkdirSync(ctx.dirs.journal,{recursive:true});
  const j=journal(journalPath);
  const append=async r=>{await j.before(r);records.push(r);};
  const entries=new Map((previous?.entries||[]).map(e=>[e.path,e]));
  for(const entry of plan.adoptions||[])entries.set(entry.path,entry);
  const registrations=new Map((previous?.registrations||[]).map(e=>[e.file,e]));
  const backupMap=new Map(records.filter(r=>r.t==='backup').map(r=>[r.path,r.backup]));
  for(const r of records.filter(r=>r.t==='backup')) {
    if(!exists(r.backup)) {
      if(diskHash(r.path)!==r.sha256_before)throw fail('E-PLAN-STALE','Interrupted backup source changed: '+r.path);
      backupMap.delete(r.path);
    }else if(diskHash(r.backup)!==r.sha256_before)throw fail('E-PLAN-STALE','Backup changed: '+r.backup);
  }
  const clis=detected.blocks.find(b=>b.name==='clis').clis;
  const registerByPath=new Map(plan.registrations.map(r=>[r.path,r]));
  const remember=undo=>{if(undo.registration){const method=records.findLast(r=>r.t==='post'&&r.path===undo.registration.file&&r.registration_method)?.registration_method;registrations.set(undo.registration.file,{...undo.registration,...(method?{method}:{})});}else if(undo.entry)entries.set(undo.entry.path,undo.entry);};
  for(const record of records)if(record.t==='pre'&&record.undo)remember(record.undo);
  async function publish(w,stage,custom) {
    if(await linked(w.path,ctx))throw fail('E-REPARSE-TARGET',w.path);
    let pre=records.find(r=>r.t==='pre'&&r.path===w.path&&r.stage===stage);
    if(pre) {
      const actual=diskHash(w.path);
      const hostRecord=pre.undo?.registration;
      const live=hostRecord&&exists(w.path)?fs.readFileSync(w.path):Buffer.alloc(0);
      if(hostRecord?registrationMatches(live,hostRecord):actual===pre.sha256_expected){if(!records.some(r=>r.t==='post'&&r.path===w.path&&r.stage===stage))await append({t:'post',stage,path:w.path,sha256_after:actual});remember(pre.undo);return;}
      if(hostRecord?!registrationMatches(live,hostRecord,true):actual!==pre.sha256_before)throw fail('E-PLAN-STALE',w.path);
    }
    if(w.directory && exists(w.path))return;
    const before=exists(w.path)&&!w.directory?fs.readFileSync(w.path):Buffer.alloc(0);
    const r=registerByPath.get(w.path);
    const reg=r?registrationEdit(r,before):null;
    const generated=w.splice?Buffer.concat([before.subarray(0,w.splice.start),Buffer.from(w.splice.bytes_base64,'base64'),before.subarray(w.splice.end)]):w.content;
    const after=w.directory?null:Buffer.from(custom??reg?.edit.bytes??generated);
    if(!w.directory&&before.equals(after)&&exists(w.path))return;
    if(!pre&&owned(w.path)&&w.before_sha256!==undefined&&!w.directory&&diskHash(w.path)!==w.before_sha256)throw fail('E-PLAN-STALE',w.path);
    const edit=reg?.edit||(!w.directory?byteEdit(before,after):null);
    const created=!exists(w.path), backup=backupMap.get(w.path)||null;
    const block=!w.directory&&w.action==='block'?scanMarkers(after,{style:path.basename(w.path)==='.gitignore'?'hash':'markdown'}).block:null;
    const entry=w.directory?{path:w.path,kind:'dir',created,removal:created?'rmdir_if_empty':'never'}:
      block?{path:w.path,kind:'block',block_id:'council:contract',contract_version:1,block_sha256_eolnorm:hashBody(block.body),pre_existing:!created,backup,adopted:false,removal:'excise_block'}:
      {path:w.path,kind:'file',created,sha256:sha256(after),removal:created?'delete_if_hash_matches':'never',backup};
    const undo=pre?.undo||{entry:reg?undefined:entry,registration:reg?{...reg.record,backup}:undefined,entryValue:reg?.entry,
      ...(reg?{before:before.toString('base64'),expected:after.toString('base64'),oldRange:edit.oldRange,newRange:edit.newRange}:{}),backup,created};
    if(!pre){pre={t:'pre',stage,path:w.path,sha256_before:diskHash(w.path),sha256_expected:reg?null:w.directory?directoryHash:sha256(after),undo};await append(pre);}
    await ctx.mutation?.('pre',stage,w.path);
    let publicationMethod;
    if(w.directory)fs.mkdirSync(w.path,{recursive:false});
    else if(reg)publicationMethod=await publishRegistration(r,before,edit,{...undo,entry:undo.entryValue},ctx,backup,clis);
    else await writeSplice(w.path,before,edit,{dryRun:false,backup});
    await ctx.mutation?.('written',stage,w.path);
    if(reg ? !registrationMatches(fs.readFileSync(w.path),undo.registration) : diskHash(w.path)!==pre.sha256_expected)throw new Error('post_content_mismatch: '+w.path);
    await append({t:'post',stage,path:w.path,sha256_after:diskHash(w.path),...(publicationMethod?{registration_method:publicationMethod}:{})});
    remember(undo);result.changed.push(w.path);
  }
  async function installApp(step) {
    const appWrites=step.writes.filter(w=>under(w.path,ctx.dirs.app));
    if(!appWrites.length)return;
    const partial=ctx.dirs.app+'.partial';
    if(exists(ctx.dirs.app)) {
      // An existing version is immutable; only a journal proving our completed
      // rename permits a resume. Never fill holes in an unrelated version tree.
      for(const w of appWrites) {
        const pre=records.find(r=>r.t==='pre'&&r.path===w.path&&r.stage==='S3');
        if(!pre||diskHash(w.path)!==pre.sha256_expected)throw fail('E-NO-MANIFEST','Incomplete existing app: '+w.path);
        remember(pre.undo);
      }
      return;
    }
    if(exists(partial)) {
      if(!resume||records[0].partial!==partial||await linked(partial,ctx))throw fail('E-USAGE','Unowned partial app: '+partial);
      fs.rmSync(partial,{recursive:true});
    }
    let created=false;
    try {
      for(const w of appWrites) {
        let pre=records.find(r=>r.t==='pre'&&r.path===w.path&&r.stage==='S3');
        if(!pre) {
          const expected=w.directory?directoryHash:sha256(Buffer.from(w.content));
          const entry={path:w.path,kind:w.directory?'dir':'file',created:true,removal:w.directory?'rmdir_if_empty':'delete_if_hash_matches',...(!w.directory?{sha256:expected}:{})};
          pre={t:'pre',stage:'S3',path:w.path,sha256_before:null,sha256_expected:expected,undo:{created:true,entry}};
          await append(pre);
        }
        await ctx.mutation?.('pre','S3',w.path);
        const target=path.join(partial,path.relative(ctx.dirs.app,w.path));
        if(w.directory){fs.mkdirSync(target,{recursive:true});created=true;}
        else {fs.mkdirSync(path.dirname(target),{recursive:true});created=true;await safewrite(target,w.content,{exclusive:true});}
        remember(pre.undo);
        await ctx.mutation?.('written','S3',w.path);
      }
      const inventory=step.writes.find(w=>w.path===path.join(ctx.dirs.manifests,'app-0.1.0.json'));
      if(inventory){for(const w of step.writes.filter(w=>w.directory&&under(inventory.path,w.path)&&!under(w.path,ctx.dirs.app)))await publish(w,'S3');await publish(inventory,'S3');}
      fs.renameSync(partial,ctx.dirs.app);created=false;
      for(const w of appWrites){await append({t:'post',stage:'S3',path:w.path,sha256_after:diskHash(w.path)});result.changed.push(w.path);}
    }catch(error){if(created&&exists(partial)&&!await linked(partial,ctx))fs.rmSync(partial,{recursive:true});throw error;}
  }
    if(!resume)await append({t:'begin',plan_sha256:hash,plan:plan.file,profile:plan.profile,vault:plan.answers.vault,partial:ctx.dirs.app+'.partial',setup_files:plan.registrations.length&&!options['no-register']?setupFiles:[],no_register:!!options['no-register']});
    if(resume&&plan.registrations.length&&!options['no-register']) {
      records[0]={...records[0],setup_files:setupFiles};
      await safewrite(journalPath,records.map(r=>JSON.stringify(r)+'\n').join(''));
    }
    await ctx.boundary?.('S1');
    const files=plan.steps.flatMap(s=>s.writes).filter(w=>w.backup&&!backupMap.has(w.path));
    const backed=files.length?await backupFiles({etc:ctx.dirs.etc,profile:plan.profile,timestamp,vault:plan.answers.vault,files:files.map(w=>({source:w.path,mirror:path.relative(path.join(ctx.dirs.backups,timestamp),w.backup)})),platform:host,journal:j}):{backups:[],warnings:[]};
    result.warnings.push(...backed.warnings);result.backups.push(...backed.backups);
    for(const b of backed.backups)if(b.backup)backupMap.set(b.source,b.backup);
    result.backups=[...backupMap].map(([source,backup])=>({source,backup}));
    if(!files.length&&backupMap.size){const acl=await host.restrictToOwner(path.dirname(ctx.dirs.backups));if(!acl.ok)result.warnings.push({directory:path.dirname(ctx.dirs.backups),...acl});}
    await ctx.boundary?.('S2');
    for(const stage of ['S3','S4','S5','S6']) {
      const step=plan.steps.find(s=>s.id===stage);
      if(stage==='S6')for(const w of plan.steps.find(s=>s.id==='S0')?.writes||[])if(w.directory)await publish(w,'S6');
      if(stage==='S3') {
        for(const w of step?.writes||[])if(w.directory&&!under(w.path,ctx.dirs.app)&&under(ctx.dirs.app,w.path))await publish(w,stage);
        await installApp(step);
      }
      for(const w of step?.writes||[]) {
        if(stage==='S3'&&under(w.path,ctx.dirs.app))continue;
        await publish(w,stage);
      }
      if(stage==='S5'){const acl=await host.restrictToOwner(path.join(vaultInfo.runtimeRoot,'secrets'));if(!acl.ok)result.warnings.push({directory:path.join(vaultInfo.runtimeRoot,'secrets'),...acl});}
      if(step?.git_init){const git=detected.blocks.find(b=>b.name==='git').path;if(!git||ctx.run(git,['-C',plan.answers.vault,'init']).status!==0)throw new Error('git_init_failed');}
      await ctx.boundary?.(stage);
    }
    const checked=integrity.check(ctx.dirs.app,path.join(ctx.dirs.manifests,'app-0.1.0.json'));
    if(!checked.ok)throw fail('E-TIER0-FAILED',checked.failures.join(', '));
    result.tier0=await (ctx.tier0||tier0)(ctx);
    await ctx.boundary?.('S7');
    for(const w of options['no-register']?[]:plan.steps.find(s=>s.id==='S8')?.writes||[]) {
      await publish(w,'S8');
      const r=registerByPath.get(w.path);if(r)await (ctx.doctor||doctorHandshake)(r,{...ctx,dirs:{...ctx.dirs,runtimeRoot:vaultInfo.runtimeRoot}});
    }
    await ctx.boundary?.('S8');
    if(options['no-register']){result.pending_hosts=[...new Set([...plan.pending_hosts,...plan.registrations.map(r=>r.surface)])];result.warnings.push('Host registration deferred by --no-register.');}
    result.registrations=[...registrations.values()];
    const pointer=readJSON(path.join(plan.answers.vault,'.council','vault.json'));
    const manifest={schema:1,profile:plan.profile,server_name:plan.answers['register-as']||'council',app_version:'0.1.0',installed_at:previous?.installed_at||plan.created_at,last_apply_at:plan.created_at,plan_sha256:hash,
      vault:{path:plan.answers.vault,real:realFuture(plan.answers.vault),vault_id:pointer.vault_id},runtime_root:vaultInfo.runtimeRoot,backups_dir:ctx.dirs.backups,
      entries:[...entries.values()].filter(e=>e.path!==ctx.dirs.manifest&&e.path!==ctx.dirs.machine),registrations:result.registrations,pending_hosts:result.pending_hosts.map(host=>({host,reason:'host unavailable or deferred'})),left_alone:plan.untouched.map(p=>({path:p,why:'retained'})),observed:{node:ctx.nodeVersion},warnings:result.warnings,journal:journalPath};
    validateManifest(manifest);
    for(const w of plan.steps.find(s=>s.id==='S9')?.writes||[])await publish(w,'S9',w.directory?undefined:JSON.stringify(manifest,null,2)+'\n');
    await ctx.boundary?.('S9');
    await append({t:'commit'});
    const unlocked=await releaseLock(lock,ctx.lockOptions);if(!unlocked.ok)throw Object.assign(new Error(unlocked.reason),unlocked);released=true;
    await ctx.boundary?.('S10');
    await finishCleanup(journalPath,records,ledgerDir,ctx);
    if(options.log)await writeLog(options.log,applyReport(result),ctx);
    await ctx.boundary?.('S11');
    return result;
  }finally{if(!released)await releaseLock(lock,ctx.lockOptions);}
}
async function writeLog(file,text,ctx) {
  file=path.resolve(file);
  if(!under(file,ctx.dirs.logs)||await linked(file,ctx)||exists(file))throw fail('E-USAGE','--log must be a new file under '+ctx.dirs.logs);
  fs.mkdirSync(path.dirname(file),{recursive:true});await safewrite(file,text,{exclusive:true});
}
