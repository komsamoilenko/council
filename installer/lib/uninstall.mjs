// Manifest-only unattended removals; A-37's four fixed attended purge targets.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import {context,readJSON,exists,under,linked} from './survey.mjs';
import {readManifest,sha256} from './manifest.mjs';
import {scanMarkers,hashBody} from './markers.mjs';
import {exciseToml} from './tomlblock.mjs';
import {spliceJsonEntry} from './host-json.mjs';
import {registrationMatches} from './registration.mjs';
import {safewrite,assertOutside,byteEdit} from './safewrite.mjs';
import {scope,inventory} from './removal-scope.mjs';
import {acquireLock,releaseLock} from './lock.mjs';

export async function uninstall(options={},overrides={}) {
  const ctx=context({...overrides,profile:options.profile||'default'}),d=ctx.dirs;
  const result={profile:options.profile||'default',removed:[],skipped:[],scope:[],backups:'Backups left entirely alone; never restored automatically.',exitCode:0};
  const refuse=reason=>Object.assign(result,{reason,exitCode:4});
  if(!exists(options.manifest||d.manifest))return refuse('E-NO-MANIFEST');
  const m=readManifest(options.manifest||d.manifest);
  if(m.profile!==result.profile)return refuse('profile_mismatch');
  const input=ctx.input||process.stdin,output=ctx.output||process.stdout;
  const say=text=>output.write(text+'\n');
  const candidates=[],origins=new Map();
  // Complete the scope pass before any deletion or host invocation.
  for(const e of [...m.registrations,...m.entries]) {
    const ok=await scope(e,m,ctx),p=e.path||e.file;
    result.scope.push({path:p,result:ok?'in_scope':'out_of_scope'});
    if(ok)candidates.push(e);else result.skipped.push({path:p,reason:'out_of_scope'});
  }
  if((options['purge-runtime']||options['purge-backups'])&&options.yes)return refuse('E-PURGE-YES: a broad authorisation does not authorise a delete');
  if(!input.isTTY||!output.isTTY)return refuse(options['purge-runtime']||options['purge-backups']?'E-PURGE-NON-TTY: purge requires a TTY':'E-UNINSTALL-NON-TTY: uninstall requires a TTY');
  if(options.all) {
    const machine=readJSON(d.machine,{}),others=(machine.shared?.profiles||[]).filter(id=>id!==m.profile);
    for(const id of others) {
      const {dirs:ignoredDirs,...childOverrides}=overrides;
      const child=await uninstall({...options,profile:id,all:false,manifest:undefined}, childOverrides);
      result.removed.push(...child.removed);result.skipped.push(...child.skipped);result.scope.push(...child.scope);
      if(child.exitCode)return refuse(child.reason||'profile_removal_incomplete');
    }
  }
  // Shared files may have been created by a profile already uninstalled. Its
  // retained manifest remains the authority; do not infer ownership from a walk.
  const shared=readJSON(d.machine,{}).shared?.profiles||[];
  if(!options['keep-app']&&shared.every(id=>id===m.profile)) {
    const profiles=path.join(d.etc,'profiles'),known=new Set(candidates.map(e=>e.path||e.file));
    const sharedPath=p=>p===d.current||p===d.launcher||under(p,path.join(d.root,'app'))||under(p,d.manifests)||p===d.skill;
    if(exists(profiles)&&!await linked(profiles,ctx))for(const id of fs.readdirSync(profiles)) {
      if(id===m.profile||!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id))continue;
      const file=path.join(profiles,id,'manifest.json');if(!exists(file)||await linked(file,ctx))continue;
      const owner=readManifest(file),{dirs:ignoredDirs,...rest}=overrides,ownerCtx=context({...rest,profile:id});
      for(const e of owner.entries)if(sharedPath(e.path)&&!known.has(e.path)) {
        const ok=await scope(e,owner,ownerCtx);result.scope.push({path:e.path,result:ok?'in_scope':'out_of_scope'});
        if(ok){candidates.push(e);known.add(e.path);origins.set(e,{owner,ownerCtx});}else result.skipped.push({path:e.path,reason:'out_of_scope'});
      }
    }
  }
  const rl=readline.createInterface({input,output});let lock;
  try {
    for(const s of result.scope)say('[D4] '+s.result+' '+s.path);
    if(!options.yes&&!/^y(?:es)?$/i.test((await rl.question('Uninstall profile '+m.profile+'? [y/N] ')).trim()))return refuse('uninstall_declined');
    const purges=[];
    const config=readJSON(d.config,{});
    const targets=[];
    if(options['purge-runtime']) {
      targets.push(['secrets',d.secrets]);
      for(const kind of ['jobs','ledger'])if(path.resolve(m.vault.path,config.layout?.[kind+'_dir']|| (kind==='jobs'?'work/jobs':'ledger'))===d[kind])targets.push([kind,d[kind]]);
    }
    if(options['purge-backups']&&await scope({path:path.join(d.backups,'scope-probe')},m,ctx,{purge:true})&&exists(d.backups))for(const name of fs.readdirSync(d.backups).sort())targets.push(['backup',path.join(d.backups,name)]);
    for(const [kind,p] of targets) {
      if(!await scope({path:p},m,ctx,{purge:true})){result.skipped.push({path:p,reason:'out_of_scope'});say('[D4] out_of_scope '+p);continue;}
      let contents;try{contents=await inventory(p,ctx);}catch{result.skipped.push({path:p,reason:'out_of_scope'});continue;}
      if([...contents.files.map(f=>f.path),...contents.directories].some(p=>/(?:^|[\\/])(?:STOP|agy-enabled|sandbox)(?:[\\/]|$)/i.test(p))){result.skipped.push({path:p,reason:'protected_content'});continue;}
      say('[D4] in_scope '+p);
      say(kind+': '+p);
      if(kind==='secrets')say('this holds your DPAPI-protected Gemini API key; deleting it means `council-setup set-key` again');
      if(kind==='jobs') {
        const dates=contents.files.map(f=>f.mtime).sort();
        say('job-directory count: '+contents.directories.filter(x=>exists(path.join(x,'state.json'))).length+'; oldest: '+(dates[0]||'none')+'; newest: '+(dates.at(-1)||'none')+'; total size: '+contents.files.reduce((n,f)=>n+f.size,0)+' bytes');
      }
      for(const f of contents.files)say('  '+path.relative(p,f.path)+(kind==='ledger'?' — '+fs.readFileSync(f.path,'utf8').split(/\r?\n/).filter(Boolean).length+' rows':''));
      if(!contents.files.length)say('  (empty)');
      if(kind==='ledger')say('file count: '+contents.files.length);
      if(/^y(?:es)?$/i.test((await rl.question('Delete '+kind+'? [y/N] ')).trim()))purges.push({p,contents});
      else {result.skipped.push({path:p,reason:'declined'});say('Left in place: '+p);}
    }
    if(targets.length&&(await rl.question('Type profile id in full ('+m.profile+'): ')).trim()!==m.profile)return refuse('profile_confirmation_mismatch');
    lock=await acquireLock(d.etc,ctx.lockOptions);if(!lock.ok)return refuse(lock.reason);
    const machine=readJSON(d.machine,{}),remaining=(machine.shared?.profiles||[]).filter(id=>id!==m.profile);
    const machineEntry=e=>!under(e.path||e.file,m.vault.path)&&!under(e.path||e.file,m.runtime_root)&&!under(e.path||e.file,d.profileDir)&&!e.file;
    const ordered=candidates.sort((a,b)=> (a.file?0:a.kind==='block'?1:a.kind==='dir'?3:2)-(b.file?0:b.kind==='block'?1:b.kind==='dir'?3:2) || (b.path||'').length-(a.path||'').length);
    for(const e of ordered) {
      if(!e.file&&result.skipped.some(s=>m.registrations.some(r=>r.file===s.path)&&s.reason!=='declined'))return refuse('registration_removal_incomplete');
      const p=e.path||e.file;
      const skip=reason=>result.skipped.push({path:p,reason});
      if(!exists(p))continue;
      const origin=origins.get(e);
      if(!await scope(e,origin?.owner||m,origin?.ownerCtx||ctx)){skip('out_of_scope');continue;}
      if(e.removal==='never'||e.removal==='never_while_profile_exists'&&(remaining.length||options['keep-app']||e.kept)){skip(e.removal);continue;}
      if(under(p,m.runtime_root)){skip('runtime_kept');continue;}
      if(options['keep-vault']&&under(p,m.vault.path)){skip('keep_vault');continue;}
      if(machineEntry(e)&&(remaining.length||options['keep-app'])){skip('shared_or_keep_app');continue;}
      if(p===d.machine){skip('shared_metadata_retained');continue;}
      if(e.kind==='dir') {
        if(e.removal!=='rmdir_if_empty'||!e.created)continue;
        try{fs.rmdirSync(p);result.removed.push(p);}catch(err){if(!['ENOTEMPTY','EEXIST','ENOENT'].includes(err.code))throw err;skip('not_empty');}
        continue;
      }
      const before=fs.readFileSync(p);let edit;
      if(e.file) {
        if(!registrationMatches(before,e)){skip('hash_mismatch');continue;}
        edit=e.host==='codex'?exciseToml(before,{name:e.name,expectedHash:e.block_sha256_eolnorm}):spliceJsonEntry(before,e.name,e.removal==='restore_pre_existing_entry'?e.pre_existing_entry:null);
        if(e.host==='claude-code'&&e.method==='claude-mcp-add-json'&&e.removal!=='restore_pre_existing_entry') {
          const cli=machine.binaries?.claude;
          if(!cli||!path.isAbsolute(cli)||/\.(cmd|bat|ps1)$/i.test(cli)){skip('claude_remove_unavailable');continue;}
          if(ctx.run(cli,['mcp','remove',e.name,'-s','user']).status!==0){skip('claude_remove_failed');continue;}
          if(JSON.parse(fs.readFileSync(p,'utf8')).mcpServers?.[e.name]){skip('host_readback_failed');continue;}
          result.removed.push(p+' :: '+e.name);continue;
        }
      }else if(e.removal==='excise_block') {
        const scan=scanMarkers(before,{style:path.basename(p)==='.gitignore'?'hash':'markdown'});
        if(!scan.ok||!scan.block||hashBody(scan.block.body)!==e.block_sha256_eolnorm){skip('hash_mismatch');continue;}
        edit=byteEdit(before,Buffer.concat([before.subarray(0,scan.block.start),before.subarray(scan.block.end)]));edit.ok=true;
      }else if(e.removal==='delete_if_hash_matches'||e.removal==='never_while_profile_exists'&&e.template==='skill') {
        if(sha256(before)!==e.sha256){skip('hash_mismatch');continue;}
        fs.unlinkSync(p);result.removed.push(p);continue;
      }else continue;
      if(!edit?.ok){skip('splice_refused');continue;}
      assertOutside(before,edit.bytes,edit.oldRange,edit.newRange);
      if(!fs.readFileSync(p).equals(before)){skip('concurrent_change');continue;}
      await safewrite(p,edit.bytes);assertOutside(before,fs.readFileSync(p),edit.oldRange,edit.newRange);result.removed.push(p+(e.file?' :: '+e.name:''));
    }
    for(const {p,contents} of purges) {
      const now=await inventory(p,ctx);
      if(!await scope({path:p},m,ctx,{purge:true})||JSON.stringify(now)!==JSON.stringify(contents)){result.skipped.push({path:p,reason:'changed_since_confirmation'});continue;}
      // Exact reviewed inventory, never recursive removal through a junction.
      for(const f of contents.files)fs.unlinkSync(f.path);
      for(const dir of [...contents.directories].reverse())fs.rmdirSync(dir);
      result.removed.push(p);say('Deleted: '+p);
    }
    if(exists(d.machine)&&!result.skipped.some(s=>['hash_mismatch','claude_remove_failed','claude_remove_unavailable','host_readback_failed'].includes(s.reason)))await safewrite(d.machine,JSON.stringify({...machine,shared:{...machine.shared,profiles:remaining}},null,2)+'\n');
    if(options['purge-backups'])result.backups='Only individually confirmed backup timestamps removed; no backup restored.';
    result.software='Installed Node and vendor CLIs retained. Optional commands (printed, never run): npm uninstall -g @anthropic-ai/claude-code @openai/codex';
    return result;
  }finally{rl.close();if(lock?.ok)await releaseLock(lock,ctx.lockOptions);}
}
