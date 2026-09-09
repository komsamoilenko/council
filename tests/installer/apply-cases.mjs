// Runs only after run.mjs's sandbox preflight; no vendor calls or real homes.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {context} from '../../installer/lib/survey.mjs';
import {buildPlan,publishPlan} from '../../installer/lib/planning.mjs';
import {apply,applyReport,tier0} from '../../installer/lib/apply.mjs';
import {rollback} from '../../installer/lib/rollback.mjs';
import {spliceJsonEntry} from '../../installer/lib/host-json.mjs';
import {fixture,put,names} from './fixtures.mjs';
import platform from '../../src/platform/index.js';
import {doctorHandshake} from '../../installer/lib/registration.mjs';
import {readJournal} from '../../installer/lib/journal.mjs';
import {sha256} from '../../installer/lib/manifest.mjs';
import {registrationMatches,registrationEdit} from '../../installer/lib/registration.mjs';
import {appdirs} from '../../installer/lib/appdirs.mjs';

export async function applyCases(root,base) {
  let count=0,serial=0;
  const make=async(name='empty',hosts='none',noClis=false,prepare=()=>{})=>{
    const dir=path.join(root,'apply-'+serial++);fs.mkdirSync(dir);
    const env={...base.env};
    for(const k of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','CODEX_HOME','CLAUDE_CONFIG_DIR','XDG_STATE_HOME']){env[k]=path.join(dir,k.toLowerCase());fs.mkdirSync(env[k]);}
    const ctx=context({...base,env,dirs:undefined,platform:{...platform,implemented:{...platform.implemented,fileAttributes:false},restrictToOwner:async()=>({ok:false,reason:'backup_acl_not_restricted',reverted:true})},tier0:async()=> 'fixture Tier-0 pass',doctor:async()=>({fixture:true})});
    // context's overrides deliberately preserve an explicit dirs; use fresh layout.
    const {appdirs}=await import('../../installer/lib/appdirs.mjs');ctx.dirs=appdirs({env});
    const vault=fixture(dir,name,ctx);
    if(name==='absent')fs.rmdirSync(vault);
    put(path.join(env.CLAUDE_CONFIG_DIR,'.claude.json'),'{\n  "canary": "untouched",\n  "mcpServers": {"neighbor": { "command": "keep" }}\n}\n');
    put(path.join(env.CODEX_HOME,'config.toml'),'developer_instructions = """\nkeep [mcp_servers.council]\n"""\n[mcp_servers.ask-claude]\ncommand = "keep"\n[windows]\nsandbox = "keep"\n');
    put(path.join(env.APPDATA,'Claude','claude_desktop_config.json'),'{"preferences": { "canary": true }, "mcpServers": {"neighbor": { "command": "keep" }}}\n');
    const originalProbe=base.probe;
    ctx.probe=(file,args,opts)=>{
      if(noClis&&args.some(a=>String(a).endsWith('npm-cli.js')))return {status:1,stdout:''};
      if(args[0]==='mcp'&&args[1]==='add-json') {const p=path.join(env.CLAUDE_CONFIG_DIR,'.claude.json');const doc=JSON.parse(fs.readFileSync(p));doc.mcpServers[args[2]]=JSON.parse(args[3]);fs.writeFileSync(p,JSON.stringify(doc,null,2)+'\n');return {status:0,stdout:''};}
      if(args.includes('mcp'))return {status:0,stdout:'fixture readback'};
      return originalProbe(file,args,opts);
    };
    await prepare(ctx,vault);
    const built=await buildPlan({vault,hosts,json:true,merge:['agents-marker-no-version','agents-two-blocks'].includes(name)?'none':'block'},ctx);
    await publishPlan(built);
    return {ctx,plan:built.plan,vault,dir,options:{plan:built.plan.file,yes:true}};
  };
  const tree=dir=>{const out={};const walk=p=>{for(const e of fs.readdirSync(p,{withFileTypes:true})){const f=path.join(p,e.name);out[f]=e.isDirectory()?'dir':fs.readFileSync(f).toString('base64');if(e.isDirectory())walk(f);}};walk(dir);return out;};
  const checkDelta=(before,after,plan)=>{
    const declared=new Set(plan.steps.flatMap(s=>s.writes).filter(w=>!w.transient).map(w=>w.path));
    for(const p of new Set([...Object.keys(before),...Object.keys(after)]))if(before[p]!==after[p])assert.ok(declared.has(p),'undeclared change: '+p);
    for(const w of plan.steps.flatMap(s=>s.writes))if(!w.transient && !w.directory && w.content!==undefined && !['S0','S1'].includes(plan.steps.find(s=>s.writes.includes(w)).id))assert.equal(after[w.path],Buffer.from(w.content).toString('base64'),'plan bytes: '+w.path);
    for(const w of plan.steps.flatMap(s=>s.writes))if(w.backup)assert.equal(after[w.backup],before[w.path],'backup canary: '+w.path);
  };
  for(const name of names) {
    const f=await make(name),before=tree(f.dir),order=[];
    const result=await apply(f.options,{...f.ctx,boundary:async s=>order.push(s)});
    const records=fs.readFileSync(result.journal,'utf8').trim().split('\n').map(JSON.parse);
    for(const w of f.plan.steps.flatMap(s=>s.writes))if(w.backup)assert.ok(records.some(r=>r.t==='backup'&&r.path===w.path&&r.backup===w.backup),'durable backup record: '+w.path);
    checkDelta(before,tree(f.dir),f.plan);assert.ok(order.indexOf('S7')<order.indexOf('S8'));
    const installed=tree(f.dir);assert.equal((await apply(f.options,f.ctx)).unchanged,true);assert.deepEqual(tree(f.dir),installed);
    if(name==='obsidian-like') {
      assert.match(applyReport(result),/backup_acl_not_restricted/);
      if(process.env.COUNCIL_PRINT_REPORT==='1')process.stdout.write('BEGIN ACTUAL OBSIDIAN APPLY\n'+applyReport(result)+'END ACTUAL OBSIDIAN APPLY\n');
      const again=await buildPlan({vault:f.vault,hosts:'none',json:true},f.ctx);await publishPlan(again);
      const state=tree(f.dir);assert.equal((await apply({plan:again.plan.file,yes:true},f.ctx)).unchanged,true,'new plan of unchanged install');assert.deepEqual(tree(f.dir),state);
    }
    count++;
    process.stdout.write('PASS apply fixture '+name+'\n');
  }
  for(const stage of Array.from({length:12},(_,i)=>'S'+i)) {
    const f=await make(stage==='S3'?'empty':'obsidian-like');let crashed=false;
    await assert.rejects(apply(f.options,{...f.ctx,boundary:async s=>{if(s===stage){crashed=true;throw new Error('fixture crash');}}}));assert.ok(crashed);
    const result=await apply({...f.options,resume:true},f.ctx);assert.ok(result.unchanged||result.changed.length>=0);count++;process.stdout.write('PASS crash/resume '+stage+'\n');
  }
  for(const mode of ['before','expected','human']) {
    const f=await make('conflicting-agents'),original=fs.readFileSync(path.join(f.vault,'AGENTS.md'));
    const target=path.join(f.vault,'AGENTS.md');
    await assert.rejects(apply(f.options,{...f.ctx,mutation:async(point,stage,p)=>{if(stage==='S6'&&p===target&&point===(mode==='before'?'pre':'written'))throw new Error('mid-stage crash');}}));
    if(mode==='human')fs.appendFileSync(target,'Human addition\n');
    const result=await rollback({yes:true,journal:path.basename(f.plan.file,'.json')},f.ctx);
    if(mode==='human'){assert.ok(result.conflicts.some(p=>p.startsWith(target)));assert.match(fs.readFileSync(target,'utf8'),/Human addition/);}
    else {assert.equal(result.conflicts.length,0,result.conflicts.join('\n'));assert.deepEqual(fs.readFileSync(target),original);assert.equal(fs.existsSync(path.join(f.vault,'.council','vault.json')),false);}
    count++;
  }
  {
    const f=await make('obsidian-like','all');let calls=0;
    await assert.rejects(apply(f.options,{...f.ctx,tier0:async()=>{throw new Error('S7 failure');},doctor:async()=>{calls++;}}));
    assert.equal(calls,0);for(const r of f.plan.registrations)assert.doesNotMatch(fs.readFileSync(r.path,'utf8'),/COUNCIL_HOST/);count++;
  }
  {
    const f=await make('obsidian-like');const p=path.join(f.vault,'AGENTS.md');fs.appendFileSync(p,'Edited after plan\n');const before=tree(f.dir);
    await assert.rejects(apply(f.options,f.ctx),e=>e.exitCode===3);assert.deepEqual(tree(f.dir),before);count++;
  }
  {
    const f=await make('obsidian-like','all'),before=new Map(f.plan.registrations.map(r=>[r.path,fs.readFileSync(r.path)]));
    const result=await apply(f.options,f.ctx);assert.equal(result.registrations.length,3);
    for(const r of f.plan.registrations)assert.ok(fs.readFileSync(r.path).includes(Buffer.from('keep')));
    for(const r of f.plan.registrations) {
      if(r.surface==='codex')fs.appendFileSync(r.path,'\n[mcp_servers.added]\ncommand = "new live state"\n');
      else fs.writeFileSync(r.path,spliceJsonEntry(fs.readFileSync(r.path),'added',{command:'new live state'}).bytes);
    }
    const undone=await rollback({yes:true,journal:path.basename(f.plan.file,'.json')},f.ctx);
    assert.equal(undone.conflicts.length,0,undone.conflicts.join('\n'));
    for(const r of f.plan.registrations) {
      // JSON removal may retain the insertion whitespace; every existing value
      // and TOML sibling byte must survive independently of serialization.
      if(r.surface==='codex')assert.deepEqual(fs.readFileSync(r.path),Buffer.concat([before.get(r.path),Buffer.from('\n[mcp_servers.added]\ncommand = "new live state"\n')]));
      else {const expected=JSON.parse(before.get(r.path));expected.mcpServers.added={command:'new live state'};assert.deepEqual(JSON.parse(fs.readFileSync(r.path)),expected);}
    }
    count++;
  }
  {
    const f=await make('obsidian-like');await apply(f.options,f.ctx);
    const vault=path.join(f.dir,'second-vault');fs.mkdirSync(vault);
    const ctx={...f.ctx,dirs:appdirs({env:f.ctx.env,profile:'second'})};
    const built=await buildPlan({profile:'second',vault,hosts:'none',json:true},ctx);await publishPlan(built);
    await apply({plan:built.plan.file,yes:true},ctx);
    assert.deepEqual(JSON.parse(fs.readFileSync(ctx.dirs.machine)).shared.profiles,['default','second']);
    assert.equal((await apply(f.options,f.ctx)).unchanged,true,'another profile does not stale shared-machine ownership');count++;
  }
  {
    const f=await make('obsidian-like'),before=tree(f.dir);
    await assert.rejects(apply(f.options,{...f.ctx,probeIo:{...fs,openSync:(p,...args)=>{if(path.basename(p)==='.write-probe')throw Object.assign(new Error('fixture read-only vault'),{code:'EACCES'});return fs.openSync(p,...args);}}}),e=>e.code==='E-VAULT-UNWRITABLE'&&e.exitCode===2);
    assert.deepEqual(tree(f.dir),before,'S0 failure wrote no lock, journal, or backup');count++;
  }
  {
    const f=await make('absent');await apply(f.options,f.ctx);assert.ok(fs.existsSync(path.join(f.vault,'.council','vault.json')));count++;
  }
  {
    const f=await make('obsidian-like','all'),before=tree(f.dir);
    assert.equal((await apply({...f.options,'dry-run':true},f.ctx)).dryRun,true);assert.deepEqual(tree(f.dir),before);
    const log=path.join(f.ctx.dirs.logs,'apply.log');const result=await apply({...f.options,'no-register':true,log},f.ctx);
    assert.equal(result.registrations.length,0);assert.equal(result.pending_hosts.length,3);assert.match(fs.readFileSync(log,'utf8'),/Host registration deferred/);count++;
  }
  {
    const f=await make('obsidian-like','none',true);
    await apply(f.options,f.ctx);
    const next=await buildPlan({vault:f.vault,hosts:'claude-desktop',json:true},f.ctx);await publishPlan(next);
    const result=await apply({plan:next.plan.file,yes:true},{...f.ctx,doctor:doctorHandshake});
    assert.equal(result.registrations.length,1);
    const ledger=path.resolve(f.vault,f.plan.layout.ledger_dir);
    assert.equal(fs.readdirSync(ledger).some(n=>n.startsWith('setup-')),false,'S11 removed exact setup list');
    if(process.env.COUNCIL_PRINT_REPORT==='1')process.stdout.write('BEGIN ACTUAL JOURNAL\n'+fs.readFileSync(result.journal,'utf8')+'END ACTUAL JOURNAL\n');
    count++;process.stdout.write('PASS real installed stdio initialize + council_doctor\n');
  }
  {
    const f=await make('obsidian-like');const result=await apply(f.options,{...f.ctx,tier0});
    assert.match(result.tier0,/Tier 0/);process.stdout.write(result.tier0);count++;
  }
  {
    const f=await make('obsidian-like','all',false,ctx=>{
      const p=path.join(ctx.env.CLAUDE_CONFIG_DIR,'.claude.json');
      const doc=JSON.parse(fs.readFileSync(p));doc.history='PRIVATE_HOST_HISTORY_SENTINEL';put(p,JSON.stringify(doc,null,2));
      fs.appendFileSync(path.join(ctx.env.CODEX_HOME,'config.toml'),'# PRIVATE_TOML_HISTORY_SENTINEL\n');
    });
    const published=fs.readFileSync(f.plan.file,'utf8');
    assert.ok(!published.includes('PRIVATE_HOST_HISTORY_SENTINEL')&&!published.includes('PRIVATE_TOML_HISTORY_SENTINEL'));
    for(const w of f.plan.steps.find(s=>s.id==='S2').writes.filter(w=>!w.directory)) {assert.equal(w.content,undefined);assert.ok(w.source&&w.source_sha256&&Number.isInteger(w.bytes));}
    const evidence=path.join(process.env.COUNCIL_TEST_DIAGNOSTICS,'brief16-plan.json');fs.writeFileSync(evidence,published);
    const r=f.plan.registrations.find(r=>r.surface==='claude-code');
    const churn=()=>{const doc=JSON.parse(fs.readFileSync(r.path));doc.sessions=(doc.sessions||0)+1;fs.writeFileSync(r.path,JSON.stringify(doc,null,2)+'\n');};
    churn();
    await assert.rejects(apply(f.options,{...f.ctx,boundary:async s=>{if(s==='S2')churn();},mutation:async(point,stage,p)=>{if(point==='written'&&stage==='S8'&&p===r.path)throw new Error('after CLI crash');}}),/after CLI crash/);
    const journal=path.join(f.ctx.dirs.journal,path.basename(f.plan.file,'.json')+'.jsonl');
    const pre=readJournal(journal).records.find(x=>x.t==='pre'&&x.path===r.path);
    assert.equal(pre.sha256_expected,null);
    assert.ok(registrationMatches(fs.readFileSync(r.path),pre.undo.registration));
    const result=await apply({...f.options,resume:true},f.ctx);
    const post=readJournal(journal).records.find(x=>x.t==='post'&&x.path===r.path);
    assert.equal(post.sha256_after,sha256(fs.readFileSync(r.path)));
    assert.equal(result.registrations.length,3);count++;
    process.stdout.write('PASS private host plan + live churn + pretty CLI crash/resume; evidence '+evidence+'\n');
  }
  for(const damage of ['missing','corrupt']) {
    const f=await make('conflicting-agents');await apply(f.options,f.ctx);
    const target=path.join(f.vault,'AGENTS.md'),w=f.plan.steps.flatMap(s=>s.writes).find(w=>w.path===target);
    // Corrupt rather than delete the backup: no new installer deletion is needed.
    if(damage==='corrupt')fs.writeFileSync(w.backup,'invalid backup');
    else fs.renameSync(w.backup,w.backup+'.retained');
    const opts={journal:path.basename(f.plan.file,'.json')};
    const before=tree(f.dir);
    await assert.rejects(rollback(opts,{...f.ctx,input:{isTTY:false}}),e=>e.exitCode===5);
    assert.deepEqual(tree(f.dir),before);
    const result=await rollback({...opts,yes:true},f.ctx);
    assert.ok(result.conflicts.some(p=>p.startsWith(target)&&p.includes('backup invalid')));
    assert.ok(result.restored.length>0);
    assert.equal(fs.existsSync(path.join(f.vault,'.council','vault.json')),false);
    assert.equal(readJournal(path.join(f.ctx.dirs.journal,opts.journal+'-rollback.jsonl')).open,false);
    count++;process.stdout.write('PASS rollback '+damage+' backup: continues, commits, non-TTY gate\n');
  }
  {
    const f=await make('obsidian-like','all');
    await assert.rejects(apply(f.options,{...f.ctx,boundary:async s=>{if(s==='S7')throw new Error('month crash');}}));
    const future=new Date(f.ctx.now().getTime()+40*86400000);
    await apply({...f.options,resume:true},{...f.ctx,now:()=>future,doctor:async()=>{
      put(path.resolve(f.vault,f.plan.layout.ledger_dir,'setup-council-'+future.toISOString().slice(0,7)+'.jsonl'),'probe');
    }});
    assert.equal(fs.readdirSync(path.resolve(f.vault,f.plan.layout.ledger_dir)).some(n=>n.startsWith('setup-')),false);count++;
  }
  {
    const f=await make('obsidian-like');
    await assert.rejects(apply(f.options,{...f.ctx,boundary:async s=>{if(s==='S2')throw new Error('interrupted S3');}}));
    const partial=f.ctx.dirs.app+'.partial';put(path.join(partial,'partial.js'),'owned partial');
    const result=await rollback({yes:true,journal:path.basename(f.plan.file,'.json')},f.ctx);
    assert.equal(result.conflicts.length,0);assert.equal(fs.existsSync(partial),false);count++;
  }
  for(const point of ['pre','written']) {
    let calls=0;
    const f=await make('obsidian-like','claude-code',false,ctx=>{
      const p=path.join(ctx.env.CLAUDE_CONFIG_DIR,'.claude.json');
      const doc=JSON.parse(fs.readFileSync(p));doc.mcpServers.council={command:ctx.node,args:[path.join(root,'old','council','server.js')]};put(p,JSON.stringify(doc,null,2));
      ctx.env.CLAUDECODE='';ctx.claudeIdle=async()=>true;
      const probe=ctx.probe;ctx.probe=(file,args,opts)=>{if(args[0]==='mcp'&&['remove','add-json'].includes(args[1]))calls++;return probe(file,args,opts);};
    });
    const options={...f.options,'adopt-existing':true};
    await assert.rejects(apply(options,{...f.ctx,mutation:async(p,stage)=>{if(stage==='S8'&&p===point)throw new Error('adoption crash');}}));
    await apply({...options,resume:true},f.ctx);assert.equal(calls,0);
    assert.equal((await rollback({yes:true,journal:path.basename(f.plan.file,'.json')},f.ctx)).conflicts.length,0);count++;
  }
  {
    const f=await make('obsidian-like','all');
    await apply(f.options,f.ctx);
    const r=f.plan.registrations.find(r=>r.surface==='claude-code');fs.writeFileSync(r.path,'{ malformed');
    const result=await rollback({yes:true,journal:path.basename(f.plan.file,'.json')},f.ctx);
    assert.ok(result.conflicts.some(p=>p.startsWith(r.path)));assert.ok(result.restored.length);count++;
  }
  {
    const f=await make('obsidian-like','codex');
    const r=f.plan.registrations[0];
    const before=Buffer.from('description = """\n# council:begin v=1\nexample\n# council:end\n"""\n');
    const edit=registrationEdit(r,before);assert.ok(registrationMatches(edit.edit.bytes,edit.record));count++;
  }
  {
    let hardened;
    const f=await make('obsidian-like','none',false,(ctx,vault)=>{
      put(ctx.dirs.config,JSON.stringify({schema:2,vault,runtime_root:path.join(ctx.dirs.root,'custom-runtime')}));
      ctx.platform.restrictToOwner=async p=>{if(path.basename(p)==='secrets')hardened=p;return {ok:true};};
    });
    await apply(f.options,f.ctx);
    assert.equal(hardened,path.join(f.ctx.dirs.root,'custom-runtime','secrets'));assert.ok(fs.existsSync(hardened));count++;
  }
  {
    const f=await make('obsidian-like','claude-code');await apply(f.options,f.ctx);
    const p=f.plan.registrations[0].path;fs.writeFileSync(p,'\ufeff'+fs.readFileSync(p,'utf8'));
    assert.equal((await rollback({yes:true,journal:path.basename(f.plan.file,'.json')},f.ctx)).conflicts.length,0);count++;
  }
  {
    const f=await make('obsidian-like');
    const stamp=path.basename(f.plan.file,'.json'),journal=path.join(f.ctx.dirs.journal,stamp+'.jsonl');put(journal,'broken\n');
    await assert.rejects(rollback({yes:true,journal:stamp},f.ctx),e=>e.exitCode===5&&e.code==='E-JOURNAL-OPEN');count++;
  }
  process.stdout.write('PASS apply/rollback ('+count+' checks)\n');
}
