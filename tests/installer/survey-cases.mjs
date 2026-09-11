// Runs only inside run.mjs's preflighted sandbox.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {context,inspectVault,linked,survey} from '../../installer/lib/survey.mjs';
import {attributeBatch} from '../../installer/lib/attribute-batch.mjs';
import {scanDuplicates} from '../../installer/lib/duplicates.mjs';
import {put} from './fixtures.mjs';

export async function surveyCases(root,ctx,invoke) {
  let checks=0;
  const check=async(label,fn)=>{await fn();checks++;process.stdout.write('PASS survey '+label+'\n');};
  const vault=path.join(root,'survey-vault');
  for(const dir of ['.git/objects/ab','node_modules/pkg','work/jobs/date/job','ledger'])
    for(let i=0;i<300;i++)put(path.join(vault,dir,String(i)),'fixture');
  for(let i=0;i<5;i++)put(path.join(vault,'notes',String(i)+'.md'),'note');
  await check('Codex exec flags accepted; missing --ignore-rules refuses',async()=>{
    const good=await survey({vault},ctx),codex=good.blocks.find(b=>b.name==='clis').clis.codex;
    assert.equal(codex.usable,true);
    assert.deepEqual(codex.exec_flags,{ignoreUserConfig:true,ignoreRules:true,skipGitRepoCheck:true});
    const negative=context({...ctx,probe:(file,args,opts)=>args.at(-2)==='exec'&&args.at(-1)==='--help'?{status:0,stdout:'--ignore-user-config --skip-git-repo-check'}:ctx.probe(file,args,opts)});
    const bad=await survey({vault},negative),cli=bad.blocks.find(b=>b.name==='clis').clis.codex;
    assert.equal(cli.usable,false);assert.equal(cli.exec_flags.ignoreRules,false);
    assert.ok(bad.warnings.some(w=>w.includes('--ignore-rules')));
    assert.ok(bad.warnings.some(w=>w.includes('Codex version floor UNVERIFIED')));
  });
  await check('excluded counts, zero walk probes, junction never entered',async()=>{
    const outside=path.join(root,'outside-survey');put(path.join(outside,'canary'),'outside');
    try {fs.symlinkSync(outside,path.join(vault,'junction'),process.platform==='win32'?'junction':'dir');}
    catch(e){process.stdout.write('SKIP survey junction: '+e.code+'\n');}
    let probes=0;const scope=context({...ctx,attributes:async p=>{probes++;assert.equal(p.startsWith(vault+path.sep),false,'walk attribute probe');return null;}});
    const r=await inspectVault(vault,scope);assert.equal(r.fileCount,5);
    assert.deepEqual(r.excluded,{'.git':300,'ledger':300,'node_modules':300,'work/jobs':300});
    // cloud(root) is permitted; descendants never invoke the attribute seam.
    const before=probes;assert.ok(before<=1);
    const out=await invoke(['detect','--vault',vault,'--json']);assert.equal(out.code,0,out.out+out.err);
    assert.deepEqual(JSON.parse(out.out).blocks.find(b=>b.name==='vault').vault.excluded,r.excluded);
    const human=await invoke(['detect','--vault',vault]);assert.match(human.out,/vault_file_count_excludes/);
    process.stdout.write('SURVEY walk probes 0\n');
  });
  await check('linked memoises attributes but rechecks lstat; context resets cache',async()=>{
    const file=path.join(vault,'notes','0.md');let calls=0;
    const scope=context({...ctx,attributes:async()=>{calls++;return null;}});
    assert.equal(await linked(file,scope),false);const first=calls;
    assert.equal(await linked(file,scope),false);assert.equal(calls,first);
    assert.equal(await linked(file,context({...scope})),false);assert.equal(calls,2*first);
  });
  await check('3000 directories and 6000 files within 5000 ms',async()=>{
    const big=path.join(root,'survey-big');
    for(let i=0;i<3000;i++)for(let j=0;j<2;j++)put(path.join(big,String(i),String(j)),'');
    const started=performance.now();const info=await inspectVault(big,context({...ctx}));
    const elapsed=Math.round(performance.now()-started);
    assert.equal(info.fileCount,6000);assert.ok(elapsed<5000,'vault block '+elapsed+' ms');
    process.stdout.write('SURVEY large fixture '+elapsed+' ms\n');
  });
  await check('EPERM and EACCES warn once; detect, plan, apply dry-run and duplicates continue',async()=>{
    const optional=path.join(vault,'protected');put(path.join(optional,'secret'),'fixture');
    for(const code of ['EPERM','EACCES']) {
      const io={...fs,readdirSync(p,...args){if(path.resolve(p)===optional)throw Object.assign(new Error(code),{code,path:p});return fs.readdirSync(p,...args);}};
      const extra={io};
      const d=await invoke(['detect','--vault',vault,'--json'],extra);assert.equal(d.code,0,d.out+d.err);
      assert.equal(JSON.parse(d.out).warnings.filter(w=>w==='vault_subtree_unreadable:protected').length,1);
      const p=await invoke(['plan','--vault',vault,'--hosts','none','--json'],extra);assert.equal(p.code,0,p.out+p.err);
      const plan=JSON.parse(p.out);assert.ok(plan.warnings.includes('vault_subtree_unreadable:protected'));
      assert.ok(plan.steps.flatMap(s=>s.writes).every(w=>!w.path.startsWith(optional)));
      const a=await invoke(['apply','--plan',plan.file,'--dry-run','--json'],extra);assert.equal(a.code,0,a.out+a.err);assert.equal(a.out.includes(optional),false);
      const duplicates=await scanDuplicates(vault,context({...ctx,io}));assert.deepEqual(duplicates.warnings,['vault_subtree_unreadable:protected']);
    }
  });
  await check('required directories and rules refuse unreadable access with exit 4',async()=>{
    for(const rel of ['','work','work/jobs','ledger','.council','AGENTS.md']) {
      const target=path.resolve(vault,rel);if(rel==='AGENTS.md')put(target,'rules');else fs.mkdirSync(target,{recursive:true});
      const io={...fs,readdirSync(p,...args){if(path.resolve(p)===target)throw Object.assign(new Error('denied'),{code:'EPERM',path:p});return fs.readdirSync(p,...args);},readFileSync(p,...args){if(path.resolve(p)===target)throw Object.assign(new Error('denied'),{code:'EACCES',path:p});return fs.readFileSync(p,...args);}};
      for(const verb of ['detect','plan']){const r=await invoke([verb,'--vault',vault,'--json'],{io});assert.equal(r.code,4,r.out+r.err);assert.match(r.out,/vault_subtree_unreadable/);}
    }
  });
  await check('attribute batches use <=200 literal paths and reject malformed payloads',async()=>{
    const files=Array.from({length:401},(_,i)=>path.join(vault,"quote'"+i));const sizes=[];
    const scope=context({...ctx,probe:(file,args,opts)=>{
      if (!args.at(-1).includes('ConvertTo-Json -Compress')) return ctx.probe(file,args,opts);
      assert.equal(opts.shell,false);assert.match(args.at(-1),/Get-Item -LiteralPath/);assert.match(args.at(-1),/quote''/);
      const n=[...args.at(-1).split('@(@(')[1].split(') | ForEach-Object')[0].matchAll(/'((?:[^']|'')*)'/g)].length;sizes.push(n);
      return {status:0,stdout:JSON.stringify(Array(n).fill(0))};
    }});
    assert.equal((await attributeBatch(files,scope)).size,401);assert.deepEqual(sizes,[200,200,1]);
    const duplicateVault=path.join(root,"batch'vault");
    for(let i=0;i<401;i++)put(path.join(duplicateVault,"quote'"+i),'identical');
    sizes.length=0;
    scope.attributes=async()=>{throw new Error('per-file attribute probe');};
    const report=await scanDuplicates(duplicateVault,scope);
    assert.equal(report.groups.length,1);assert.equal(report.groups[0].paths.length,401);
    assert.deepEqual(sizes,[200,200,1,200,200,1]);
    for(const stdout of ['[]','[null]','0'])await assert.rejects(attributeBatch([files[0]],context({...ctx,probe:()=>({status:0,stdout})})),/attribute_probe_payload/);
    await assert.rejects(attributeBatch([files[0]],context({...ctx,probe:()=>({status:1,stdout:''})})),/attribute_probe_failed/);
  });
  return checks;
}
