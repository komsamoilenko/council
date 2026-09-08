import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { safewrite } from '../../../installer/lib/safewrite.mjs';

export default async function(test) {
  await test('real replacement and exclusive publication', async root => {
    const file = path.join(root,'data');
    await safewrite(file, 'first'); await safewrite(file, 'second');
    assert.equal(fs.readFileSync(file,'utf8'), 'second');
    await assert.rejects(safewrite(file, 'third', { exclusive: true }), { code: 'EEXIST' });
    assert.equal(fs.readFileSync(file,'utf8'), 'second');
    assert.deepEqual(fs.readdirSync(root), ['data']);
  });
  await test('fsync precedes rename; five retries', async root => {
    const events = [], sleeps = []; let attempts = 0;
    const io = { ...fs, fsyncSync(fd) { events.push('sync'); fs.fsyncSync(fd); }, renameSync(a,b) {
      events.push('rename'); if (attempts++ < 5) throw Object.assign(new Error(), { code: attempts % 2 ? 'EBUSY' : 'EPERM' }); fs.renameSync(a,b);
    } };
    await safewrite(path.join(root,'data'), 'x', { io, sleep: async ms => sleeps.push(ms) });
    assert.equal(events[0], 'sync'); assert.equal(attempts, 6); assert.deepEqual(sleeps, [200,200,200,200,200]);
  });
  await test('retry exhaustion preserves target and cleans temp', async root => {
    const file = path.join(root,'data'); await safewrite(file,'original'); let calls = 0;
    await assert.rejects(safewrite(file,'new', { io: { ...fs, renameSync() { calls++; throw Object.assign(new Error(),{code:'EBUSY'}); } }, sleep: async () => {} }), { code:'EBUSY' });
    assert.equal(calls,6); assert.equal(fs.readFileSync(file,'utf8'),'original'); assert.deepEqual(fs.readdirSync(root),['data']);
  });
  await test('short writes complete; other errors do not retry', async root => {
    const file = path.join(root,'data');
    await safewrite(file,'abcdef', { io: { ...fs, writeSync: (fd,b,o,n) => fs.writeSync(fd,b,o,Math.min(n,2)) } });
    assert.equal(fs.readFileSync(file,'utf8'),'abcdef');
    await assert.rejects(safewrite(file,'x', { io: { ...fs, fsyncSync() { throw new Error('sync_failure'); } }, sleep: () => assert.fail('unexpected_retry') }), /sync_failure/);
    assert.deepEqual(fs.readdirSync(root),['data']);
  });
  await test('exclusive contenders preserve a single winner', async root => {
    const file=path.join(root,'data');
    const results=await Promise.allSettled(['one','two','three'].map(s => safewrite(file,s,{exclusive:true})));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(results.filter(r=>r.status==='rejected' && r.reason.code==='EEXIST').length,2);
    assert.deepEqual(fs.readdirSync(root),['data']);
  });
}
