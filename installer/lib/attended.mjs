// Shared stream-based interaction; secrets never pass through readline's echo.
import readline from 'node:readline/promises';
import {fail} from './dialogue.mjs';
export function streams(ctx) { return {input:ctx.input||process.stdin,output:ctx.output||process.stdout}; }
export function requireTTY(ctx,code='E-USAGE') {
  const s=streams(ctx);
  if(!s.input.isTTY||!s.output.isTTY)throw fail(code,'This operation requires an interactive terminal.');
  return s;
}
export async function ask(ctx,text) {
  const {input,output}=streams(ctx),rl=readline.createInterface({input,output});
  try{return (await rl.question(text)).trim();}finally{rl.close();}
}
export async function confirm(ctx,text) {requireTTY(ctx);return /^y(?:es)?$/i.test(await ask(ctx,text+' [y/N] '));}
export async function secretInput(ctx) {
  const {input,output}=streams(ctx);
  if(!input.isTTY) {
    let value='';for await(const chunk of input){value+=chunk.toString('utf8');if(value.length>4096)throw fail('E-USAGE','Key input too long.');}
    return value.trim();
  }
  if(typeof input.setRawMode!=='function')throw fail('E-USAGE','Hidden terminal input is unavailable.');
  const wasRaw=!!input.isRaw;input.setRawMode(true);input.resume();
  output.write('Gemini API key (hidden): ');
  try{return await new Promise((resolve,reject)=>{
    let value='';
    const done=(error)=>{input.off('data',data);input.off('end',end);input.off('error',done);error?reject(fail('E-USAGE','Key input cancelled.')):resolve(value);};
    const end=()=>done(true);
    const data=chunk=>{for(const c of chunk.toString('utf8')){if(c==='\r'||c==='\n'){done();return;}if(c==='\x03'||c==='\x04'){done(true);return;}if(c==='\x7f'||c==='\b')value=value.slice(0,-1);else if(c>=' ')value+=c;if(value.length>4096){done(true);return;}}};
    input.on('data',data);input.once('end',end);input.once('error',done);
  });}finally{input.setRawMode(wasRaw);input.pause();output.write('\n');}
}
