import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { appdirs } from '../../../installer/lib/appdirs.mjs';
import { safewrite } from '../../../installer/lib/safewrite.mjs';

export default async function(test) {
  await test('native layout on disk', async root => {
    const dirs = appdirs({ env: { ...process.env, HOME: root, USERPROFILE: root, LOCALAPPDATA: root, XDG_STATE_HOME: root, COUNCIL_PLATFORM: '' } });
    fs.mkdirSync(dirs.profileDir,{recursive:true}); await safewrite(dirs.config,'{}');
    assert.equal(fs.readFileSync(dirs.config,'utf8'),'{}'); assert.equal(dirs.lock,path.join(dirs.etc,'setup.lock'));
  });
  await test('darwin override uses POSIX separators', async root => {
    const home = '/' + path.basename(root);
    const d = appdirs({ env: { COUNCIL_PLATFORM:'darwin', HOME:home }, profile:'alpha' });
    assert.equal(d.root, home + '/Library/Application Support/council'); assert.equal(d.config,d.etc + '/profiles/alpha/config.json');
    assert.ok(!d.config.includes('\\'));
  });
  await test('linux XDG and fallback', async root => {
    const home = '/' + path.basename(root);
    assert.equal(appdirs({env:{COUNCIL_PLATFORM:'linux',HOME:home}}).root,home+'/.local/state/council');
    assert.equal(appdirs({env:{COUNCIL_PLATFORM:'linux',HOME:home,XDG_STATE_HOME:home+'/state'}}).root,home+'/state/council');
  });
  await test('win32 override and invalid inputs', async root => {
    const d = appdirs({env:{COUNCIL_PLATFORM:'win32', userprofile:root, localappdata:root}});
    assert.equal(d.root,path.win32.join(root,'council')); assert.equal(d.globalStop,path.win32.join(d.root,'STOP'));
    assert.throws(() => appdirs({profile:'../escape'}),/bad_profile/);
    assert.throws(() => appdirs({env:{COUNCIL_PLATFORM:'other'}}),/unsupported/);
  });
}
