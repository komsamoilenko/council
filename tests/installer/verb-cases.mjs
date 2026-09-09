// Sandboxed integrations; shared apply fixture retains whole-tree and canary checks.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {PassThrough,Writable} from 'node:stream';
import {apply,tier0} from '../../installer/lib/apply.mjs';
import {uninstall} from '../../installer/lib/uninstall.mjs';
import {verify} from '../../installer/lib/verify.mjs';
import {update} from '../../installer/lib/update.mjs';
import {sha256} from '../../installer/lib/manifest.mjs';
import {scanMarkers} from '../../installer/lib/markers.mjs';
import {names,put} from './fixtures.mjs';
import {nativeProbe} from '../../installer/lib/survey.mjs';
import {appdirs} from '../../installer/lib/appdirs.mjs';
import {buildPlan,publishPlan} from '../../installer/lib/planning.mjs';
import {snapshot,assertUnchanged} from './sandbox-assertions.mjs';

export function terminal(answers=[]) {
  const input=new PassThrough();input.isTTY=true;let transcript='',buffer='';
  const output=new Writable({write(chunk,encoding,done){const text=chunk.toString();transcript+=text;buffer+=text;
    if(/(?:\[y\/N\] |Type profile id in full \([^\n]+\): )$/.test(buffer)&&answers.length){const answer=answers.shift();buffer='';setImmediate(()=>input.write(answer+'\n'));}done();}});output.isTTY=true;
  return {input,output,text:()=>transcript};
}
const json=(file,doc)=>put(file,JSON.stringify(doc,null,2)+'\n');
function zipFixture(files) {
  const locals=[],central=[];let offset=0;
  for(const [name,bytes] of files) {
    const n=Buffer.from(name),head=Buffer.alloc(30);head.writeUInt32LE(0x04034b50);head.writeUInt32LE(bytes.length,18);head.writeUInt32LE(bytes.length,22);head.writeUInt16LE(n.length,26);
    locals.push(head,n,bytes);const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt32LE(bytes.length,20);c.writeUInt32LE(bytes.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE(offset,42);central.push(c,n);offset+=30+n.length+bytes.length;
  }
  const cd=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...locals,cd,end]);
}
export async function verbCases(make,tree) {
  let count=0;
  for(const name of names) {
    const f=await make(name),before=tree(f.vault);await apply(f.options,f.ctx);
    const installed=tree(f.vault),manifest=JSON.parse(fs.readFileSync(f.ctx.dirs.manifest));
    const backups=fs.existsSync(f.ctx.dirs.backups)?tree(f.ctx.dirs.backups):{};
    const term=terminal();const result=await uninstall({yes:true},{...f.ctx,...term});assert.equal(result.exitCode,0,JSON.stringify(result));
    const after=tree(f.vault);
    for(const [file,bytes] of Object.entries(before)) {
      // §7.7 removes adopted council blocks, preserving every outside byte.
      if(manifest.entries.some(e=>e.path===file&&e.kind==='block')) {const b=Buffer.from(installed[file],'base64'),s=scanMarkers(b,{style:path.basename(file)==='.gitignore'?'hash':'markdown'});assert.equal(after[file],Buffer.concat([b.subarray(0,s.block.start),b.subarray(s.block.end)]).toString('base64'),'§7.7 outside bytes, including the appended separator, preserved');}
      else if(manifest.entries.some(e=>e.path===file&&e.removal==='never'))assert.equal(after[file],installed[file],'manifest never preserves the installed transplant pointer');
      else assert.equal(after[file],bytes,'uninstall original: '+file);
    }
    assert.deepEqual(fs.existsSync(f.ctx.dirs.backups)?tree(f.ctx.dirs.backups):{},backups);
    assert.ok(fs.existsSync(f.ctx.dirs.runtimeRoot));count++;
  }
  {
    const f=await make('empty','all');await apply(f.options,f.ctx);
    const term=terminal();
    const result=await uninstall({yes:true},{...f.ctx,...term,probe:(file,args,opts)=>{
      if(args[0]==='mcp'&&args[1]==='remove') {const p=path.join(f.ctx.env.CLAUDE_CONFIG_DIR,'.claude.json');const doc=JSON.parse(fs.readFileSync(p));delete doc.mcpServers[args[2]];json(p,doc);return {status:0,stdout:''};}return f.ctx.probe(file,args,opts);
    }});
    assert.equal(result.exitCode,0);
    for(const r of f.plan.registrations){const bytes=fs.readFileSync(r.path,'utf8');assert.match(bytes,/keep/);assert.doesNotMatch(bytes,/COUNCIL_PROFILE/);}
    const out=path.join(f.dir,'Documents');fs.mkdirSync(out);put(path.join(out,'keep'),'canary');
    const m=JSON.parse(fs.readFileSync(f.ctx.dirs.manifest));m.entries.push({path:out,kind:'dir',created:true,removal:'rmdir_if_empty'});json(f.ctx.dirs.manifest,m);
    const scoped=await uninstall({yes:true},{...f.ctx,...terminal()});assert.ok(scoped.skipped.some(s=>s.path===out&&s.reason==='out_of_scope'));assert.equal(fs.readFileSync(path.join(out,'keep'),'utf8'),'canary');count++;
    process.stdout.write('BEGIN SANDBOX UNINSTALL\n'+term.text()+JSON.stringify(result,null,2)+'\nEND SANDBOX UNINSTALL\n');
  }
  {
    const f=await make('empty','claude-desktop',true);await apply(f.options,f.ctx);
    const before=snapshot(f.dir);
    const checked=await verify({}, {...f.ctx,probe:nativeProbe});
    assert.equal(checked.exitCode,0,JSON.stringify(checked));assert.equal(checked.registrations.length,1);assertUnchanged(f.dir,f.ctx.env.USERPROFILE,before,snapshot(f.dir),[],f.ctx.dirs.id);
    assert.equal(checked.registrations[0].doctor.mode,'normal');assert.equal(checked.registrations[0].doctor.reaper,'suppressed (COUNCIL_SMOKE_RUN)');count++;
    process.stdout.write('PASS real-profile verify initialize + tools/list + doctor + clean pipe exit\n');
  }
  for(const all of [false,true]) {
    const f=await make('empty');await apply(f.options,f.ctx);
    const vault=path.join(f.dir,'second-vault');fs.mkdirSync(vault);
    const ctx={...f.ctx,dirs:appdirs({env:f.ctx.env,profile:'second'})};
    const plan=await buildPlan({profile:'second',vault,hosts:'none',json:true},ctx);await publishPlan(plan);await apply({plan:plan.plan.file,yes:true},ctx);
    const appBefore=tree(f.ctx.dirs.app);
    const first=await uninstall({yes:true,all},{...f.ctx,...terminal()});assert.equal(first.exitCode,0,JSON.stringify(first));
    if(!all){assert.deepEqual(tree(f.ctx.dirs.app),appBefore);assert.deepEqual(JSON.parse(fs.readFileSync(ctx.dirs.machine)).shared.profiles,['second']);const last=await uninstall({yes:true,profile:'second'},{...ctx,...terminal()});assert.equal(last.exitCode,0,JSON.stringify(last));}
    assert.equal(fs.existsSync(f.ctx.dirs.app),false);assert.equal(fs.existsSync(f.ctx.dirs.launcher),false);assert.deepEqual(JSON.parse(fs.readFileSync(ctx.dirs.machine)).shared.profiles,[]);count++;
  }
  {
    let runtime;
    const f=await make('empty','claude-desktop',true,(ctx,vault)=>{runtime=path.join(ctx.dirs.root,'custom-runtime');json(ctx.dirs.config,{schema:2,vault,runtime_root:runtime});});
    await apply(f.options,f.ctx);const before=snapshot(f.dir);
    const checked=await verify({}, {...f.ctx,probe:nativeProbe});assert.equal(checked.exitCode,0,JSON.stringify(checked));assertUnchanged(f.dir,f.ctx.env.USERPROFILE,before,snapshot(f.dir),[],f.ctx.dirs.id);
    const removed=await uninstall({yes:true},{...f.ctx,...terminal()});assert.equal(removed.exitCode,0,JSON.stringify(removed));assert.ok(fs.existsSync(runtime));assert.equal(fs.existsSync(f.ctx.dirs.app),false);count++;
  }
  {
    const f=await make('empty');await apply(f.options,f.ctx);
    put(path.join(f.ctx.dirs.backups,'stamp-a','a.txt'),'first');put(path.join(f.ctx.dirs.backups,'stamp-b','b.txt'),'second');
    const before=tree(f.dir),wrong=await uninstall({'purge-backups':true},{...f.ctx,...terminal(['yes','yes','no','wrong'])});
    assert.equal(wrong.exitCode,4);assert.deepEqual(tree(f.dir),before);
    const term=terminal(['yes','yes','no','default']);const purged=await uninstall({'purge-backups':true},{...f.ctx,...term});assert.equal(purged.exitCode,0);
    assert.equal(fs.existsSync(path.join(f.ctx.dirs.backups,'stamp-a')),false);assert.equal(fs.readFileSync(path.join(f.ctx.dirs.backups,'stamp-b','b.txt'),'utf8'),'second');assert.match(term.text(),/a.txt/);assert.match(term.text(),/b.txt/);count++;
  }
  {
    const f=await make('empty');await apply(f.options,f.ctx);
    const c=JSON.parse(fs.readFileSync(f.ctx.dirs.config));c.layout.jobs_dir=f.ctx.dirs.jobs;c.layout.ledger_dir=f.ctx.dirs.ledger;json(f.ctx.dirs.config,c);
    put(path.join(f.ctx.dirs.secrets,'gemini.bin'),'encrypted fixture');put(path.join(f.ctx.dirs.jobs,'job','state.json'),'{}');put(path.join(f.ctx.dirs.ledger,'council.jsonl'),'{}\n{}\n');
    put(f.ctx.dirs.stop,'stop');put(f.ctx.dirs.agyGate,'fixture inert');
    const before=tree(f.dir);
    const yes=await uninstall({'purge-runtime':true,yes:true},{...f.ctx,...terminal()});assert.equal(yes.exitCode,4);assert.deepEqual(tree(f.dir),before);
    const non=await uninstall({'purge-runtime':true},{...f.ctx,input:{isTTY:false},output:{isTTY:false}});assert.equal(non.exitCode,4);assert.deepEqual(tree(f.dir),before);
    const term=terminal(['yes','yes','no','yes','default']);
    const result=await uninstall({'purge-runtime':true},{...f.ctx,...term});assert.equal(result.exitCode,0);
    assert.equal(fs.existsSync(f.ctx.dirs.secrets),false);assert.equal(fs.existsSync(f.ctx.dirs.ledger),false);assert.ok(fs.existsSync(path.join(f.ctx.dirs.jobs,'job','state.json')));
    assert.ok(fs.existsSync(f.ctx.dirs.stop));assert.ok(fs.existsSync(f.ctx.dirs.agyGate));assert.ok(fs.existsSync(f.ctx.dirs.sandbox));
    process.stdout.write('BEGIN SANDBOX PURGE\n'+term.text()+'--yes: '+yes.reason+'\nnon-TTY: '+non.reason+'\nEND SANDBOX PURGE\n');count++;
  }
  {
    const f=await make('empty','all');await apply(f.options,f.ctx);
    const ctx={...f.ctx,trustCheck:async()=>({status:0,stdout:'{"failures":[]}'}),verifyHandshake:async(r,c,e)=>{
      assert.equal(e.profile,'default');assert.equal(r.env.COUNCIL_PROFILE,e.profile);assert.equal(e.vault,f.vault);
      fs.appendFileSync(path.join(e.ledger,'verify-council-'+new Date().toISOString().slice(0,7)+'.jsonl'),'{}\n');return {elapsed_ms:1};
    }};
    const before=snapshot(f.dir);const healthy=await verify({},ctx);assert.equal(healthy.exitCode,0,JSON.stringify(healthy));assert.equal(healthy.registrations.length,3);assertUnchanged(f.dir,f.ctx.env.USERPROFILE,before,snapshot(f.dir),[],f.ctx.dirs.id);for(const p of healthy.created)assert.equal(fs.existsSync(p),false);
    const router=path.join(f.ctx.dirs.app,'lib','router.js'),old=fs.readFileSync(router);fs.appendFileSync(router,'x');const bad=await verify({},ctx);assert.equal(bad.exitCode,7);assert.ok(bad.drift.includes('app_integrity_failed:lib/router.js'));fs.writeFileSync(router,old);
    const host=f.plan.registrations.find(r=>r.surface==='claude-desktop').path,doc=JSON.parse(fs.readFileSync(host));doc.mcpServers.council.command='shim.cmd';json(host,doc);const shim=await verify({},ctx);assert.equal(shim.exitCode,7);assert.ok(shim.drift.some(x=>x.includes('E_SHIM_REGISTRATION')));count++;
  }
  // Zip digest refusal precedes even the setup lock or a staged directory.
  {
    const f=await make('empty');await apply(f.options,f.ctx);
    const asset=path.join(f.dir,'release.zip');put(asset,'not a zip');put(asset+'.sha256','0'.repeat(64));
    const machine=JSON.parse(fs.readFileSync(f.ctx.dirs.machine));machine.source={channel:'zip',asset};json(f.ctx.dirs.machine,machine);
    const before=tree(f.dir);const result=await update({},f.ctx);assert.equal(result.exitCode,4);assert.equal(result.reason,'zip_sha256_mismatch');assert.deepEqual(tree(f.dir),before);count++;
  }
  for(const scenario of ['tier0-fail','running-job','promote-rollback','migrate','edited-contract','prune','real-stage']) {
    const migrating=['migrate','edited-contract'].includes(scenario);
    const f=await make(migrating?'conflicting-agents':'empty');await apply(f.options,f.ctx);
    const files=[];const walk=dir=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else files.push(['src/'+path.relative(f.ctx.dirs.app,p).replaceAll('\\','/'),fs.readFileSync(p)]);}};walk(f.ctx.dirs.app);
    files.find(([p])=>p==='src/version.js')[1]=Buffer.from(files.find(([p])=>p==='src/version.js')[1].toString().replace("APP_VERSION: '0.1.0'","APP_VERSION: '0.1.1'"));
    if(migrating) {
      const version=files.find(([p])=>p==='src/version.js');version[1]=Buffer.from(version[1].toString().replace('CONFIG_SCHEMA: 2','CONFIG_SCHEMA: 3').replace('CONTRACT_VERSION: 1','CONTRACT_VERSION: 2'));
      const templates=path.resolve(import.meta.dirname,'../../installer/templates');
      const collect=dir=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())collect(p);else {let bytes=fs.readFileSync(p);if(e.name==='config.template.json')bytes=Buffer.from(bytes.toString().replace('"schema": 2','"schema": 3'));if(e.name==='AGENTS.block.md.tmpl')bytes=Buffer.from(bytes.toString().replace('## Council','Updated contract fixture\n\n## Council'));files.push(['installer/templates/'+path.relative(templates,p).replaceAll('\\','/'),bytes]);}}};collect(templates);
      if(scenario==='edited-contract'){const p=path.join(f.vault,'AGENTS.md');put(p,fs.readFileSync(p,'utf8').replace('## Council','Human-edited contract\n## Council'));}
    }
    const notice=Buffer.from('Fixture NOTICE');files.push(['NOTICE.md',notice]);
    const asset=path.join(f.dir,'release.zip'),bytes=zipFixture(files);put(asset,bytes);put(asset+'.sha256',sha256(bytes));
    const machine=JSON.parse(fs.readFileSync(f.ctx.dirs.machine));machine.source={channel:'zip',asset};machine.notice_ack={notice_sha256:sha256(notice)};json(f.ctx.dirs.machine,machine);
    const before=fs.readFileSync(f.ctx.dirs.current);
    if(scenario==='running-job')put(path.join(f.vault,'work','jobs','job','state.json'),'{"state":"running"}');
    let staged;
    const result=await update({}, {...f.ctx,tier0:async c=>{staged=c.dirs.app;assert.ok(staged.endsWith('0.1.1.partial'));assert.match(fs.readFileSync(path.join(staged,'version.js'),'utf8'),/0.1.1/);if(scenario==='tier0-fail')throw new Error('fixture failed');return scenario==='real-stage'?tier0(c):'staged fixture passed';}});
    assert.ok(staged);
    if(scenario==='real-stage') {assert.equal(result.exitCode,0,JSON.stringify(result));assert.match(result.tier0,/0 failed/);process.stdout.write('PASS real staged-version Tier-0 fast\n');}
    else if(scenario==='prune') {
      assert.equal(result.exitCode,0,JSON.stringify(result));
      const snapshot=tree(f.dir);
      const busy=await update({'prune-versions':true,keep:1},{...f.ctx,platform:{...f.ctx.platform,commandLines:()=>['node '+path.join(f.ctx.dirs.app,'server.js')]}});
      assert.equal(busy.exitCode,4);assert.equal(busy.reason,'version_in_use');assert.deepEqual(tree(f.dir),snapshot);
      const unknown=await update({'prune-versions':true,keep:1},{...f.ctx,platform:{...f.ctx.platform,commandLines:()=>null}});assert.equal(unknown.exitCode,4);assert.deepEqual(tree(f.dir),snapshot);
      const pruned=await update({'prune-versions':true,keep:1},{...f.ctx,platform:{...f.ctx.platform,commandLines:()=>[]}});assert.equal(pruned.exitCode,0,JSON.stringify(pruned));assert.equal(fs.existsSync(f.ctx.dirs.app),false);assert.equal(fs.existsSync(path.join(path.dirname(f.ctx.dirs.app),'0.1.1')),true);
    }else if(migrating) {
      assert.equal(result.exitCode,0,JSON.stringify(result));assert.equal(JSON.parse(fs.readFileSync(f.ctx.dirs.config)).schema,3);
      const agents=path.join(f.vault,'AGENTS.md'),mf=JSON.parse(fs.readFileSync(f.ctx.dirs.manifest));
      if(scenario==='edited-contract'){assert.match(fs.readFileSync(agents,'utf8'),/Human-edited/);assert.match(fs.readFileSync(agents+'.council-new','utf8'),/Updated contract/);assert.match(result.proposals[0].diff,/---/);}
      else {assert.match(fs.readFileSync(agents,'utf8'),/Updated contract/);assert.equal(mf.entries.find(e=>e.path===agents).contract_version,2);}
      assert.ok(Object.keys(tree(f.ctx.dirs.backups)).some(p=>path.basename(p)==='config.json'));
    }else if(scenario==='promote-rollback') {
      assert.equal(result.exitCode,0,JSON.stringify(result));assert.equal(JSON.parse(fs.readFileSync(f.ctx.dirs.current)).version,'0.1.1');assert.ok(fs.existsSync(f.ctx.dirs.app));
      const snapshot=tree(f.dir),rollback=await update({rollback:true},f.ctx);assert.equal(rollback.exitCode,0);assert.deepEqual(fs.readFileSync(f.ctx.dirs.current),before);const after=tree(f.dir);delete after[f.ctx.dirs.current];delete snapshot[f.ctx.dirs.current];assert.deepEqual(after,snapshot);
    }else {assert.equal(result.exitCode,scenario==='tier0-fail'?1:4,JSON.stringify(result));assert.deepEqual(fs.readFileSync(f.ctx.dirs.current),before);}
    count++;
  }
  process.stdout.write('PASS verify/uninstall/update ('+count+' checks)\n');
}
