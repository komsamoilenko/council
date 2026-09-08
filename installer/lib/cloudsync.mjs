// Owns ordered evidence-only cloud detection; specification §10.1.
import fs from 'node:fs';
import path from 'node:path';
import platform from '../../src/platform/index.js';
import { appdirs } from './appdirs.mjs';

const SEGMENTS = ['OneDrive','Dropbox','Google Drive','GoogleDrive','iCloudDrive','pCloudDrive','Box','MEGA',
  'Nextcloud','Yandex.Disk','Library/Mobile Documents','Library/CloudStorage','ownCloud','Insync'];
const folded = p => String(p).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
const under = (p, root) => folded(p) === folded(root) || folded(p).startsWith(folded(root) + '/');
export async function cloudsync(vault, { env = process.env, platform: host = platform, providerPaths, io = fs } = {}) {
  const real = io.realpathSync(vault);
  const found = (signal, detail) => ({ synced: true, unknown: false, path: real, signal, detail });
  for (const name of ['OneDrive','OneDriveConsumer','OneDriveCommercial']) {
    if (env[name] && under(real, env[name])) return found('env_root', name);
  }
  const segments = '/' + folded(real) + '/';
  for (const segment of SEGMENTS) if (segments.includes('/' + segment.toLowerCase() + '/')) return found('path_segment', segment);
  providerPaths ||= appdirs({ env }).providerPaths;
  if (providerPaths.dropbox) {
    try {
      const config = JSON.parse(io.readFileSync(providerPaths.dropbox, 'utf8'));
      for (const value of Object.values(config)) if (typeof value?.path === 'string' && under(real, value.path)) return found('provider_config', 'Dropbox/info.json');
    } catch {}
  }
  // The specification lists provider presence as evidence, not proof of membership.
  if (providerPaths.driveFS) {
    try { if (io.statSync(providerPaths.driveFS).isDirectory()) return { ...found('provider_config', 'Google/DriveFS'), scope: 'provider_presence' }; } catch {}
  }
  for (let ancestor = real; ; ancestor = path.dirname(ancestor)) {
    for (const marker of ['.dropbox','.dropbox.cache']) {
      try { io.lstatSync(path.join(ancestor, marker)); return found('ancestor_marker', marker); } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; }
    }
    if (path.dirname(ancestor) === ancestor) break;
  }
  let attributes = null;
  try { attributes = await host.fileAttributes(real); } catch {}
  for (const [key, bit] of [['reparsePoint',0x400],['offline',0x1000],['recallOnDataAccess',0x400000],['pinned',0x80000]]) {
    if (attributes?.[key] || (attributes?.bits & bit)) return found('file_attribute', key);
  }
  return { synced: null, unknown: true, path: real, signal: null, attributes };
}
