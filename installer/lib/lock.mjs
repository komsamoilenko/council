// Owns installer lock arbitration using platform liveness; specification §7.4 S1/S10.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import platform from '../../src/platform/index.js';
import { safewrite } from './safewrite.mjs';

export const STALE_MS = 30 * 60 * 1000;
const refused = reason => ({ ok: false, code: 'E_SETUP_LOCKED', exitCode: 5, reason });
// The short-lived directory serializes stale reclamation and release as well as creation.
// A crash inside arbitration leaves a visible busy guard; never guess its ownership.
async function arbitrate(file, action) {
  const guard = file + '.council-tmp-claim';
  try { fs.mkdirSync(guard); } catch (e) { if (e.code === 'EEXIST') return refused('lock_arbitration_busy'); throw e; }
  try { return await action(); } finally { fs.rmdirSync(guard); }
}
export async function acquireLock(etc, { now = Date.now, pid = process.pid, platform: host = platform, ctx } = {}) {
  const file = path.join(etc, 'setup.lock');
  return arbitrate(file, async () => {
    let previous = null;
    try {
      if (fs.lstatSync(file).isSymbolicLink()) return refused('lock_reparse_target');
      previous = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) { if (e.code !== 'ENOENT') return refused('invalid_lock'); }
    let reclaimed = false;
    if (previous) {
      if (!Number.isInteger(previous.pid) || previous.pid <= 0 || !Number.isFinite(previous.createdMs)) return refused('invalid_lock');
      let live = 'unknown';
      try { live = await host.livenessOf(ctx || { paths: { binaries: host.systemBinaries() } }, previous.pid); } catch {}
      if (live === 'alive') return refused('lock_live');
      if (live !== 'gone') return refused('lock_liveness_unknown');
      if (now() - previous.createdMs < STALE_MS) return refused('lock_not_stale');
      reclaimed = true;
    }
    const owner = { pid, createdMs: now(), token: randomUUID() };
    await safewrite(file, JSON.stringify(owner) + '\n', { exclusive: !previous });
    return { ok: true, file, owner, reclaimed };
  });
}
export async function releaseLock(lock) {
  if (!lock?.ok) throw new Error('lock_not_owned');
  return arbitrate(lock.file, async () => {
    let current;
    try { current = JSON.parse(fs.readFileSync(lock.file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return { ok: false, reason: 'lock_missing' }; throw e; }
    if (current.token !== lock.owner.token) return { ok: false, reason: 'lock_owner_changed' };
    // Explicitly required by S10, despite omission from §7.1's deletion carve-outs.
    fs.unlinkSync(lock.file);
    return { ok: true };
  });
}
