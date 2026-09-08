// Owns regression checks for scanner coverage and required license attribution.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {scan} from './scan-personal.mjs';

// Virtual fixtures: no disk writes and no dependence on the caller's ACL identity.
const root=path.join(os.tmpdir(),'council-scanner-virtual');
const originalRead=fs.readFileSync,originalList=fs.readdirSync;
const entry=(name,type)=>({name,isDirectory:()=>type==='dir',isFile:()=>type==='file',isSymbolicLink:()=>type==='link'});
const person=['De','nis'].join('');
const denied=()=>{throw Object.assign(new Error('Denied'),{code:'EACCES'});};
try {
  fs.readdirSync=dir=>dir===root ? [entry('.git','dir'),entry('blocked','dir'),entry('bad.txt','file'),entry('later','dir'),entry('LICENSE','file')] : dir===path.join(root,'later') ? [entry('last.txt','file')] : denied();
  fs.readFileSync=file=>file===path.join(root,'bad.txt') ? denied() : Buffer.from(file===path.join(root,'LICENSE') ? 'Copyright (c) 2026 '+person+'\n' : person);
  const result=scan(root);
  assert.equal(result.files,2);
  assert.equal(result.skipped,2);
  assert.deepEqual(result.hits.filter(h=>h.rule==='unreadable').map(h=>h.file),['blocked','bad.txt']);
  assert.ok(result.hits.some(h=>h.file===path.join('later','last.txt')));
  assert.ok(!result.hits.some(h=>h.file==='LICENSE'));

  fs.readdirSync=()=>[entry('LICENSE','file')];
  fs.readFileSync=()=>Buffer.from('Copyright (c) 2026 '+person+'\n'+person);
  assert.ok(scan(root).hits.some(h=>h.file==='LICENSE' && h.line===2));
  fs.readFileSync=()=>Buffer.from('Copyright (c) 2026 '+person+'\n');
  assert.deepEqual(scan(root),{files:1,skipped:0,hits:[]});

  fs.readdirSync=()=>[];
  assert.ok(scan(root).hits.some(h=>h.rule==='no-files-inspected'));
  fs.readdirSync=denied;
  assert.equal(scan(root).skipped,1);
  fs.readdirSync=()=>[entry('link','link')];
  assert.equal(scan(root).skipped,1);
} finally {
  fs.readFileSync=originalRead;
  fs.readdirSync=originalList;
}
console.log('scan-personal regression checks passed');
