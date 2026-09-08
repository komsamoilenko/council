// Owns the isolated foundation unit suite; specification §§16.4,16.6.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let passed = 0, failed = 0;
for (const name of ['safewrite','appdirs','markers','tomlblock','manifest','journal','lock','backup','cloudsync','dialogue','report']) {
  let count = 0, failures = 0;
  const test = async (label, run) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'council-unit-'));
    try { await run(root); count++; passed++; }
    catch (error) { failures++; failed++; process.stdout.write('FAIL ' + name + ': ' + label + ' — ' + error.stack + '\n'); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  };
  try { await (await import('./' + name + '.test.mjs')).default(test); }
  catch (error) { failures++; failed++; process.stdout.write('FAIL ' + name + ': ' + error.stack + '\n'); }
  process.stdout.write((failures ? 'FAIL' : 'PASS') + ' ' + name + ' (' + count + ' passed, ' + failures + ' failed)\n');
}
process.stdout.write('unit suite: ' + passed + ' passed, ' + failed + ' failed\n');
process.exitCode = failed ? 1 : 0;
