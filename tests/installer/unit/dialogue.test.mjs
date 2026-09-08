// Owns dialogue boundary tests; specification §§7.3,12.2.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { questions, sanitize, loadAnswers, fail, errorObject, ERROR_CATALOGUE } from '../../../installer/lib/dialogue.mjs';
export default async function(test) {
  await test('marker injection and Unicode bounds',async()=>{
    const value=sanitize('A\r\n<!--\u2028B\u0000'+ '😀'.repeat(100));
    assert.equal(/[\r\n\u2028\u0000]|<!--/.test(value),false);assert.equal([...value].length,80);assert.equal(value.endsWith('\ud83d'),false);
  });
  await test('all defaults work without a terminal',async root=>{
    const a=await questions({json:true},{home:root,cloud:true,fresh:true});
    assert.equal(a.vault,path.join(root,'Notes'));assert.equal(a['relocate-runtime'],true);assert.equal(a.conventions,true);assert.equal(a.hosts,'all');assert.equal(a.merge,'block');assert.equal(a.duplicates,false);
  });
  await test('ask has an unattended default, including per-file answers',async root=>{
    assert.equal((await questions({json:true,merge:'ask'},{home:root})).merge,'block');
    assert.deepEqual((await questions({json:true,merge:{'AGENTS.md':'ask','CLAUDE.md':'none'}},{home:root})).merge,{'AGENTS.md':'block','CLAUDE.md':'none'});
  });
  await test('answers cannot smuggle a key or unknown option',async root=>{
    const file=path.join(root,'answers.json');fs.writeFileSync(file,JSON.stringify({api_key:'do not retain'}));assert.throws(()=>loadAnswers(file),e=>e.exitCode===2);
    fs.writeFileSync(file,'[]');assert.throws(()=>loadAnswers(file),e=>e.exitCode===2);
  });
  await test('catalogue has a fix and hides stacks unless verbose',async()=>{
    for(const code of Object.keys(ERROR_CATALOGUE)){const e=fail(code);assert.ok(e.what&&e.why&&e.fix);assert.equal(errorObject(e).stack,undefined);assert.ok(errorObject(e,true).stack);assert.ok(e.exitCode>=1&&e.exitCode<=7);}
  });
}
