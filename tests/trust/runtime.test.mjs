// A-54/A-55: fixture-only process evidence; no vendor or machine-profile access.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import cp from 'node:child_process';
import {spawn as nativeSpawn,execFile as nativeExecFile} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {put,json} from './fixture.mjs';

function job(f, ctx, age=0) {
  const store=f.load('lib/jobstore');
  const id=store.newJobId(Date.now()-age), made=store.createJobDir(ctx.paths,id,['echo']);
  json(made.files.request,{job_id:id,profile:ctx.profile,created_ms:1,deadline_ms:Date.now()-61000,legs:[{leg_id:'echo',backend:'echo',expected_image:'evil.exe'}]});
  json(made.files.state,{runner_pid:123,heartbeat_ms:Date.now(),legs:{echo:{pid:456,state:'running'}}});
  return {id,...made,view:()=>store.loadView(ctx.paths,ctx.config,id)};
}
function patch(object, values) {
  const old=Object.fromEntries(Object.keys(values).map(k=>[k,object[k]]));
  Object.assign(object,values); return ()=>Object.assign(object,old);
}
export default async function(test) {
  await test('T-52','forged runner refuses all leaves in sweep and cancel; verified control finalizes',async f=>{
    const ctx=f.load('server').boot(),r=f.load('lib/reaper'),p=f.load('platform');
    ctx.config.timing={cancel_watch_ms:1};
    const j=job(f,ctx),killed=[],verified=[];
    const restore=patch(p,{verifyRunner:async()=>({ok:false,reason:'pid-identity-mismatch'}),
      verifyLeaf:async(_c,pid,o)=>{verified.push(o);return {ok:true};},treeKill:async(_c,pid)=>{killed.push(pid);return {verified_dead:true,exit:0};}});
    try {
      const sweep=await r.tick(ctx); assert.equal(sweep.orphans,1); assert.deepEqual(killed,[]); assert.deepEqual(verified,[]);
      const j2=job(f,ctx); const cancelled=await r.cancelJob(ctx,j2.id);
      assert.equal(cancelled.killed.refused,'pid-identity-mismatch');
      assert.equal(cancelled.children_cancelled[0].refused,'pid-identity-mismatch');
      assert.equal(cancelled.children_cancelled[0].verified_dead,false); assert.deepEqual(killed,[]);
      const positive=job(f,ctx); p.verifyRunner=async()=>({ok:true});
      const done=await r.enforceDeadline(ctx,positive.view()); assert.equal(done.finalized,true);
      assert.deepEqual(killed,[123,456]); assert.equal(verified[0].expectedImage,f.load('backends/echo').expectedImageFor(ctx));
      assert.equal(verified[0].createdAtMs,f.load('lib/jobstore').jobMs(positive.id)); assert.equal(f.spawns,0);
    } finally {restore();}
  });
  await test('T-52-native','own live child survives fabricated job; real echo positive control',async f=>{
    const server=f.load('server'),ctx=server.boot(),r=f.load('lib/reaper'),p=f.load('platform');
    ctx.paths.binaries={...ctx.paths.binaries,...p.systemBinaries()};ctx.config.timing={cancel_watch_ms:1};
    const child=nativeSpawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
    const closed=new Promise(resolve=>child.once('close',resolve));
    let taskkills=0,inspections=0;
    const restore=patch(cp,{execFile:(file,...args)=>{
      if(p.sameFile(file,ctx.paths.binaries.taskkill)){taskkills++;throw new Error('native test forbids taskkill');}
      if(p.sameFile(file,ctx.paths.binaries.powershell))inspections++;
      return nativeExecFile(file,...args);
    },spawn:(file,args,options)=>{
      assert.equal(file,process.execPath);assert.equal(args[0],ctx.paths.runnerJs);
      return nativeSpawn(file,args,options);
    }});
    try {
      const probe=await p.verifyRunner(ctx,process.pid,{jobId:'fixture-not-a-runner'});
      assert.equal(inspections,1,'native inspection must execute before considering a skip');
      if(probe.reason==='identity_unevaluable') {
        assert.doesNotMatch(String(probe.error), /blocked/i, 'fixture interception is a harness failure, not an inspection skip');
        return {skip:'sandbox process inspection unavailable: '+probe.error+'; T-52 retains simulated kill-path coverage'};
      }
      for(const cancel of [false,true]) {
        const j=job(f,ctx),request=JSON.parse(fs.readFileSync(j.files.request));
        request.legs[0].expected_image=p.expectedImage('node');json(j.files.request,request);
        json(j.files.state,{runner_pid:process.pid,heartbeat_ms:Date.now(),legs:{echo:{pid:child.pid,state:'running'}}});
        if(cancel){const result=await r.cancelJob(ctx,j.id);assert.equal(result.children_cancelled[0].refused,'pid-identity-mismatch');}
        else {const result=await r.tick(ctx);assert.equal(result.orphans,1);}
        assert.equal(taskkills,0);assert.equal(child.exitCode,null);assert.equal(await p.livenessOf(ctx,child.pid),'alive');
      }
      const positive=await server.createJob(ctx,{prompt:'sleep:0'},{backends:['echo']});assert.equal(positive.ok,true);
      const deadline=Date.now()+5000;
      while(!fs.existsSync(positive.view.files.done)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
      assert.equal(fs.existsSync(positive.view.files.done),true,'real echo finalized');assert.equal(taskkills,0);
    } finally {restore();child.kill();await closed;}
  });
  await test('T-53','terminal markers cannot hide a verified live runner; vault locks ignored',async f=>{
    const ctx=f.load('server').boot(),r=f.load('lib/reaper'),p=f.load('platform');
    ctx.config.timing={cancel_watch_ms:1};
    put(path.join(ctx.paths.jobsRoot,'.reaper.lock'),'fresh');put(path.join(ctx.paths.jobsRoot,'.rate.lock'),'fresh');
    const j=job(f,ctx);put(j.files.done,'');let kills=0;
    const restore=patch(p,{verifyRunner:async()=>({ok:true}),verifyLeaf:async()=>({ok:true}),treeKill:async()=>{kills++;return {verified_dead:true,exit:0};},livenessOf:async()=> 'unknown'});
    try {
      const swept=await r.tick(ctx);assert.equal(swept.skipped_lock,false);assert.equal(swept.scanned,1);assert.equal(kills,2);
      assert.match(fs.readFileSync(ctx.paths.ledgerFileFor(),'utf8'),new RegExp('terminal_marker_' + 'with_live_runner'));
      const cancelled=await r.cancelJob(ctx,j.id);assert.equal(cancelled.killed.verified_dead,false,'unknown is not death');
      assert.equal(f.load('lib/fuses').reserveLegs(ctx,{job_id:'reservation',legs:[{leg_id:'echo',backend:'echo'}]}).ok,true);
    } finally {restore();}
  });
  await test('T-54','only control reservations affect hour/day/concurrency; completion preserves windows',async f=>{
    const ctx=f.load('server').boot(),fuses=f.load('lib/fuses'),store=f.load('lib/jobstore');
    ctx.config.fuses={max_running:1,max_per_hour:2};
    const reservation=fuses.reserveLegs(ctx,{job_id:'one',legs:[{leg_id:'echo',backend:'echo'}]});assert.equal(reservation.ok,true);
    put(path.join(ctx.paths.ledgerDir,'spawns.jsonl'),JSON.stringify({job_id:'one',leg_id:'echo',released:true})+'\n');
    const fabricated=job(f,ctx);put(fabricated.files.done,'');
    assert.equal(fuses.snapshot(ctx).running,1);assert.equal(fuses.snapshot(ctx).hour_used,1);
    assert.equal(fuses.reserveLegs(ctx,{job_id:'two',legs:[{leg_id:'echo'}]}).refuse_reason,'concurrency_limit');
    // A forged lost job may be finalized as a record; it cannot release a live reservation.
    const real=job(f,ctx);
    store.appendLine(ctx.paths.spawnsPath,JSON.stringify({job_id:real.id,leg_id:'echo',ms:Date.now()}));
    json(real.files.state,{runner_pid:null,heartbeat_ms:1,legs:{}});
    const restore=patch(f.load('platform'),{verifyRunner:async()=>({ok:false,reason:'no-pid'})});
    try {await f.load('lib/reaper').checkLost(ctx,real.view());} finally {restore();}
    assert.equal(fuses.snapshot(ctx).running,2,'vault finalization never frees a reservation');
    fuses.releaseReservation(ctx,{ok:true,job_id:real.id,reserved:[{leg_id:'echo',ms:Date.now()}]});
    fuses.completeLeg(ctx,'one','echo');assert.equal(fuses.snapshot(ctx).running,0);assert.equal(fuses.snapshot(ctx).hour_used,1);
    fuses.releaseReservation(ctx,reservation);assert.equal(fuses.snapshot(ctx).hour_used,0);
    store.appendLine(ctx.paths.spawnsPath,JSON.stringify({job_id:'expired',leg_id:'echo',ms:Date.now()-1801000}));
    assert.equal(fuses.snapshot(ctx).running,0);
    assert.ok(ctx.paths.idemDir.startsWith(ctx.paths.controlDir));
  });
  await test('T-54-native','two server contexts count live children and recover missed close callbacks',async f=>{
    const server=f.load('server'),ctx=server.boot(),other=server.boot(),fuses=f.load('lib/fuses');
    ctx.config.fuses={max_running:1,max_per_hour:10,max_timeout_s:1};
    other.config.fuses={...ctx.config.fuses};
    assert.equal(ctx.paths.controlDir,other.paths.controlDir);
    assert.equal(ctx.paths.spawnsPath,other.paths.spawnsPath);
    const child=nativeSpawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
    const closed=new Promise(resolve=>child.once('close',resolve));
    const id=f.load('lib/jobstore').newJobId();
    const reservation=fuses.reserveLegs(ctx,{job_id:id,legs:[{leg_id:'echo',backend:'echo'}]});
    try {
      assert.equal(reservation.ok,true);
      fuses.startLeg(ctx,id,'echo',child.pid);
      assert.equal(fuses.snapshot(other).running,1,'spawn does not release the live reservation');
      assert.equal(fuses.snapshot(other).hour_used,1,'start evidence is not another reservation');
      assert.equal(fuses.liveLegs(other,other.paths,Date.now()+2000).legs,1,'live child remains counted past timeout');
      assert.equal(fuses.reserveLegs(other,{job_id:'second',legs:[{leg_id:'echo'}]}).refuse_reason,'concurrency_limit');
      const remote=await new Promise((resolve,reject)=>nativeExecFile(process.execPath,['-e',
        "const s=require(process.argv[1]+'/server'),f=require(process.argv[1]+'/lib/fuses'),c=s.boot(); c.config.fuses={max_running:1}; console.log(JSON.stringify({control:c.paths.controlDir,spawns:c.paths.spawnsPath,running:f.snapshot(c).running,result:f.reserveLegs(c,{job_id:'remote',legs:[{leg_id:'echo'}]})}));",f.app],
        {env:process.env,cwd:f.root,windowsHide:true,timeout:10000},(error,stdout)=>error?reject(error):resolve(JSON.parse(stdout))));
      assert.equal(remote.control,ctx.paths.controlDir,'another server process resolves the same control directory');
      assert.equal(remote.spawns,ctx.paths.spawnsPath);
      assert.equal(remote.running,1,'another server process counts the live reservation');
      assert.equal(remote.result.refuse_reason,'concurrency_limit');
      const restore=patch(process,{kill:()=>{throw Object.assign(new Error('denied'),{code:'EPERM'});}});
      try {assert.equal(fuses.snapshot(other).running,1,'unevaluable liveness retains reservation');} finally {restore();}
    } finally {child.kill();await closed;}
    assert.equal(fuses.readSpawns(ctx.paths).some(r=>r.completed||r.released),false,'simulate a runner killed before its close callback');
    assert.equal(fuses.snapshot(other).running,0,'actual child exit frees concurrency without Vault evidence');
    assert.equal(fuses.snapshot(other).hour_used,1,'exit preserves rate accounting');
    assert.equal(fuses.reserveLegs(other,{job_id:'second',legs:[{leg_id:'echo'}]}).ok,true);
  });
  await test('T-55','hard links refused and search-filtered; ordinary file and junction controls',async f=>{
    const server=f.load('server'),ctx=server.boot(),paths=f.load('lib/paths'),search=f.load('lib/search');
    const outside=put(path.join(f.root,'private.md'),'private'),alias=path.join(f.vault,'alias.md');fs.linkSync(outside,alias);
    assert.deepEqual(paths.resolveVaultPath(alias,ctx.paths),{ok:false,reason:'path_outside_vault',detail:'hard_link'});
    const rejected=await server.createJob(ctx,{prompt:'fixture',read_paths:[alias]},{backends:['echo']});assert.equal(rejected.payload.refuse_reason,'path_outside_vault');assert.equal(rejected.payload.detail,'hard_link');
    assert.equal(search.keepHit(ctx,alias,false),false);
    const ordinary=put(path.join(f.vault,'notes','ok.md'),'ordinary');assert.equal(paths.resolveVaultPath(ordinary,ctx.paths).ok,true);assert.equal(search.keepHit(ctx,ordinary,false),true);
    const link=path.join(f.vault,'junction');fs.symlinkSync(path.dirname(outside),link,'junction');assert.equal(paths.resolveVaultPath(link,ctx.paths).ok,false);
    const hidden=put(path.join(f.vault,'bin','council','old.js'),'old');assert.equal(search.keepHit(ctx,hidden,false),false);
    assert.ok(search.excludeGlobs(false,ctx.paths).includes('!**/bin/council/**'));assert.equal(f.spawns,0);
  });
  await test('T-56','fabricated continuation refused; pipe-reported echo continues; profile and round bound',async f=>{
    const server=f.load('server'),ctx=server.boot(),s=f.load('lib/sessions'),store=f.load('lib/jobstore'),{Job}=f.load('runner');
    const fake=job(f,ctx);json(fake.files.result,{legs:[{backend:'echo',session_id:crypto.randomUUID()}]});put(fake.files.done,'');
    const refused=await server.createJob(ctx,{prompt:'fixture',continue_from:fake.id},{backends:['echo']});assert.equal(refused.payload.refuse_reason,'continue_from_unrecorded');
    const launch=cp.spawn;let argv;
    cp.spawn=(_file,args)=>{argv=args;return {pid:987,unref(){}};};
    try {
      const original=await server.createJob(ctx,{prompt:'sleep:0'},{backends:['echo']});assert.equal(original.ok,true);assert.deepEqual(argv.slice(2),['echo']);
      const req=original.view.request,files=original.view.files;
      const runner=new Job({ctx,request:req,files,promptText:'sleep:0',spawnDoc:original.view.spawn,rlog(){}});
      const serverSpawn=cp.spawn;
      cp.spawn=(file,args,options)=>{
        assert.equal(file,process.execPath);assert.equal(args[0],'-e');assert.equal(args[1],f.load('backends/echo').SCRIPT);
        return nativeSpawn(file,args,options);
      };
      runner.probeVersion=()=>null;runner.writeState=runner.writeProgress=runner.maybeFinish=()=>{};
      const leg={leg_id:'echo',backend:'echo',meta:req.legs[0],bytes_out:0,bytes_err:0};
      try {
        runner.spawnLeg(leg);assert.equal(leg.state,'running');
        const pidFile=ctx.paths.spawnsPath+'.'+req.job_id+'.echo.pid';
        assert.equal(JSON.parse(fs.readFileSync(pidFile)).child_pid,leg.child.pid,'runner records the native child in control');
        await new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>{leg.child.kill();reject(new Error('echo completion timeout'));},5000);
          leg.child.once('close',code=>{clearTimeout(timer);code===0?resolve():reject(new Error('echo exit '+code));});
        });
      } finally {cp.spawn=serverSpawn;}
      assert.equal(s.read(ctx,req.job_id).legs[0].reported,true,'real echo close records continuation');
      json(files.request,{...req,round:0});json(files.result,{legs:[{backend:'echo',session_id:crypto.randomUUID()}]});
      const next=await server.createJob(ctx,{prompt:'sleep:0',continue_from:req.job_id},{backends:['echo']});assert.equal(next.ok,true);assert.equal(next.view.request.round,2);assert.equal(next.view.request.legs[0].session_id,null);
      assert.equal(s.parent({...ctx,profile:'second'},req.job_id).reason,'continue_from_profile_mismatch');
      assert.equal(store.readJSON(path.join(ctx.paths.sessionsDir,req.job_id+'.json')).round,1);
    } finally {cp.spawn=launch;}
  });
  await test('T-57','staged read grant passes claude shape; every other runtime grant refused',async f=>{
    const server=f.load('server'),ctx=server.boot(),{Job}=f.load('runner');
    const named=put(path.join(f.vault,'note.md'),'original');
    const launch=cp.spawn;cp.spawn=()=>({pid:987,unref(){}});
    const read=fs.readFileSync;let swapped=false;
    fs.readFileSync=(file,...args)=>{
      if(typeof file==='number'&&!swapped){swapped=true;fs.renameSync(named,named+'.old');put(named,'replacement');}
      return read(file,...args);
    };
    let result;try {result=await server.createJob(ctx,{prompt:'sleep:0',read_paths:[named]},{backends:['echo']});} finally {cp.spawn=launch;fs.readFileSync=read;}
    assert.equal(swapped,true,'source name replaced after descriptor validation');
    assert.equal(result.ok,true);const req=result.view.request,staged=ctx.paths.readsFor(req.job_id);
    assert.deepEqual(req.read_paths_add_dirs,[staged]);assert.equal(fs.readFileSync(path.join(staged,'note.md'),'utf8'),'original');
    const old=path.join(result.view.dir,'reads');fs.symlinkSync(path.dirname(named),old,'junction');
    ctx.config.binaries.claude=f.binaries.node;
    const meta={leg_id:'claude',backend:'claude',tools:ctx.config.tools,model:null};
    const spec=f.load('backends/claude').buildSpawn(ctx,{job:req,leg:{...meta,tools:f.load('lib/router').CLASSES[req.router.task_class].tools},promptPath:result.view.files.prompt,readPaths:[staged],timeoutS:req.timeout_s,budgetUsd:req.max_cost_usd});
    const runner=new Job({ctx,request:req,files:result.view.files,promptText:'fixture',rlog(){}});
    assert.doesNotThrow(()=>runner.validateSpawn(spec,{leg_id:'claude',backend:'claude',meta}));
    for(const bad of [ctx.paths.runtimeRoot,ctx.paths.controlDir,path.dirname(staged),old,ctx.paths.sandboxFor('echo')]) {
      assert.throws(()=>runner.validateSpawn({...spec,args:spec.args.map(a=>a===staged?bad:a)},{leg_id:'claude',backend:'claude',meta}),/read grant rejected/);
    }
    put(result.view.files.cancel,'{}');runner.finish=()=>{throw new Error('vault cancel honored');};runner.checkCancelFile();
    let cancelled=false;runner.finish=()=>{cancelled=true;};put(ctx.paths.cancelFor(req.job_id),'{}');runner.checkCancelFile();assert.equal(cancelled,true);
  });
  await test('T-58','runner ignores env extras, refuses extra legs and argv prompts, clamps deadline and provenance',f=>{
    const ctx=f.load('server').boot(),{Job}=f.load('runner'),store=f.load('lib/jobstore'),j=job(f,ctx);
    ctx.config.fuses={max_timeout_s:12};
    const request={job_id:j.id,deadline_ms:Infinity,legs:[{leg_id:'echo',backend:'echo'}],prompt_sha256:'fake',prompt_chars:999};
    const runner=new Job({ctx,request,files:j.files,promptText:'fixture',spawnDoc:{legs:{}},reservedLegIds:['echo'],rlog(){}});
    assert.equal(runner.deadlineMs,runner.startedMs+12000);assert.equal(request.prompt_chars,7);assert.equal(request.prompt_sha256,crypto.createHash('sha256').update('fixture').digest('hex'));
    const spec=f.load('backends/echo').buildSpawn(ctx,{job:request,leg:{leg_id:'echo'}});
    runner.spawnDoc.legs.echo={...spec,env_extra:{COUNCIL_DEPTH:'0',COUNCIL_HOST:'evil',CODEX_HOME:f.vault},flags:['fake']};
    const extra={leg_id:'echo-2',backend:'echo',meta:{}};runner.spawnLeg(extra);assert.equal(extra.spawn_error,'unreserved_leg');
    assert.throws(()=>runner.validateSpawn({...spec,promptVia:'argv'},{leg_id:'echo',backend:'echo',meta:{}}),/prompt transport rejected/);
    assert.throws(()=>runner.validateSpawn({...spec,prompt_path:path.join(f.root,'private')},{leg_id:'echo',backend:'echo',meta:{}}),/job_prompt_mismatch/);
    const launch=cp.spawn,child=new EventEmitter();Object.assign(child,{pid:999,stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()});
    let environment;cp.spawn=(_file,_args,o)=>{environment=o.env;return child;};runner.probeVersion=()=>null;
    const leg={leg_id:'echo',backend:'echo',meta:{}};
    try {runner.spawnLeg(leg);assert.equal(leg.state,'running');assert.equal(environment.COUNCIL_DEPTH,'1');assert.equal(environment.COUNCIL_HOST,'child');assert.notEqual(environment.CODEX_HOME,f.vault);assert.deepEqual(runner.legFlags('echo'),spec.flags);}
    finally {cp.spawn=launch;leg.out?.close();leg.err?.close();child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();}
    ctx.config.models={gemini:'configured-model'};assert.equal(runner.apiModel('configured-model'),'configured-model');assert.throws(()=>runner.apiModel('arbitrary'),/api_model_not_configured/);
    assert.equal(store.exists(ctx.paths.cancelFor(j.id)),false);
  });
}
