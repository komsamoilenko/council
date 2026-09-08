import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { probeVault } from '../../../installer/lib/preflight.mjs';

export default async function(test) {
  await test('absent ancestors recorded at creation and removed in reverse', async root => {
    const vault = path.join(root, 'absent', 'vault'), council = path.join(vault, '.council');
    const r = await probeVault(vault);
    assert.deepEqual(r.created, [path.join(root, 'absent'), vault, council]);
    assert.deepEqual(r.removed, [path.join(council, '.write-probe'), council, vault, path.join(root, 'absent')]);
    assert.deepEqual(fs.readdirSync(root), []);
  });
  await test('probe failure leaves no directories, lock, journal or backup', async root => {
    const vault = path.join(root, 'vault');
    await assert.rejects(probeVault(vault, { io: { ...fs, fsyncSync() { throw new Error('denied'); } } }), e => e.exitCode === 2 && e.code === 'E-VAULT-UNWRITABLE');
    assert.deepEqual(fs.readdirSync(root), []);
  });
  await test('pre-existing probe and directories never removed', async root => {
    const council = path.join(root, '.council'); fs.mkdirSync(council);
    const probe = path.join(council, '.write-probe'); fs.writeFileSync(probe, 'user');
    await assert.rejects(probeVault(root), e => e.record.created.length === 0);
    assert.equal(fs.readFileSync(probe, 'utf8'), 'user');
  });
  await test('nonempty created directory retained and reported', async root => {
    const vault = path.join(root, 'vault'), council = path.join(vault, '.council');
    await assert.rejects(probeVault(vault, { io: { ...fs, fsyncSync(fd) { fs.fsyncSync(fd); fs.writeFileSync(path.join(council, 'user'), 'keep'); } } }), e => {
      assert.deepEqual(e.record.warnings.map(w => w.path), [council, vault]); return e.exitCode === 2;
    });
    assert.equal(fs.readFileSync(path.join(council, 'user'), 'utf8'), 'keep');
  });
}
