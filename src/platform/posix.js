// Owns implemented POSIX paths and explicit capability refusals; specification §§3–4.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { APP_VERSION } = require('../version');
class PlatformNotImplemented extends Error {
  constructor(capability) { super(capability + ' is not implemented on this platform in council 0.1.0.'); this.name = 'PlatformNotImplemented'; this.code = 'platform_not_implemented'; }
}
module.exports = function make(id) {
  const homeDir = () => process.env.HOME || os.homedir();
  const tokens = () => ({ HOME: homeDir(), XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || path.join(homeDir(), '.config'), XDG_DATA_HOME: process.env.XDG_DATA_HOME || path.join(homeDir(), '.local/share'), XDG_STATE_HOME: process.env.XDG_STATE_HOME || path.join(homeDir(), '.local/state'), COUNCIL_APP: path.resolve(__dirname, '..'), COUNCIL_VAULT: '' });
  const appDirs = () => { const stateAnchor = id === 'darwin' ? path.join(homeDir(), 'Library/Application Support') : tokens().XDG_STATE_HOME; const root = path.join(stateAnchor, 'council'); return { root, app: path.join(root, 'app', APP_VERSION), etc: path.join(root, 'etc'), run: path.join(root, 'run'), stateAnchor }; };
  const caseFold = s => id === 'darwin' ? String(s).toLowerCase() : String(s);
  const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const fail = c => () => { throw new PlatformNotImplemented(c); };
  const asyncFail = c => async () => { throw new PlatformNotImplemented(c); };
  return {
    executableNames: name => [name],
    vendorBinary: (name, {npmRoot} = {}) => name === 'codex' && npmRoot ? path.join(npmRoot,'@openai','codex','bin','codex.js') : null,
    desktopCliLayout: () => null,
    fileAttributesProbe: () => null,
    id, implemented: { proc: false, secrets: false, fileAttributes: false }, notImplementedReason: 'Process supervision is not implemented on ' + id + ' in council 0.1.0; use Windows.',
    appDirs, homeDir, tokens, caseFold, sameFile: (a,b) => caseFold(real(a)) === caseFold(real(b)), isAbsoluteNative: p => typeof p === 'string' && p.startsWith('/'),
    childEnvAllow: () => ['HOME','USER','LOGNAME','LANG','LC_ALL','LC_CTYPE','TMPDIR','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME'],
    childPath: nodeDir => [nodeDir, '/usr/bin', '/bin'].filter(Boolean).join(path.delimiter), nullDevice: () => '/dev/null',
    allowedRootsBase: () => [path.dirname(real(process.execPath)), path.join(appDirs().root, 'app')],
    systemBinaries: () => ({ ps: '/bin/ps', pgrep: '/usr/bin/pgrep', sh: '/bin/sh' }),
    longLivedChildArgv: () => ({ file: '/bin/sleep', args: ['300'] }),
    credentialProbePaths: () => ({ claude: path.join(homeDir(), '.claude/.credentials.json'), codex: path.join(homeDir(), '.codex') }),
    processNameProbe: () => null,
    killPid: asyncFail('proc'), childrenOf: asyncFail('proc'), probe: asyncFail('proc'), inspect: asyncFail('proc'), isAlive: asyncFail('proc'), livenessOf: asyncFail('proc'), verifyRunner: asyncFail('proc'), verifyLeaf: asyncFail('proc'), waitForDeath: asyncFail('proc'), treeKill: asyncFail('proc'), spawnDetachedOpts: fail('proc'),
    fileAttributes: asyncFail('fileAttributes'), restrictToOwner: asyncFail('fileAttributes'),
    isCloudSynced: async p => ({ synced: /(?:^|\/)(?:Dropbox|OneDrive|Google Drive|Mobile Documents)(?:\/|$)/i.test(p), evidence: ['path-name heuristic'], unknown: true }),
    secretGet: fail('secrets'), secretSet: fail('secrets'), secretDelete: fail('secrets'),
    hostConfigPaths: () => ({ claudeCode: path.join(homeDir(), '.claude.json'), codex: path.join(homeDir(), '.codex/config.toml'), claudeDesktop: id === 'darwin' ? [path.join(homeDir(), 'Library/Application Support/Claude', 'claude_desktop_config.json')] : [] }),
    planUsagePath: () => id === 'darwin' ? path.join(homeDir(),'Library/Application Support','Claude','plan-usage-history.json') : null,
    secretHelper: () => null,
    rgVendorDir: js => path.resolve(path.dirname(js), '..', 'vendor'), expectedImage: name => name,
    agyBinaryRoot: () => null, npmRootInfo: () => ({ root: null, warning: null }),
  };
};
