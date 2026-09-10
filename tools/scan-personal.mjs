// Owns the release-tree personal-data gate; specification §14.1.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const forbidden = [
  ['kom','sa'],['Pay','sera'],['pay','sera\\.net'],['\\b','ps','r','\\b'],
  ['anthropic:', 'cli'],['openai:chatgpt-', 'personal'],['google:', 'aipro'],
  ['app to work ', 'with AI'],['2026-09-07-council-', 'build'],['2026-09-07-council-', 'installer'],
].map(parts=>new RegExp(parts.join(''),'gi'));
const userPath = new RegExp('C:'+String.raw`(?:\\+|/+)Users(?:\\+|/+)(?!<you>)[A-Za-z]`,'gi');
const opaque = /[A-Za-z0-9_+\/-]{32,}={0,2}/g;
const maxFileBytes=8*1024*1024,maxLineLength=64*1024;
// Read at most one byte beyond the cap, including when a file grows during reading.
function readBounded(file) {
  const fd=fs.openSync(file,'r'),chunks=[];
  let size=0;
  try {
    while(size<=maxFileBytes) {
      const chunk=Buffer.alloc(Math.min(64*1024,maxFileBytes+1-size));
      const count=fs.readSync(fd,chunk,0,chunk.length,size);
      if(count===0)break;
      chunks.push(chunk.subarray(0,count));size+=count;
    }
    return Buffer.concat(chunks,size);
  } finally {fs.closeSync(fd);}
}
export function scan(root) {
  root=path.resolve(root);
  const hits=[]; let files=0,skipped=0;
  const inspect=(s,rel,part)=>{
    const lines=s.split('\n');
    const longLine=lines.findIndex(line=>line.length>maxLineLength);
    if(longLine!==-1) {
      hits.push({file:rel,line:longLine+1,rule:'unscannable',reason:'line_too_long',part});
      return false;
    }
    for(const [offset,line] of lines.entries()) {
      for(const [index,re] of [...forbidden,userPath,opaque].entries()) {
        re.lastIndex=0;
        for(const m of line.matchAll(re)) {
          // A-50: segmented paths are candidates only with an unbroken token run.
          if(re===opaque && !/[A-Za-z0-9+=_]{24}/.test(m[0]))continue;
          hits.push({file:rel,line:offset+1,rule:index,part});
        }
      }
    }
    return true;
  };
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
      try {bytes=readBounded(p);}catch {skip(rel,'unreadable');continue;}
      files++;
      if(bytes.length>maxFileBytes) {
        hits.push({file:rel,rule:'unscannable',reason:'file_too_large'});
        continue;
      }
      if(inspect(bytes.toString('utf8'),rel,'content') && bytes.includes(0))inspect(bytes.toString('utf16le'),rel,'utf16');
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
