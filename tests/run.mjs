// Local release gate; hosted CI must use the pure unit entry point instead (§16.6).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
let failed = 0;
for (const suite of ['tier0/smoke.mjs', 'installer/unit/run.mjs', 'installer/run.mjs']) {
  console.log('RUN node tests/' + suite);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(suite, import.meta.url))], {stdio:'inherit', windowsHide:true});
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) failed++;
}
console.log('gate: ' + (failed ? 'FAIL (' + failed + ' suites failed)' : 'PASS (3 suites)'));
process.exitCode = failed ? 1 : 0;
