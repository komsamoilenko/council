import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {machineBytes} from '../../../installer/lib/machine.mjs';
import {vendoredRipgrep,sha256} from '../../../installer/lib/survey.mjs';

export default async function(test) {
  await test('template keys, metadata, merge and contained readable ripgrep',async root=>{
    const template=JSON.parse(fs.readFileSync(new URL('../../../installer/templates/profile/machine.template.json',import.meta.url)));
    const codex=path.join(root,'codex','bin','codex.js');
    const rg=path.join(root,'codex','node_modules','@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc','codex-path','rg.exe');
    fs.mkdirSync(path.dirname(codex),{recursive:true});fs.writeFileSync(codex,'fixture');
    fs.mkdirSync(path.dirname(rg),{recursive:true});fs.writeFileSync(rg,'fixture');
    const clis={claude:{usable:true,path:path.join(root,'claude.exe'),version:'2.1.263'},codex:{usable:true,path:codex,version:'0.153.2',rg:vendoredRipgrep(codex,'win32')}};
    assert.equal(clis.codex.rg,rg);
    const detect={blocks:[{name:'clis',clis},{name:'node',version:'24.11.1'},{name:'npm',root}]};
    const ctx={node:process.execPath,dirs:{id:'win32',skill:path.join(root,'SKILL.md')},now:()=>new Date('2026-09-11T00:00:00Z'),platform:{systemBinaries:()=>({powershell:'fixture',tasklist:'fixture',taskkill:'fixture'})}};
    const render=machine=>JSON.parse(machineBytes(machine,detect,ctx,'default'));
    const doc=render(null);
    assert.deepEqual(Object.keys(doc).sort(),Object.keys(template).sort());
    assert.deepEqual(Object.keys(doc.binaries).sort(),Object.keys(template.binaries).sort());
    assert.equal(doc.binaries.gemini_api_js,template.binaries.gemini_api_js);
    assert.equal(doc.written_at,ctx.now().toISOString());
    assert.deepEqual(doc.versions_at_install,{node:'24.11.1',claude:'2.1.263',codex:'0.153.2'});
    assert.deepEqual(doc.notice_ack,{notice_sha256:sha256(fs.readFileSync(new URL('../../../NOTICE.md',import.meta.url))),accepted_at:doc.written_at});
    const old={...doc,custom:'kept',binaries:{...doc.binaries,custom:'kept'},shared:{...doc.shared,custom:'kept',profiles:['other']}};
    const merged=render(old);assert.equal(merged.custom,'kept');assert.equal(merged.binaries.custom,'kept');assert.equal(merged.shared.custom,'kept');assert.deepEqual(merged.shared.profiles,['other','default']);assert.deepEqual(merged.notice_ack,old.notice_ack);
    ctx.now=()=>new Date('2026-09-12T00:00:00Z');
    assert.deepEqual(render(merged),merged,'an unchanged plan preserves its write timestamp');
    clis.codex.version='0.153.3';assert.equal(render(merged).written_at,ctx.now().toISOString());
    fs.unlinkSync(rg);clis.codex.rg=vendoredRipgrep(codex,'win32');
    assert.equal(clis.codex.rg,null);assert.equal('rg' in render(old).binaries,false);
    fs.mkdirSync(rg);assert.equal(vendoredRipgrep(codex,'win32'),null);fs.rmdirSync(rg);
    const outside=path.join(root,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'rg.exe'),'outside');
    fs.rmdirSync(path.dirname(rg));fs.symlinkSync(outside,path.dirname(rg),'junction');
    assert.equal(vendoredRipgrep(codex,'win32'),null);
    assert.equal(vendoredRipgrep(codex,'linux'),null);
    process.stdout.write('PASS hydration template keys all; rg absent for missing, directory and escaping junction fixtures\n');
  });
}
