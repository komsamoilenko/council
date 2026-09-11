// Owns the isolated foundation unit suite; specification §§16.4,16.6.
import fs from 'node:fs';
import {tempRoot} from '../../temp-root.mjs';
const suite = tempRoot('unit', 'council-unit-');
import path from 'node:path';

let passed = 0, failed = 0;
for (const name of ['audit','safewrite','preflight','host-json','appdirs','markers','tomlblock','manifest','journal','lock','backup','cloudsync','dialogue','report','machine']) {
  let count = 0, failures = 0;
  const test = async (label, run) => {
    const root = fs.mkdtempSync(path.join(suite.root, 'case-'));
    let success=false;
    try { await run(root); count++; passed++; success=true; }
    catch (error) { failures++; failed++; process.stdout.write('FAIL ' + name + ': ' + label + ' — ' + error.stack + '\n'); }
    finally { if(success) fs.rmSync(root, { recursive: true, force: true }); else console.log('Failed unit case: '+root); }
  };
  try { await (await import('./' + name + '.test.mjs')).default(test); }
  catch (error) { failures++; failed++; process.stdout.write('FAIL ' + name + ': ' + error.stack + '\n'); }
  process.stdout.write((failures ? 'FAIL' : 'PASS') + ' ' + name + ' (' + count + ' passed, ' + failures + ' failed)\n');
}
process.stdout.write('unit suite: ' + passed + ' passed, ' + failed + ' failed\n');
suite.finish(failed===0);
process.exitCode = failed ? 1 : 0;
