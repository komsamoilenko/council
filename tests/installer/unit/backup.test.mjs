import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { backupFiles } from '../../../installer/lib/backup.mjs';
import { safewrite } from '../../../installer/lib/safewrite.mjs';
import { journal, readJournal } from '../../../installer/lib/journal.mjs';
import { sha256 } from '../../../installer/lib/manifest.mjs';
async function fixture(root) {
  const etc=path.join(root,'etc'), vault=path.join(root,'notes'), source=path.join(vault,'AGENTS.md');
  fs.mkdirSync(etc); fs.mkdirSync(vault); await safewrite(source,Buffer.from([0,1,2,255,13,10]));
  return {etc,vault,profile:'default',timestamp:'test-1',files:[{source,mirror:'vault/AGENTS.md'}]};
}
const host = result => ({implemented:{fileAttributes:false},restrictToOwner:async () => result});
export default async function(test) {
  await test('absent vault resolves through its nearest existing ancestor (A-34)', async root => {
    const etc = path.join(root, 'etc'); fs.mkdirSync(etc);
    const vault = path.join(root, 'absent', 'notes');
    const result = await backupFiles({etc, vault, profile:'default', timestamp:'absent',
      files:[{source:path.join(vault, 'AGENTS.md'), mirror:'vault/AGENTS.md'}], platform:host({ok:true})});
    assert.deepEqual(result.backups, []);
    assert.equal(fs.existsSync(path.join(root, 'absent')), false);
  });
  await test('real whole-file copy, immutable and journalled', async root => {
    const args=await fixture(root), file=path.join(args.etc,'journal.jsonl'), j=journal(file);
    await j.before({t:'begin',plan_sha256:sha256('plan')});
    let called;
    const r=await backupFiles({...args,journal:j,platform:{...host({ok:true}),restrictToOwner:async d => { called=d; return {ok:true}; }}});
    assert.equal(called,path.join(args.etc,'backups')); assert.equal(r.warnings.length,0);
    assert.deepEqual(fs.readFileSync(r.backups[0].backup),fs.readFileSync(args.files[0].source));
    assert.equal(readJournal(file).records.at(-1).backup,r.backups[0].backup);
    await assert.rejects(backupFiles({...args,platform:host({ok:true})}),{code:'EEXIST'});
  });
  for (const reverted of [true,false]) await test('ACL failure carries on '+reverted, async root => {
    const args=await fixture(root), r=await backupFiles({...args,platform:host({ok:false,reason:'backup_acl_not_restricted',reverted})});
    assert.deepEqual(r.warnings,[{directory:path.join(args.etc,'backups'),reason:'backup_acl_not_restricted',reverted}]);
    assert.deepEqual(fs.readFileSync(r.backups[0].backup),fs.readFileSync(args.files[0].source));
  });
  await test('missing source, multiple roots and thrown ACL error', async root => {
    const args=await fixture(root), hostFile=path.join(root,'host.json'); await safewrite(hostFile,'{"live":true}');
    args.files.push({source:hostFile,mirror:'home/host.json'},{source:path.join(root,'missing'),mirror:'home/missing'});
    const r=await backupFiles({...args,platform:{...host({ok:true}),restrictToOwner:async () => { throw new Error('unsupported'); }}});
    assert.equal(r.backups[2].missing,true); assert.equal(r.backups[2].backup,null); assert.equal(r.warnings[0].reason,'backup_acl_not_restricted');
    assert.equal(fs.readFileSync(r.backups[1].backup,'utf8'),'{"live":true}');
  });
  await test('vault destination and mirror traversal refused', async root => {
    const args=await fixture(root), fake=host({ok:true});
    await assert.rejects(backupFiles({...args,etc:args.vault,platform:fake}),/inside_vault/);
    for (const mirror of ['../escape','a/../../escape','a\\..\\escape','a:b','']) await assert.rejects(backupFiles({...args,files:[{source:args.files[0].source,mirror}],platform:fake}),/invalid_backup_mirror/);
    assert.ok(!fs.existsSync(path.join(args.etc,'backups')));
    await assert.rejects(backupFiles({...args,files:[...args.files,...args.files],platform:fake}),/collision/);
  });
  await test('junction destination rejected before writes', async root => {
    const args=await fixture(root), dest=path.join(args.etc,'backups'); fs.symlinkSync(args.vault,dest,'junction');
    await assert.rejects(backupFiles({...args,platform:host({ok:true})}),/reparse/);
    assert.deepEqual(fs.readdirSync(args.vault),['AGENTS.md']);
  });
  await test('profile junction refused before timestamp directory creation', async root => {
    const args=await fixture(root), dest=path.join(args.etc,'backups'); fs.mkdirSync(dest);
    fs.symlinkSync(args.vault,path.join(dest,args.profile),'junction');
    await assert.rejects(backupFiles({...args,platform:host({ok:true})}),/reparse/);
    assert.deepEqual(fs.readdirSync(args.vault),['AGENTS.md']);
  });
}
