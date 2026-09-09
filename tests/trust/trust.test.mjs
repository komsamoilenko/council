import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {files,put,json,repo} from './fixture.mjs';
import acl from './win32-acl.test.mjs';
import {validateManifest,sha256} from '../../installer/lib/manifest.mjs';
function reason(result,want){assert.equal(result.ok,false);assert.equal(result.reason,want);}
function failure(result,key,want){assert.equal(result.ok,false);assert.ok(result.failures.some(x=>x.key===key && x.reason===want),key+': expected '+want);}
async function cases(items){const errors=[];for(const [name,run] of items){try{await run();}catch(e){errors.push(name+': '+e.message);}}assert.equal(errors.length,0,errors.join('; '));}
export default async function(test){
  await test('T-40','modified router and unlisted code refuse boot',async f=>{
    const server=f.load('server.js'); assert.equal(server.boot().trust.ok,true,'clean installed control');
    const router=path.join(f.app,'lib','router.js'), original=fs.readFileSync(router), changed=Buffer.from(original); changed[0]^=1; fs.writeFileSync(router,changed);
    let ctx=server.boot(); failure(ctx.trust,'app','app_integrity_failed:lib/router.js'); assert.notEqual(ctx.mode,'normal');
    fs.writeFileSync(router,original); put(path.join(f.app,'lib','evil.js'),'// unlisted\n');
    ctx=server.boot(); failure(ctx.trust,'app','app_integrity_failed:lib/evil.js'); assert.notEqual(ctx.mode,'normal');
    assert.equal(f.spawns,0);
  });
  await test('T-41','vault config/accounts/code and profile overrides stay ignored',async f=>{
    const profile=f.load('lib/profile.js'),server=f.load('server.js'); const baseline=profile.resolve().config.binaries;
    const dropped={...f.config,binaries:{node:path.join(f.vault,'evil')}};
    const p=json(path.join(f.vault,'config.json'),dropped);
    json(path.join(f.vault,'accounts.json'),{accounts:{echo:{label:'hostile'}}});
    const legacy=path.join(f.vault,'bin','council','config.json');
    json(legacy,dropped);
    json(path.join(f.vault,'bin','council','accounts.json'),{accounts:{echo:{label:'hostile'}}});
    put(path.join(f.vault,'bin','council','server.js'),'throw new Error("vault code ran");');
    await cases([
      ['installed',async()=>{const ctx=server.boot();assert.deepEqual(ctx.config.binaries,baseline);assert.equal(ctx.accounts.echo.label,'trusted');assert.ok((await server.doctorReport(ctx,false)).warnings.includes('vault_config_ignored'));}],
      ['explicit vault path',()=>{const r=profile.resolve(p);assert.ok(r.warnings.includes('vault_config_ignored'));assert.ok(JSON.stringify(r.config.binaries)===JSON.stringify(baseline),'effective binaries changed');}],
      ...['','smoke','codex'].map(host=>['COUNCIL_CONFIG host='+ (host||'unset'),()=>{process.env.COUNCIL_HOST=host;process.env.COUNCIL_CONFIG=p;const r=profile.resolve();assert.ok(r.warnings.includes('vault_config_ignored'));assert.ok(JSON.stringify(r.config.binaries)===JSON.stringify(baseline),'effective binaries changed');}]),
      ['vault-root config without legacy sibling',()=>{delete process.env.COUNCIL_CONFIG;fs.unlinkSync(legacy);const r=profile.resolve();assert.deepEqual(r.config.binaries,baseline);assert.ok(r.warnings.includes('vault_config_ignored'),'missing vault_config_ignored');}],
      ['vault override without legacy sibling',()=>{delete process.env.COUNCIL_HOST;process.env.COUNCIL_CONFIG=p;const r=profile.resolve();assert.ok(r.warnings.includes('vault_config_ignored'),'missing vault_config_ignored');}]
    ]);
  });
  await test('T-42','roots widening and temporary npm root ignored',f=>{
    const roots=f.load('lib/roots.js'),guard=f.load('lib/guard.js'),platform=f.load('platform');
    const baseline=roots.allowedRoots({}),evil=put(path.join(f.root,'untrusted','tool'),'fixture');
    const machine={allowed_roots:[f.root],ALLOWED_ROOTS:[f.root],roots:[f.root]};
    assert.deepEqual(roots.allowedRoots(machine),baseline);
    reason(guard.checkBinaryPath('node',evil,machine,f.config),'outside_allowed_roots');
    const npm=path.join(process.env.LOCALAPPDATA,'npm-under-temp');fs.mkdirSync(npm,{recursive:true});
    // Explicit TEMP contains an otherwise trusted anchor: exercises exclusion, not just missing/foreign paths.
    process.env.TEMP=f.root;process.env.TMP=f.root;
    const r=platform.npmRootInfo({npm_root_g:npm});assert.equal(r.warning,'npm_root_ignored');assert.notEqual(r.root,npm);
    assert.deepEqual(roots.allowedRoots({npm_root_g:npm}),baseline);
  });
  await test('T-43','secret detected without stdout, stderr or output-file disclosure',async f=>{
    const secret='AIza'+'Q7x_'.repeat(9);json(f.configPath,{...f.config,notes:secret});
    const before=new Map(files(f.root).map(p=>[p,fs.readFileSync(p)]));
    const output={stdout:'',stderr:''},saved=[];
    for(const key of Object.keys(output)){const stream=process[key],old=stream.write;saved.push(()=>stream.write=old);stream.write=(chunk,...args)=>{output[key]+=String(chunk);const cb=args.find(x=>typeof x==='function');if(cb)cb();return true;};}
    let ctx,report,error;
    try{const server=f.load('server.js');ctx=server.boot();report=await server.doctorReport(ctx,false);process.stdout.write(JSON.stringify(report));}catch(e){error=e;}finally{for(const restore of saved)restore();}
    assert.ok(!Object.values(output).some(s=>s.includes(secret)),'secret leaked to stdout/stderr');
    for(const p of files(f.root)){const bytes=fs.readFileSync(p);if(!before.get(p)?.equals(bytes))assert.ok(!bytes.includes(Buffer.from(secret)),'secret leaked to output file');}
    if(error)throw error;
    failure(ctx.trust,'profile.notes','secret_in_config');assert.notEqual(ctx.mode,'normal');
    assert.ok(report.config.trust.failures.some(x=>x.reason==='secret_in_config'));
  });
  await test('T-44','agy absent, empty, acknowledged: exact reasons and zero spawns',async f=>{
    const server=f.load('server.js'),ctx=server.boot(),agy=f.load('backends/gemini-agy.js');
    // Read the canonical sentence, without introducing another copy of it in the repository.
    const source=fs.readFileSync(path.join(repo,'src','backends','gemini-agy.js'),'utf8');
    const ack=/const ACKNOWLEDGEMENT = '([^']+)'/.exec(source)[1];
    for(const [content,want] of [[null,'agy_gate_missing'],['','agy_notice_not_acknowledged'],['\n  '+ack+'  \n','agy_prompt_form_unknown']]){
      if(content!==null)put(ctx.paths.agyGate,content);
      reason(agy.available(ctx,{}),want);
      assert.equal((await server.doctorReport(ctx,false)).gemini.reason,want);
      assert.equal(f.spawns,0,'each agy state must spawn nothing');
    }
  });
  await test('T-45','tampered spawn.json file and node script refused with zero spawns',f=>{
    const ctx=f.load('server.js').boot(),{Job}=f.load('runner.js'),store=f.load('lib/jobstore.js');
    const dir=path.join(f.vault,'work','jobs','tampered'),out=store.jobFiles(dir);
    const spec={file:f.binaries.node,args:[f.binaries.codex_js],cwd:f.runtime,promptVia:'stdin'};
    const job=new Job({ctx,jobDir:dir,files:out,request:{job_id:'tampered'},spawnDoc:{},promptText:'fixture',rlog:()=>{}});
    assert.equal(job.binaryAllowed(spec.file,spec.args,'codex').ok,true,'valid binary control');
    for(const [change,want] of [[{file:path.join(f.vault,'evil')},'not one of config.binaries'],[{args:[path.join(f.vault,'evil.js')]},'node_script_rejected']]){
      json(out.spawn,{legs:{codex:{...spec,...change}}});job.spawnDoc=store.readJSON(out.spawn);
      const leg={leg_id:'codex',backend:'codex',meta:{}};job.spawnLeg(leg);
      assert.equal(leg.state,'error');assert.equal(leg.spawn_error,'spawn.json file rejected: '+want);assert.equal(f.spawns,0);
    }
  });
  await test('T-46','uninstall preserves out-of-scope Documents',async f=>{
    const documents=put(path.join(process.env.USERPROFILE,'Documents','keep.txt'),'user content');
    const doc={schema:1,profile:'default',server_name:'council',app_version:'0.1.0',
      installed_at:'2026-09-08T00:00:00Z',last_apply_at:'2026-09-08T00:00:00Z',
      runtime_root:f.runtime,backups_dir:path.join(f.dirs.etc,'backups'),plan_sha256:sha256('fixture plan'),
      vault:{path:f.vault,real:fs.realpathSync(f.vault),vault_id:'fixture'},
      entries:[{path:path.dirname(documents),kind:'dir',created:true,removal:'rmdir_if_empty'}],
      registrations:[],pending_hosts:[],left_alone:[],observed:{}};
    validateManifest(doc);
    json(path.join(f.vault,'.council','vault.json'),{schema:1,profile:'default',vault_id:'fixture'});
    const manifest=json(path.join(f.dirs.etc,'profiles','default','manifest.json'),doc);
    // Task 11 must bind the verb's eventual API here; the target and exact refusal stay fixed.
    const {uninstall}=await import('../../installer/lib/uninstall.mjs');
    const report=await uninstall({manifest,profile:'default'});
    assert.ok(report.skipped.some(x=>x.path===path.dirname(documents)&&x.reason==='out_of_scope'));
    assert.equal(fs.readFileSync(documents,'utf8'),'user content');
  });
  await test('T-47','runtime, vault and layout zone crossings refused',async f=>{
    const guard=f.load('lib/guard.js'),profile=f.load('lib/profile.js');const base=profile.resolve();assert.equal(guard.checkConfigTrust(base).ok,true);
    const check=config=>guard.checkConfigTrust({...base,config});
    await cases([
      ['runtime under vault',()=>failure(check({...base.config,runtime_root:path.join(f.vault,'run')}),'runtime_root','inside_vault')],
      ['vault contains app data',()=>failure(check({...base.config,vault:path.dirname(f.dirs.root)}),'vault','vault_contains_app_data')],
      ...['work_dir','jobs_dir','ledger_dir'].map(key=>[key,()=>failure(check({...base.config,layout:{...base.config.layout,[key]:path.join(f.root,'outside')}}),'layout.'+key,'layout_outside_known_roots')])
    ]);
  });
  await test('T-48','binary in runtime returns writable_zone',f=>{
    const file=put(path.join(f.runtime,'tool'),'fixture');
    reason(f.load('lib/guard.js').checkBinaryPath('node',file,{},f.config),'writable_zone');
  });
  await test('T-49','vault-root and ancestor read paths refused',f=>{
    const p=f.load('lib/paths.js'),P=p.computePaths(f.config);
    const notes=put(path.join(f.vault,'notes','ok.md'),'readable');assert.equal(p.resolveVaultPath(notes,P).ok,true);
    for(const input of [f.vault,'.',path.dirname(f.vault)])reason(p.resolveVaultPath(input,P),'vault_root_not_grantable');
  });
  await test('T-50','ACL failed grant restores readability and reports reason',acl);
  await test('T-50-report','ACL warning surfaces in apply',async f=>{
    const platform={...f.load('platform'),restrictToOwner:async()=>({ok:false,reason:'backup_acl_not_restricted'})};
    const {aclApply}=await import('../installer/acl-apply.mjs');
    assert.match(await aclApply(f,platform),/backup_acl_not_restricted/);
  });
  await test('T-50-verify','ACL warning surfaces in verify',async f=>{
    const backup=path.join(f.dirs.etc,'backups','fixture');fs.mkdirSync(backup,{recursive:true});
    const platform={...f.load('platform'),restrictToOwner:async()=>({ok:false,reason:'backup_acl_not_restricted'})};
    const {verify}=await import('../../installer/lib/verify.mjs');
    assert.match(JSON.stringify(await verify({profile:'default'},{platform})),/backup_acl_not_restricted/);
  });
}
