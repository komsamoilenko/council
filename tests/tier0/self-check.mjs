// Exercise the real driver's completion path in an isolated retention namespace.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';

export function registerHarnessChecks(test,{ROOT,HERE,TMP}) {
  if(process.argv.includes('--harness-probe')) {
    test('H-PROBE','intentional harness completion probe',async t=>{
      t.ok(fs.existsSync(TMP),'profile exists during run');
      t.ok(!process.argv.includes('--harness-probe-fail'),'intentional failure');
    },{requires:[]});
    return;
  }
  test('H-01','passing Tier-0 roots removed; failures recorded once per owner/suite',async t=>{
    const owner=crypto.createHash('sha256').update(new URL('../temp-root.mjs',import.meta.url).href).digest('hex').slice(0,16);
    for(const mode of ['direct','S7','verify']) {
      const base=fs.mkdtempSync(path.join(TMP,'retention-'));
      const env={...process.env,TEMP:base,TMP:base,TMPDIR:base};
      const extra=mode==='direct'?[]:mode==='S7'?['--app',HERE]:['--app',HERE,'--verify-profile'];
      let previous;
      for(const fail of [false,true,true]) {
        const r=spawnSync(process.execPath,[path.join(ROOT,'tests','tier0','smoke.mjs'),'--only','H-PROBE','--harness-probe',...extra,...(fail?['--harness-probe-fail']:[])],
          {cwd:base,env,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:4*1024*1024});
        t.eq(r.status,fail?1:0,mode+' probe exit: '+(r.error?.message||''));
        const roots=fs.readdirSync(base).filter(n=>n.startsWith('council-smoke-'));
        if(!fail)t.eq(roots.length,0,mode+' passing smoke root no longer exists');
        else {
          const records=fs.readdirSync(base).filter(n=>n===`council-retained-${owner}-tier0.json`);
          t.eq(records.length,1,mode+' exactly one (owner,tier0) record');
          t.eq(roots.length,1,mode+' exactly one retained failed root');
          if(records.length){const record=JSON.parse(fs.readFileSync(path.join(base,records[0]),'utf8'));
            t.eq(record.owner,owner,'record owner');t.eq(record.suite,'tier0','record suite');
            t.ok(fs.existsSync(record.root),'recorded failed root exists');
            if(previous)t.ok(!fs.existsSync(previous),'prior failed root replaced');previous=record.root;
          }
        }
      }
      t.note('H-01 '+mode+': passing run and two consecutive failing runs checked');
    }
  },{requires:[]});
}
