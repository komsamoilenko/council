// Owns regression checks for scanner coverage and required license attribution.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {scan} from './scan-personal.mjs';

// Virtual fixtures: no disk writes and no dependence on the caller's ACL identity.
const root=path.join(os.tmpdir(),'council-scanner-virtual');
const originalOpen=fs.openSync,originalRead=fs.readSync,originalClose=fs.closeSync,originalList=fs.readdirSync;
let readFixture;
fs.openSync=file=>readFixture(file);
fs.readSync=(bytes,buffer,offset,length,position)=>bytes.copy(buffer,offset,position,position+length);
fs.closeSync=()=>{};
const entry=(name,type)=>({name,isDirectory:()=>type==='dir',isFile:()=>type==='file',isSymbolicLink:()=>type==='link'});
const person=['De','nis',' ','Samoi','lenko'].join('');
const account=['kom','sa'].join('');
const machinePath='C:/Users/'+account+'/file.txt';
const denied=()=>{throw Object.assign(new Error('Denied'),{code:'EACCES'});};
try {
  fs.readdirSync=dir=>dir===root ? [entry('.git','dir'),entry('blocked','dir'),entry('bad.txt','file'),entry('later','dir'),entry('LICENSE','file')] : dir===path.join(root,'later') ? [entry('last.txt','file')] : denied();
  readFixture=file=>file===path.join(root,'bad.txt') ? denied() : Buffer.from(file===path.join(root,'LICENSE') ? 'Copyright (c) 2026 '+person+'\n' : account);
  const result=scan(root);
  assert.equal(result.files,2);
  assert.equal(result.skipped,2);
  assert.deepEqual(result.hits.filter(h=>h.rule==='unreadable').map(h=>h.file),['blocked','bad.txt']);
  assert.ok(result.hits.some(h=>h.file===path.join('later','last.txt')));
  assert.ok(!result.hits.some(h=>h.file==='LICENSE'));

  fs.readdirSync=()=>[entry('LICENSE','file')];
  readFixture=()=>Buffer.from('Copyright (c) 2026 '+person+'\n'+machinePath);
  assert.ok(scan(root).hits.some(h=>h.file==='LICENSE' && h.line===2));
  readFixture=()=>Buffer.from('Copyright (c) 2026 '+person+' '+machinePath+'\n');
  assert.ok(scan(root).hits.some(h=>h.file==='LICENSE' && h.line===1 && h.rule===0));
  readFixture=()=>Buffer.from('Copyright (c) 2026 '+person+'\n'+person);
  assert.deepEqual(scan(root),{files:1,skipped:0,hits:[]});

  // A-50 applies to token structure, regardless of file name or path.
  fs.readdirSync=()=>[entry('candidate.txt','file')];
  const candidates=[
    ['AppData/Local/Microsoft/Windows/PowerShell/StartupProfileData-NonInteractive',false],
    ['AppData/Local/Microsoft/Windows/PowerShell',false],
    [Buffer.from('fixture base64 credential material').toString('base64'),true],
    ['a1'.repeat(32),true],
    ['AIza'+'b'.repeat(35),true],
    ['ghp_'+'c'.repeat(36),true],
    [Buffer.from(JSON.stringify({sub:'fixture',role:'scanner-test'})).toString('base64url'),true],
    ['a'.repeat(23)+'/'+'b'.repeat(23),false],
    ['a'.repeat(24)+'-'+'b'.repeat(8),true],
  ];
  for(const [value,hit] of candidates) {
    readFixture=()=>Buffer.from(value);
    assert.equal(scan(root).hits.some(h=>h.rule===11),hit,value);
  }

  for(const [label,size,reason] of [
    ['9 MiB one-line file',9*1024*1024,'file_too_large'],
    ['100 KiB single line',100*1024,'line_too_long'],
  ]) {
    fs.readdirSync=()=>[entry('large.md','file')];
    readFixture=()=>Buffer.alloc(size,97);
    let result;
    assert.doesNotThrow(()=>{result=scan(root);});
    assert.equal(result.files,1);
    assert.equal(result.skipped,0);
    assert.equal(result.hits.length,1);
    assert.equal(result.hits[0].file,'large.md');
    assert.equal(result.hits[0].rule,'unscannable');
    assert.equal(result.hits[0].reason,reason);
    console.log(label+' -> one unscannable hit ('+reason+'), no throw');
  }

  // Exact caps are inclusive; long ordinary multiline files remain scannable.
  fs.readdirSync=()=>[entry('boundary.txt','file')];
  readFixture=()=>Buffer.alloc(64*1024,46);
  assert.deepEqual(scan(root),{files:1,skipped:0,hits:[]});
  readFixture=()=>Buffer.from(('.'.repeat(1023)+'\n').repeat(8192));
  assert.deepEqual(scan(root),{files:1,skipped:0,hits:[]});
  readFixture=()=>Buffer.from('ordinary\n'+account+'\n'+machinePath);
  assert.ok(scan(root).hits.some(h=>h.rule===0 && h.line===2));
  assert.ok(scan(root).hits.some(h=>h.rule===10 && h.line===3));
  readFixture=()=>Buffer.from('ordinary\n'+account,'utf16le');
  assert.ok(scan(root).hits.some(h=>h.rule===0 && h.part==='utf16' && h.line===2));

  fs.readdirSync=()=>[];
  assert.ok(scan(root).hits.some(h=>h.rule==='no-files-inspected'));
  fs.readdirSync=denied;
  assert.equal(scan(root).skipped,1);
  fs.readdirSync=()=>[entry('link','link')];
  assert.equal(scan(root).skipped,1);
} finally {
  fs.openSync=originalOpen;
  fs.readSync=originalRead;
  fs.closeSync=originalClose;
  fs.readdirSync=originalList;
}
console.log('scan-personal regression checks passed');
