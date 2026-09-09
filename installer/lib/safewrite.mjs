// Owns durable installer writes and byte-range verification; specification §7.1.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { nativePlatform } from './appdirs.mjs';

export async function safewrite(file, data, { io = fs, sleep = ms => new Promise(r => setTimeout(r, ms)), exclusive = false, mode = 0o600, platform = nativePlatform, onWarning = warning => process.emitWarning(JSON.stringify(warning)) } = {}) {
  const temp = file + '.council-tmp-' + randomUUID();
  const guard = file + '.council-tmp-publish', warnings = [];
  let fd, created = false, claimed = false, cleanupAttempted = false, existingMode;
  const cleanupGuard = async () => {
    if (!claimed || cleanupAttempted) return;
    cleanupAttempted = true;
    for (let retry = 0; ; retry++) {
      try { io.rmdirSync(guard); claimed = false; return; }
      catch (error) {
        const warning = { code: error.code, path: guard, message: 'Publication guard cleanup failed; remove this directory if it remains.' };
        warnings.push(warning); onWarning(warning);
        if (!['EBUSY','EPERM'].includes(error.code) || retry === 5) return;
        await sleep(200);
      }
    }
  };
  try {
    try { existingMode = io.statSync(file).mode & 0o7777; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    fd = io.openSync(temp, 'wx', existingMode ?? mode);
    created = true;
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let offset = 0;
    while (offset < bytes.length) {
      const n = io.writeSync(fd, bytes, offset, bytes.length - offset);
      if (!n) throw new Error('short_write');
      offset += n;
    }
    // Restore exact existing POSIX permissions after writes, independent of umask.
    if (existingMode !== undefined && platform !== 'win32') io.fchmodSync(fd, existingMode);
    io.fsyncSync(fd);
    const closing = fd; fd = undefined; io.closeSync(closing);
    if (exclusive) {
      for (let retry = 0; ; retry++) {
        try { io.mkdirSync(guard); claimed = true; break; }
        catch (error) {
          if (error.code === 'EEXIST') error.code = 'EBUSY';
          if (!['EBUSY','EPERM'].includes(error.code) || retry === 5) throw error;
          await sleep(200);
        }
      }
      let exists = true;
      try { io.lstatSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; exists = false; }
      if (exists) throw Object.assign(new Error('destination_exists'), { code: 'EEXIST' });
    }
    // Only a failed rename is repeatable; cleanup never re-enters publication.
    for (let retry = 0; ; retry++) {
      try { io.renameSync(temp, file); break; }
      catch (error) {
        if (!['EBUSY', 'EPERM'].includes(error.code) || retry === 5) throw error;
        await sleep(200);
      }
    }
    // Node on Windows has no portable directory fsync: file bytes are durable,
    // but rename durability against power loss cannot be guaranteed there.
    if (platform !== 'win32') {
      const directory = io.openSync(path.dirname(file), 'r');
      try { io.fsyncSync(directory); } finally { io.closeSync(directory); }
    }
    await cleanupGuard();
    return { path: file, bytes: bytes.length, warnings };
  } finally {
    try {
      if (fd !== undefined) { const closing = fd; fd = undefined; io.closeSync(closing); }
    } finally {
      try { if (created) { try { io.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; } } }
      finally { await cleanupGuard(); }
    }
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
  if (!dryRun && /^(?:\.claude\.json|config\.toml|claude_desktop_config\.json)$/i.test(path.basename(file)))
    throw new Error('host_requires_surgical_writer');
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

// Host recovery never consumes backup bytes. recover receives the live bytes and
// must return a splice restoring only the recorded entry/table. Re-check those
// bytes immediately before recovery so a concurrent host change is never reverted.
export async function writeHostSplice(file, before, result, { dryRun = true, backup, writer = safewrite, recover, verify, serializedByHost = false } = {}) {
  assertOutside(before, result.bytes, result.oldRange, result.newRange);
  if (dryRun || before.equals(result.bytes)) return result;
  if (typeof recover !== 'function') throw new Error('host_recovery_required');
  if (typeof verify !== 'function') throw new Error('host_content_verifier_required');
  if (fs.existsSync(file) && (!backup || !fs.existsSync(backup))) throw new Error('backup_required');
  const read = () => { try { return fs.readFileSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; return Buffer.alloc(0); } };
  if (!read().equals(before)) throw Object.assign(new Error('plan_stale'), { exitCode: 3 });
  await writer(file, result.bytes);
  try {
    const actual=read();
    if (!verify(actual)) throw new Error('host_content_mismatch');
    if (!serializedByHost) assertOutside(before,actual,result.oldRange,result.newRange);
  }
  catch (error) {
    const current = read(), restore = recover(current);
    if (!restore?.ok) throw Object.assign(error, { recovery: 'refused', recoveryCode: restore?.code });
    assertOutside(current, restore.bytes, restore.oldRange, restore.newRange);
    if (!read().equals(current)) throw Object.assign(error, { recovery: 'concurrent_change' });
    await safewrite(file, restore.bytes);
    assertOutside(current, read(), restore.oldRange, restore.newRange);
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

export function byteEdit(before,after) {
  let start=0,end=before.length,newEnd=after.length;
  while(start<end&&start<newEnd&&before[start]===after[start])start++;
  while(end>start&&newEnd>start&&before[end-1]===after[newEnd-1]){end--;newEnd--;}
  return {ok:true,bytes:after,oldRange:{start,end},newRange:{start,end:newEnd}};
}
