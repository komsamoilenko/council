// Owns S0's exact-list probe lifecycle; specification §10.3 and A-29.
import fs from 'node:fs';
import path from 'node:path';
import { rejectReparse } from './safewrite.mjs';

export async function probeVault(vault, { io = fs, platform, onWarning = () => {} } = {}) {
  const directory = path.join(vault, '.council');
  const probe = path.join(directory, '.write-probe');
  const created = [], removed = [], warnings = [];
  let fd, ownProbe = false, failure;
  try {
    if (await rejectReparse(directory, platform)) throw new Error('probe_reparse_target');
    const absent = [];
    for (let p = directory; !io.existsSync(p); p = path.dirname(p)) absent.unshift(p);
    for (const p of absent) { io.mkdirSync(p); created.push(p); }
    fd = io.openSync(probe, 'wx', 0o600); ownProbe = true;
    io.fsyncSync(fd);
  } catch (error) { failure = error; }
  finally {
    if (fd !== undefined) { try { io.closeSync(fd); } catch (error) { failure ||= error; } }
    if (ownProbe) {
      try { io.unlinkSync(probe); removed.push(probe); }
      catch (error) { failure ||= error; }
    }
    for (const p of [...created].reverse()) {
      try { io.rmdirSync(p); removed.push(p); }
      catch (error) {
        const warning = { path: p, code: error.code, message: 'S0-created directory left in place; empty-only removal failed.' };
        warnings.push(warning); onWarning(warning);
      }
    }
  }
  const record = { probe, created, removed, warnings };
  if (failure) throw Object.assign(new Error('plan cannot test writability without writing; this is the first write council attempts'),
    { code: 'E-VAULT-UNWRITABLE', exitCode: 2, cause: failure, record });
  return record;
}
