// CI runs the existing T-24 and T-27 bodies without the smoke process bootstrap.
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {registerNewTests} from './new-tests.mjs';
import {tempRoot} from '../temp-root.mjs';
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const suite = tempRoot('static-lint', 'council-static-lint-');
const selected = [];
registerNewTests((id,name,fn)=>{if (['T-24','T-27'].includes(id)) selected.push({id,name,fn});},
  {ROOT, HERE:path.join(ROOT,'src'), TMP:suite.root});
let failed = 0;
try {
  assert.equal(selected.length, 2);
  for (const {id,name,fn} of selected) {
    try {
      await fn({ok:(v,m)=>assert.ok(v,m), eq:(a,b,m)=>assert.equal(a,b,m), note:m=>console.log(m)});
      console.log('PASS ' + id + ' ' + name);
    } catch (e) { failed++; console.error('FAIL ' + id + ' ' + e.stack); }
  }
} catch (e) { failed++; console.error(e.stack); }
suite.finish(failed===0);
process.exitCode = failed ? 1 : 0;
