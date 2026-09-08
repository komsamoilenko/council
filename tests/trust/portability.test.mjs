// T-00 scans production code, including comments: boundary 3 says "appears".
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {files,repo} from './fixture.mjs';
import {FLAGS,render} from '../../installer/lib/render.mjs';
export default function(f){
  const errors=[];
  const check=(name,fn)=>{try{fn();}catch(e){errors.push(name+': '+e.message);}};
  const production=['src','installer','bin'].flatMap(d=>files(path.join(repo,d))).filter(p=>/\.[cm]?js$/.test(p));
  for(const p of production){
    const rel=path.relative(repo,p).split(path.sep).join('/');
    if(rel.startsWith('src/platform/'))continue;
    fs.readFileSync(p,'utf8').split(/\r?\n/).forEach((line,i)=>{
      if(line.includes('// council:portability-exempt')){
        if(!['src/backends/echo.js','src/lib/render.js'].includes(rel))errors.push(rel+':'+(i+1)+': invalid exemption');
        return;
      }
      const bad=[];
      if(/process\.platform/.test(line)&&rel!=='installer/lib/appdirs.mjs')bad.push('process.platform');
      if(/\b(?:taskkill|tasklist|Get-CimInstance|powershell|icacls)\b/i.test(line))bad.push('shell helper');
      if(/(?<![A-Za-z0-9_])[A-Za-z]:[\\/]|\\+Users\\|\/Users\/|\/home\//i.test(line))bad.push('absolute platform path');
      if(/\.exe\b/i.test(line))bad.push('.exe');
      if(/\.join\(\s*(['"]);\1\s*\)/.test(line))bad.push('semicolon path join');
      if(bad.length)errors.push(rel+':'+(i+1)+': '+bad.join(', '));
    });
  }
  check('conditional flags',()=>assert.deepEqual(FLAGS,['INDEX','CONVENTIONS']));
  for(const p of files(path.join(repo,'installer','templates'))){
    const rel=path.relative(repo,p),s=fs.readFileSync(p,'utf8');
    check(rel,()=>{
      assert.doesNotMatch(s,/require\s*\(|\$\{|(?<![A-Za-z0-9_])[A-Za-z]:[\\/]|(?:^|[\s"'`])\/(?!\/)[A-Za-z]|\\\\[A-Za-z]/m);
      const values=Object.fromEntries([...s.matchAll(/\{\{([A-Z][A-Z0-9_]*)\}\}/g)].map(m=>[m[1],'fixture']));
      for(const INDEX of [false,true])for(const CONVENTIONS of [false,true])render(s,values,{INDEX,CONVENTIONS});
    });
  }
  check('template negative controls',()=>{
    for(const s of ['{{#if UNKNOWN}}x{{/if}}','{{#if INDEX}}{{#if CONVENTIONS}}x{{/if}}{{/if}}','{{bad}}'])assert.throws(()=>render(s,{},{}));
  });
  // Current host emission lives in planning.mjs. Check both registration JSON and TOML
  // data flow, and its two sources; a future writer must be added to this inventory.
  check('host registration emitters',()=>{
    const planning=fs.readFileSync(path.join(repo,'installer','lib','planning.mjs'),'utf8');
    const survey=fs.readFileSync(path.join(repo,'installer','lib','survey.mjs'),'utf8');
    const dirs=fs.readFileSync(path.join(repo,'installer','lib','appdirs.mjs'),'utf8');
    assert.match(survey,/node: process\.execPath/);
    assert.match(dirs,/launcher:.*council-server\.js/);
    const registrations=planning.split('\n').filter(s=>/const registration =|const body = .*mcp_servers/.test(s));
    assert.equal(registrations.length,2,'JSON and TOML emitters must both be inspected');
    for(const line of registrations){assert.doesNotMatch(line,/\.(cmd|bat|ps1)\b|\bnpx\b/i);assert.match(line,/ctx\.node/);assert.match(line,/ctx\.dirs\.launcher/);}
    assert.match(registrations[0],/command:ctx\.node,args:\[ctx\.dirs\.launcher\]/);
    assert.match(registrations[1],/command = \$\{JSON\.stringify\(ctx\.node\)\}/);
    assert.match(registrations[1],/args = \[\$\{JSON\.stringify\(ctx\.dirs\.launcher\)\}\]/);
  });
  check('platform export sets',()=>{
    const keys=f.load('platform/win32.js');
    for(const id of ['darwin','linux','unsupported'])assert.deepEqual(Object.keys(f.load('platform/'+id+'.js')).sort(),Object.keys(keys).sort(),id);
  });
  assert.equal(errors.length,0,errors.join('\n'));
}
