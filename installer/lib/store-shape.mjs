// Compare persisted layouts without loading or executing a previous installation.
import fs from 'node:fs';
import path from 'node:path';
import {fail} from './dialogue.mjs';

function tokens(text) {
  let out='';
  for(let i=0;i<text.length;) {
    const c=text[i];
    if(/\s/.test(c)){i++;continue;}
    if(['"',"'",'`'].includes(c)) {
      const start=i++;let closed=false;
      while(i<text.length){if(text[i]==='\\'){i+=2;continue;}if(text[i++]===c){closed=true;break;}}
      if(!closed)throw fail('E-USAGE','Previous store source is incomplete.');
      out+=text.slice(start,i);continue;
    }
    if(text.slice(i,i+2)==='//'){const end=text.indexOf('\n',i+2);i=end<0?text.length:end+1;continue;}
    if(text.slice(i,i+2)==='/*'){const end=text.indexOf('*/',i+2);if(end<0)throw fail('E-USAGE','Previous store source is incomplete.');i=end+2;continue;}
    out+=c;i++;
  }
  return out;
}
function declaration(text,name) {
  const found=text.match(new RegExp('^function '+name+'\\([^]*?^\\}','m'));
  if(!found)throw fail('E-USAGE','Previous store declaration missing: '+name);
  return tokens(found[0]);
}
export function storeShape(root) {
  const job=fs.readFileSync(path.join(root,'lib','jobstore.js'),'utf8'),ledger=fs.readFileSync(path.join(root,'lib','ledger.js'),'utf8');
  const row=ledger.match(/const row = \{[\s\S]*?\n  \};/);
  if(!row)throw fail('E-USAGE','Previous ledger row shape is unknown.');
  return {
    jobs:Object.fromEntries(['jobDirFor','jobDateDir','jobFiles','createJobDir','appendLine','acquireLock','releaseLock'].map(n=>[n,declaration(job,n)])),
    ledger:{row:tokens(row[0]),...Object.fromEntries(['defaultRequester','monthFiles','readBoundedLines'].map(n=>[n,declaration(ledger,n)]))},
  };
}
export function assertStoreShape(previous,current) {
  let before,after;
  try{before=storeShape(previous);after=storeShape(current);}
  catch{throw fail('E-USAGE','Previous job-store or ledger shape differs; review compatibility before migration.');}
  const differing=[];
  for(const group of ['jobs','ledger'])for(const name of Object.keys(after[group]))
    if(before[group][name]!==after[group][name])differing.push(group+'.'+name);
  if(differing.length)throw fail('E-USAGE','store shape differs: '+differing.join(', '));
}
