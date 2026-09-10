// Compare source-only previous-build fixtures; never execute the old build.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {tempRoot} from '../../temp-root.mjs';
import {assertStoreShape} from '../../../installer/lib/store-shape.mjs';

const current=fileURLToPath(new URL('../../../src/',import.meta.url));
function previousBuild(root) {
  const previous=path.join(root,'previous');
  fs.mkdirSync(path.join(previous,'lib'),{recursive:true});
  for(const name of ['jobstore.js','ledger.js'])
    fs.copyFileSync(path.join(current,'lib',name),path.join(previous,'lib',name));
  return previous;
}
function changeToken(previous,name,declaration,from,to) {
  const file=path.join(previous,'lib',name),source=fs.readFileSync(file,'utf8');
  const match=source.match(declaration);
  assert.ok(match,'fixture declaration exists');
  assert.ok(match[0].includes(from),'fixture token exists');
  const changed=match[0].replace(from,to);
  assert.notEqual(changed,match[0]);
  fs.writeFileSync(file,source.slice(0,match.index)+changed+source.slice(match.index+match[0].length));
}
export default async function storeShapeTests(test) {
  await test('identical previous-build jobstore and ledger copies pass',root=>{
    assert.doesNotThrow(()=>assertStoreShape(previousBuild(root),current));
  });
  await test('changed createJobDir refuses naming jobs.createJobDir',root=>{
    const previous=previousBuild(root);
    changeToken(previous,'jobstore.js',/^function createJobDir\([^]*?^\}/m,'recursive: true','recursive: false');
    const refuses=detail=>assert.throws(()=>assertStoreShape(previous,current),error=>{
      assert.equal(error.code,'E-USAGE');
      assert.equal(error.exitCode,2);
      assert.equal(error.detail,detail);
      return true;
    });
    refuses('store shape differs: jobs.createJobDir');
    changeToken(previous,'ledger.js',/const row = \{[\s\S]*?\n  \};/,'v: 1','v: 2');
    refuses('store shape differs: jobs.createJobDir, ledger.row');
    fs.copyFileSync(path.join(current,'lib','jobstore.js'),path.join(previous,'lib','jobstore.js'));
    refuses('store shape differs: ledger.row');
  });
  await test('changed loadView alone passes',root=>{
    const previous=previousBuild(root);
    changeToken(previous,'jobstore.js',/^function loadView\([^]*?^\}/m,'return null','return undefined');
    assert.doesNotThrow(()=>assertStoreShape(previous,current));
  });
}

// Standalone entry point: the existing unit runner has a fixed module list.
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const suite=tempRoot('store-shape','council-store-shape-');
  let failed=0;
  await storeShapeTests(async(label,run)=>{
    const root=fs.mkdtempSync(path.join(suite.root,'case-'));
    try{await run(root);console.log('PASS '+label);}
    catch(error){failed++;console.error('FAIL '+label+'\n'+error.stack);}
  });
  suite.finish(failed===0);
  process.exitCode=failed?1:0;
}
