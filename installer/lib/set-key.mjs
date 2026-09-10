// Key lifetime is limited to input, an HTTPS header and the OS store's stdin.
import https from 'node:https';
import path from 'node:path';
import platform from '../../src/platform/index.js';
import {readJSON,exists,linked,realFuture,under} from './survey.mjs';
import {safewrite} from './safewrite.mjs';
import {fail} from './dialogue.mjs';
import {requireTTY,confirm,secretInput} from './attended.mjs';
export async function validateKey(endpoint,key) {
  const url=new URL(endpoint);
  if(url.protocol!=='https:' || url.username || url.password || (url.port && url.port!=='443') || url.search || url.hash || !(url.hostname==='generativelanguage.googleapis.com' || /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.aiplatform\.googleapis\.com$/.test(url.hostname))) throw new Error('gemini_endpoint_rejected');
  url.pathname=url.pathname.replace(/\/$/,'')+'/models';
  return new Promise(resolve=>{
    const req=https.request(url,{method:'GET',headers:{'x-goog-api-key':key},timeout:15000},res=>{res.resume();resolve(res.statusCode>=200&&res.statusCode<300);});
    req.on('error',()=>resolve(false));req.on('timeout',()=>req.destroy());req.end();
  });
}
export async function setKey(options,ctx) {
  const host=ctx.platform||platform;if(!host.implemented.secrets)throw fail('E-PLATFORM');
  const config=readJSON(ctx.dirs.config),machine=readJSON(ctx.dirs.machine);
  if(!config||!machine)throw fail('E-USAGE','Install the profile before setting its key.');
  const root=config.runtime_root;
  if(!path.isAbsolute(root)||!under(realFuture(root),realFuture(ctx.dirs.stateAnchor))||under(realFuture(root),realFuture(config.vault))||await linked(root,ctx))throw fail('E-USAGE','Invalid secret store root.');
  const descriptor={profile:options.profile||'default',runtimeRoot:root,binary:host.secretHelper(machine.binaries||{})};
  const file=host.secretPath(descriptor);if(await linked(file,ctx))throw fail('E-REPARSE-TARGET');
  if(options.delete) {
    const {output}=requireTTY(ctx,'E-SETKEY-NON-TTY');output.write(file+'\nthis holds your DPAPI-protected Gemini API key; deleting it means `council-setup set-key` again\n');
    if(!await confirm(ctx,'Delete this key?'))return {removed:false,exitCode:5};
    const removed=exists(file);host.secretDelete(descriptor);return {removed,exitCode:0};
  }
  let key='';
  try {
    key=await secretInput(ctx);if(key.length<=4)throw fail('E-USAGE','No key was supplied.');
    let ok=false;try{ok=await (ctx.validateKey||validateKey)(config.gemini?.endpoint||'https://generativelanguage.googleapis.com/v1beta',key);}catch{}
    if(!ok)throw fail('E-GEMINI-KEY-REJECTED');
    if(await linked(file,ctx))throw fail('E-REPARSE-TARGET');
    try{await host.secretSet(descriptor,Buffer.from(key,'utf8').toString('base64'),safewrite);}catch{throw fail('E-STEP','Credential store operation failed.');}
    return {stored:true,last_four:key.slice(-4),exitCode:0};
  }finally{key='';}
}
