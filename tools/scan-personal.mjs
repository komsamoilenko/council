// Owns the release-tree personal-data gate; specification §14.1.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const forbidden = [
  ['kom','sa'],['De','nis'],['Samoi','lenko'],['Pay','sera'],['pay','sera\\.net'],['\\b','ps','r','\\b'],
  ['anthropic:', 'cli'],['openai:chatgpt-', 'personal'],['google:', 'aipro'],
  ['app to work ', 'with AI'],['2026-09-07-council-', 'build'],['2026-09-07-council-', 'installer'],
].map(parts=>new RegExp(parts.join(''),'gi'));
const userPath = new RegExp('C:'+String.raw`(?:\\+|/+)Users(?:\\+|/+)(?!<you>)[A-Za-z]`,'gi');
const opaque = /[A-Za-z0-9_+\/-]{32,}={0,2}/g;
export function scan(root) {
  root=path.resolve(root);
  const hits=[]; let files=0,skipped=0;
  const inspect=(s,rel,part)=>{ for(const [index,re] of [...forbidden,userPath,opaque].entries()) {
    re.lastIndex=0;
    for(const m of s.matchAll(re)) {
      const line=s.slice(0,m.index).split('\n').length;
      // The author's name in the root MIT copyright notice is required attribution.
      if(rel==='LICENSE' && part!=='name' && index<3 && /^Copyright \(c\) \d{4} /u.test(s.split('\n')[line-1]))continue;
      hits.push({file:rel,line,rule:index,part});
    }
  } };
  const skip=(rel,rule)=>{skipped++;hits.push({file:rel,rule});};
  const walk=dir=>{
    let entries;
    try {entries=fs.readdirSync(dir,{withFileTypes:true});}
    catch {skip(path.relative(root,dir)||'.','unreadable');return;}
    for(const entry of entries) {
    // VCS metadata is not a release file; all working files, including ignored ones, are scanned.
    if(dir===root && entry.name==='.git')continue;
    const p=path.join(dir,entry.name),rel=path.relative(root,p);inspect(entry.name,rel,'name');
    if(entry.isSymbolicLink()) {skip(rel,'symlink');continue;}
    if(entry.isDirectory())walk(p);else {
      if(!entry.isFile()) {skip(rel,'unsupported');continue;}
      let bytes;
      try {bytes=fs.readFileSync(p);}catch {skip(rel,'unreadable');continue;}
      inspect(bytes.toString('utf8'),rel,'content');if(bytes.includes(0))inspect(bytes.toString('utf16le'),rel,'utf16');
      files++;
    }
  }};
  walk(root);
  if(files===0)hits.push({file:'.',rule:'no-files-inspected'});
  return {files,skipped,hits};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const result=scan(path.resolve(process.argv[2] || '.'));
  for(const h of result.hits)process.stderr.write(JSON.stringify(h)+'\n');
  process.stdout.write('scan-personal: '+result.files+' files, '+result.skipped+' skipped, '+result.hits.length+' hits\n');process.exitCode=result.hits.length || result.skipped || !result.files?1:0;
}
