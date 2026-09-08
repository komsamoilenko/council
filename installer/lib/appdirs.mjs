// Owns installer platform selection and directory layout; specification §§2,4,16.4.
import path from 'node:path';
import os from 'node:os';
import version from '../../src/version.js';
export const nativePlatform = process.platform;

export function appdirs({ env = process.env, home, appVersion = version.APP_VERSION, profile = 'default' } = {}) {
  const id = env.COUNCIL_PLATFORM || process.platform;
  if (!['win32', 'darwin', 'linux'].includes(id)) throw Object.assign(new Error('unsupported_platform'), { exitCode: 6 });
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(profile)) throw new Error('bad_profile_name');
  const p = id === 'win32' ? path.win32 : path.posix;
  const vars = id === 'win32' ? Object.fromEntries(Object.entries(env).map(([k,v]) => [k.toUpperCase(),v])) : env;
  home ||= vars[id === 'win32' ? 'USERPROFILE' : 'HOME'] || os.homedir();
  const stateAnchor = id === 'win32' ? vars.LOCALAPPDATA || p.join(home, 'AppData', 'Local') :
    id === 'darwin' ? p.join(home, 'Library', 'Application Support') : vars.XDG_STATE_HOME || p.join(home, '.local', 'state');
  const root = p.join(stateAnchor, 'council'), etc = p.join(root, 'etc'), run = p.join(root, 'run');
  const profileDir = p.join(etc, 'profiles', profile), runtimeRoot = p.join(run, profile);
  return { id, home, stateAnchor, root, app: p.join(root, 'app', appVersion), etc, run,
    launcher: p.join(root, 'bin', 'council-server.js'), current: p.join(root, 'current.json'),
    globalStop: p.join(root, 'STOP'), machine: p.join(etc, 'machine.json'), profileDir,
    config: p.join(profileDir, 'config.json'), accounts: p.join(profileDir, 'accounts.json'),
    manifest: p.join(profileDir, 'manifest.json'), manifests: p.join(etc, 'manifests'),
    journal: p.join(etc, 'journal'), plans: p.join(etc, 'plans'), backups: p.join(etc, 'backups', profile),
    reports: p.join(etc, 'reports'), logs: p.join(etc, 'logs'), lock: p.join(etc, 'setup.lock'),
    runtimeRoot, secrets: p.join(runtimeRoot, 'secrets'), sandbox: p.join(runtimeRoot, 'sandbox'),
    stop: p.join(runtimeRoot, 'STOP'), agyGate: p.join(runtimeRoot, 'agy-enabled'),
    jobs: p.join(runtimeRoot, 'jobs'), ledger: p.join(runtimeRoot, 'ledger'),
    providerPaths: vars.LOCALAPPDATA ? { dropbox: p.join(vars.LOCALAPPDATA, 'Dropbox', 'info.json'),
      driveFS: p.join(vars.LOCALAPPDATA, 'Google', 'DriveFS') } : {} };
}
