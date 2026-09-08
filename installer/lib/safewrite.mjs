// Owns durable installer writes and byte-range verification; specification §7.1.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function safewrite(file, data, { io = fs, sleep = ms => new Promise(r => setTimeout(r, ms)), exclusive = false, mode = 0o600 } = {}) {
  const temp = file + '.council-tmp-' + randomUUID();
  let fd, created = false;
  try {
    fd = io.openSync(temp, 'wx', mode);
    created = true;
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let offset = 0;
    while (offset < bytes.length) {
      const n = io.writeSync(fd, bytes, offset, bytes.length - offset);
      if (!n) throw new Error('short_write');
      offset += n;
    }
    io.fsyncSync(fd);
    io.closeSync(fd); fd = undefined;
    for (let retry = 0; ; retry++) {
      try {
        // Serialize cooperating exclusive publishers while retaining temp/fsync/rename.
        // An abandoned guard is refused, never treated as proof that its owner is gone.
        const guard = file + '.council-tmp-publish';
        let claimed = false;
        try {
          if (exclusive) {
            try { io.mkdirSync(guard); claimed = true; }
            catch (error) { if (error.code === 'EEXIST') error.code = 'EBUSY'; throw error; }
            let exists = true;
            try { io.lstatSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; exists = false; }
            if (exists) throw Object.assign(new Error('destination_exists'), { code: 'EEXIST' });
          }
          io.renameSync(temp, file);
        } finally { if (claimed) io.rmdirSync(guard); }
        break;
      } catch (error) {
        if (!['EBUSY', 'EPERM'].includes(error.code) || retry === 5) throw error;
        await sleep(200);
      }
    }
    return { path: file, bytes: bytes.length };
  } finally {
    if (fd !== undefined) io.closeSync(fd);
    if (created) { try { io.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  }
}

export function assertOutside(before, after, oldRange, newRange) {
  if (!before.subarray(0, oldRange.start).equals(after.subarray(0, newRange.start)) ||
      !before.subarray(oldRange.end).equals(after.subarray(newRange.end))) {
    throw Object.assign(new Error('outside_range_changed'), { code: 'E_OUTSIDE_RANGE', exitCode: 1 });
  }
}

// Both dry and wet callers consume the same splice and the same assertion.
export async function writeSplice(file, before, result, { dryRun = true, backup, writer = safewrite } = {}) {
  assertOutside(before, result.bytes, result.oldRange, result.newRange);
  if (dryRun || before.equals(result.bytes)) return result;
  if (fs.existsSync(file) && (!backup || !fs.readFileSync(backup).equals(before))) throw new Error('backup_required');
  // Refuse stale plans immediately before publication.
  let current;
  try { current = fs.readFileSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; current = Buffer.alloc(0); }
  if (!current.equals(before)) throw Object.assign(new Error('plan_stale'), { exitCode: 3 });
  await writer(file, result.bytes);
  try { assertOutside(before, fs.readFileSync(file), result.oldRange, result.newRange); }
  catch (error) {
    await safewrite(file, backup ? fs.readFileSync(backup) : before);
    throw error;
  }
  return result;
}

// Reject links in every existing path component, including directory junctions.
export async function rejectReparse(file, platform) {
  for (let p = path.resolve(file); ; p = path.dirname(p)) {
    try {
      if (fs.lstatSync(p).isSymbolicLink()) return true;
      if (platform?.implemented?.fileAttributes) {
        const a = await platform.fileAttributes(p);
        if (a.reparsePoint || (a.bits & 0x400)) return true;
      }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (path.dirname(p) === p) return false;
  }
}
