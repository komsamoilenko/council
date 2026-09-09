// Local trust gate. --lint-only is the hosted-CI T-00 entry point (§16.6).
import {fixture} from './fixture.mjs';
import tests from './trust.test.mjs';
import lint from './portability.test.mjs';
let passed=0,failed=0,skipped=0;
const test=async (id,label,run,skip) => {
  if(skip){skipped++;console.log('SKIP '+id+' '+label+' — '+skip);return;}
  const f=fixture();
  let success=false;
  try {await run(f); if(f.networks)throw new Error('network attempts: '+f.networks); passed++;success=true;console.log('PASS '+id+' '+label);}
  catch(e){failed++;console.log('FAIL '+id+' '+label+' — '+e.message);}
  finally{f.close(success);}
};
if(!process.argv.includes('--lint-only'))await tests(test);
await test('T-00','portability, templates, host registrations, platform exports',lint);
console.log('trust suite: '+(passed+failed)+' ran, '+passed+' passed, '+failed+' failed, '+skipped+' skipped');
process.exitCode=failed?1:0;
