import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateManifest, readManifest, writeManifest, entryState, removalFor, REMOVALS, sha256, entryHash, registrationState } from '../../../installer/lib/manifest.mjs';
import { canonicalBlock, scanMarkers, hashBody } from '../../../installer/lib/markers.mjs';
import { safewrite } from '../../../installer/lib/safewrite.mjs';

function manifest(root) { return {schema:1,profile:'default',server_name:'council',app_version:'0.1.0',installed_at:'2026-01-01',last_apply_at:'2026-01-01',
  plan_sha256:sha256('plan'),vault:{path:root,real:root,vault_id:'fixture'},runtime_root:path.join(root,'runtime'),backups_dir:path.join(root,'backups'),
  entries:[],registrations:[],pending_hosts:[],left_alone:[],observed:{node:'test'}}; }
export default async function(test) {
  await test('round trip and file drift', async root => {
    const file=path.join(root,'owned'), m=manifest(root); await safewrite(file,'before');
    const e={path:file,kind:'file',created:true,sha256:sha256('before'),removal:'delete_if_hash_matches'}; m.entries.push(e);
    const mf=path.join(root,'manifest.json'); await writeManifest(mf,m); assert.deepEqual(readManifest(mf),m);
    assert.equal(entryState(e,m).state,'unchanged'); await safewrite(file,'edit'); assert.equal(entryState(e,m).state,'changed');
  });
  await test('closed removal set and schema validation', async root => {
    assert.equal(REMOVALS.length,7); for (const removal of REMOVALS) assert.equal(removalFor({removal}),removal);
    assert.throws(() => removalFor({removal:'delete_everything'}),/invalid_manifest/);
    const m=manifest(root); for (const key of Object.keys(m)) { const bad={...m}; delete bad[key]; assert.throws(() => validateManifest(bad)); }
    assert.throws(() => validateManifest({...m,schema:2}));
    assert.throws(() => validateManifest({...m,entries:[{path:root,kind:'dir',created:true,removal:'delete_if_hash_matches'}]}));
  });
  await test('missing requires vault pointer and matching profile', async root => {
    const m=manifest(root), e={path:path.join(root,'missing'),kind:'file',removal:'never'};
    assert.throws(() => entryState(e,m)); fs.mkdirSync(path.join(root,'.council'));
    const pointer=path.join(root,'.council','vault.json'); await safewrite(pointer,JSON.stringify({profile:'wrong'})); assert.throws(() => entryState(e,m),/profile_mismatch/);
    await safewrite(pointer,JSON.stringify({profile:'default'})); assert.equal(entryState(e,m).state,'missing');
    assert.throws(() => entryState(e,{...m,vault:{path:path.join(root,'absent')}}));
  });
  await test('block hashes normalize EOL and ignore outside edits', async root => {
    const file=path.join(root,'AGENTS.md'), bytes=canonicalBlock('old',{eol:'\r\n'});
    await safewrite(file,Buffer.concat([Buffer.from('outside edit\n'),bytes]));
    const e={path:file,kind:'block',removal:'excise_block',block_sha256_eolnorm:hashBody('old\n')};
    assert.equal(entryState(e,manifest(root)).state,'unchanged'); await safewrite(file,canonicalBlock('changed')); assert.equal(entryState(e,manifest(root)).state,'changed');
  });
  await test('registration subtree ignores host live state', async root => {
    const file=path.join(root,'host.json'), subtree={command:'node',args:['launcher'],env:{B:'2',A:'1'}};
    await safewrite(file,JSON.stringify({mcpServers:{council:subtree,other:{value:2}},live:'changed'}));
    const e={file,name:'council',method:'json-single-key',entry_sha256:entryHash(subtree),removal:'restore_pre_existing_entry'};
    assert.equal(entryState(e,manifest(root)).state,'unchanged'); assert.equal(entryHash({b:2,a:1}),entryHash({a:1,b:2}));
    assert.equal(registrationState(subtree,{launcher:'launcher'}).action,'skip');
    assert.equal(registrationState(subtree,{isCouncilServer:p => p==='launcher'}).confirmationRequired,true);
    assert.equal(registrationState(subtree).code,'E_HOST_NAME_TAKEN');
  });
  await test('registration preimages mandatory', async root => {
    const m=manifest(root), e={host:'codex',file:path.join(root,'config.toml'),name:'council',method:'toml-marker-block',block_sha256_eolnorm:sha256('body'),removal:'excise_block',backup:null,pre_existing_table:null};
    m.registrations=[e]; assert.equal(validateManifest(m),m);
    delete e.backup; assert.throws(() => validateManifest(m),/backup/); e.backup=null; delete e.pre_existing_table; assert.throws(() => validateManifest(m),/pre_existing/);
  });
  await test('TOML registration and directory states', async root => {
    const file=path.join(root,'config.toml'), bytes=canonicalBlock('[mcp_servers.council]\nx=1',{style:'hash'}); await safewrite(file,bytes);
    const e={file,method:'toml-marker-block',removal:'excise_block',block_sha256_eolnorm:hashBody(scanMarkers(bytes,{style:'hash'}).block.body)};
    assert.equal(entryState(e,manifest(root)).state,'unchanged'); assert.equal(entryState({path:root,kind:'dir',removal:'rmdir_if_empty'},manifest(root)).state,'unchanged');
  });
}
