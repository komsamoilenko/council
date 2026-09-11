// Owns the fail-closed child sandbox and read-only integration suite; specification §16.4.
import fs from 'node:fs';
import os from 'node:os';
import {tempRoot} from '../temp-root.mjs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../',import.meta.url));
const self = fileURLToPath(import.meta.url), fakebin = path.join(repo,'tests','helpers','fakebin');
const inside = (p,r) => { const rel=path.relative(r,p); return rel!=='' && !rel.startsWith('..') && !path.isAbsolute(rel); };
const envKeys = ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','TMPDIR','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CACHE_HOME','CODEX_HOME','CLAUDE_CONFIG_DIR'];
function preflight() {
  const root=process.env.COUNCIL_TEST_ROOT;
  if (!root || !inside(root,process.env.COUNCIL_TEST_TEMP_BASE || '') || fs.realpathSync(root)!==path.resolve(root) ||
      !inside(process.env.USERPROFILE || '',os.tmpdir()) || envKeys.some(key => !process.env[key] || !(path.resolve(process.env[key])===root || inside(path.resolve(process.env[key]),root))) ||
      process.env.PATH.split(path.delimiter)[0]!==fakebin || !['win32','darwin','linux'].includes(process.env.COUNCIL_PLATFORM)) throw new Error('REFUSED: installer child is not sandboxed');
  return root;
}

if (process.argv.includes('--child')) {
  let root;
  try { root=preflight(); } catch (e) { process.stderr.write(e.message+'\n'); process.exit(2); }
  // No fixture import, test registration or operation occurs until preflight passed.
  const {run,parse,usage}=await import('../../installer/setup.mjs');
  const {context,survey,fingerprint,sha256,stable,which}=await import('../../installer/lib/survey.mjs');
  const {buildPlan}=await import('../../installer/lib/planning.mjs');
  const {scanDuplicates,ignored,ignoreRules}=await import('../../installer/lib/duplicates.mjs');
  const {fail,errorObject,ERROR_CATALOGUE,questions}=await import('../../installer/lib/dialogue.mjs');
  const {planReport}=await import('../../installer/lib/report.mjs');
  const {names,fixture,put}=await import('./fixtures.mjs');
  const {writeSplice}=await import('../../installer/lib/safewrite.mjs');
  const {snapshot,assertUnchanged,assertHostTargetsOutsideProfile}=await import('./sandbox-assertions.mjs');
  const caseName=process.argv[process.argv.indexOf('--child')+1];
  let count=0;
  const test=async (label,fn) => { await fn(); count++; };
  let tick=0;
  const calls=[];
  const env={...process.env};
  const npmRoot=path.join(root,'npm','node_modules');
  for (const file of [path.join('@anthropic-ai','claude-code','bin','claude.exe'),path.join('@openai','codex','bin','codex.js')]) put(path.join(npmRoot,file),'fixture sentinel\n');
  put(path.join(npmRoot,'@openai','codex','node_modules','@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc','codex-path','rg.exe'),'fixture ripgrep\n');
  const node=process.execPath;
  const probe=(file,args,opts) => {
    assert.equal(path.isAbsolute(file),true); assert.equal(opts.cwd,os.tmpdir()); assert.equal(opts.shell,false);
    assert.equal(/\.(cmd|bat|ps1)$/i.test(file),false);
    calls.push({file,args});
    if (path.basename(file).toLowerCase()==='powershell.exe' && args.at(-1).includes('ConvertTo-Json -Compress')) {
      assert.deepEqual(args.slice(0,-1),['-NoProfile','-NonInteractive','-Command']);
      assert.ok(args.at(-1).includes('Get-Item -LiteralPath $_ -Force -ErrorAction Stop'));
      const literals=args.at(-1).split('@(@(')[1].split(') | ForEach-Object')[0];
      const files=[...literals.matchAll(/'((?:[^']|'')*)'/g)].map(m=>m[1].replaceAll("''","'"));
      assert.ok(files.length>0&&files.length<=200);
      return {status:0,stdout:JSON.stringify(files.map(p=>path.basename(p)==='cloud.md'?0x1000:0))};
    }
    if (file===node && args[0]===path.join(path.dirname(node),'node_modules','npm','bin','npm-cli.js')) return {status:0,stdout:args[1]==='root'?npmRoot:args[1]==='prefix'?path.dirname(npmRoot):'11.0.0',stderr:''};
    if (file===path.join(fakebin,'git')) return args.includes('check-ignore')?{status:128,stdout:'',stderr:''}:{status:0,stdout:'git version 2.51.2',stderr:''};
    if (file===path.join(npmRoot,'@anthropic-ai','claude-code','bin','claude.exe')) return {status:0,stdout:'2.1.263 (Claude Code)',stderr:''};
    if (file===node && args[0]===path.join(npmRoot,'@openai','codex','bin','codex.js')) {
      const argv=args.slice(1);
      if(argv.includes('--help')) {
        assert.ok(JSON.stringify(argv)===JSON.stringify(['exec','--help'])||JSON.stringify(argv)===JSON.stringify(['exec','--ignore-user-config','--ignore-rules','--skip-git-repo-check','--help']));
        return {status:0,stdout:'--ignore-user-config --ignore-rules --skip-git-repo-check',stderr:''};
      }
      assert.ok(JSON.stringify(argv)===JSON.stringify(['--version'])||JSON.stringify(argv)===JSON.stringify(['login','status']));
      return {status:0,stdout:argv.includes('login')?'signed in':'codex-cli 0.153.2',stderr:''};
    }
    throw new Error('Unapproved probe: '+file+' '+args.join(' '));
  };
  const ctx=context({env,probe,nodeVersion:'v24.11.1',now:()=>new Date(Date.UTC(2026,8,8,9,10,tick++)),attributes:async file=>path.basename(file)==='cloud.md'?{bits:0x1000}:null});
  assertHostTargetsOutsideProfile(ctx);
  const unchanged=(before,allowed=[])=>{
    assertUnchanged(root,env.USERPROFILE,before,snapshot(root),allowed,ctx.dirs.id);
  };
  const invoke=async (argv,extra={})=>{let out='',err='';const code=await run(argv,{...ctx,...extra,stdout:t=>out+=t,stderr:t=>err+=t});return {code,out,err};};
  try {
    if(caseName==='apply') {
      const {applyCases}=await import('./apply-cases.mjs');await applyCases(root,ctx);
    }
    if (caseName === 'cleanup-failure') {
      fixture(root,'empty',ctx);
      throw new Error('intentional cleanup failure');
    }
    if(names.includes(caseName)) {
      const vault=fixture(root,caseName,ctx);
      const before=snapshot(root);
      await test('detect preserves whole sandbox',async()=>{const r=await invoke(['detect','--vault',vault,'--json']);assert.equal(r.code,0,r.out+r.err);JSON.parse(r.out);unchanged(before);});
      await test('human and JSON survey have identical facts',async()=>{
        const j=JSON.parse((await invoke(['detect','--vault',vault,'--json'])).out),h=await invoke(['detect','--vault',vault]);
        for(const {name,...facts} of j.blocks) assert.ok(h.out.includes(name+': '+JSON.stringify(facts)));unchanged(before);
      });
      await test('plan preserves whole sandbox; only declared plan/report appear',async()=>{
        const r=await invoke(['plan','--vault',vault,'--hosts','none','--json']);
        const expected=['agents-marker-no-version','agents-two-blocks'].includes(caseName)?4:0;
        assert.equal(r.code,expected,r.out+r.err);
        if(r.code){const j=JSON.parse(r.out);if(caseName==='agents-marker-no-version') assert.equal(j.error.code,'E-BLOCK-NOT-TEMPLATE');unchanged(before);return;}
        const p=JSON.parse(r.out);unchanged(before,[path.relative(root,p.file)]);
        const {file_sha256:hash,...body}=p;
        assert.deepEqual(JSON.parse(fs.readFileSync(p.file,'utf8')),body);
        assert.equal(hash,sha256(fs.readFileSync(p.file)));
        const report=planReport(p);for(const line of ['WILL OVERWRITE (0)','WILL DELETE (0)','WILL MOVE OR RENAME (0)']) assert.ok(report.includes(line));
        if(caseName==='cloud-synced')assert.equal(p.answers['relocate-runtime'],true);
        if(caseName==='agents-with-protocol-text') assert.equal(p.answers.merge['AGENTS.md'],'none');
      });
      await test('plan duplicates allowance over every fixture',async()=>{
        const baseline=snapshot(root),r=await invoke(['plan','--vault',vault,'--hosts','none','--merge','none','--duplicates','--json']);
        assert.equal(r.code,0,r.out+r.err);const p=JSON.parse(r.out),after=snapshot(root);
        const reports=Object.keys(after).filter(p=>!baseline[p] && !after[p].directory && p.startsWith(path.relative(root,ctx.dirs.reports)+path.sep));
        assert.equal(reports.length,1);unchanged(baseline,[path.relative(root,p.file),...reports]);
      });
      await test('actual human plan equals D2 renderer',async()=>{
        const baseline=snapshot(root),r=await invoke(['plan','--vault',vault,'--hosts','none','--merge',['agents-marker-no-version','agents-two-blocks'].includes(caseName)?'none':'block']);
        assert.equal(r.code,0,r.out+r.err);const file=/^PLAN FILE\s+(.+?)\s+sha256 /m.exec(r.out)[1];
        const p=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(r.out,planReport(p));unchanged(baseline,[path.relative(root,file)]);
        if(caseName==='obsidian-like' && process.env.COUNCIL_PRINT_REPORT==='1')process.stdout.write('BEGIN ACTUAL OBSIDIAN PLAN\n'+r.out+'END ACTUAL OBSIDIAN PLAN\n');
      });
    } else if(caseName==='survey') {
      const {surveyCases}=await import('./survey-cases.mjs');count+=await surveyCases(root,ctx,invoke);
    } else if(caseName==='behavior') {
      const vault=fixture(root,'empty',ctx);
      await test('preflight has already run',async()=>assert.equal(preflight(),root));
      await test('profile allowlist admits OS rewrites and rejects every other change',async()=>{
        const rel=p=>path.join('userprofile',...p.split('/'));
        const check=(before,after,allowed=[],id='win32')=>assertUnchanged(root,env.USERPROFILE,before,after,allowed,id);
        const old={hash:'before',mtime:1},changed={hash:'after',mtime:2};
        for(const p of ['AppData/Local/Microsoft/Windows/PowerShell/StartupProfileData-NonInteractive','AppData/Roaming/system-cache']) {
          const file=rel(p);check({}, {[file]:changed});check({[file]:old},{[file]:changed});
          assert.throws(()=>check({}, {[file]:changed},[],'linux'),/unexpected profile-root change/);
        }
        for(const p of ['.claude.json','.codex/config.toml','.claude/settings.json','invented','AppData/Local-other/cache','AppData/Roaming-other/cache']) {
          const file=rel(p),named=e=>e.message.includes(file);
          assert.throws(()=>check({}, {[file]:changed},[file]),named);
          assert.throws(()=>check({[file]:old},{[file]:changed}),named);
          assert.throws(()=>check({[file]:old},{}),named);
        }
        for(const dir of ['vault','appdata','localappdata','claude_config_dir','codex_home','xdg_state_home']) {
          const file=path.join(dir,'canary');
          assert.throws(()=>check({[file]:old},{[file]:{...old,mtime:2}}),/existing path changed/);
          assert.throws(()=>check({[file]:old},{[file]:{...old,hash:'changed'}}),/existing path changed/);
          assert.throws(()=>check({}, {[file]:changed}),/unexpected new path/);
          check({}, {[file]:changed},[file]);
        }
        for(const key of ['CLAUDE_CONFIG_DIR','CODEX_HOME','APPDATA'])
          assert.throws(()=>assertHostTargetsOutsideProfile({...ctx,env:{...env,[key]:env.USERPROFILE}}),/installer host target resolves inside profile/);
      });
      await test('force-unlock CLI recovers unknown stale guard and lock', async()=>{
        const file=ctx.dirs.lock, guard=file+'.council-tmp-claim';
        put(file,JSON.stringify({pid:42,createdMs:1}));
        put(path.join(guard,'stale.json'),JSON.stringify({pid:42,createdMs:1,token:'stale'}));
        const lockOptions={now:()=>31*60*1000,platform:{systemBinaries:()=>({}),livenessOf:async()=> 'unknown'}};
        const r=await invoke(['unlock','--force-unlock','--json'],{lockOptions});
        assert.equal(r.code,0,r.out+r.err);assert.equal(fs.existsSync(file),false);assert.equal(fs.existsSync(guard),false);
        assert.equal((await invoke(['unlock','--json'])).code,2);
      });
      await test('parser closed verbs and flags',async()=>{
        for(const verb of ['install-prereqs','login','migrate','set-key']){const r=await invoke([verb,'--json']);assert.equal(r.code,2);assert.ok(JSON.parse(r.out).error.code);assert.ok(usage.includes(verb));}
        for(const verb of ['verify','update','uninstall']){const r=await invoke([verb,'--json']);assert.equal(r.code,4);assert.equal(JSON.parse(r.out).reason,'E-NO-MANIFEST');assert.ok(usage.includes(verb));}
        for(const verb of ['apply','rollback'])assert.equal((await invoke([verb,'--json'])).code,2);
        for(const args of [['bogus'],['detect','--bad'],['plan','--vault'],['detect','--profile','../bad'],['new-task','../bad','--vault',vault]]) assert.equal((await invoke(args)).code,2);
        assert.equal(parse(['--profile','custom','detect']).options.profile,'custom');
      });
      await test('complete unattended answers and sanitization',async()=>{
        const answers=path.join(root,'answers.json');put(answers,JSON.stringify({vault,owner:'Name\n<!--injected', 'chat-language':'English\r\n'+'x'.repeat(100),merge:{'AGENTS.md':'none'},'relocate-runtime':false,'gemini-key':'later',duplicates:false,hosts:'none',conventions:false}));
        const r=await invoke(['plan','--answers',answers,'--json']);assert.equal(r.code,0,r.out+r.err);const p=JSON.parse(r.out);assert.equal(p.answers.owner,'Name injected');assert.equal(p.answers['chat-language'].length,80);assert.equal(p.answers.conventions,false);
        assert.equal(p.detect_fingerprint.sha256,sha256(stable(p.detect_fingerprint.inputs)));
      });
      await test('eight questions with defaults',async()=>{const a=await questions({json:true},{home:root});assert.equal(a.owner,'Owner');assert.equal(a['gemini-key'],'later');assert.equal(a.duplicates,false);});
      await test('npm probes disable writes and update checks',async()=>{
        const npmCalls=calls.filter(c=>c.args[0]?.endsWith('npm-cli.js'));assert.ok(npmCalls.length>=3);
        for(const call of npmCalls){assert.equal(call.file,node);for(const flag of ['--logs-max=0','--update-notifier=false','--timing=false'])assert.ok(call.args.includes(flag));assert.equal(call.args[call.args.indexOf('--cache')+1],os.tmpdir());assert.equal(call.args[call.args.indexOf('--logs-dir')+1],node);}
      });
      await test('credentials are existence-only and probe key never enters output',async()=>{
        const file=path.join(env.CLAUDE_CONFIG_DIR,'.credentials.json');put(file,'private credential');const read=fs.readFileSync;
        const probeKey='test-key-'+Math.random().toString(36).slice(2);ctx.env.COUNCIL_GEMINI_API_KEY=probeKey;
        fs.readFileSync=function(p,...args){if(path.resolve(String(p))===file)throw new Error('credential opened');return read.call(this,p,...args);};
        try {const r=await invoke(['detect','--vault',vault,'--json']);assert.equal(r.code,0,r.out+r.err);assert.equal(r.out.includes(probeKey),false);assert.equal(JSON.parse(r.out).blocks.find(b=>b.name==='logins').geminiKey.present,true);
          const p=await invoke(['plan','--vault',vault,'--hosts','none','--json']);assert.equal(p.code,0,p.out+p.err);assert.equal(p.out.includes(probeKey),false);
        } finally {fs.readFileSync=read;delete ctx.env.COUNCIL_GEMINI_API_KEY;}
        const inspect=dir=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())inspect(p);else assert.equal(fs.readFileSync(p).includes(Buffer.from(probeKey)),false,p);}};inspect(root);
      });
      await test('vault free text is absent from detect JSON',async()=>{
        const contractVault=path.join(root,'private-vault');fs.mkdirSync(contractVault);put(path.join(contractVault,'.council','vault.json'),JSON.stringify({schema:1,profile:'default',note:'never echo this private note',vault_id:'id'}));
        const r=await invoke(['detect','--vault',contractVault,'--json']);assert.equal(r.code,0);assert.equal(r.out.includes('never echo this private note'),false);
      });
      await test('filesystem failure returns 1 without overriding earlier node failure',async()=>{
        put(ctx.dirs.current,'invalid JSON');const b=snapshot(root);
        assert.equal((await invoke(['detect','--vault',vault,'--json'])).code,1);unchanged(b);
        assert.equal((await invoke(['detect','--vault',vault,'--json'],{nodeVersion:'v18.0.0'})).code,2);unchanged(b);
        put(ctx.dirs.current,'{}\n');
      });
      await test('all refusal roots write nothing, including --log',async()=>{
        const file=path.join(root,'not-dir');put(file,'data');
        for(const p of [file,ctx.dirs.home,env.APPDATA,env.LOCALAPPDATA,path.parse(root).root,root,'\\\\server\\share']) {const b=snapshot(root),r=await invoke(['plan','--vault',p,'--log',path.join(root,'forbidden.log'),'--json']);assert.equal(r.code,2,r.out+r.err);unchanged(b);}
      });
      await test('large-vault refusal has no write probe',async()=>{
        const big=path.join(root,'big');fs.mkdirSync(big);for(let i=0;i<5001;i++)put(path.join(big,String(i)),'');
        let b=snapshot(root),r=await invoke(['plan','--vault',big,'--json']);assert.equal(r.code,2);unchanged(b);
        r=await invoke(['plan','--vault',big,'--large-vault','--hosts','none','--json']);assert.equal(r.code,0,r.out+r.err);assert.equal(fs.existsSync(path.join(big,'.council')),false);
      });
      await test('cloud runtime refused and nonempty relocation prints copy commands',async()=>{
        let b=snapshot(root);const r=await invoke(['plan','--vault',vault,'--json'],{env:{...ctx.env,OneDrive:env.LOCALAPPDATA}});assert.equal(r.code,2,r.out+r.err);assert.equal(JSON.parse(r.out).error.code,'E-RUNTIME-ROOT-SYNCED');unchanged(b);
        const v=path.join(root,'nonempty');put(path.join(v,'work','jobs','job.json'),'{}');b=snapshot(root);const q=await invoke(['plan','--vault',v,'--relocate-runtime','--hosts','none','--json']);assert.equal(q.code,2,q.out+q.err);assert.ok(q.out.includes('Copy-Item -LiteralPath'));unchanged(b);
      });
      await test('directory junction is never followed by any verb',async()=>{
        const v=path.join(root,'linked-vault'),outside=path.join(root,'outside');fs.mkdirSync(v);fs.mkdirSync(outside);put(path.join(outside,'canary'),'private');
        fs.symlinkSync(outside,path.join(v,'work'),process.platform==='win32'?'junction':'dir');
        let b=snapshot(root);assert.equal((await invoke(['detect','--vault',v,'--json'])).code,0);unchanged(b);
        assert.equal((await invoke(['plan','--vault',v,'--hosts','none','--json'])).code,4);unchanged(b);
        assert.equal((await invoke(['new-task','blocked','--vault',v,'--agents','codex','--json'])).code,4);unchanged(b);
        const q=await invoke(['duplicates','--vault',v,'--json']);assert.equal(q.code,0,q.out+q.err);assert.equal(JSON.parse(q.out).files,0);unchanged(b,[path.relative(root,JSON.parse(q.out).reportFile)]);
      });
      await test('only selected host entries enter fingerprint',async()=>{
        const host=path.join(env.CLAUDE_CONFIG_DIR,'.claude.json');put(host,JSON.stringify({live:1,mcpServers:{council:{command:'node',args:['old']},other:{command:'a'}}}));
        const a=fingerprint(await survey({vault},ctx));put(host,JSON.stringify({live:99,mcpServers:{other:{command:'b'},council:{args:['old'],command:'node'}}}));
        const b=fingerprint(await survey({vault},ctx));assert.deepEqual(a,b);
        put(host,JSON.stringify({mcpServers:{council:{command:'node',args:['new']}}}));assert.notEqual(fingerprint(await survey({vault},ctx)).sha256,a.sha256);
        assert.notEqual(fingerprint(await survey({vault},ctx),'council-next').sha256,a.sha256);
      });
      await test('TOML siblings and unrelated live state do not stale fingerprint',async()=>{
        const host=path.join(env.CODEX_HOME,'config.toml');put(host,'[mcp_servers.ask]\ncommand="a"\n[mcp_servers.council]\ncommand="node"\n[windows]\na=1\n');
        const a=fingerprint(await survey({vault},ctx));put(host,'[mcp_servers.ask]\ncommand="changed"\n[mcp_servers.council]\ncommand="node"\n[windows]\na=22\n');
        assert.deepEqual(fingerprint(await survey({vault},ctx)),a);
      });
      await test('new-task never creates absent index; existing index preserves bytes',async()=>{
        const r=await invoke(['new-task','first-task','--vault',vault,'--agents','claude,codex','--json']);assert.equal(r.code,0,r.out+r.err);assert.equal(fs.existsSync(path.join(vault,'INDEX.md')),false);
        put(path.join(vault,'INDEX.md'),'# Mine\r\n');const q=await invoke(['new-task','second-task','--vault',vault,'--agents','gemini','--json']);assert.equal(q.code,0,q.out+q.err);assert.ok(fs.readFileSync(path.join(vault,'INDEX.md'),'utf8').startsWith('# Mine\r\n'));assert.equal(JSON.parse(q.out).indexAppended,true);
        const before=snapshot(root);assert.equal((await invoke(['new-task','second-task','--vault',vault,'--agents','gemini'])).code,2);unchanged(before);
      });
      await test('already listed task path is not appended',async()=>{
        put(path.join(vault,'INDEX.md'),'- `work/2026-09-08-listed` — prior\n');const b=fs.readFileSync(path.join(vault,'INDEX.md'));
        const r=await invoke(['new-task','listed','--vault',vault,'--agents','codex','--json']);assert.equal(r.code,0);assert.equal(JSON.parse(r.out).indexAppended,false);assert.deepEqual(fs.readFileSync(path.join(vault,'INDEX.md')),b);
      });
      await test('detect --out is explicit and cannot target vault',async()=>{
        const b=snapshot(root),r=await invoke(['detect','--vault',vault,'--out',path.join(vault,'forbidden'),'--json']);assert.equal(r.code,2);unchanged(b);
        const file=path.join(root,'survey.json');const q=await invoke(['detect','--vault',vault,'--out',file,'--json']);assert.equal(q.code,0,q.out+q.err);assert.deepEqual(JSON.parse(fs.readFileSync(file)),JSON.parse(q.out));
      });
      await test('open journal appears first but first failing block chooses exit',async()=>{
        put(path.join(ctx.dirs.journal,'open.jsonl'),JSON.stringify({t:'begin',plan_sha256:'a'.repeat(64)})+'\n');
        const r=await invoke(['detect','--vault',vault]);assert.equal(r.code,5);assert.ok(r.out.split('\n')[1].startsWith('journal:'));
        const q=await invoke(['detect','--vault',vault,'--json'],{nodeVersion:'v18.0.0'});assert.equal(q.code,2);
        const b=snapshot(root);assert.equal((await invoke(['plan','--vault',vault,'--json'])).code,5);unchanged(b);
      });
      await test('actual verify entry point refuses a missing manifest in sandbox',async()=>{
        const r=spawnSync(node,[path.join(repo,'installer','setup.mjs'),'verify','--json'],{env:process.env,encoding:'utf8',windowsHide:true});assert.equal(r.status,4);assert.equal(JSON.parse(r.stdout).reason,'E-NO-MANIFEST');
      });
      await test('all closed exit codes have exercised producers',async()=>{
        for(const [code,wanted] of [['E-STEP',1],['E-USAGE',2],['E-PLAN-STALE',3],['E-MARKER-DUPLICATE',4],['E-JOURNAL-OPEN',5],['E-PLATFORM',6],['E-VERIFY-SLOW',7]]) assert.equal(errorObject(fail(code)).exitCode,wanted);
        // Code 3 is reached here; the verb cases also exercise verify's drift exit 7.
        const file=path.join(root,'stale'),backup=path.join(root,'stale-backup');put(file,'changed');put(backup,'old');await assert.rejects(writeSplice(file,Buffer.from('old'),{bytes:Buffer.from('new'),oldRange:{start:0,end:3},newRange:{start:0,end:3}},{dryRun:false,backup}),e=>e.exitCode===3);
        assert.ok(Object.values(ERROR_CATALOGUE).every(row=>row[0]>=0&&row[0]<=7));
      });
    } else if(caseName==='duplicate-caps') {
      const vault=fixture(root,'duplicates',ctx),before=snapshot(root);
      await test('duplicate groups, skips, cloud-only, repeated index',async()=>{
        const r=await scanDuplicates(vault,ctx);assert.equal(r.groups.length,1);assert.deepEqual(r.groups[0].paths,['a.md','b.md','keep.secret','nested/c.md']);assert.equal(r.indexRepeats[0].occurrences,2);assert.ok(r.notHashed.some(v=>v.path==='cloud.md'&&v.reason==='cloud-only, not hashed'));assert.ok(r.notHashed.some(v=>v.path==='large.md'));unchanged(before);
      });
      await test('file and byte caps',async()=>{const a=await scanDuplicates(vault,ctx,{maxFiles:2});assert.equal(a.files,2);assert.equal(a.capped,true);const b=await scanDuplicates(vault,ctx,{maxBytes:12});assert.equal(b.hashedBytes,11);assert.equal(b.capped,true);unchanged(before);});
      await test('gitignore anchoring, negation, globstar, nested rules',async()=>{
        const rules=ignoreRules('/root.txt\n*.tmp\n!keep.tmp\na/**/b\nfolder/\n');for(const p of ['root.txt','deep/a.tmp','a/b','a/deep/b'])assert.equal(ignored(p,false,rules),true,p);for(const p of ['deep/root.txt','keep.tmp'])assert.equal(ignored(p,false,rules),false,p);assert.equal(ignored('folder',true,rules),true);
        assert.equal(ignored('nested/file',false,ignoreRules('/file','nested')),true);
      });
      await test('duplicates only publishes under reports',async()=>{
        const r=await invoke(['duplicates','--vault',vault,'--json']);assert.equal(r.code,0,r.out+r.err);const report=JSON.parse(r.out);assert.ok(fs.readFileSync(report.reportFile,'utf8').includes(report.notice));unchanged(before,[path.relative(root,report.reportFile)]);
        const b=snapshot(root);assert.equal((await invoke(['duplicates','--vault',vault,'--out',path.join(vault,'no.md')])).code,2);unchanged(b);
      });
    } else if(caseName==='platform') {
      const vault=fixture(root,'empty',ctx);
      await test('non-Windows detect completes; plan needs explicit override',async()=>{
        const b=snapshot(root),r=await invoke(['detect','--vault',vault,'--json']);assert.equal(r.code,6,r.out+r.err);assert.ok(JSON.parse(r.out).blocks.some(b=>b.name==='region'));unchanged(b);
        assert.equal((await invoke(['plan','--vault',vault,'--hosts','none','--json'])).code,6);unchanged(b);
        const q=await invoke(['plan','--vault',vault,'--hosts','none','--allow-unsupported-platform','--json']);assert.equal(q.code,0,q.out+q.err);unchanged(b,[path.relative(root,JSON.parse(q.out).file)]);
      });
    }
    process.stdout.write(`PASS ${caseName}${caseName==='platform'?' '+env.COUNCIL_PLATFORM:''} (${count} checks)\n`);
  } catch(error) {process.stderr.write(`FAIL ${caseName}: ${error.stack}\n`);process.exitCode=1;}
} else {
  // Fixtures live in system temp; the parent owns cleanup even if a child fails.
  const sandbox=tempRoot('installer', 'council-sandbox-');
  const tempBase=sandbox.root;
  const diagnostics=tempRoot('brief16', 'council-diagnostics-');
  const {names}=await import('./fixtures.mjs');let passed=0,failed=0;
  const invalid=spawnSync(process.execPath,[self,'--child','empty'],{env:{...process.env,COUNCIL_TEST_ROOT:''},encoding:'utf8',windowsHide:true});
  if(invalid.status===2 && invalid.stderr.includes('REFUSED: installer child is not sandboxed')){passed++;process.stdout.write('PASS sandbox pre-flight refusal\n');}else{failed++;process.stdout.write('FAIL sandbox pre-flight refusal\n');}
  const cases=process.argv.includes('--exercise-failure-cleanup')?[['cleanup-failure','win32']]:process.argv.includes('--report')?[['obsidian-like','win32']]:[...names.map(n=>[n,'win32']),['behavior','win32'],['survey','win32'],['duplicate-caps','win32'],['platform','linux'],['platform','darwin']];
  if(process.argv.includes('--apply-only')||process.argv.includes('--verbs-only')||process.argv.includes('--verbs2-only'))cases.splice(0,cases.length);
  if(!process.argv.includes('--exercise-failure-cleanup'))cases.push(['apply','win32']);
  for(const [name,platform] of cases) {
    const root=fs.mkdtempSync(path.join(tempBase,'installer-'));
    let success=false;
    try {
    const env={...process.env,COUNCIL_TEST_DIAGNOSTICS:diagnostics.root,COUNCIL_TEST_TEMP_BASE:tempBase,COUNCIL_TEST_ROOT:root,COUNCIL_PLATFORM:platform,PATH:fakebin,OneDrive:'',OneDriveConsumer:'',OneDriveCommercial:'',COUNCIL_GEMINI_API_KEY:''};
    if(process.argv.includes('--report'))env.COUNCIL_PRINT_REPORT='1';
    for(const key of envKeys)env[key]=['TEMP','TMP','TMPDIR'].includes(key)?root:path.join(root,key.toLowerCase());
    for(const key of envKeys)fs.mkdirSync(env[key],{recursive:true});
    if(platform==='win32')for(const folder of ['Local','Roaming'])fs.mkdirSync(path.join(env.USERPROFILE,'AppData',folder),{recursive:true});
    // Remove inherited differently-cased PATH entries on Windows.
    for(const key of Object.keys(env))if(key.toUpperCase()==='PATH'&&key!=='PATH')delete env[key];
    const r=spawnSync(process.execPath,[self,'--child',name,...(process.argv.includes('--verbs-only')?['--verbs-only']:[]),...(process.argv.includes('--verbs2-only')?['--verbs2-only']:[])],{env,encoding:'utf8',windowsHide:true,timeout:900000,maxBuffer:16*1024**2, ...(name==='apply'?{stdio:'inherit'}:{})});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');success=r.status===0;if(success)passed++;else failed++;}
    finally {if(!inside(root,tempBase))throw new Error('unsafe cleanup');if(success)fs.rmSync(root,{recursive:true,force:true});else process.stdout.write('Failed installer case: '+root+'\n');}
  }
  const statusFile=path.join(diagnostics.root,'brief16-status.txt');
  fs.writeFileSync(statusFile,`installer suite: ${passed} passed, ${failed} failed\nexit code: ${failed?1:0}\n`);
  process.stdout.write('Status evidence: '+statusFile+'\n');
  diagnostics.finish(false);
  sandbox.finish(failed===0);
  process.stdout.write(`installer suite: ${passed} passed, ${failed} failed\n`);process.exitCode=failed?1:0;
}
