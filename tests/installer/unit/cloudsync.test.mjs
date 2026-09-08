import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cloudsync } from '../../../installer/lib/cloudsync.mjs';
import { safewrite } from '../../../installer/lib/safewrite.mjs';
const base={env:{},providerPaths:{},platform:{fileAttributes:async () => ({bits:0})}};

export default async function(test) {
  await test('real path and no signal remains unknown', async root => {
    const r=await cloudsync(root,base); assert.equal(r.path,fs.realpathSync(root)); assert.equal(r.synced,null); assert.equal(r.unknown,true); assert.equal(r.signal,null);
  });
  await test('env roots ordered before names and attributes', async root => {
    const vault=path.join(root,'Dropbox'); fs.mkdirSync(vault);
    const r=await cloudsync(vault,{...base,env:{OneDrive:root,OneDriveConsumer:root,OneDriveCommercial:root},platform:{fileAttributes:async () => assert.fail('expensive_probe')}});
    assert.equal(r.signal,'env_root'); assert.equal(r.detail,'OneDrive');
    assert.equal((await cloudsync(root,{...base,env:{OneDrive:root+'-other'}})).synced,null);
  });
  for (const name of ['OneDrive','Dropbox','Google Drive','GoogleDrive','iCloudDrive','pCloudDrive','Box','MEGA','Nextcloud','Yandex.Disk','Library/Mobile Documents','Library/CloudStorage','ownCloud','Insync']) {
    await test('path segment '+name, async root => {
      const vault=path.join(root,...name.split('/'),'notes'); fs.mkdirSync(vault,{recursive:true});
      const r=await cloudsync(vault,base); assert.equal(r.signal,'path_segment'); assert.equal(r.detail,name);
    });
  }
  await test('provider config roots and DriveFS presence', async root => {
    const config=path.join(root,'info.json'), vault=path.join(root,'notes'); fs.mkdirSync(vault);
    await safewrite(config,JSON.stringify({personal:{path:vault}}));
    assert.equal((await cloudsync(vault,{...base,providerPaths:{dropbox:config}})).detail,'Dropbox/info.json');
    await safewrite(config,JSON.stringify({personal:{path:root+'-other'}}));
    assert.equal((await cloudsync(vault,{...base,providerPaths:{dropbox:config}})).synced,null);
    const driveFS=path.join(root,'provider'); fs.mkdirSync(driveFS);
    const r=await cloudsync(vault,{...base,providerPaths:{driveFS}}); assert.equal(r.detail,'Google/DriveFS'); assert.equal(r.scope,'provider_presence');
  });
  await test('ancestor marker and realpath alias', async root => {
    const real=path.join(root,'notes'), sub=path.join(real,'nested'), link=path.join(root,'alias'); fs.mkdirSync(sub,{recursive:true});
    await safewrite(path.join(real,'.dropbox'),''); fs.symlinkSync(sub,link,'junction');
    const r=await cloudsync(link,base); assert.equal(r.signal,'ancestor_marker'); assert.equal(r.detail,'.dropbox'); assert.equal(r.path,fs.realpathSync(sub));
  });
  for (const [key,bit] of [['reparsePoint',0x400],['offline',0x1000],['recallOnDataAccess',0x400000],['pinned',0x80000]]) {
    await test('attribute '+key, async root => { const r=await cloudsync(root,{...base,platform:{fileAttributes:async () => ({bits:bit})}}); assert.equal(r.detail,key); });
  }
  await test('failed attributes and misleading substrings remain unknown', async root => {
    const vault=path.join(root,'notDropbox'); fs.mkdirSync(vault);
    const r=await cloudsync(vault,{...base,platform:{fileAttributes:async () => { throw new Error('probe_failure'); }}}); assert.equal(r.synced,null); assert.equal(r.unknown,true);
  });
}
