// Owns immutable whole-file pre-images outside the vault; specification §§7.4 S2,8.3.
import fs from 'node:fs';
import path from 'node:path';
import platform from '../../src/platform/index.js';
import { safewrite, rejectReparse } from './safewrite.mjs';
import { sha256 } from './manifest.mjs';

function inside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
export async function backupFiles({ etc, profile, timestamp, vault, files, platform: host = platform, journal }) {
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(profile || '') || !/^[A-Za-z0-9_-]+$/.test(timestamp || '')) throw new Error('invalid_backup_location');
  const root = path.resolve(etc, 'backups');
  // Check the real existing anchor before creating any backup directory.
  let anchor = path.resolve(vault);
  const suffix = [];
  while (!fs.existsSync(anchor)) { suffix.unshift(path.basename(anchor)); anchor = path.dirname(anchor); }
  const realEtc = fs.realpathSync(etc), realVault = path.join(fs.realpathSync(anchor), ...suffix);
  if (inside(realEtc, realVault) || inside(root, path.resolve(vault))) throw new Error('backup_inside_vault');
  if (await rejectReparse(root, host)) throw new Error('backup_reparse_target');
  const directory = path.join(root, profile, timestamp), destinations = new Set();
  // Validate every destination before the first mutation.
  const vaultAbsent = !fs.existsSync(vault);
  const items = files.map(({ source, mirror }) => {
    if (typeof mirror !== 'string' || !mirror || path.isAbsolute(mirror) || mirror.split(/[\\/]/).some(s => !s || s === '.' || s === '..' || s.includes(':'))) throw new Error('invalid_backup_mirror');
    const destination = path.resolve(directory, mirror);
    if (!inside(destination, directory) || destinations.has(destination.toLowerCase())) throw new Error('backup_collision');
    destinations.add(destination.toLowerCase());
    return { source, destination };
  }).filter(({ source }) => !(vaultAbsent && inside(path.resolve(source), path.resolve(vault))));
  if (await rejectReparse(directory, host)) throw new Error('backup_reparse_target');
  for (const { destination } of items) if (await rejectReparse(destination, host)) throw new Error('backup_reparse_target');
  fs.mkdirSync(root, { recursive: true });
  const warnings = [];
  let acl;
  try { acl = await host.restrictToOwner(root); }
  catch { acl = { ok: false, reason: 'backup_acl_not_restricted', reverted: false }; }
  if (!acl.ok) warnings.push({ directory: root, reason: acl.reason, reverted: acl.reverted });
  fs.mkdirSync(directory, { recursive: true });
  const backups = [];
  for (const { source, destination } of items) {
    if (await rejectReparse(destination, host)) throw new Error('backup_reparse_target');
    let bytes;
    try { bytes = fs.readFileSync(source); } catch (e) { if (e.code === 'ENOENT') { backups.push({ source, backup: null, missing: true }); continue; } throw e; }
    const hash = sha256(bytes);
    const action = async () => {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      await safewrite(destination, bytes, { exclusive: true });
      if (sha256(fs.readFileSync(destination)) !== hash) throw new Error('backup_hash_mismatch');
    };
    if (journal) await journal.before({ t: 'backup', path: source, backup: destination, sha256_before: hash }, action);
    else await action();
    backups.push({ source, backup: destination, sha256: hash });
  }
  return { directory, backups, warnings };
}
