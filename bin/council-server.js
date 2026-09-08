#!/usr/bin/env node
// Owns version-independent main-module launch; specification §4.8.
'use strict';
const fs=require('fs'),path=require('path'),Module=require('module');
const root=path.resolve(__dirname,'..');
function fail(message){process.stderr.write('[council] '+message+'\n[council] run: council-setup verify\n');process.exit(78);}
let version;
try{version=JSON.parse(fs.readFileSync(path.join(root,'current.json'),'utf8').replace(/^\uFEFF/,'')).version;}catch{fail('cannot read current.json');}
if(typeof version!=='string' || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(version))fail('invalid version in current.json');
const target=path.join(root,'app',version,'server.js');
if(!fs.existsSync(target))fail('selected version is not installed');
process.argv[1]=target;
// Verified target require.main identity on Node v24.11.1; Node 20.11 is unverified.
Module.runMain();
