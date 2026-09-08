// Owns app-manifest verification before runtime writes; specification §1 I1 and §5.
'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const platform=require('../platform'),{APP_VERSION}=require('../version');
function check(appDir=path.resolve(__dirname,'..'), manifestPath=path.join(platform.appDirs().etc,'manifests','app-'+APP_VERSION+'.json')) {
  const failures=[]; const fail=p=>failures.push('app_integrity_failed:'+p);
  let manifest; try { manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8').replace(/^\uFEFF/,'')); } catch { fail('manifest'); return {ok:false,failures}; }
  const entries=Array.isArray(manifest.files) ? manifest.files.map(x=>[x.path || x.relpath,x.sha256]) : Object.entries(manifest.files || {}).map(([k,v])=>[k,typeof v==='string'?v:v.sha256]);
  const listed=new Set();
  if(!entries.length) fail('manifest');
  for(const [rel,hash] of entries) {
    if(typeof rel!=='string' || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..') || typeof hash!=='string') { fail('manifest'); continue; }
    const key=rel.replace(/\\/g,'/'); if(listed.has(key)) {fail(key); continue;} listed.add(key);
    try { const p=path.join(appDir,rel); const st=fs.lstatSync(p); if(!st.isFile() || st.isSymbolicLink() || !require('./paths').isUnder(fs.realpathSync(p),fs.realpathSync(appDir))) throw new Error(); if(crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')!==hash) fail(key); } catch { fail(key); }
  }
  function walk(dir) { for(const e of fs.readdirSync(dir,{withFileTypes:true})) { const p=path.join(dir,e.name),rel=path.relative(appDir,p).replace(/\\/g,'/'); if(e.isSymbolicLink()) {fail(rel); continue;} if(e.isDirectory()) walk(p); else if(/\.(js|mjs|cjs|json|node)$/i.test(e.name) && !listed.has(rel)) fail(rel); } }
  try {walk(appDir);} catch {fail('unreadable');}
  return {ok:failures.length===0,failures};
}
module.exports={check};
