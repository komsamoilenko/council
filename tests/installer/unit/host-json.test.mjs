import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spliceJsonEntry } from '../../../installer/lib/host-json.mjs';
import { safewrite, writeHostSplice, writeSplice, assertOutside } from '../../../installer/lib/safewrite.mjs';

export default async function(test) {
  for (const text of ['', '{}', '{ "preferences" : {"label":"é"} }', '{"mcpServers":{ "other" : {"args":["a"]} }, "live": 1}', '\ufeff{\r\n "mcpServers": {"council":{"command":"old"},"other":{}}\r\n}\r\n']) {
    await test('JSON splice preserves all bytes outside its member', async () => {
      const before = Buffer.from(text), r = spliceJsonEntry(before, 'council', { command: 'new' });
      assertOutside(before, r.bytes, r.oldRange, r.newRange);
      assert.equal(JSON.parse(r.bytes.toString().replace(/^\ufeff/, '')).mcpServers.council.command, 'new');
      const restored = spliceJsonEntry(r.bytes, 'council', r.previous);
      assertOutside(r.bytes, restored.bytes, restored.oldRange, restored.newRange);
      assert.deepEqual(JSON.parse(restored.bytes.toString().replace(/^\ufeff/, '')).mcpServers.council, r.previous ?? undefined);
    });
  }
  await test('host assertion recovery preserves intervening live state', async root => {
    const file = path.join(root, '.claude.json'), backup = path.join(root, 'backup');
    const before = Buffer.from('{"mcpServers":{"other":{},"council":{"command":"old"}},"live":1}');
    await safewrite(file, before); await safewrite(backup, before);
    const r = spliceJsonEntry(before, 'council', {command:'new'});
    await assert.rejects(writeHostSplice(file, before, r, { dryRun:false, backup,
      writer: (p, bytes) => safewrite(p, bytes.toString().replace('"live":1', '"live":2')),
      recover: current => spliceJsonEntry(current, 'council', r.previous) }), {code:'E_OUTSIDE_RANGE'});
    assert.equal(fs.readFileSync(file, 'utf8'), before.toString().replace('"live":1', '"live":2'));
    assert.deepEqual(fs.readFileSync(backup), before);
    await assert.rejects(writeSplice(file, before, r, {dryRun:false,backup}), /host_requires_surgical_writer/);
  });
}
