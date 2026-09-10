// Owns reverse journal recovery. Host files are exclusively entry/table splices.
import fs from 'node:fs';
import readline from 'node:readline/promises';
import path from 'node:path';
import { readJournal, journal } from './journal.mjs';
import { readJSON, exists, linked, under } from './survey.mjs';
import { planFileHash } from './report.mjs';
import { sha256 } from './manifest.mjs';
import { safewrite, assertOutside } from './safewrite.mjs';
import { recoverRegistration, registrationMatches } from './registration.mjs';
import { diskHash, validatePlan, cleanupSetup } from './apply.mjs';
import { acquireLock, releaseLock } from './lock.mjs';
import { fail } from './dialogue.mjs';

export async function rollback(options,ctx) {
  if(!/^[A-Za-z0-9_-]+$/.test(options.journal||''))throw fail('E-USAGE','rollback requires a journal timestamp.');
  const file=path.join(ctx.dirs.journal,options.journal+'.jsonl');
  if(await linked(file,ctx))throw fail('E-REPARSE-TARGET',file);
  const state=readJournal(file), begin=state.records[0];
  if(state.corrupt)throw fail('E-JOURNAL-OPEN','Corrupt journal; manual recovery required.');
  const plan=readJSON(begin.plan);
  if(begin.migration)return (await import('./migrate.mjs')).resumeMigration(plan,ctx,{reverse:true});
  await validatePlan(plan,ctx);
  if(begin.plan_sha256!==planFileHash(plan))throw fail('E-PLAN-STALE','Journal/plan mismatch.');
  const allowed=new Set(plan.steps.flatMap(s=>s.writes).map(w=>w.path));
  for(const r of state.records)if(r.t==='pre'&&(!allowed.has(r.path)||!r.undo||r.undo.entry&&r.undo.entry.path!==r.path||r.undo.registration&&r.undo.registration.file!==r.path))throw fail('E-USAGE','Out-of-scope journal intent.');
  if(state.records.at(-1)?.outcome==='rollback')return {restored:[],conflicts:[],unchanged:true};
  const recoveryFile=path.join(ctx.dirs.journal,options.journal+'-rollback.jsonl');
  if(await linked(recoveryFile,ctx))throw fail('E-REPARSE-TARGET',recoveryFile);
  const recovery=exists(recoveryFile)?readJournal(recoveryFile):null;
  if(recovery?.corrupt||recovery&&recovery.records[0].plan_sha256!==begin.plan_sha256)throw fail('E-JOURNAL-OPEN','Recovery journal is inconsistent.');
  if(recovery&&!recovery.open)return {restored:[],conflicts:recovery.records.at(-1).conflicts||[],unchanged:true,exitCode:recovery.records.at(-1).conflicts?.length?4:0};
  if(!options.yes) {
    const input=ctx.input||process.stdin,output=ctx.output||process.stderr;
    if(!input.isTTY)throw Object.assign(new Error('Rollback confirmation requires --yes when unattended.'),{exitCode:5});
    const rl=readline.createInterface({input,output});
    try {if(!/^y(?:es)?$/i.test((await rl.question('Roll back '+options.journal+'? [y/N] ')).trim()))throw Object.assign(new Error('Rollback declined.'),{exitCode:5});}finally{rl.close();}
  }
  const lock=await acquireLock(ctx.dirs.etc,ctx.lockOptions);if(!lock.ok)throw Object.assign(new Error(lock.reason),lock);
  const restored=[],conflicts=[];
  try {
    const undoJournal=journal(recoveryFile);
    if(!recovery)await undoJournal.before({t:'begin',plan_sha256:begin.plan_sha256,plan:begin.plan,rollback_of:file});
    // Finish the original transaction's exact-list setup cleanup before trying
    // empty-only directory removal. This is the same §7.4 S11 transient inventory.
    if(!state.records.at(-1)?.cleanup_done)await cleanupSetup(begin.setup_files||[],path.resolve(plan.answers.vault,plan.layout.ledger_dir),ctx);
    if(begin.partial&&exists(begin.partial)) {
      const partial=path.resolve(begin.partial);
      if(partial!==path.resolve(ctx.dirs.app+'.partial')||!under(partial,ctx.dirs.root)||await linked(partial,ctx))conflicts.push(partial+' (unsafe partial app)');
      else fs.rmSync(partial,{recursive:true});
    }
    const intents=state.records.filter(r=>r.t==='pre').sort((a,b)=>{
      const position=r=>{const post=state.records.findLastIndex(p=>p.t==='post'&&p.path===r.path&&p.stage===r.stage);return post<0?state.records.indexOf(r):post;};
      return position(b)-position(a);
    });
    for(const pre of intents) {
      const p=pre.path,u=pre.undo;
      if(/^(?:\.claude\.json|config\.toml|claude_desktop_config\.json)$/i.test(path.basename(p))&&!u.registration)throw new Error('host_requires_surgical_recovery');
      if(await linked(p,ctx)){conflicts.push(p+' (reparse target)');continue;}
      const current=diskHash(p);
      if(!u.registration&&current===pre.sha256_before)continue;
      const posted=state.records.some(r=>r.t==='post'&&r.stage===pre.stage&&r.path===p);
      // Owned files use byte hashes; host intents are classified by entry/block content.
      if(!u.registration&&!posted&&current!==pre.sha256_expected){conflicts.push(p+' (human edit after incomplete write)');continue;}
      if(u.registration) {
        if(!exists(p)){if(registrationMatches(Buffer.alloc(0),u.registration,true))continue;conflicts.push(p);continue;}
        const bytes=fs.readFileSync(p),r=u.registration;
        if(registrationMatches(bytes,r,true))continue;
        const matches=registrationMatches(bytes,r);
        if(!matches){conflicts.push(p+' (registration changed)');continue;}
        const edit=recoverRegistration(bytes,u);
        if(!edit.ok){conflicts.push(p+' (surgical recovery refused)');continue;}
        assertOutside(bytes,edit.bytes,edit.oldRange,edit.newRange);
        if(!fs.readFileSync(p).equals(bytes)){conflicts.push(p+' (concurrent change)');continue;}
        await safewrite(p,edit.bytes);
        assertOutside(bytes,fs.readFileSync(p),edit.oldRange,edit.newRange);
      }else if(u.entry.kind==='dir') {
        if(!u.created||u.entry.removal!=='rmdir_if_empty')continue;
        try{fs.rmdirSync(p);}catch(e){if(!['ENOENT','ENOTEMPTY','EEXIST'].includes(e.code))throw e;if(e.code!=='ENOENT')conflicts.push(p+' (not empty)');continue;}
      }else {
        if(current!==pre.sha256_expected){conflicts.push(p+' (human edit)');continue;}
        if(u.created) {
          if(u.entry.removal!=='delete_if_hash_matches')throw new Error('unauthorized_removal');
          fs.unlinkSync(p);
        }else {
          let backup;
          try {
            if(!u.backup||!under(u.backup,ctx.dirs.backups)||await linked(u.backup,ctx))throw new Error('unsafe path');
            backup=fs.readFileSync(u.backup);
            if(sha256(backup)!==pre.sha256_before)throw new Error('hash mismatch');
          }catch(error){conflicts.push(p+' (rollback backup invalid: '+(u.backup||'missing path')+'; '+error.message+')');continue;}
          await safewrite(p,backup);
        }
      }
      restored.push(p);
    }
    if(state.open)await journal(file).before({t:'commit',outcome:conflicts.length?'rollback_partial':'rollback',conflicts});
    await undoJournal.before({t:'commit',outcome:conflicts.length?'rollback_partial':'rollback',conflicts});
    return {restored,conflicts,exitCode:conflicts.length?4:0};
  }finally{await releaseLock(lock,ctx.lockOptions);}
}
