// Owns host entry publication and surgical recovery, never whole-file restoration.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { spliceJsonEntry } from './host-json.mjs';
import { spliceToml, restoreToml, tokenizeToml, councilSpan } from './tomlblock.mjs';
import { writeHostSplice } from './safewrite.mjs';
import { entryHash } from './manifest.mjs';
import { scanMarkers, hashBody } from './markers.mjs';
import platform from '../../src/platform/index.js';

export function registrationEdit(r, before) {
  if (!path.isAbsolute(r.command) || /\.(cmd|bat|ps1)$/i.test(r.command) || r.args.length !== 1 || !path.isAbsolute(r.args[0]) || Object.keys(r.env).some(k => !['COUNCIL_HOST','COUNCIL_PROFILE'].includes(k))) throw new Error('E_SHIM_REGISTRATION');
  const entry = { ...(r.surface === 'claude-code' ? {type:'stdio'} : {}), command:r.command,args:r.args,env:r.env };
  const body = `[mcp_servers.${r.name}]\ncommand = ${JSON.stringify(r.command)}\nargs = [${JSON.stringify(r.args[0])}]\ntool_timeout_sec = 60\n[mcp_servers.${r.name}.env]\nCOUNCIL_HOST = "codex"\nCOUNCIL_PROFILE = ${JSON.stringify(r.env.COUNCIL_PROFILE)}\n`;
  const edit = r.surface === 'codex' ? spliceToml(before,body,{name:r.name,adoptExisting:r.adoptExisting}) : spliceJsonEntry(before,r.name,entry);
  if (!edit.ok) throw new Error(edit.code);
  const record = {host:r.surface,file:r.path,name:r.name,backup:null,
    ...(r.surface === 'codex' ? {method:'toml-marker-block',pre_existing_table:r.adoptExisting?before.subarray(edit.oldRange.start,edit.oldRange.end).toString('utf8'):null,block_sha256_eolnorm:hashBody(scanMarkers(edit.bytes,{style:'hash',ignoreLines:tokenizeToml(edit.bytes).ignoreLines}).block.body),removal:'excise_block'} :
      {method:r.surface === 'claude-code'&&!r.adoptExisting?'claude-mcp-add-json':'json-single-key',scope:'user',pre_existing_entry:edit.previous,entry_sha256:entryHash(entry),removal:edit.previous?'restore_pre_existing_entry':'delete_key_if_'+'entry_hash_matches'})};
  return {edit,entry,record};
}
// One content verifier for publication, resume and rollback. Host bytes are diagnostic only.
export function registrationMatches(bytes, record, previous = false) {
  try {
    if (record.host !== 'codex') {
      const value = bytes.length ? JSON.parse(bytes.toString('utf8').replace(/^\ufeff/, '')).mcpServers?.[record.name] ?? null : null;
      return entryHash(value) === (previous ? entryHash(record.pre_existing_entry ?? null) : record.entry_sha256);
    }
    const scan = scanMarkers(bytes, {style:'hash', ignoreLines:tokenizeToml(bytes).ignoreLines});
    if (!scan.ok) return false;
    const block=scan.block;
    if (!previous) return !!block && hashBody(block.body) === record.block_sha256_eolnorm;
    if (!record.pre_existing_table) return !block && !councilSpan(bytes,{name:record.name}).span;
    const old=Buffer.from(record.pre_existing_table),oldBlock=scanMarkers(old,{style:'hash',ignoreLines:tokenizeToml(old).ignoreLines}).block;
    if(oldBlock)return !!block&&hashBody(block.body)===hashBody(oldBlock.body);
    const span=councilSpan(bytes,{name:record.name}).span;
    return !block&&!!span&&hashBody(bytes.subarray(span.start,span.end))===hashBody(old);
  } catch { return false; }
}
export function recoverRegistration(current, undo) {
  if (undo.registration.host !== 'codex') return spliceJsonEntry(current,undo.registration.name,undo.registration.pre_existing_entry);
  return restoreToml(current,Buffer.from(undo.before,'base64'),{bytes:Buffer.from(undo.expected,'base64'),oldRange:undo.oldRange,newRange:undo.newRange},{name:undo.registration.name});
}
export async function publishRegistration(r, before, edit, undo, ctx, backup, clis) {
  let method = undo.registration.method;
  const writer = async (file, bytes) => {
    const {safewrite} = await import('./safewrite.mjs');
    if (r.surface === 'claude-code') {
      const cli = clis.claude?.path;
      const added = cli && !r.adoptExisting ? ctx.run(cli,['mcp','add-json',r.name,JSON.stringify(undo.entry),'-s','user']) : {status:1};
      if (added.status === 0) {
        if (ctx.run(cli,['mcp','get',r.name]).status !== 0) throw new Error('E_HOST_READBACK');
        const actual = JSON.parse(fs.readFileSync(file,'utf8').replace(/^\ufeff/,'')).mcpServers?.[r.name];
        if (entryHash(actual) !== undo.registration.entry_sha256) throw new Error('E_HOST_READBACK');
        return;
      }
      // Fail closed if process inspection is unavailable. Tests inject the answer,
      // never an environment switch that could weaken a production registration.
      const probe=(ctx.platform||platform).processNameProbe('claude',ctx.env);
      const idle=ctx.claudeIdle?await ctx.claudeIdle():probe?ctx.run(probe.file,probe.args):null;
      if (ctx.env.CLAUDECODE || !(idle===true || idle?.status===0&&idle.stdout.trim()==='0')) throw new Error('claude fallback running or unknown');
      const live=fs.existsSync(file)?fs.readFileSync(file):Buffer.alloc(0);
      if (!live.equals(before)) throw Object.assign(new Error('plan_stale'),{exitCode:3});
      method = 'json-single-key';
    }
    await safewrite(file,bytes);
  };
  await writeHostSplice(r.path,before,edit,{dryRun:false,backup,writer,serializedByHost:r.surface==='claude-code',verify:bytes=>registrationMatches(bytes,undo.registration),recover:current=>recoverRegistration(current,undo)});
  if (r.surface === 'codex' && clis.codex?.path) {
    const p=clis.codex.path, result=/\.[cm]?js$/i.test(p)?ctx.run(ctx.node,[p,'mcp','list']):ctx.run(p,['mcp','list']);
    if (result.status !== 0) throw new Error('E_HOST_READBACK');
  }
  return method;
}

export async function doctorHandshake(r, ctx) {
  return new Promise((resolve,reject) => {
    const env={...ctx.env,...r.env,COUNCIL_LEDGER_PREFIX:'setup-',COUNCIL_SMOKE_RUN:'1'};
    delete env.COUNCIL_CONFIG;
    const child=spawn(r.command,r.args,{env,cwd:ctx.dirs.runtimeRoot,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let buffer='',done=false,stderr='';
    const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);child.once('close',()=>error?reject(error):resolve(result));child.stdin.end();child.kill();};
    const timer=setTimeout(()=>finish(new Error('host_doctor_timeout')),15000);
    const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
    child.on('error',finish); child.stdin.on('error',finish);
    child.on('exit',()=>{if(!done)finish(new Error('host_doctor_exit: '+stderr.slice(-500)));});
    child.stderr.on('data',data=>{stderr=(stderr+data).slice(-2000);});
    child.stdout.on('data',data=>{
      buffer+=data;
      for(let i;(i=buffer.indexOf('\n'))>=0;) {
        const line=buffer.slice(0,i);buffer=buffer.slice(i+1);let message;
        try {message=JSON.parse(line);}catch{return finish(new Error('host_invalid_rpc'));}
        if(message.error)return finish(new Error('host_rpc_error'));
        if(message.id===1){if(!message.result?.protocolVersion)return finish(new Error('host_initialize_invalid'));send({jsonrpc:'2.0',method:'notifications/initialized'});send({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'council_doctor',arguments:{}}});}
        if(message.id===2){if(message.result?.isError || !message.result?.content)return finish(new Error('host_doctor_failed'));finish(null,message.result);}
      }
    });
    send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'council-setup',version:'0.1.0'}}});
  });
}
