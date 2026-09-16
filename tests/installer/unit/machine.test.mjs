import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import platform from '../../../src/platform/index.js';
import version from '../../../src/version.js';
import {machineBytes,updateSource,LATEST_ASSET} from '../../../installer/lib/machine.mjs';
import {vendoredRipgrep,sha256} from '../../../installer/lib/survey.mjs';

export default async function(test) {
  await test('template keys, metadata, merge and contained readable ripgrep',async root=>{
    const template=JSON.parse(fs.readFileSync(new URL('../../../installer/templates/profile/machine.template.json',import.meta.url)));
    const codex=path.join(root,'codex','bin','codex.js');
    const rg=path.join(platform.rgVendorDir(codex),platform.expectedImage('rg'));
    fs.mkdirSync(path.dirname(codex),{recursive:true});fs.writeFileSync(codex,'fixture');
    fs.mkdirSync(path.dirname(rg),{recursive:true});fs.writeFileSync(rg,'fixture');
    const clis={claude:{usable:true,path:path.join(root,'claude.exe'),version:'2.1.263'},codex:{usable:true,path:codex,version:'0.153.2',rg:vendoredRipgrep(codex)}};
    assert.equal(clis.codex.rg,rg);
    const detect={blocks:[{name:'clis',clis},{name:'node',version:'24.11.1'},{name:'npm',root}]};
    fs.mkdirSync(path.join(root,'.git'));
    const ctx={node:process.execPath,dirs:{id:'win32',skill:path.join(root,'SKILL.md')},now:()=>new Date('2026-09-11T00:00:00Z'),platform:{systemBinaries:()=>({powershell:'fixture',tasklist:'fixture',taskkill:'fixture'})},installerRoot:root};
    const render=machine=>JSON.parse(machineBytes(machine,detect,ctx,'default'));
    const doc=render(null);
    assert.deepEqual(doc.source,{channel:'git',worktree:root,ref:'HEAD'},'an installer run from a git worktree records that worktree as the update source');
    assert.equal(doc.written_by,'council-setup '+version.APP_VERSION);
    assert.deepEqual(doc.shared.app_versions,[version.APP_VERSION]);
    assert.deepEqual(Object.keys(doc).sort(),Object.keys(template).sort());
    assert.deepEqual(Object.keys(doc.binaries).sort(),Object.keys(template.binaries).sort());
    assert.equal(doc.binaries.gemini_api_js,template.binaries.gemini_api_js);
    assert.equal(doc.written_at,ctx.now().toISOString());
    assert.deepEqual(doc.versions_at_install,{node:'24.11.1',claude:'2.1.263',codex:'0.153.2'});
    assert.deepEqual(doc.notice_ack,{notice_sha256:sha256(fs.readFileSync(new URL('../../../NOTICE.md',import.meta.url))),accepted_at:doc.written_at});
    const old={...doc,custom:'kept',binaries:{...doc.binaries,custom:'kept'},shared:{...doc.shared,custom:'kept',profiles:['other']}};
    const merged=render(old);assert.equal(merged.custom,'kept');assert.equal(merged.binaries.custom,'kept');assert.equal(merged.shared.custom,'kept');assert.deepEqual(merged.shared.profiles,['other','default']);assert.deepEqual(merged.notice_ack,old.notice_ack);
    assert.deepEqual(render({...doc,shared:{...doc.shared,app_versions:['0.0.9']}}).shared.app_versions,['0.0.9',version.APP_VERSION],'an older recorded version is retained and the running one appended');
    ctx.now=()=>new Date('2026-09-12T00:00:00Z');
    assert.deepEqual(render(merged),merged,'an unchanged plan preserves its write timestamp');
    clis.codex.version='0.153.3';assert.equal(render(merged).written_at,ctx.now().toISOString());
    fs.unlinkSync(rg);clis.codex.rg=vendoredRipgrep(codex);
    assert.equal(clis.codex.rg,null);assert.equal('rg' in render(old).binaries,false);
    fs.mkdirSync(rg);assert.equal(vendoredRipgrep(codex),null);fs.rmdirSync(rg);
    const outside=path.join(root,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,platform.expectedImage('rg')),'outside');
    fs.rmdirSync(path.dirname(rg));fs.symlinkSync(outside,path.dirname(rg),'junction');
    assert.equal(vendoredRipgrep(codex),null);
    process.stdout.write('PASS hydration template keys all; rg absent for missing, directory and escaping junction fixtures\n');
  });
  await test('update source: git worktree, extracted release, unknown origin, and a hand-set source kept',async root=>{
    const clis={claude:{usable:false,path:null,version:null},codex:{usable:false,path:null,version:null,rg:null}};
    const detect={blocks:[{name:'clis',clis},{name:'node',version:'24.11.1'},{name:'npm',root}]};
    const base={node:process.execPath,dirs:{id:'win32',skill:path.join(root,'SKILL.md')},now:()=>new Date('2026-09-16T00:00:00Z'),platform:{systemBinaries:()=>({powershell:'fixture',tasklist:'fixture',taskkill:'fixture'})}};
    const render=(machine,installerRoot)=>JSON.parse(machineBytes(machine,detect,{...base,installerRoot},'default'));
    // A git worktree: update reads its checkout.
    const clone=path.join(root,'clone');fs.mkdirSync(path.join(clone,'.git'),{recursive:true});
    assert.deepEqual(updateSource({installerRoot:clone}),{channel:'git',worktree:clone,ref:'HEAD'});
    // An extracted release: the repository's latest fixed-name asset, from package.json, either repository form.
    const extracted=path.join(root,'extracted');fs.mkdirSync(extracted);
    fs.writeFileSync(path.join(extracted,'package.json'),JSON.stringify({name:'council',repository:{type:'git',url:'git+https://github.com/example-owner/council.git'}}));
    assert.deepEqual(updateSource({installerRoot:extracted}),{channel:'zip',asset:'https://github.com/example-owner/council/releases/latest/download/'+LATEST_ASSET});
    fs.writeFileSync(path.join(extracted,'package.json'),JSON.stringify({name:'council',repository:'https://github.com/example-owner/council'}));
    assert.deepEqual(updateSource({installerRoot:extracted}).asset,'https://github.com/example-owner/council/releases/latest/download/'+LATEST_ASSET);
    // Unknown origin records nothing rather than guessing, and the key is absent from the document.
    const bare=path.join(root,'bare');fs.mkdirSync(bare);
    assert.equal(updateSource({installerRoot:bare}),null);
    assert.equal(updateSource({}),null);
    assert.equal('source' in render(null,bare),false);
    // A source the user set by hand survives a re-apply from anywhere.
    const own={channel:'zip',asset:'https://example.invalid/council.zip'};
    assert.deepEqual(render({schema:2,source:own},clone).source,own);
    assert.deepEqual(render(null,clone).source,{channel:'git',worktree:clone,ref:'HEAD'});
    process.stdout.write('PASS update source recorded from the installer tree and never overwritten\n');
  });
}
