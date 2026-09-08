import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalBlock, mergeMarkers, mergeMarkerFile, scanMarkers, hashBody } from '../../../installer/lib/markers.mjs';
import { safewrite } from '../../../installer/lib/safewrite.mjs';
import { acquireLock, releaseLock, STALE_MS } from '../../../installer/lib/lock.mjs';

const host = live => ({ systemBinaries: () => ({}), livenessOf: async () => live });
export default async function(test) {
  await test('1 real marked template and malformed proposal', async () => {
    const template = fs.readFileSync(new URL('../../../installer/templates/' + 'vault/AGENTS.block.md.tmpl', import.meta.url));
    const result = mergeMarkers(Buffer.from('# Notes\n'), template);
    assert.equal(result.ok, true);
    assert.equal(hashBody(scanMarkers(result.bytes).block.body), hashBody(scanMarkers(template).block.body));
    const bad = mergeMarkers(Buffer.alloc(0), '<!-- council:begin v=1 -->\nbroken');
    assert.equal(bad.ok, false); assert.equal(bad.exitCode, 4);
  });
  await test('2 refused gitignore retains full proposal', async root => {
    const file = path.join(root, '.gitignore');
    fs.writeFileSync(file, '# council:begin v=1\ncache/\n# council:end\n# council:begin v=1\ncache/\n# council:end\n');
    const result = await mergeMarkerFile(file, 'cache/\n', { dryRun: false, platform: { implemented: {} } });
    assert.equal(result.ok, false); assert.match(fs.readFileSync(result.sibling, 'utf8'), /cache\//);
  });
  await test('3 unclosed fence before and after block refuses', async () => {
    const block = canonicalBlock('old').toString();
    for (const input of ['```\nexample\n' + block, block + '\n```\nexample']) {
      const result = mergeMarkers(Buffer.from(input), 'new', { allowRewrite: true });
      assert.equal(result.ok, false); assert.equal(result.code, 'E_MARKER_FENCE_UNTERMINATED');
    }
  });
  await test('4 stale arbitration recovery and force unknown escape', async root => {
    const file = path.join(root, 'setup.lock'), guard = file + '.council-tmp-claim';
    fs.mkdirSync(guard);
    fs.writeFileSync(path.join(guard, 'dead.json'), JSON.stringify({ pid: 42, createdMs: 1, token: 'dead' }));
    const options = { now: () => STALE_MS + 2, platform: host('gone') };
    assert.equal((await acquireLock(root, options)).ok, true);
    fs.writeFileSync(file, JSON.stringify({ pid: 42, createdMs: 1 }));
    const unknown = await acquireLock(root, { ...options, platform: host('unknown') });
    assert.equal(unknown.path, file); assert.equal(unknown.escape, '--force-unlock');
    assert.equal(unknown.owner.pid, 42);
    fs.mkdirSync(guard); fs.writeFileSync(path.join(guard, 'unknown.json'), JSON.stringify({ pid: 42, createdMs: 1, token: 'unknown' }));
    assert.equal((await acquireLock(root, { ...options, platform: host('unknown'), forceUnlock: true })).ok, true);
  });
  await test('5 cleanup failure cannot republish successful rename', async root => {
    let renames = 0, removals = 0;
    const file = path.join(root, 'data');
    const result = await safewrite(file, 'published', { exclusive: true, onWarning: () => {}, sleep: async () => {}, io: { ...fs,
      renameSync(a,b) { renames++; fs.renameSync(a,b); },
      rmdirSync(p) { removals++; if (removals === 1) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); fs.rmdirSync(p); }
    } });
    assert.equal(renames, 1); assert.equal(fs.readFileSync(file, 'utf8'), 'published');
    assert.equal(result.warnings.length, 1); assert.deepEqual(fs.readdirSync(root), ['data']);
  });
  await test('6 throwing close is attempted once and temp removed', async root => {
    let closes = 0;
    await assert.rejects(safewrite(path.join(root,'data'), 'x', { io: { ...fs, closeSync(fd) {
      closes++; if (closes === 1) fs.closeSync(fd); throw new Error('close_failure');
    } } }), /close_failure/);
    assert.equal(closes, 1); assert.deepEqual(fs.readdirSync(root), []);
  });
  await test('7 parent directory synced after rename', async root => {
    const events = [], directory = 987654;
    await safewrite(path.join(root,'journal.jsonl'), '{}\n', { platform: 'linux', io: { ...fs,
      openSync(p,...args) { if (p === root) { events.push('open-directory'); return directory; } return fs.openSync(p,...args); },
      fsyncSync(fd) { events.push(fd === directory ? 'sync-directory' : 'sync-file'); if (fd !== directory) fs.fsyncSync(fd); },
      closeSync(fd) { if (fd !== directory) fs.closeSync(fd); },
      renameSync(a,b) { events.push('rename'); fs.renameSync(a,b); }
    } });
    assert.deepEqual(events, ['sync-file','rename','open-directory','sync-directory']);
  });
  await test('8 existing POSIX mode preserved despite umask', async root => {
    const file = path.join(root, 'data'); fs.writeFileSync(file, 'old'); let opened, chmod;
    await safewrite(file, 'new', { platform: 'linux', io: { ...fs,
      statSync(p) { return p === file ? { mode: 0o100754 } : fs.statSync(p); },
      openSync(p,flags,mode) { if (p === root) return 987654; opened = mode; return fs.openSync(p,flags,mode); },
      fsyncSync(fd) { if (fd !== 987654) fs.fsyncSync(fd); },
      closeSync(fd) { if (fd !== 987654) fs.closeSync(fd); },
      fchmodSync(fd,mode) { chmod = mode; }
    } });
    assert.equal(chmod ?? opened, 0o754);
  });
  await test('arbitration force respects live and young owners; release recovers stale claim', async root => {
    const lock = await acquireLock(root), guard = lock.file + '.council-tmp-claim';
    fs.mkdirSync(guard);
    fs.writeFileSync(path.join(guard,'old.json'), JSON.stringify({pid:42,createdMs:1,token:'old'}));
    for (const [live,now,reason] of [['alive',STALE_MS+2,'lock_arbitration_live'],['unknown',2,'lock_arbitration_not_stale'],['unknown',STALE_MS+2,'lock_arbitration_' + 'liveness_unknown']]) {
      const result = await acquireLock(root,{platform:host(live),now:()=>now,forceUnlock:live==='alive' || now===2});
      assert.equal(result.reason,reason); assert.equal(result.path,guard);
    }
    assert.equal((await releaseLock(lock,{platform:host('gone'),now:()=>STALE_MS+2})).ok,true);
    assert.deepEqual(fs.readdirSync(root),[]);
  });
  await test('permanent guard cleanup failure reports completed write and exact recovery path', async root => {
    const file=path.join(root,'data'), warnings=[]; let renames=0;
    const result=await safewrite(file,'done',{exclusive:true,sleep:async()=>{},onWarning:w=>warnings.push(w),io:{...fs,
      renameSync(a,b){renames++;fs.renameSync(a,b);},
      rmdirSync(){throw Object.assign(new Error('busy'),{code:'EPERM'});}
    }});
    assert.equal(renames,1);assert.equal(result.bytes,4);assert.equal(warnings.length,6);
    assert.ok(warnings.every(w=>w.path===file+'.council-tmp-publish'));
  });
}
