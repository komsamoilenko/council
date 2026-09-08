// Owns ACL failure-path regression checks; fixtures are virtual system-temp paths.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const sourcePath=new URL('../src/platform/win32.js',import.meta.url);
const source=fs.readFileSync(sourcePath,'utf8');
const nativeRequire=createRequire(sourcePath);
async function scenario(options={}) {
  const events=[],files=new Map();
  const dir=path.join(os.tmpdir(),'council-acl-virtual');
  let readable=true;
  const fakeFs={...fs,
    readdirSync(){events.push('list');if(!readable)throw new Error('unreadable');return [];},
    writeFileSync(p,s){events.push('write');files.set(p,s);},
    readFileSync(p){return options.badProbe?'bad':files.get(p);},
    unlinkSync(p){events.push('unlink');files.delete(p);},
  };
  const context={require:n=>n==='fs'?fakeFs:nativeRequire(n),module:{exports:{}},process,__dirname:path.dirname(sourcePath.pathname),setTimeout};
  vm.runInNewContext(source+'\nmodule.exports.setHelpers=(p,r)=>{ps=p;run=r;};',context);
  context.module.exports.setHelpers(async command=>{
    if(command.startsWith('(Get-Acl')){events.push('snapshot');return options.saved??'D:AI(A;OICI;FA;;;SY)';}
    if(command.includes('WindowsIdentity'))return 'S-1-5-21-1';
    if(command.startsWith('$p=')){events.push('prune');if(options.pruneFails)throw new Error('prune failed');return '';}
    events.push('restore');if(options.restoreFails)throw new Error('restore failed');readable=true;return '';
  },async (_binary,args)=>{
    if(args.includes('/grant:r')){events.push('grant');if(options.grantFails){readable=false;return {ok:false};}return {ok:true};}
    const option=args[1];events.push(option);
    readable=option==='/reset'?!options.resetFails:!options.inheritanceFails;
    return {ok:readable};
  });
  const result=await context.module.exports.restrictToOwner(dir);
  assert.equal(files.size,0,'probe cleanup');
  return {result,events};
}
let r=await scenario();assert.equal(r.result.ok,true);assert.ok(r.events.includes('prune'));
r=await scenario({grantFails:true});
assert.equal(JSON.stringify(r.result),JSON.stringify({ok:false,reason:'backup_acl_not_restricted',reverted:true}));
assert.ok(r.events.indexOf('list')<r.events.indexOf('restore'),'post-check follows failed grant');
assert.equal(r.result.error.message,'ACL owner grant failed');
r=await scenario({grantFails:true,restoreFails:true,resetFails:true});
assert.ok(r.events.indexOf('/reset')<r.events.indexOf('/inheritance:e'));assert.equal(r.result.reverted,true);
assert.equal(r.result.error.cause.cause.message,'restore failed');
for(const saved of ['', 'D:', 'D:PAI', 'invalid']) {
  r=await scenario({saved,grantFails:true});assert.ok(!r.events.includes('restore'));assert.ok(r.events.includes('/reset'));assert.equal(r.result.reverted,true);
}
r=await scenario({grantFails:true,restoreFails:true,resetFails:true,inheritanceFails:true});assert.equal(r.result.reverted,false);
r=await scenario({badProbe:true});assert.equal(r.result.ok,false);assert.ok(r.events.includes('unlink'));
r=await scenario({pruneFails:true});assert.equal(r.result.ok,false);assert.equal(r.result.reverted,true);
console.log('win32 ACL regression checks passed');
