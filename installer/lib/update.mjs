// Staging, zero-quota validation, drain, and atomic launcher promotion (§7.6).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import {inflateRawSync} from 'node:zlib';
import {context,readJSON,exists,linked,under,which} from './survey.mjs';
import {sha256,readManifest} from './manifest.mjs';
import {safewrite} from './safewrite.mjs';
import {tier0} from './apply.mjs';
import {scanMarkers,hashBody,mergeMarkers} from './markers.mjs';
import {render,layout} from './render.mjs';
import {acquireLock,releaseLock} from './lock.mjs';
import {inventory,scope} from './removal-scope.mjs';
import {backupFiles} from './backup.mjs';
import platform from '../../src/platform/index.js';
import integrity from '../../src/lib/integrity.js';

const validVersion=v=>typeof v==='string'&&/^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9.-]+)?$/.test(v);
const mergeDefaults=(defaults,current)=>Object.fromEntries([...new Set([...Object.keys(defaults),...Object.keys(current)])].map(k=>[k,current[k]===undefined?defaults[k]:defaults[k]&&current[k]&&typeof defaults[k]==='object'&&typeof current[k]==='object'&&!Array.isArray(defaults[k])&&!Array.isArray(current[k])?mergeDefaults(defaults[k],current[k]):current[k]]));
export function releaseVersions(bytes) {
  const text=bytes.toString('utf8'),out={};
  for(const key of ['APP_VERSION','CONFIG_SCHEMA','CONTRACT_VERSION']) {
    const m=new RegExp('\\b'+key+"\\s*:\\s*(?:['\"]([^'\"]+)['\"]|(\\d+))").exec(text);
    if(!m)throw new Error('release_version_missing:'+key);out[key]=m[1]||Number(m[2]);
  }
  if(!validVersion(out.APP_VERSION))throw new Error('release_version_invalid');return out;
}
// Decode in memory before creating a staged tree. Reject ZIP links/traversal/bombs.
export function unzip(bytes) {
  let end=-1;
  for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50){end=i;break;}
  if(end<0||bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6))throw new Error('zip_invalid');
  const count=bytes.readUInt16LE(end+10),files=new Map();let pos=bytes.readUInt32LE(end+16),total=0;
  if(count>20000)throw new Error('zip_too_many_entries');
  for(let i=0;i<count;i++) {
    if(bytes.readUInt32LE(pos)!==0x02014b50)throw new Error('zip_invalid');
    const flags=bytes.readUInt16LE(pos+8),method=bytes.readUInt16LE(pos+10),size=bytes.readUInt32LE(pos+24),compressed=bytes.readUInt32LE(pos+20),n=bytes.readUInt16LE(pos+28),extra=bytes.readUInt16LE(pos+30),comment=bytes.readUInt16LE(pos+32),offset=bytes.readUInt32LE(pos+42);
    const name=bytes.subarray(pos+46,pos+46+n).toString('utf8').replaceAll('\\','/');
    if(flags&1||!name||name.startsWith('/')||name.includes(':')||name.split('/').some(p=>p==='..'||p==='.'||/[. ]$/.test(p))||((bytes.readUInt32LE(pos+38)>>>16)&0xf000)===0xa000)throw new Error('zip_unsafe_entry');
    total+=size;if(total>256*1024**2||size>32*1024**2)throw new Error('zip_size_limit');
    pos+=46+n+extra+comment;
    if(name.endsWith('/'))continue;
    if(bytes.readUInt32LE(offset)!==0x04034b50)throw new Error('zip_invalid');
    const start=offset+30+bytes.readUInt16LE(offset+26)+bytes.readUInt16LE(offset+28),raw=bytes.subarray(start,start+compressed);
    const data=method===0?raw:method===8?inflateRawSync(raw,{maxOutputLength:Math.max(size,1)}):null;
    if(!data||data.length!==size||[...files.keys()].some(k=>k.toLowerCase()===name.toLowerCase()))throw new Error('zip_invalid');
    files.set(name,Buffer.from(data));
  }
  return files;
}
export async function runningJobs(ctx) {
  const jobs=[];const profiles=path.join(ctx.dirs.etc,'profiles');
  if(!exists(profiles))return jobs;
  for(const id of fs.readdirSync(profiles)) {
    if(!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id))continue;
    const file=path.join(profiles,id,'config.json');if(await linked(file,ctx))throw new Error('out_of_scope');
    const c=readJSON(file);if(!c)continue;
    const expand=s=>String(s).replace(/%([^%]+)%/g,(_,k)=>k==='COUNCIL_VAULT'?c.vault:ctx.env[k]||'%'+k+'%');
    const root=path.resolve(expand(c.vault),expand(c.layout?.jobs_dir||'work/jobs'));
    if(!under(root,expand(c.vault))&&!under(root,expand(c.runtime_root)))throw new Error('jobs_out_of_scope');
    for(const f of (await inventory(root,ctx)).files)if(path.basename(f.path)==='state.json') {
      const state=readJSON(f.path);
      if(state?.state==='running'||state?.status==='running'||state?.legs?.some(l=>l.state==='running'))jobs.push({profile:id,path:f.path});
    }
  }
  return jobs;
}
async function pruneVersions(options,ctx,machine,current,result) {
  const keep=options.keep===undefined?2:Number(options.keep);
  if(!Number.isSafeInteger(keep)||keep<1)return {...result,reason:'invalid_keep',exitCode:4};
  const commandLines=await (ctx.platform||platform).commandLines(ctx.env,ctx.run);
  if(!Array.isArray(commandLines))return {...result,reason:'prune_process_inventory_'+'unavailable',exitCode:4};
  const versions=[...new Set(machine.shared?.app_versions||[])];
  if(versions.some(v=>!validVersion(v)))return {...result,reason:'invalid_version_inventory',exitCode:4};
  const ordered=[current.version,...versions.filter(v=>v!==current.version).reverse()],remove=ordered.slice(keep);
  const records=(machine.shared?.profiles||[]).map(id=>({file:path.join(ctx.dirs.etc,'profiles',id,'manifest.json')}));
  for(const r of records){if(await linked(r.file,ctx))return {...result,reason:'out_of_scope',exitCode:4};r.m=readManifest(r.file);}
  const actions=new Map();
  for(const version of remove) {
    const root=path.join(ctx.dirs.root,'app',version),meta=path.join(ctx.dirs.manifests,'app-'+version+'.json');
    if(commandLines.some(s=>s.toLowerCase().replaceAll('\\','/').includes(root.toLowerCase().replaceAll('\\','/'))))return {...result,reason:'version_in_use',version,exitCode:4};
    for(const {m} of records)for(const e of m.entries)if(under(e.path,root)||e.path===meta) {
      if(!exists(e.path))continue;
      if(!await scope(e,m,ctx)||!e.created||!['delete_if_hash_matches','rmdir_if_empty'].includes(e.removal)||e.kind==='file'&&sha256(fs.readFileSync(e.path))!==e.sha256)return {...result,reason:'prune_manifest_refused',path:e.path,exitCode:4};
      actions.set(e.path,{e,m});
    }
    // No implicit recursive removal: every existing node must have its own verb.
    for(const p of [...(await inventory(root,ctx)).files.map(f=>f.path),...(await inventory(root,ctx)).directories])if(!actions.has(p))return {...result,reason:'prune_unowned_path',path:p,exitCode:4};
  }
  if(!actions.size)return {...result,unchanged:true};
  const lock=await acquireLock(ctx.dirs.etc,ctx.lockOptions);if(!lock.ok)return {...result,reason:lock.reason,exitCode:4};
  try {
    const live=await (ctx.platform||platform).commandLines(ctx.env,ctx.run);
    if(!Array.isArray(live)||remove.some(v=>live.some(s=>s.toLowerCase().replaceAll('\\','/').includes(path.join(ctx.dirs.root,'app',v).toLowerCase().replaceAll('\\','/')))))return {...result,reason:'version_in_use_or_unknown',exitCode:4};
    for(const {e,m} of [...actions.values()].sort((a,b)=>(a.e.kind==='dir')-(b.e.kind==='dir')||b.e.path.length-a.e.path.length)) {
      if(!await scope(e,m,ctx)||e.kind==='file'&&sha256(fs.readFileSync(e.path))!==e.sha256)throw new Error('prune_path_changed');
      if(e.kind==='dir')fs.rmdirSync(e.path);else fs.unlinkSync(e.path);result.changed.push(e.path);
    }
    for(const {file,m} of records)await safewrite(file,JSON.stringify({...m,app_versions:(m.app_versions||[]).filter(v=>!remove.includes(v)),entries:m.entries.filter(e=>!actions.has(e.path))},null,2)+'\n');
    await safewrite(ctx.dirs.machine,JSON.stringify({...machine,shared:{...machine.shared,app_versions:versions.filter(v=>!remove.includes(v))}},null,2)+'\n');
    return result;
  }finally{await releaseLock(lock,ctx.lockOptions);}
}
async function resolveSource(options,ctx,machine,result) {
  const source=machine.source;
  if(!source||typeof source!=='object')throw new Error('update_source_missing');
  const channel=options.channel||source.channel||source.type;
  let files;
  if(channel==='git') {
    const worktree=source.worktree||source.path;
    if(!path.isAbsolute(worktree||'')||await linked(worktree,ctx))throw new Error('git_source_invalid');
    const git=which('git',ctx.env).find(p=>!/\.(cmd|bat|ps1)$/i.test(p));
    if(!git)throw new Error('git_unavailable');
    const ref=options.ref||source.ref||'HEAD';if(!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)||ref.includes('..'))throw new Error('git_ref_invalid');
    const resolved=ctx.run(git,['-C',worktree,'rev-parse','--verify',ref+'^{commit}']);
    const commit=resolved.stdout?.trim();if(resolved.status||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(commit))throw new Error('git_ref_unresolved');
    const listing=ctx.run(git,['-C',worktree,'ls-tree','-rz',commit]);if(listing.status)throw new Error('git_tree_failed');
    files=new Map();
    for(const row of listing.stdout.split('\0').filter(Boolean)) {
      const match=/^(100644|100755) blob [a-f0-9]+\t(.+)$/.exec(row);
      if(!match)throw new Error('git_nonregular_entry');
      const name=match[2];if(!/^(src\/|installer\/templates\/|NOTICE.md$)/.test(name))continue;
      const read=ctx.run(git,['-C',worktree,'show',commit+':'+name]);if(read.status)throw new Error('git_read_failed');files.set(name,Buffer.from(read.stdout));
    }
    result.source={channel,commit,worktree};
  }else if(channel==='zip') {
    const asset=source.asset||source.url||source.path;
    let bytes,checksum;
    if(/^https:\/\//.test(asset)) {
      const response=await fetch(source.sha256_url||asset+'.sha256');if(!response.ok)throw new Error('checksum_fetch_failed');checksum=(await response.text()).trim().split(/\s+/)[0];
      if(!/^[a-f0-9]{64}$/i.test(checksum))throw new Error('checksum_invalid');
      (ctx.output||process.stdout).write('Download URL: '+asset+'\nExpected sha256: '+checksum+'\n');
      const response2=await fetch(asset);if(!response2.ok)throw new Error('asset_fetch_failed');bytes=Buffer.from(await response2.arrayBuffer());
    }else {
      if(!path.isAbsolute(asset||'')||await linked(asset,ctx))throw new Error('zip_source_invalid');
      checksum=fs.readFileSync(source.sha256_file||asset+'.sha256','utf8').trim().split(/\s+/)[0];bytes=fs.readFileSync(asset);
    }
    if(!/^[a-f0-9]{64}$/i.test(checksum)||sha256(bytes)!==checksum.toLowerCase())throw new Error('zip_sha256_mismatch');
    files=unzip(bytes);result.source={channel,asset,sha256:checksum};
    const versionNames=[...files.keys()].filter(k=>k==='src/version.js'||k.endsWith('/src/version.js'));
    if(versionNames.length!==1)throw new Error('zip_release_layout');
    const prefix=versionNames[0].slice(0,-'src/version.js'.length);
    files=new Map([...files].filter(([k])=>k.startsWith(prefix)).map(([k,v])=>[k.slice(prefix.length),v]));
  }else throw new Error('update_channel_invalid');
  if(!files.has('src/version.js')||!files.has('NOTICE.md'))throw new Error('release_incomplete');
  return files;
}
export async function update(options={},overrides={}) {
  const ctx=context({...overrides,profile:options.profile||'default'}),d=ctx.dirs;
  const result={changed:[],kept:[],proposals:[],warnings:[],exitCode:0};
  const refuse=reason=>({...result,reason,exitCode:4});
  if(!exists(d.manifest))return refuse('E-NO-MANIFEST');
  for(const p of [d.manifest,d.current,d.machine,path.join(d.root,'app'),d.manifests])if(await linked(p,ctx))return refuse('out_of_scope');
  const current=readJSON(d.current),machine=readJSON(d.machine);
  if(!machine||!Array.isArray(machine.shared?.profiles)||machine.shared.profiles.some(id=>!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)))return refuse('invalid_profile_inventory');
  if(!validVersion(current?.version))return refuse('invalid_current');
  const before=fs.readFileSync(d.current);
  if(options.rollback) {
    const target=typeof options.rollback==='string'?options.rollback:current.previous?.version;
    if(!validVersion(target)||!exists(path.join(d.root,'app',target)))return refuse('rollback_version_missing');
    if(!current.previous||current.previous.version!==target)return refuse('rollback_preimage_missing');
    const bytes=Buffer.from(current.previous.bytes_base64,'base64');
    if(JSON.parse(bytes).version!==target)return refuse('rollback_preimage_invalid');
    await safewrite(d.current,bytes);result.changed.push(d.current);return result;
  }
  if(options['prune-versions'])return pruneVersions(options,ctx,machine,current,result);
  let files,versions;
  try{files=await resolveSource(options,ctx,machine,result);versions=releaseVersions(files.get('src/version.js'));}catch(e){return refuse(e.message);}
  result.version=versions.APP_VERSION;
  if(options.check)return {...result,available:versions.APP_VERSION!==current.version};
  if(versions.APP_VERSION===current.version)return {...result,unchanged:true};
  const partial=path.join(d.root,'app',versions.APP_VERSION+'.partial'),target=path.join(d.root,'app',versions.APP_VERSION);
  if(exists(partial)||exists(target)||await linked(partial,ctx))return refuse('version_already_exists');
  const lock=await acquireLock(d.etc,ctx.lockOptions);if(!lock.ok)return refuse(lock.reason);
  try {
    const hashes=[];
    for(const [name,bytes] of files)if(name.startsWith('src/')) {
      const rel=name.slice(4),p=path.join(partial,rel);
      if(!under(p,partial)||await linked(p,ctx))return refuse('release_path_out_of_scope');
      fs.mkdirSync(path.dirname(p),{recursive:true});await safewrite(p,bytes,{exclusive:true});hashes.push({path:rel,sha256:sha256(bytes)});
    }
    const manifestFile=path.join(d.manifests,'app-'+versions.APP_VERSION+'.json');
    await safewrite(manifestFile,JSON.stringify({schema:1,version:versions.APP_VERSION,files:hashes},null,2)+'\n',{exclusive:true});
    result.staged=partial;
    try{result.tier0=await (ctx.tier0||tier0)({...ctx,dirs:{...d,app:partial}});}catch(e){return {...result,reason:'staged_tier0_failed: '+e.message,exitCode:1};}
    const checked=integrity.check(partial,manifestFile);if(!checked.ok)return {...result,reason:'staged_integrity_failed',drift:checked.failures,exitCode:1};
    const running=await runningJobs(ctx);if(running.length)return {...refuse('drain_gate_running_jobs'),running};
    // Prepare all migrations before promotion. Unknown schemas fail closed.
    const oldVersions=releaseVersions(fs.readFileSync(path.join(d.root,'app',current.version,'version.js')));
    const migrations=[];
    if(versions.CONFIG_SCHEMA!==oldVersions.CONFIG_SCHEMA) {
      const template=files.get(['installer','templates','profile','config.template.json'].join('/'));
      if(!template)return refuse('config_migration_'+'template_missing');
      const schema=/"schema"\s*:\s*(\d+)/.exec(template.toString())?.[1];if(Number(schema)!==versions.CONFIG_SCHEMA)return refuse('config_migration_schema_invalid');
      for(const id of machine.shared?.profiles||[]) {
        const p=path.join(d.etc,'profiles',id,'config.json');if(await linked(p,ctx))return refuse('out_of_scope');
        const c=readJSON(p),defaults=JSON.parse(render(template.toString(),{VAULT:c.vault,RUNTIME_ROOT:c.runtime_root,PROFILE:id,CREATED_AT:c.created_at||new Date().toISOString(),SERVER_NAME:c.server_name||'council',WORK_DIR:c.layout?.work_dir||'work',JOBS_DIR:c.layout?.jobs_dir||'work/jobs',LEDGER_DIR:c.layout?.ledger_dir||'ledger'},{},{json:true}));
        migrations.push({p,before:fs.readFileSync(p),after:Buffer.from(JSON.stringify({...mergeDefaults(defaults,c),schema:versions.CONFIG_SCHEMA},null,2)+'\n'),profile:id,vault:c.vault});
      }
    }
    const notice=sha256(files.get('NOTICE.md'));
    if(notice!==machine.notice_ack?.notice_sha256) {
      const input=ctx.input||process.stdin,output=ctx.output||process.stdout;
      if(!input.isTTY||!output.isTTY)return refuse('NOTICE_reacknowledgement_'+'requires_TTY');
      output.write(files.get('NOTICE.md').toString()+'\n');
      const rl=readline.createInterface({input,output});
      try{if(!/^y(?:es)?$/i.test((await rl.question('Acknowledge the changed NOTICE? [y/N] ')).trim()))return refuse('NOTICE_declined');}finally{rl.close();}
    }
    // A job may have started during NOTICE review: recheck immediately before rename.
    if((await runningJobs(ctx)).length)return refuse('drain_gate_running_jobs');
    if(!fs.readFileSync(d.current).equals(before))return refuse('current_changed');
    fs.renameSync(partial,target);
    await safewrite(d.current,JSON.stringify({...current,version:versions.APP_VERSION,previous:{version:current.version,bytes_base64:before.toString('base64')}},null,2)+'\n');
    result.changed.push(d.current);result.kept.push(path.join(d.root,'app',current.version));
    const stamp=new Date().toISOString().replace(/[^0-9]/g,'');
    for(const migration of migrations) {
      if(!fs.readFileSync(migration.p).equals(migration.before))throw new Error('config_changed_during_update');
      const backed=await backupFiles({etc:d.etc,profile:migration.profile,timestamp:stamp,vault:migration.vault,files:[{source:migration.p,mirror:'config.json'}],platform:ctx.platform});result.warnings.push(...backed.warnings);await safewrite(migration.p,migration.after);result.changed.push(migration.p);
    }
    if(versions.CONTRACT_VERSION!==oldVersions.CONTRACT_VERSION) {
      for(const id of machine.shared?.profiles||[]) {
        const mf=path.join(d.etc,'profiles',id,'manifest.json'),m=readManifest(mf),c=readJSON(path.join(d.etc,'profiles',id,'config.json'));
        for(const e of m.entries.filter(e=>e.kind==='block')) {
          if(await linked(e.path,ctx)||!under(e.path,m.vault.path))throw new Error('marker_out_of_scope');
          const name=path.basename(e.path),templateName=name==='AGENTS.md'?'AGENTS.block.md.tmpl':name==='.gitignore'?'gitignore.block.tmpl':name+'.tmpl';
          const template=files.get('installer/templates/vault/'+templateName);if(!template)throw new Error('contract_template_missing:'+name);
          // Render through the accepted template engine, using staged release templates.
          const plan=readJSON(path.join(d.plans,path.basename(m.journal||'','.jsonl')+'.json'),{}),answers=plan.answers||{};
          const text=render(template.toString(),{OWNER:answers.owner||'Owner',CHAT_LANGUAGE:answers['chat-language']||'English',PROFILE:id,WORK_DIR:c.layout.work_dir,JOBS_DIR:c.layout.jobs_dir,LEDGER_DIR:c.layout.ledger_dir,LAYOUT:layout(c.vault,{workDir:c.layout.work_dir,conventions:!!answers.conventions}),SERVER_NAME:m.server_name},{INDEX:!!answers.conventions||exists(path.join(c.vault,'INDEX.md')),CONVENTIONS:!!answers.conventions});
          const beforeBlock=fs.readFileSync(e.path),style=name==='.gitignore'?'hash':'markdown',scan=scanMarkers(beforeBlock,{style});
          if(!scan.ok||!scan.block||hashBody(scan.block.body)!==e.block_sha256_eolnorm) {
            const sibling=e.path+'.council-new';await safewrite(sibling,text,{exclusive:true});result.proposals.push({path:e.path,sibling,diff:'--- '+e.path+'\n+++ '+sibling+'\n'+beforeBlock.toString().split('\n').map(l=>'-'+l).join('\n')+'\n'+text.split('\n').map(l=>'+'+l).join('\n')});continue;
          }
          const merged=mergeMarkers(beforeBlock,text,{style,allowRewrite:true,recordedHash:e.block_sha256_eolnorm});if(!merged.ok)throw new Error(merged.code);
          const backed=await backupFiles({etc:d.etc,profile:id,timestamp:stamp,vault:m.vault.path,files:[{source:e.path,mirror:path.join('vault',name)}],platform:ctx.platform});result.warnings.push(...backed.warnings);await safewrite(e.path,merged.bytes);result.changed.push(e.path);
        }
      }
    }
    await safewrite(d.machine,JSON.stringify({...machine,notice_ack:{notice_sha256:notice,accepted_at:new Date().toISOString()},shared:{...machine.shared,app_versions:[...new Set([...(machine.shared?.app_versions||[]),versions.APP_VERSION])]}},null,2)+'\n');
    // Carry ownership forward so verify and a later uninstall see the promoted bytes.
    for(const id of machine.shared?.profiles||[]) {
      const mf=path.join(d.etc,'profiles',id,'manifest.json');if(await linked(mf,ctx))throw new Error('manifest_out_of_scope');
      const m=readManifest(mf),entries=new Map(m.entries.map(e=>[e.path,e]));
      for(const h of hashes)entries.set(path.join(target,h.path),{path:path.join(target,h.path),kind:'file',created:true,sha256:h.sha256,removal:'delete_if_hash_matches'});
      for(const file of [target,...hashes.map(h=>path.dirname(path.join(target,h.path)))])for(let p=file;under(p,target);p=path.dirname(p)){if(!entries.has(p))entries.set(p,{path:p,kind:'dir',created:true,removal:'rmdir_if_empty'});if(p===target)break;}
      entries.set(manifestFile,{path:manifestFile,kind:'file',created:true,sha256:sha256(fs.readFileSync(manifestFile)),removal:'delete_if_hash_matches'});
      for(const e of entries.values())if(result.changed.includes(e.path)&&exists(e.path)) {
        if(e.kind==='file')e.sha256=sha256(fs.readFileSync(e.path));
        if(e.kind==='block'){e.block_sha256_eolnorm=hashBody(scanMarkers(fs.readFileSync(e.path),{style:path.basename(e.path)==='.gitignore'?'hash':'markdown'}).block.body);e.contract_version=versions.CONTRACT_VERSION;}
      }
      await safewrite(mf,JSON.stringify({...m,app_version:versions.APP_VERSION,app_versions:[...new Set([...(m.app_versions||[]),m.app_version,versions.APP_VERSION])],entries:[...entries.values()]},null,2)+'\n');result.changed.push(mf);
    }
    result.changed.push(d.machine);return result;
  }finally{await releaseLock(lock,ctx.lockOptions);}
}
