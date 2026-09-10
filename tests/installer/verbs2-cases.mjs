// Runs only through the installer harness after its sandbox preflight.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {PassThrough,Writable,Readable} from 'node:stream';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {randomBytes,createCipheriv} from 'node:crypto';
import {context,readJSON,hostPaths} from '../../installer/lib/survey.mjs';
import {apply} from '../../installer/lib/apply.mjs';
import {buildPlan,publishPlan} from '../../installer/lib/planning.mjs';
import {migrate,resumeMigration} from '../../installer/lib/migrate.mjs';
import {run,parse} from '../../installer/setup.mjs';
import {setKey} from '../../installer/lib/set-key.mjs';
import {installPrereqs} from '../../installer/lib/install-prereqs.mjs';
import {login} from '../../installer/lib/login.mjs';
import {uninstall} from '../../installer/lib/uninstall.mjs';
import {readJournal,openJournals} from '../../installer/lib/journal.mjs';
import {spliceJsonEntry} from '../../installer/lib/host-json.mjs';
import {put} from './fixtures.mjs';
import {snapshot,assertUnchanged} from './sandbox-assertions.mjs';

const m=fs.readFileSync(new URL('../../src/backends/gemini-agy.js',import.meta.url),'utf8').match(/const ACKNOWLEDGEMENT\s*=\s*'([^'\n]+)'/);
assert.ok(m, 'ACKNOWLEDGEMENT constant not found in gemini-agy.js');
const sentence=m[1];
assert.ok(sentence.startsWith('I have read NOTICE.md'));

function terminal(answers=[]) {
  const input=new PassThrough();input.isTTY=true;input.setRawMode=raw=>{input.isRaw=raw;};let text='';
  const output=new Writable({write(chunk,enc,done){const s=chunk.toString();text+=s;
    if(/(?:\[y\/N\] |s to skip: |\(hidden\): )$/.test(s)) {assert.ok(answers.length,'unexpected prompt: '+s);const a=answers.shift();setImmediate(()=>input.write(a+'\n'));}done();}});output.isTTY=true;
  return {input,output,text:()=>text};
}
const require=createRequire(import.meta.url);
export async function verbs2Cases(make,tree) {
  let checks=0;
  const check=async(label,fn)=>{await fn();checks++;process.stdout.write('PASS verbs2 '+label+'\n');};
  await check('closed flags and attended refusals',async()=>{
    for(const verb of ['install-prereqs','set-key'])assert.throws(()=>parse([verb,'--yes']),e=>e.code==='E-USAGE'&&e.exitCode===2);
    assert.equal(parse(['migrate','--phase','3']).options.phase,'3');
    const accidental='AIza'+randomBytes(24).toString('hex');
    assert.throws(()=>parse(['set-key','--'+accidental]),e=>e.exitCode===2&&!e.message.includes(accidental));
    const f=await make();let out='';assert.equal(await run(['install-prereqs','--json'],{...f.ctx,stdout:s=>out+=s}),2);assert.equal(JSON.parse(out).error.code,'E-USAGE');
  });
  await check('metadata, per-item prompts, exact install argv and failures',async()=>{
    const f=await make(),fake=path.join(f.dir,'fake');put(path.join(fake,'winget.exe'),'fixture');
    const npm=path.join(path.dirname(f.ctx.node),'node_modules','npm','bin','npm-cli.js'),calls=[];
    const probe=(file,args,opts)=>{
      assert.equal(path.isAbsolute(file),true);assert.equal(opts.cwd,os.tmpdir());assert.equal(opts.shell,false);calls.push({file,args,opts});
      if(args[0]==='show'){assert.equal(opts.timeout,60000);assert.deepEqual(opts.stdio,['ignore','pipe','pipe']);return {status:0,stdout:'Installer Url: https://example.invalid/node.msi\nInstaller SHA256: fixture-hash\n'};}
      if(args[1]==='view'){assert.equal(opts.timeout,60000);assert.deepEqual(opts.stdio,['ignore','pipe','pipe']);assert.equal(opts.env.npm_config_logs_max,'0');return {status:0,stdout:JSON.stringify({version:'1.2.3','dist.tarball':'https://example.invalid/package.tgz','dist.integrity':'sha512-fixture'})+'\n'};}
      if(args[0]==='install'||args[1]==='install')return {status:0,stdout:''};
      throw new Error('unapproved prerequisite spawn');
    };
    const t=terminal(['y','y','y']),ctx=context({...f.ctx,...t,env:{...f.ctx.env,PATH:fake},probe});
    assert.equal((await installPrereqs({},ctx)).exitCode,0);
    assert.deepEqual(calls.filter(c=>c.args.includes('install')).map(c=>c.args),[
      ['install','--exact','--id','OpenJS.NodeJS.LTS','--source','winget'],[npm,'install','-g','@anthropic-ai/claude-code@1.2.3'],[npm,'install','-g','@openai/codex@1.2.3']]);
    assert.ok(t.text().indexOf('Installer SHA256: fixture-hash')<t.text().indexOf('Install node?'));
    assert.ok(t.text().indexOf('https://example.invalid/node.msi')<t.text().indexOf('Install node?'));
    for(const kind of ['claude','codex'])assert.ok(t.text().indexOf('sha512-fixture')<t.text().indexOf('Install '+kind+'?'));
    assert.equal((t.text().match(/does not re-verify/g)||[]).length,3);
    calls.length=0;assert.equal((await installPrereqs({'print-only':true},context({...ctx,...terminal(),probe}))).exitCode,0);assert.equal(calls.length,3);
    calls.length=0;assert.equal((await installPrereqs({},context({...ctx,...terminal(['n','n','n']),probe}))).exitCode,0);assert.equal(calls.length,3);
    for(const response of [{status:1,stdout:''},{status:1,error:'ETIMEDOUT',stdout:''},{status:0,stdout:'bad JSON'},{status:0,stdout:'{}'}]) {
      let installs=0;const broken=(file,args,opts)=>{if(args.includes('install'))installs++;return response;};
      const r=await installPrereqs({claude:true,'print-only':true},context({...ctx,...terminal(),probe:broken}));assert.equal(r.exitCode,1);assert.equal(installs,0);
    }
    let installs=0;const broken=(file,args)=>{if(args.includes('install'))installs++;return {status:1,stdout:''};};
    assert.equal((await installPrereqs({node:true},context({...ctx,...terminal(['y']),probe:broken}))).exitCode,1);assert.equal(installs,0);
  });
  await check('key zero-hits, hidden input, deletion and rejection',async()=>{
    const f=await make();await apply(f.options,f.ctx);
    const key='AIza'+randomBytes(24).toString('hex'),secretFile=path.join(f.ctx.dirs.secrets,'gemini-api-key.dpapi');
    // Fake OS store encrypts (never plain/base64 key), while asserting the descriptor.
    const host={...f.ctx.platform,implemented:{...f.ctx.platform.implemented,secrets:true},secretHelper:()=>f.ctx.node,
      secretPath:d=>{assert.equal(d.runtimeRoot,f.ctx.dirs.runtimeRoot);assert.equal(d.profile,'default');return secretFile;},
      secretSet:(d,encoded)=>{assert.equal(Buffer.from(encoded,'base64').toString(),key);const cipher=createCipheriv('aes-256-gcm',randomBytes(32),randomBytes(12));put(secretFile,Buffer.concat([cipher.update(Buffer.from(encoded,'base64')),cipher.final(),cipher.getAuthTag()]).toString('base64'));},
      secretDelete:d=>{assert.equal(d.profile,'default');if(fs.existsSync(secretFile))fs.unlinkSync(secretFile);}};
    const term=terminal([key]);let stdout='',stderr='';
    const ctx={...f.ctx,...term,platform:host,validateKey:async(endpoint,k)=>{assert.equal(k,key);assert.equal(endpoint,'https://generativelanguage.googleapis.com/v1beta');return true;},stdout:s=>stdout+=s,stderr:s=>stderr+=s};
    assert.equal(await run(['set-key','--json','--log',path.join(f.ctx.dirs.logs,'key.log')],ctx),0);
    const artifacts=tree(f.dir);let hits=0;for(const [file,b] of Object.entries(artifacts))if(b!=='dir'&&Buffer.from(b,'base64').includes(Buffer.from(key)))hits++;
    for(const s of [stdout,stderr,term.text()])if(s.includes(key))hits++;
    assert.equal(hits,0);assert.equal(term.input.isRaw,false);assert.equal(JSON.parse(stdout).last_four,key.slice(-4));
    process.stdout.write('SET-KEY ZERO HITS: '+hits+'; all '+Object.keys(artifacts).length+' sandbox paths (blob included), stdout JSON/report, stderr, hidden-prompt transcript; no log created.\n');
    const before=tree(f.dir);await assert.rejects(setKey({delete:true},{...ctx,input:Readable.from([]),output:term.output}),e=>e.code==='E-SETKEY-NON-TTY'&&e.exitCode===2);assert.deepEqual(tree(f.dir),before);
    assert.equal((await setKey({delete:true},{...ctx,...terminal(['n'])})).exitCode,5);assert.deepEqual(tree(f.dir),before);
    assert.equal((await setKey({delete:true},{...ctx,...terminal(['y'])})).removed,true);assert.equal((await setKey({delete:true},{...ctx,...terminal(['y'])})).removed,false);
    let err='';assert.equal(await run(['set-key','--json'],{...ctx,input:Readable.from([key]),validateKey:async()=>{throw new Error(key);},stdout:s=>err+=s}),1);assert.ok(!err.includes(key));assert.match(err,/E-GEMINI-KEY-REJECTED/);assert.match(err,/EEA/);
  });
  await check('login whole-tree no-write and credential existence only',async()=>{
    const f=await make();await apply(f.options,f.ctx);const t=terminal(['s','','s']);
    let statuses=0;const credential=path.join(f.dir,'credential');put(credential,'credential must never be read');
    const before=snapshot(f.dir);
    const original=fs.readFileSync;fs.readFileSync=function(file,...args){assert.notEqual(String(file),credential);return original.call(fs,file,...args);};
    try{await login({},context({...f.ctx,...t,platform:{...f.ctx.platform,credentialProbePaths:()=>({claude:credential})},probe:(file,args,opts)=>{if(args.includes('login')){statuses++;return {status:statuses===1?1:0};}return f.ctx.probe(file,args,opts);}}));}finally{fs.readFileSync=original;}
    assert.equal(statuses,2);assertUnchanged(f.dir,f.ctx.env.USERPROFILE,before,snapshot(f.dir),[],f.ctx.dirs.id);
    assert.ok(!t.text().includes('agy'+'-enabled'));assert.ok(!t.text().includes('prompt_'+'form'));assert.ok(!t.text().includes(sentence));
  });
  await check('skill rendering, shared profiles and user edit retention',async()=>{
    const f=await make();await apply(f.options,f.ctx);const skill=fs.readFileSync(f.ctx.dirs.skill,'utf8'),lines=skill.trimEnd().split('\n').length;
    assert.ok(lines<60);assert.match(skill,/^---\nname: council-setup\ndescription: [^\n]+\n---\n/);assert.ok(!skill.includes('{{'));
    assert.equal(readJSON(f.ctx.dirs.machine).shared.skill,f.ctx.dirs.skill);
    const e=readJSON(f.ctx.dirs.manifest).entries.find(e=>e.template==='skill');assert.equal(e.removal,'never_while_profile_exists');
    process.stdout.write('BEGIN RENDERED SKILL ('+lines+' lines)\n'+skill+'END RENDERED SKILL\n');
    const second=context({...f.ctx,profile:'second'});delete second.dirs;second.dirs=(await import('../../installer/lib/appdirs.mjs')).appdirs({env:f.ctx.env,profile:'second'});
    const vault=path.join(f.dir,'second-vault');fs.mkdirSync(vault);
    const built=await buildPlan({vault,profile:'second',hosts:'none',json:true},second);await publishPlan(built);await apply({plan:built.plan.file,yes:true},second);
    assert.equal(readJSON(second.dirs.manifest).entries.find(e=>e.template==='skill').created,false);
    await uninstall({yes:true},{...f.ctx,...terminal()});assert.equal(fs.readFileSync(f.ctx.dirs.skill,'utf8'),skill);
    await uninstall({profile:'second',yes:true},{...second,...terminal()});assert.equal(fs.existsSync(second.dirs.skill),false);
    const edited=await make();await apply(edited.options,edited.ctx);put(edited.ctx.dirs.skill,'user edited skill\n');const b=await buildPlan({vault:edited.vault,hosts:'none',json:true},edited.ctx);await publishPlan(b);await apply({plan:b.plan.file,yes:true},edited.ctx);assert.equal(fs.readFileSync(edited.ctx.dirs.skill,'utf8'),'user edited skill\n');assert.equal(readJSON(edited.ctx.dirs.manifest).entries.find(e=>e.template==='skill').kept,'user_modified');
  });
  const migrationFixture=async()=>{
    const f=await make('previous-install');const previousProbe=f.ctx.probe,term=terminal(Array(30).fill('y'));
    const ctx=context({...f.ctx,...term,trustCheck:async()=>({status:0,stdout:'{"failures":[]}'}),verifyHandshake:async(r,c,e)=>{assert.equal(e.jobs,path.join(f.vault,'work','jobs'));assert.equal(e.ledger,path.join(f.vault,'ledger'));return {elapsed_ms:1};},probe:(file,args,opts)=>{
      if(args[0]==='mcp'&&['remove','add-json'].includes(args[1])) {
        const p=hostPaths(f.ctx)['claude-code'][0],doc=readJSON(p);
        assert.ok(doc.mcpServers.council||doc.mcpServers['council-next'],'coverage before command');
        if(args[1]==='remove'){assert.ok(doc.mcpServers[args[2]]);delete doc.mcpServers[args[2]];}
        else {assert.ok(!doc.mcpServers[args[2]],'vendor refuses duplicate name');doc.mcpServers[args[2]]=JSON.parse(args[3]);}
        put(p,JSON.stringify(doc,null,2)+'\n');assert.ok(doc.mcpServers.council||doc.mcpServers['council-next'],'coverage after command');return {status:0,stdout:''};
      }
      return previousProbe(file,args,opts);
    }});
    return {...f,ctx,term,from:path.join(f.vault,'bin','council'),hosts:Object.values(hostPaths(ctx)).flat()};
  };
  const phase=async(f,n,host)=>{const r=await migrate({from:f.from,phase:String(n),...(host?{host}:{})},f.ctx);assert.equal(r.exitCode,0,JSON.stringify(r));return r;};
  await check('migration dry-run, declined step and schema mismatch write nothing',async()=>{
    const f=await migrationFixture(),before=snapshot(f.dir);
    assert.equal((await migrate({from:f.from,phase:'0','dry-run':true},f.ctx)).exitCode,0);
    assertUnchanged(f.dir,f.ctx.env.USERPROFILE,before,snapshot(f.dir),[],f.ctx.dirs.id);
    const store=path.join(f.from,'lib','jobstore.js'),original=fs.readFileSync(store,'utf8');
    put(store,original.replace("'request.json'","'changed-request.json'"));
    const changed=snapshot(f.dir);
    await assert.rejects(migrate({from:f.from,phase:'0'},f.ctx),e=>e.code==='E-USAGE');
    assertUnchanged(f.dir,f.ctx.env.USERPROFILE,changed,snapshot(f.dir),[],f.ctx.dirs.id);
    put(store,original);await phase(f,0);await phase(f,1);
    const installed=snapshot(f.dir);
    assert.equal((await migrate({from:f.from,phase:'2',host:'codex'},{...f.ctx,...terminal(['n'])})).exitCode,5);
    assertUnchanged(f.dir,f.ctx.env.USERPROFILE,installed,snapshot(f.dir),[],f.ctx.dirs.id);
  });
  await check('migration 0/1/2/3, live previous job, ledger and rollback',async()=>{
    const f=await migrationFixture(),original=new Map(f.hosts.map(p=>[p,fs.readFileSync(p)]));
    // The live job store is checked by poll(); never enumerate its atomic-write temps.
    const migrationTree=()=>{
      const out={},jobs=path.join(f.vault,'work','jobs');
      const walk=p=>{for(const e of fs.readdirSync(p,{withFileTypes:true})){
        const file=path.join(p,e.name);if(file===jobs)continue;
        out[file]=e.isDirectory()?'dir':fs.readFileSync(file).toString('base64');if(e.isDirectory())walk(file);
      }};walk(f.vault);return out;
    };
    const before=migrationTree();
    // Real child using the previous build's job-store, with an ongoing heartbeat.
    const child=spawn(f.ctx.node,[path.join(f.from,'server.js')],{env:f.ctx.env,stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});
    const id=await new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.once('data',d=>resolve(d.toString().trim()));child.stderr.once('data',d=>reject(new Error(d.toString())));});
    const ledger=path.join(f.vault,'ledger','spawns.jsonl');put(ledger,'{"fixture":"previous spawn"}\n');const ledgerBefore=fs.readFileSync(ledger);
    const poll=()=>{assert.equal(child.exitCode,null);const s=require(path.join(f.ctx.dirs.app,'lib','jobstore.js'));const v=s.loadView({jobsRoot:path.join(f.vault,'work','jobs')},{},id);assert.ok(v,'old job pollable from new build');assert.equal(v.state_derived,'running');assert.equal(fs.readFileSync(ledger).equals(ledgerBefore),true);};
    try {
      await phase(f,0);for(const [p,b] of original)assert.deepEqual(fs.readFileSync(p),b);const after=migrationTree();for(const [p,b] of Object.entries(before))assert.equal(after[p],b);poll();
      await phase(f,1);for(const p of f.hosts.slice(1))assert.deepEqual(fs.readFileSync(p),original.get(p));poll();
      const doc=readJSON(f.hosts[0]);assert.equal(doc.mcpServers.neighbor.command,'keep');assert.ok(doc.mcpServers.council&&doc.mcpServers['council-next']);
      for(const h of ['codex','claude-desktop','claude-code']){await phase(f,2,h);poll();}
      assert.ok(!readJSON(f.hosts[0]).mcpServers['council-next']);assert.ok(!readJSON(f.ctx.dirs.manifest).registrations.some(r=>r.name==='council-next'));
      const oldTree=tree(f.from);await phase(f,3);const newTree=tree(f.from);assert.deepEqual(Object.keys(newTree).filter(p=>!Object.hasOwn(oldTree,p)),[path.join(f.from,'FROZEN.md')]);for(const [p,b] of Object.entries(oldTree))assert.equal(newTree[p],b);poll();
      const outside=b=>spliceJsonEntry(spliceJsonEntry(b,'council',null).bytes,'council-next',null).bytes;
      const rollbackOutside=new Map(f.hosts.filter(p=>!p.endsWith('.toml')).map(p=>[p,outside(fs.readFileSync(p))]));
      assert.equal((await migrate({from:f.from,rollback:true},f.ctx)).exitCode,0);poll();
      for(const [p,b] of rollbackOutside)assert.deepEqual(outside(fs.readFileSync(p)),b,'rollback preserves every byte outside the two entries');
      for(const p of f.hosts)if(p.endsWith('.toml'))assert.deepEqual(fs.readFileSync(p),original.get(p));else {const a=readJSON(p),b=JSON.parse(original.get(p));assert.deepEqual(a,b);}
      process.stdout.write('BEGIN SANDBOX MIGRATE TRANSCRIPT\n'+f.term.text()+'END SANDBOX MIGRATE TRANSCRIPT\n');
    }finally{
      child.stdin.end('done');await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{child.kill();reject(new Error('previous fixture did not exit cleanly'));},5000);
        const finish=code=>{clearTimeout(timer);code===0?resolve():reject(new Error('previous fixture exit '+code));};
        if(child.exitCode!==null)finish(child.exitCode);else child.once('exit',finish);
      });
    }
  });
  for(const stop of [0,1,2])await check('rollback from phase '+stop,async()=>{
    const f=await migrationFixture();await phase(f,0);if(stop>=1)await phase(f,1);if(stop>=2)await phase(f,2,'codex');
    const p=f.hosts[1];fs.appendFileSync(p,'\n[unrelated]\nvalue = "added later"\n');
    assert.equal((await migrate({from:f.from,rollback:true},f.ctx)).exitCode,0);assert.match(fs.readFileSync(p,'utf8'),/value = "added later"/);
    assert.ok(!readJSON(f.hosts[0]).mcpServers['council-next']);assert.equal(readJSON(f.hosts[0]).mcpServers.council.args[0],path.join(f.from,'server.js'));
  });
  for(const point of ['pre','written'])for(const op of [0,1,2,3])await check('Claude cutover crash '+point+' '+op,async()=>{
    const f=await migrationFixture();await phase(f,0);await phase(f,1);await phase(f,2,'codex');await phase(f,2,'claude-desktop');
    await assert.rejects(migrate({from:f.from,phase:'2',host:'claude-code'},{...f.ctx,migrationMutation:async(p,i)=>{if(p===point&&i===op)throw new Error('fixture crash');}}),/fixture crash/);
    const open=openJournals(f.ctx.dirs.journal);assert.equal(open.length,1);const state=readJournal(open[0].path);assert.equal(state.records.filter(r=>r.t==='pre').length,4);
    const plan=readJSON(state.records[0].plan);assert.equal((await apply({plan:plan.file,resume:true},f.ctx)).exitCode,0);
    assert.ok(!readJSON(f.hosts[0]).mcpServers['council-next']);assert.ok(!readJSON(f.ctx.dirs.manifest).registrations.some(r=>r.name==='council-next'));assert.equal(openJournals(f.ctx.dirs.journal).length,0);
  });
  for(const op of [0,1,2,3])await check('journal rollback after Claude write '+op,async()=>{
    const f=await migrationFixture();await phase(f,0);await phase(f,1);await phase(f,2,'codex');await phase(f,2,'claude-desktop');
    const hostBefore=readJSON(f.hosts[0]);
    await assert.rejects(migrate({from:f.from,phase:'2',host:'claude-code'},{...f.ctx,migrationMutation:async(point,i)=>{if(point==='written'&&i===op)throw new Error('fixture crash');}}));
    const open=openJournals(f.ctx.dirs.journal)[0],plan=readJSON(open.records[0].plan);
    const r=await resumeMigration(plan,f.ctx,{reverse:true});assert.equal(r.exitCode,0);
    assert.deepEqual(readJSON(f.hosts[0]),hostBefore);assert.ok(readJSON(f.ctx.dirs.manifest).registrations.some(r=>r.name==='council-next'));
    assert.equal(openJournals(f.ctx.dirs.journal).length,0);
  });
  await check('migrate rollback recovers open step then re-points every host',async()=>{
    const f=await migrationFixture();await phase(f,0);await phase(f,1);await phase(f,2,'codex');await phase(f,2,'claude-desktop');
    await assert.rejects(migrate({from:f.from,phase:'2',host:'claude-code'},{...f.ctx,migrationMutation:async(point,i)=>{if(point==='written'&&i===2)throw new Error('fixture crash');}}));
    assert.equal((await migrate({from:f.from,rollback:true},f.ctx)).exitCode,0);
    assert.equal(openJournals(f.ctx.dirs.journal).length,0);
    for(const file of [f.hosts[0],f.hosts[2]])assert.equal(readJSON(file).mcpServers.council.args[0],path.join(f.from,'server.js'));
    assert.ok(!readJSON(f.hosts[0]).mcpServers['council-next']);assert.ok(fs.readFileSync(f.hosts[1],'utf8').includes(JSON.stringify(path.join(f.from,'server.js'))));
  });
  await check('migration old agy prints exactly one runtime reason and preserves old gate',async()=>{
    const f=await migrationFixture(),oldConfig=readJSON(path.join(f.from,'config.json'));
    oldConfig.gemini={provider:'agy'};oldConfig.runtime_root=path.join(f.dir,'previous-runtime');
    put(path.join(f.from,'config.json'),JSON.stringify(oldConfig,null,2)+'\n');
    const gate=path.join(oldConfig.runtime_root,'agy-enabled'),gateBefore=Buffer.from('old gate canary\r\n');
    put(gate,gateBefore);
    assert.equal(readJSON(f.ctx.dirs.config),null);assert.equal(fs.existsSync(f.ctx.dirs.agyGate),false);
    await phase(f,0);
    const transcript=f.term.text(),lines=transcript.split(/\r?\n/);
    process.stdout.write('BEGIN SANDBOX AGY POSITIVE TRANSCRIPT\n'+transcript+'END SANDBOX AGY POSITIVE TRANSCRIPT\n');
    assert.equal(lines.filter(line=>/^gemini: agy_[a-z_]+ — see NOTICE\.md$/.test(line)).length,1);
    assert.ok(!transcript.includes('agy'+'-enabled'));assert.ok(!transcript.includes('prompt_'+'form'));assert.ok(!transcript.includes(sentence));
    assert.doesNotMatch(transcript,/\b(enable|enabling|acknowledge|accept)\b[^\n]*\b(agy|antigravity)\b/i);
    assert.doesNotMatch(transcript,/\b(agy|antigravity)\b[^\n]*\b(enable|enabling|acknowledge|accept)\b/i);
    assert.deepEqual(fs.readFileSync(gate),gateBefore);assert.equal(fs.existsSync(f.ctx.dirs.agyGate),false);
  });
  process.stdout.write('PASS verbs2 ('+checks+' checks; migration phases 3/3)\n');
}
