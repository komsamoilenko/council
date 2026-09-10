// Sixteen zero-quota regression cases from specification section 16.2.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import childProcess from 'node:child_process';
import {installed, inEnv, put, json, files, snapshot, Wire} from './new-fixture.mjs';
import portability from '../trust/portability.test.mjs';
import {names, fixture as vaultFixture} from '../installer/fixtures.mjs';
import {renderVault, layout} from '../../installer/lib/render.mjs';
import {parse} from '../../installer/setup.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const textTree = root => files(root).map(file => fs.readFileSync(file, 'utf8')).join('\n');
const rows = root => files(root).filter(file => file.endsWith('.jsonl')).flatMap(file =>
  fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)));

export function registerNewTests(test, {ROOT, HERE, TMP}) {
  const make = id => installed(TMP, ROOT, HERE, id.toLowerCase());
  const normal = (t, ctx) => t.eq(ctx.mode, 'normal', 'trusted fixture boot: ' + JSON.stringify(ctx.trust.failures));
  const seed = (f, ctx, stale = false) => {
    const store = f.load('lib/jobstore.js'), now = Date.now() - (stale ? 120000 : 0);
    const id = store.newJobId(now), made = store.createJobDir(ctx.paths, id, []);
    json(made.files.request, {v:1, profile:ctx.profile, job_id:id, root_job_id:id, created_ms:now,
      created_at:new Date(now).toISOString(), state:'running', legs:[], deadline_ms:Date.now()+300000});
    json(made.files.state, {state:stale?'running':'success', heartbeat_ms:now, runner_pid:null, legs:{}});
    if (!stale) { json(made.files.result, {state:'success', legs:[]}); put(made.files.done, ''); }
    return {id, dir:made.dir, files:made.files};
  };

  test('T-22', 'two profiles isolate jobs, ledger and STOP', async t => {
    const f = await make('T-22'), ps = [f.profile('alpha'), f.profile('beta')];
    const contexts = []; for(const p of ps) contexts.push(await f.boot(p));
    const jobs = contexts.map(ctx => { normal(t,ctx); return seed(f,ctx); });
    for (let i=0;i<2;i++) await inEnv(ps[i].env, async () => {
      const ctx=contexts[i], other=jobs[1-i];
      f.load('lib/ledger.js').append(ctx, f.load('lib/ledger.js').baseRow(ctx,{event:'fixture_marker',job_id:jobs[i].id}));
      const s=await Wire.start(f.launcher, ps[i].env);
      try {
        const list=await s.tool('council_list',{});
        t.has(JSON.stringify(list),jobs[i].id,'own job visible');
        t.ok(!JSON.stringify(list).includes(other.id),'other job absent');
        const poll=await s.tool('council_poll',{job_id:other.id,wait_s:0});
        t.ok(poll.isError || /not.found/.test(JSON.stringify(poll)), 'foreign job cannot be polled');
      } finally {await s.stop();}
      const own=f.load('lib/ledger.js').readRows(ctx).rows;
      t.ok(own.some(r=>r.job_id===jobs[i].id),'own ledger marker visible');
      t.ok(!own.some(r=>r.job_id===other.id),'other ledger marker absent');
    });
    for (const stop of [contexts[0].paths.stopLocal,contexts[0].paths.stopVault]) {
      put(stop,'fixture');
      for(let i=0;i<2;i++) await inEnv(ps[i].env,()=>t.eq(f.load('lib/fuses.js').stopFiles(contexts[i]).tripped,i===0,'profile STOP isolation'));
      fs.unlinkSync(stop);
    }
  }, {requires:['proc']});

  test('T-23', 'relocated layout resolves and persists only at configured paths', async t => {
    const f=await make('T-23'), runtime=path.join(f.dirs.run,'moved');
    const p=f.profile('moved',{layout:{work_dir:'tasks',jobs_dir:path.join(runtime,'jobs'),ledger_dir:path.join(runtime,'ledger')}});
    const ctx=await f.boot(p); normal(t,ctx);
    t.eq(ctx.paths.workDir,path.join(p.config.vault,'tasks'),'work root');
    t.eq(ctx.paths.jobsRoot,path.join(runtime,'jobs'),'jobs root');
    t.eq(ctx.paths.ledgerDir,path.join(runtime,'ledger'),'ledger root');
    const job=seed(f,ctx);
    await inEnv(p.env,()=>f.load('lib/ledger.js').append(ctx,f.load('lib/ledger.js').baseRow(ctx,{event:'fixture_marker',job_id:job.id})));
    const s=await Wire.start(f.launcher,p.env);
    try {t.has(JSON.stringify(await s.tool('council_list')),job.id,'relocated job visible over stdio');}
    finally {await s.stop();}
    t.ok(files(ctx.paths.ledgerDir).length>0,'relocated ledger used');
    t.ok(!fs.existsSync(path.join(p.config.vault,'work','jobs')),'default jobs not created');
    t.ok(!fs.existsSync(path.join(p.config.vault,'ledger')),'default ledger not created');
  }, {requires:['proc']});

  test('T-24', 'module boundaries and template paths/commands in every fixture and flag combination', async t => {
    const f=await make('T-24');
    try {portability({load:f.load});} catch(e) {t.ok(false,e.message);}
    // A-48 adds the shared pure redactor to boundary 2.
    const allowed=new Set(['version.js','platform/index.js','platform','lib/paths.js','lib/guard.js','lib/roots.js','lib/integrity.js','lib/redact.js']);
    for(const dir of ['src','installer']) for(const file of files(path.join(ROOT,dir)).filter(p=>/\.[cm]?js$/.test(p))) {
      const source=fs.readFileSync(file,'utf8');
      if(dir==='src' && path.relative(path.join(ROOT,'src'),file)!==path.join('platform','index.js'))
        t.ok(!/process\.platform/.test(source),path.relative(ROOT,file)+' must select platform through platform/index.js');
      for(const match of source.matchAll(/(?:require\s*\(\s*|from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)) {
        if(!match[1].startsWith('.'))continue;
        const target=path.resolve(path.dirname(file),match[1]), relative=path.relative(ROOT,target).split(path.sep).join('/');
        if(dir==='src')t.ok(!/^(installer|tests)\//.test(relative),path.relative(ROOT,file)+' imports '+relative);
        else if(relative.startsWith('src/'))t.ok(allowed.has(relative.slice(4)),path.relative(ROOT,file)+' crosses boundary: '+relative);
      }
      if(dir==='src' && !file.includes(path.sep+'platform'+path.sep) && !file.endsWith(path.join('lib','secrets.js')))
        t.ok(!/process\.env\.(?:COUNCIL_GEMINI_API_KEY)|secretGet\s*\(/.test(source),path.relative(ROOT,file)+' holds plaintext key');
      if(file.includes(path.sep+'backends'+path.sep)) {
        // readText is a local wrapper: inspect every caller as well as its body.
        for(const call of source.matchAll(/(?<!function )readText\(([^\n;]+)/g))
          t.ok(/^o\.stdoutPath\)|^o\.legDir \? path\.join\(o\.legDir, 'last.md'\) : ''\)/.test(call[1]),path.relative(ROOT,file)+' read outside job outputs: '+call[1]);
        for(const call of source.matchAll(/fs\.readFileSync\(([^,\n]+)/g))
          t.ok(/^(?:p|o\.stdoutPath|o\.stderrPath|ctx\.paths\.agyGate)$/.test(call[1]),path.relative(ROOT,file)+' unclassified read: '+call[1]);
      }
    }
    // Section 14.2 / A-49: declared task conventions are not existing-path claims.
    const taskNames=new Set(['BRIEF.md','NOTES.md','RESULT.md','claude/','codex/','gemini/']);
    const failures=new Map(); let renders=0;
    for(const name of names)for(const INDEX of [false,true])for(const CONVENTIONS of [false,true]) {
      const root=fs.mkdtempSync(path.join(f.root,'lint-'));
      const vault=vaultFixture(root,name,{env:{},dirs:{app:path.join(root,'app')}});
      // Only the installer's declared contract/layout outputs are materialised.
      for(const entry of ['AGENTS.md','CLAUDE.md',...(INDEX?['INDEX.md']:[])])if(!fs.existsSync(path.join(vault,entry)))put(path.join(vault,entry),'fixture\n');
      for(const entry of ['work/jobs','ledger',...(CONVENTIONS?['inbox','shared','output']:[])])fs.mkdirSync(path.join(vault,entry),{recursive:true});
      const output=renderVault(path.join(ROOT,'installer','templates','vault'),'AGENTS.md.tmpl',
        {OWNER:'Owner',CHAT_LANGUAGE:'English',WORK_DIR:'work',LAYOUT:layout(vault,{conventions:CONVENTIONS})},{INDEX,CONVENTIONS});
      renders++;
      const record=message=>{if(!failures.has(message))failures.set(message,`${name} INDEX=${INDEX} CONVENTIONS=${CONVENTIONS}`);};
      for(const [,token] of output.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)) {
        const value=token.replace(/^@/,'');
        if(/YYYY|MM-DD|<[^>]*>|\{[^}]*\}|…/.test(value)||/^work\/.+/.test(value)||taskNames.has(value))continue;
        if(/\.(?:md|json|toml)(?:$|[ /])|^[\w./-]+\/$/.test(value) && !fs.existsSync(path.resolve(vault,value)))record('unresolved backticked path '+value);
      }
      for(const [,verb] of output.matchAll(/\bcouncil-setup\s+([a-z][a-z-]*)/g)) {
        try {t.eq(parse([verb,...(verb==='new-task'?['fixture-task']:[])]).verb,verb,'rendered command is a real verb');}catch {record('unknown council-setup verb '+verb);}
      }
    }
    t.eq(renders,names.length*4,'all installer fixtures x all flag combinations rendered');
    for(const [message,where] of failures)t.ok(false,message+'; first fixture: '+where);
    t.note(`${renders} renders (${names.length} fixtures x 4 flags)`);
  }, {requires:[]});

  test('T-25', 'derived roots from a fabricated environment stay narrow', async t => {
    const f=await make('T-25'), platform=f.load('platform'), env={...f.env};
    env.TEMP=env.TMP=path.join(f.root,'temp');
    env.SystemRoot=path.join(f.root,'system');env.ProgramFiles=path.join(f.root,'programs');env.ProgramW6432=env.ProgramFiles;
    const npm=path.join(env.APPDATA,'custom-prefix','node_modules');fs.mkdirSync(npm,{recursive:true});
    await inEnv(env,()=>{
      const machine={npm_root_g:npm}, roots=f.load('lib/roots.js').allowedRoots(machine);
      const expected=platform.allowedRootsBase(machine).map(p=>p.endsWith(path.sep)?p:p+path.sep);
      t.eq(JSON.stringify(roots),JSON.stringify([...new Set(expected)]),'deduplicated platform-derived roots');
      for(const scope of ['@anthropic-ai','@openai'])t.ok(roots.includes(path.join(npm,scope)+path.sep),'custom npm vendor root '+scope);
      for(const broad of [npm,env.LOCALAPPDATA,path.join(env.LOCALAPPDATA,'Programs'),env.ProgramFiles].filter(Boolean))t.ok(!roots.includes(broad+path.sep),'no broad root '+path.basename(broad));
      t.ok(roots.includes(path.dirname(fs.realpathSync(process.execPath))+path.sep),'real node executable directory');
      if(platform.agyBinaryRoot()) {
        t.ok(roots.includes(path.join(env.LOCALAPPDATA,'agy','bin')+path.sep),'fabricated vendor-scoped agy root');
        t.ok(roots.includes(path.join(env.SystemRoot,'System32')+path.sep),'fabricated system binary root');
        t.ok(roots.includes(path.join(env.LOCALAPPDATA,'council','app')+path.sep),'fabricated installed app root');
        t.eq(roots.length,6,'exactly six narrow roots');
      }
      t.eq(platform.npmRootInfo({npm_root_g:env.TEMP}).warning,'npm_root_ignored','temporary npm root refused');
      const other={...env,APPDATA:path.join(f.root,'another-user','roaming'),LOCALAPPDATA:path.join(f.root,'another-user','local')};
      return inEnv(other,()=>{const changed=f.load('lib/roots.js').allowedRoots({});t.ok(!changed.some(p=>p.startsWith(env.APPDATA+path.sep)||p.startsWith(env.LOCALAPPDATA+path.sep)),'no former user anchor survives derivation');});
    });
  }, {requires:[]});

  test('T-26', 'initialize and tools/list through installed launcher stdio', async t => {
    const f=await make('T-26'), p=f.profile('launch'), s=await Wire.start(f.launcher,p.env);
    try {
      t.eq(s.init.result?.serverInfo?.name,'council','launcher reaches runtime main');
      const listed=await s.rpc('tools/list');t.eq(listed.result?.tools?.length,8,'eight tools through launcher');
      t.ok(listed.result?.tools?.some(x=>x.name==='council_doctor'),'doctor advertised');
      // A-48: installer-facing trust and agy facts are owned by the runtime report.
      const doctor=(await s.tool('council_doctor',{deep:true})).payload;
      t.eq(doctor.config.trust.ok,true,'doctor reports trust ok');
      t.eq(JSON.stringify(doctor.config.trust.failures),'[]','doctor reports trust failures');
      t.ok(Array.isArray(doctor.config.trust.allowed_roots),'doctor reports allowed roots');
      t.eq(doctor.agy.ok,false,'doctor reports agy unavailable');
      t.eq(doctor.agy.reason,'agy_gate_missing','doctor reports raw agy reason');
      t.eq(doctor.agy.notice,'see NOTICE.md','doctor agy notice');
      t.note('launcher round trip on '+process.version+'; Node 20.11 floor remains unverified unless it runs this test');
    } finally {await s.stop();}
    const {doctorProbe}=await import('../../installer/lib/verify-trust.mjs');
    const probeCtx={node:process.execPath,env:p.env,attributes:async()=>null,dirs:{...f.dirs,
      config:p.configPath,profileDir:path.dirname(p.configPath),current:path.join(f.dirs.root,'current.json'),launcher:f.launcher}};
    const before=snapshot(f.root), report=await doctorProbe(probeCtx);
    t.eq(report.config.trust.ok,true,'installer receives doctor trust over stdio');
    t.eq(JSON.stringify(snapshot(f.root)),JSON.stringify(before),'doctor bridge cleans only its own probe evidence');
    const cli=childProcess.spawnSync(process.execPath,[path.join(ROOT,'installer','lib','verify-trust.mjs')],
      {env:p.env,cwd:f.root,encoding:'utf8',windowsHide:true,timeout:15000});
    t.eq(cli.status,0,'verify trust CLI doctor bridge: '+(cli.stderr||cli.error?.message||''));
    if(cli.status===0)t.eq(JSON.parse(cli.stdout).ok,true,'verify receives doctor trust');
    json(p.configPath,{...p.config,schema:1});
    const failed=await doctorProbe(probeCtx);
    t.eq(failed.config.trust.ok,false,'doctor reports failed trust over stdio');
    t.ok(failed.config.trust.failures.some(f=>f.key==='schema'),'doctor preserves trust failure details');
  }, {requires:[]});

  test('T-27', 'personal-data scanner over whole working tree without exemptions', async t => {
    const result=childProcess.spawnSync(process.execPath,[path.join(ROOT,'tools','scan-personal.mjs'),ROOT],{cwd:TMP,env:process.env,encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024});
    put(path.join(TMP,'personal-scan.stdout.log'),result.stdout||'');put(path.join(TMP,'personal-scan.stderr.log'),result.stderr||'');
    t.eq(result.status,0,'scanner exit (full diagnostics: '+path.join(TMP,'personal-scan.stderr.log')+')');
    if(result.status!==0)for(const file of [...new Set((result.stderr||'').split('\n').filter(Boolean).map(line=>{try{return JSON.parse(line).file;}catch{return line;}}))])t.ok(false,'scanner hit: '+file);
    t.note((result.stdout||result.error?.message||'').trim());
  }, {requires:[]});

  test('T-28', 'absent, bad and traversing profile remain doctor-only', async t => {
    const f=await make('T-28');
    for(const value of [undefined,'BAD!','../x']) {
      const env={...f.env};if(value===undefined)delete env.COUNCIL_PROFILE;else env.COUNCIL_PROFILE=value;
      const s=await Wire.start(f.launcher,env);
      try {const d=await s.tool('council_doctor');t.eq(d.payload.mode,'doctor-only','profile '+String(value));
        const r=await s.tool('council_start',{prompt:'text:must not run',backends:['echo']});t.ok(r.isError || r.payload.refused,'job refused');
      } finally {await s.stop();}
    }
    t.ok(!files(f.root).some(p=>path.basename(p)==='request.json'),'no jobs written');
  }, {requires:['proc']});

  test('T-29', 'runner rejects request profile_mismatch before spawning', async t => {
    const f=await make('T-29'), p=f.profile('runner'), ctx=await f.boot(p);normal(t,ctx);
    const job=seed(f,ctx,true);json(job.files.request,{...read(job.files.request),profile:'another'});json(job.files.spawn,{legs:{}});
    const before=snapshot(job.dir);
    const r=childProcess.spawnSync(process.execPath,[path.join(f.app,'runner.js'),job.dir],{env:p.env,cwd:f.root,encoding:'utf8',windowsHide:true,timeout:20000});
    t.eq(r.status,5,'runner mismatch exit');t.has(fs.readFileSync(job.files.runnerLog,'utf8'),'profile_mismatch','named refusal');
    const after=snapshot(job.dir);delete after['runner.log'];t.eq(JSON.stringify(after),JSON.stringify(before),'no leaf/state/output mutation');
  }, {requires:['proc']});

  test('T-30', 'Gemini API key and three agy gates are independent', async t => {
    const f=await make('T-30'), p=f.profile('gates'), ctx=await f.boot(p), adapter=f.load('backends/gemini.js');
    await inEnv(p.env,()=>{
      t.eq(adapter.available(ctx,{}).reason,'agy_gate_missing','absent agy gate');
      put(ctx.paths.agyGate,'');t.eq(adapter.available(ctx,{}).reason,'agy_notice_not_acknowledged','empty agy gate');
      const acknowledgement='I have read NOTICE.md and I accept that using agy with council may breach Antigravity Additional Terms of Service section 6.';
      put(ctx.paths.agyGate,acknowledgement+'\n');
      ctx.config.prompt_form=null;t.eq(adapter.available(ctx,{}).reason,'agy_prompt_form_unknown','third agy gate');
      ctx.config.prompt_form='split';t.eq(adapter.available(ctx,{}).ok,true,'all agy gates satisfied');
      ctx.config.gemini={provider:'api'};t.eq(adapter.available(ctx,{}).reason,'gemini_key_missing','agy acknowledgement does not enable API');
      process.env.COUNCIL_GEMINI_API_KEY='fixture-key';t.eq(adapter.available(ctx,{}).ok,true,'API key suffices');
      fs.unlinkSync(ctx.paths.agyGate);t.eq(adapter.available(ctx,{}).ok,true,'API independent of agy gate');
      ctx.config.gemini={provider:'agy'};t.eq(adapter.available(ctx,{}).reason,'agy_gate_missing','API key cannot enable agy');
    });
  }, {requires:[]});

  test('T-31', 'provider expectedImageFor is persisted in request.json', async t => {
    const f=await make('T-31');
    for(const provider of ['api','agy']) {
      const p=f.profile(provider,{gemini:{provider}});p.env.COUNCIL_GEMINI_API_KEY='fixture-key';
      const ctx=await f.boot(p);normal(t,ctx);
      if(provider==='agy')put(ctx.paths.agyGate,'I have read NOTICE.md and I accept that using agy with council may breach Antigravity Additional Terms of Service section 6.'+'\n');
      await inEnv(p.env,async()=>{
        const server=f.load('server.js');server.refreshGeminiState(ctx);
        const original=childProcess.spawn;let spawns=0;
        // Intercept only the detached supervisor boundary: no vendor is ever run.
        childProcess.spawn=(file,args,opts)=>{if(file!==process.execPath || args[0]!==ctx.paths.runnerJs || !opts.detached)throw new Error('unexpected spawn');spawns++;return {pid:0,unref(){}};};
        let result;try {result=await server.createJob(ctx,{prompt:'fixture request',timeout_s:5},{tool:'council_start',backends:['gemini']});}finally {childProcess.spawn=original;}
        t.eq(result.ok,true,'request admitted: '+JSON.stringify(result.payload));t.eq(spawns,1,'one intercepted supervisor');
        if(result.ok){const store=f.load('lib/jobstore.js'),dir=store.findJobDir(ctx.paths,result.payload.job_id),request=read(path.join(dir,'request.json'));
          const expected=f.load('platform').expectedImage(provider==='api'?'node':'agy');
          t.eq(server.BACKENDS.gemini.expectedImageFor(ctx),expected,'provider image');t.eq(request.legs[0].expected_image,expected,'request image persisted for '+provider);}
      });
    }
  }, {requires:['proc']});

  test('T-32', 'package, runtime and initialize versions agree', async t => {
    const f=await make('T-32'), p=f.profile('versions'), s=await Wire.start(f.launcher,p.env);
    try {const version=f.load('version.js').APP_VERSION;
      t.eq(s.init.result?.serverInfo?.version,version,'wire/runtime version');
      // HERE is the app source selected by --app; f.app is always a fixture copy.
      const app=fs.realpathSync(HERE);
      if(app===fs.realpathSync(path.join(ROOT,'src')))
        t.eq(version,read(path.join(app,'..','package.json')).version,'package/runtime version');
      else t.note('staged app: no package.json, package leg not applicable');
    } finally {await s.stop();}
  }, {requires:[]});

  test('T-33', 'extraAllowed refuses every key/secret/token spelling', async t => {
    const f=await make('T-33'), lib=f.load('lib/env.js');
    const keys=['COUNCIL_GEMINI_API_KEY',...['KEY','SECRET','TOKEN'].flatMap(s=>['COUNCIL_'+s,'COUNCIL_'+s.toLowerCase()+'_VALUE',s.toLowerCase()])];
    await inEnv(f.env,()=>{for(const backend of ['claude','codex','echo','gemini']) {
      const options={backend,provider:'api',extra:Object.fromEntries(keys.map(k=>[k,'private-fixture-value']))};
      for(const key of keys)t.eq(lib.extraAllowed(key,options),false,key+' refused for '+backend);
      const env=lib.childEnv(options);for(const key of keys)t.ok(!Object.hasOwn(env,key),key+' absent from child');
    }});
  }, {requires:[]});

  test('T-34', 'Gemini API local HTTP stub, secret artefact scan and endpoint rejection', async t => {
    const f=await make('T-34'), key='probe-'+crypto.randomBytes(18).toString('hex');
    let requests=0;
    const stub=http.createServer((req,res)=>{requests++;t.ok(req.headers['x-goog-api-key']===key,'key reaches only HTTP header');let body='';req.on('data',d=>body+=d);req.on('end',()=>{
      t.has(body,'fixture prompt','prompt arrives at stub');res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({candidates:[{content:{parts:[{text:'stub response '+key}]}}],usageMetadata:{promptTokenCount:3,candidatesTokenCount:4,totalTokenCount:7}}));
    });});
    await new Promise(resolve=>stub.listen(0,'127.0.0.1',resolve));
    const capture=path.join(f.root,'api-child.json'), runner=f.binaries.gemini_api_js;
    // Test copy only: replace transport after production host validation; deny every
    // target except the one configured Google host and route exclusively to loopback.
    const instrumentation=`const fs=require('fs'),https=require('https'),http=require('http');\nfs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({argv:process.argv,env:process.env}));\nhttps.request=(target,options,callback)=>{if(target.hostname!=='generativelanguage.googleapis.com')throw new Error('unexpected network target');return http.request({hostname:'127.0.0.1',port:${stub.address().port},path:target.pathname,method:options.method,headers:options.headers},callback);};\n`;
    put(runner,instrumentation+fs.readFileSync(runner,'utf8'));f.seal();
    const p=f.profile('api',{gemini:{provider:'api',endpoint:'https://generativelanguage.googleapis.com/v1beta'}});p.env.COUNCIL_GEMINI_API_KEY=key;
    let s;
    try {
      s=await Wire.start(f.launcher,p.env);const r=await s.tool('council_start',{prompt:'fixture prompt',backends:['gemini'],timeout_s:15});
      t.ok(!r.isError,'API request accepted: '+JSON.stringify(r.payload));
      const ctx=await f.boot(p),store=f.load('lib/jobstore.js'),dir=store.findJobDir(ctx.paths,r.payload.job_id);
      t.ok(!!dir,'job directory created');if(!dir)return;
      const deadline=Date.now()+30000;while(!fs.existsSync(path.join(dir,'DONE'))&&Date.now()<deadline)await sleep(100);
      t.ok(fs.existsSync(path.join(dir,'DONE')),'API job finalised');
      const result=await s.tool('council_poll',{job_id:r.payload.job_id,wait_s:0});
      t.eq(requests,1,'exactly one local HTTP request');t.has(JSON.stringify(result),'stub response','stub result returned');
      t.ok(fs.existsSync(capture),'actual API child env and argv captured');
      for(const file of files(f.root))t.ok(!fs.readFileSync(file).includes(Buffer.from(key)),'key absent from '+path.relative(f.root,file));
      for(const [name,value] of Object.entries({start:r,poll:result,stderr:s.stderr,stdout:s.stdout}))t.ok(!JSON.stringify(value).includes(key),'key absent from '+name);
      t.ok(fs.existsSync(path.join(dir,'spawn.json')),'spawn plan scanned');t.ok(files(ctx.paths.ledgerDir).some(file=>file.endsWith('.jsonl')),'ledger scanned');
      const child=childProcess.spawn(process.execPath,[runner],{env:{...f.env},cwd:f.root,windowsHide:true,stdio:['pipe','pipe','pipe']});
      let rejected='';child.stdout.on('data',d=>rejected+=d);child.stderr.on('data',d=>rejected+=d);
      child.stdin.end(JSON.stringify({api_key:key,endpoint:'https://attacker.example/v1beta',model:'fixture'})+'\n\nfixture prompt');
      const code=await new Promise(resolve=>child.once('close',resolve));
      t.eq(code,2,'attacker endpoint exit');t.has(rejected,'gemini_endpoint_rejected','host allowlist refusal');t.ok(!rejected.includes(key),'rejection redacts key');t.eq(requests,1,'rejected endpoint made no request');
      t.note('local HTTP stub: key absent from spawn.json, argv, actual child env, all ledger/files, stderr and tool results; attacker.example refused');
    } finally {if(s)await s.stop();await new Promise(resolve=>stub.close(resolve));}
  }, {requires:['proc'],inspection:true});

  test('T-35', 'global STOP refuses every profile', async t => {
    const f=await make('T-35'), ps=[f.profile('one'),f.profile('two')];
    for(const p of ps)normal(t,await f.boot(p));
    put(path.join(f.dirs.root,'STOP'),'fixture global stop');
    for(const p of ps){const s=await Wire.start(f.launcher,p.env);try {
      const r=await s.tool('council_start',{prompt:'text:must not run',backends:['echo']});t.eq(r.payload.refuse_reason,'stop_file','global stop blocks '+p.id);
    } finally {await s.stop();}}
    t.ok(!files(f.root).some(file=>path.basename(file)==='spawn.json'),'no supervisor plan created');
  }, {requires:['proc']});

  test('T-36', '40-second reaper suppression and unsuppressed control', async t => {
    const f=await make('T-36'), p=f.profile('reaper'), ctx=await f.boot(p);normal(t,ctx);
    const job=seed(f,ctx,true), before=snapshot(job.dir);
    t.ok(f.load('lib/reaper.js').FIRST_TICK_MS<40000,'hold exceeds first tick');
    let s=await Wire.start(f.launcher,p.env);
    try {
      const started=Date.now();await sleep(40000);t.ok(Date.now()-started>=40000,'pipe held open 40 seconds');
      t.eq(JSON.stringify(snapshot(job.dir)),JSON.stringify(before),'suppressed job directory byte-identical');
      t.ok(!fs.existsSync(job.files.error)&&!fs.existsSync(job.files.done),'suppressed: no error.json/DONE');
      t.ok(!rows(ctx.paths.ledgerDir).some(r=>r.event==='reaper_action'),'suppressed: no reaper_action in any ledger file');
      const d=await s.tool('council_doctor');t.has(d.payload.reaper,'suppressed','doctor reports reaper: suppressed');
      t.note('T-36 suppressed: 40 s open pipe; job byte-identical; no error.json/DONE; no reaper_action; doctor reaper: '+d.payload.reaper);
    } finally {await s.stop();}
    const env={...p.env};delete env.COUNCIL_SMOKE_RUN;s=await Wire.start(f.launcher,env);
    try {
      const deadline=Date.now()+45000;while(!fs.existsSync(job.files.done)&&Date.now()<deadline)await sleep(200);
      t.ok(fs.existsSync(job.files.done)&&fs.existsSync(job.files.error),'control finalises stale job');
      t.ok(rows(ctx.paths.ledgerDir).some(r=>r.event==='reaper_action'&&r.job_id===job.id&&r.finalized),'control records finalisation');
      t.note('T-36 control: COUNCIL_SMOKE_RUN absent; error.json/DONE='+String(fs.existsSync(job.files.error)&&fs.existsSync(job.files.done))+'; reaper_action finalised='+String(rows(ctx.paths.ledgerDir).some(r=>r.event==='reaper_action'&&r.finalized)));
    } finally {await s.stop();}
  }, {requires:['proc'],inspection:true,slow:true});

  test('T-37', 'proxy and CA env scoped to Gemini API with value-free refusals', async t => {
    const f=await make('T-37'), p=f.profile('proxy'), ctx=await f.boot(p), lib=f.load('lib/env.js');
    const names=['HTTPS_PROXY','HTTP_PROXY','NO_PROXY','NODE_EXTRA_CA_CERTS'];
    const ca=put(path.join(f.root,'readable-ca.pem'),'fixture CA bundle\n');
    const values={HTTPS_PROXY:'https://proxy.example:443',HTTP_PROXY:'http://proxy.example:8080',NO_PROXY:'https://generativelanguage.googleapis.com',NODE_EXTRA_CA_CERTS:ca};
    await inEnv({...p.env,...values},async()=>{
      const filter=lib.proxyEnvFor(ctx);t.eq(JSON.stringify(filter.env),JSON.stringify(values),'all four valid parent values pass filter');
      for(const backend of ['claude','codex','echo']) {
        const child=lib.childEnv({backend,extra:values});t.eq(names.filter(k=>Object.hasOwn(child,k)).length,0,backend+' child has no proxy/CA names');
        t.note('T-37 '+backend+': HTTPS_PROXY, HTTP_PROXY, NO_PROXY, NODE_EXTRA_CA_CERTS all absent');
      }
      const child=lib.childEnv({backend:'gemini',provider:'api',extra:filter.env});
      t.eq(JSON.stringify(Object.fromEntries(names.filter(k=>Object.hasOwn(child,k)).map(k=>[k,child[k]]))),JSON.stringify(values),'Gemini API receives exactly filtered values');
      t.note('T-37 gemini-api: exactly the four filtered proxy/CA values');
      const unreadable=path.join(f.root,'missing-private-ca.pem');process.env.NODE_EXTRA_CA_CERTS=unreadable;process.env.NO_PROXY='not a URL';
      let stderr='';const write=process.stderr.write;process.stderr.write=function(chunk){stderr+=chunk;return true;};
      try {
        const rejected=lib.proxyEnvFor(ctx);t.ok(rejected.ignored.includes('proxy_env_ignored:NODE_EXTRA_CA_CERTS'),'unreadable CA diagnostic');
        t.ok(rejected.ignored.includes('proxy_env_ignored:NO_PROXY'),'invalid proxy diagnostic');
        t.eq(JSON.stringify(Object.keys(rejected.env)),JSON.stringify(['HTTPS_PROXY','HTTP_PROXY']),'invalid values removed');
        const plan=f.load('backends/gemini-api.js').buildSpawn(ctx,{job:{job_id:'fixture'},model:'fixture'});
        t.eq(names.filter(k=>Object.hasOwn(plan.env,k)).join(','),'HTTPS_PROXY,HTTP_PROXY','adapter uses filter');
        const doctor=await f.load('server.js').doctorReport(ctx,false);
        const output=JSON.stringify({rejected,plan,doctor,stderr});t.ok(!output.includes(unreadable),'unreadable CA value absent from all returned output');
        t.has(JSON.stringify(doctor),'proxy_env_ignored:NODE_EXTRA_CA_CERTS','doctor carries named warning');
        t.ok(!textTree(f.root).includes(unreadable),'CA value absent from all disk artefacts');
      } finally {process.stderr.write=write;}
      t.note('T-37 unreadable CA: proxy_env_ignored:NODE_EXTRA_CA_CERTS; value absent from filter, spawn plan, doctor, stderr and all fixture files');
    });
  }, {requires:[]});
}
