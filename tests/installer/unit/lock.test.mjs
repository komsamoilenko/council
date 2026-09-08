import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { acquireLock, releaseLock, forceUnlock, STALE_MS } from '../../../installer/lib/lock.mjs';
import { safewrite } from '../../../installer/lib/safewrite.mjs';
const host = live => ({systemBinaries:() => ({}),livenessOf:async () => live});

export default async function(test) {
  await test('real exclusive acquisition and release', async root => {
    const lock=await acquireLock(root); assert.equal(lock.ok,true);
    const stored=JSON.parse(fs.readFileSync(lock.file,'utf8')); assert.equal(stored.pid,process.pid); assert.equal(typeof stored.createdMs,'number');
    assert.equal((await acquireLock(root,{platform:host('alive')})).reason,'lock_live');
    assert.equal((await releaseLock(lock)).ok,true); assert.deepEqual(fs.readdirSync(root),[]);
  });
  for (const guard of [false, true]) await test('confirmed-dead young ' + (guard ? 'arbitration guard' : 'setup.lock') + ' reclaimed', async root => {
    for (const force of [false, true]) {
      const etc = path.join(root, force ? 'force' : 'acquire'); fs.mkdirSync(etc);
      const file = path.join(etc, 'setup.lock');
      const owner = {pid:42, createdMs:1000, token:'dead'};
      if (guard) { fs.mkdirSync(file + '.council-tmp-claim'); fs.writeFileSync(path.join(file + '.council-tmp-claim', 'dead.json'), JSON.stringify(owner)); }
      else await safewrite(file, JSON.stringify(owner));
      const options = {now:()=>2000, platform:host('gone')};
      if (force) assert.equal((await forceUnlock(etc, options)).ok, true);
      else {
        const lock = await acquireLock(etc, options);
        assert.equal(lock.ok, true); assert.notEqual(lock.owner.token, owner.token);
        assert.equal((await releaseLock(lock)).ok, true);
      }
      assert.deepEqual(fs.readdirSync(etc), []);
    }
  });
  await test('dead stale lock reclaimed with new owner', async root => {
    const file=path.join(root,'setup.lock'); await safewrite(file,JSON.stringify({pid:1,createdMs:1}));
    const lock=await acquireLock(root,{now:() => STALE_MS+1,platform:host('gone')}); assert.equal(lock.reclaimed,true);
    assert.equal((await releaseLock(lock)).ok,true);
  });
  for (const [live,age,reason] of [['alive',STALE_MS+1,'lock_live'],['unknown',STALE_MS+1,'lock_liveness_unknown'],['unknown',STALE_MS-1,'lock_not_stale']]) {
    await test('refuses '+reason, async root => {
      const file=path.join(root,'setup.lock'), bytes=JSON.stringify({pid:1,createdMs:1}); await safewrite(file,bytes);
      assert.equal((await acquireLock(root,{now:() => age+1,platform:host(live)})).reason,reason);
      assert.equal(fs.readFileSync(file,'utf8'),bytes);
    });
  }
  await test('simultaneous contenders produce one owner', async root => {
    const results=await Promise.all(Array.from({length:8},() => acquireLock(root,{platform:host('alive')})));
    assert.equal(results.filter(r => r.ok).length,1); await releaseLock(results.find(r=>r.ok));
  });
  await test('changed owner, malformed lock and abandoned arbitration', async root => {
    const lock=await acquireLock(root); await safewrite(lock.file,JSON.stringify({...lock.owner,token:'another'}));
    assert.equal((await releaseLock(lock)).reason,'lock_owner_changed');
    await safewrite(lock.file,'{bad'); assert.equal((await acquireLock(root)).reason,'invalid_lock');
    fs.mkdirSync(lock.file+'.council-tmp-claim'); assert.equal((await acquireLock(root)).reason,'lock_arbitration_busy');
  });
  await test('context forwarded and probe failure remains unknown', async root => {
    await safewrite(path.join(root,'setup.lock'),JSON.stringify({pid:42,createdMs:1})); const ctx={sentinel:true};
    const fake={livenessOf:async (given,pid) => { assert.equal(given,ctx); assert.equal(pid,42); throw new Error('probe_failure'); }};
    assert.equal((await acquireLock(root,{ctx,platform:fake,now:()=>STALE_MS+1})).reason,'lock_liveness_unknown');
  });
}
