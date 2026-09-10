// Owns installer lock arbitration using platform liveness; specification §7.4 S1/S10.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import platform from '../../src/platform/index.js';
import { safewrite } from './safewrite.mjs';

export const STALE_MS = 30 * 60 * 1000;
const refused = (reason, file, owner, escape) => ({ ok: false, code: 'E-SETUP-LOCKED', exitCode: 5,
  reason, path: file, owner, ...(escape ? { escape: '--force-unlock' } : {}),
  message: reason + ': ' + file + '. Recovery path: ' + file });
const settings = options => ({ now: Date.now, pid: process.pid, platform, ...options });
async function reclaimable(owner, file, options, prefix = 'lock') {
  const { now, platform: host, ctx, forceUnlock } = options;
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0 || !Number.isFinite(owner.createdMs))
    return refused('invalid_lock', file, owner);
  let live = 'unknown';
  try { live = await host.livenessOf(ctx || { paths: { binaries: host.systemBinaries() } }, owner.pid); } catch {}
  if (live === 'alive') return refused(prefix + '_live', file, owner);
  if (live !== 'gone' && now() - owner.createdMs < STALE_MS) return refused(prefix + '_not_stale', file, owner);
  if (live !== 'gone' && !forceUnlock) return refused(prefix + '_liveness_unknown', file, owner, true);
  return null;
}
// Each directory has one uniquely named owner record. Reclaim removes that exact
// record before rmdir: a competing reclaimer cannot delete a successor's owner.
// Force recovery runs BEFORE claiming this guard, so it cannot be blocked by it.
async function arbitrate(file, action, options) {
  const guard = file + '.council-tmp-claim';
  for (let attempt = 0; ; attempt++) {
    try { fs.mkdirSync(guard); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (attempt || fs.lstatSync(guard).isSymbolicLink()) return refused('lock_arbitration_busy', guard);
      const entries = fs.readdirSync(guard);
      let owner, record;
      if (entries.length === 1 && /^[a-zA-Z0-9-]+\.json$/.test(entries[0])) {
        record = path.join(guard, entries[0]);
        try { if (!fs.lstatSync(record).isSymbolicLink()) owner = JSON.parse(fs.readFileSync(record, 'utf8')); } catch {}
      }
      if (!owner) {
        // Covers a crash between mkdir and writing ownership, including old builds.
        // No recursive deletion: unknown contents require manual recovery.
        const old = options.now() - fs.statSync(guard).mtimeMs >= STALE_MS;
        if ((entries.length && !record) || !old || !options.forceUnlock)
          return refused('lock_arbitration_busy', guard, undefined, old && (!entries.length || !!record));
      } else {
        const refusal = await reclaimable(owner, guard, options, 'lock_arbitration');
        if (refusal) return refusal;
      }
      try {
        if (record) fs.unlinkSync(record);
        fs.rmdirSync(guard);
      } catch { return refused('lock_arbitration_busy', guard, owner); }
    }
  }
  const owner = { pid: options.pid, createdMs: options.now(), token: randomUUID() };
  const record = path.join(guard, owner.token + '.json');
  try {
    fs.writeFileSync(record, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    return await action();
  } finally {
    try { fs.unlinkSync(record); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    fs.rmdirSync(guard);
  }
}
export async function acquireLock(etc, options = {}) {
  options = settings(options);
  const file = path.join(etc, 'setup.lock');
  return arbitrate(file, async () => {
    let previous = null;
    try {
      if (fs.lstatSync(file).isSymbolicLink()) return refused('lock_reparse_target', file);
      previous = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) { if (e.code !== 'ENOENT') return refused('invalid_lock', file); }
    if (previous) {
      const refusal = await reclaimable(previous, file, options);
      if (refusal) return refusal;
    }
    const owner = { pid: options.pid, createdMs: options.now(), token: randomUUID() };
    // Arbitration already serializes publication; no second crash-persistent guard.
    await safewrite(file, JSON.stringify(owner) + '\n');
    return { ok: true, file, owner, reclaimed: !!previous };
  }, options);
}
export async function releaseLock(lock, options = {}) {
  if (!lock?.ok) throw new Error('lock_not_owned');
  return arbitrate(lock.file, async () => {
    let current;
    try { current = JSON.parse(fs.readFileSync(lock.file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return refused('lock_missing', lock.file); throw e; }
    if (current.token !== lock.owner.token) return refused('lock_owner_changed', lock.file, current);
    // Explicitly required by S10, despite omission from §7.1's deletion carve-outs.
    fs.unlinkSync(lock.file);
    return { ok: true };
  }, settings(options));
}

// Explicit A-03 escape; arbitration recovery is performed before acquisition.
// Even force cannot override a live owner or the minimum age for unknown liveness.
export async function forceUnlock(etc, options = {}) {
  const lock = await acquireLock(etc, { ...options, forceUnlock: true });
  if (!lock.ok) return lock;
  return releaseLock(lock, options);
}
