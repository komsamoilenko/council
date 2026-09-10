// Owns plaintext key lifetime, stdin transport and API requests; specification §§6.3–6.5.
'use strict';
const fs=require('fs'),path=require('path'),https=require('https'),http=require('http'),tls=require('tls');
const platform=require('../platform'),redact=require('./redact');
function descriptor(ctx) { return {profile:ctx.config.profile || 'default',runtimeRoot:ctx.config.runtime_root,binary:platform.secretHelper(ctx.config.binaries || {})}; }
function present(ctx) { return !!process.env.COUNCIL_GEMINI_API_KEY || (platform.implemented.secrets && fs.existsSync(path.join(ctx.config.runtime_root,'secrets','gemini-api-key.dpapi'))); }
function resolve(ctx) { if(process.env.COUNCIL_GEMINI_API_KEY) return process.env.COUNCIL_GEMINI_API_KEY; if(!platform.implemented.secrets) throw new Error('gemini_key_missing'); return Buffer.from(platform.secretGet(descriptor(ctx)),'base64').toString('utf8'); }
function set(ctx,value) { platform.secretSet(descriptor(ctx),Buffer.from(value,'utf8').toString('base64')); }
function writeHeader(ctx,stream,o) { const header={api_key:resolve(ctx),endpoint:(ctx.config.gemini || {}).endpoint || 'https://generativelanguage.googleapis.com/v1beta',model:o.model || (ctx.config.gemini || {}).model || 'gemini-3-pro',system:o.system || ''}; stream.write(JSON.stringify(header)+'\n\n'); header.api_key=''; }
function validEndpoint(value) {
  const u=new URL(value);
  if(u.protocol!=='https:' || u.username || u.password || (u.port && u.port!=='443') || u.search || u.hash || !(u.hostname==='generativelanguage.googleapis.com' || /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.aiplatform\.googleapis\.com$/.test(u.hostname))) throw new Error('gemini_endpoint_rejected');
  return u;
}
function agentFor(target) {
  const bypass=process.env.NO_PROXY;
  if(bypass) { try {if(new URL(bypass).hostname===target.hostname) return undefined;} catch {} }
  const raw=process.env.HTTPS_PROXY || process.env.HTTP_PROXY; if(!raw) return undefined;
  const proxy=new URL(raw); if(!['http:','https:'].includes(proxy.protocol)) throw new Error('proxy_rejected');
  const agent=new https.Agent({keepAlive:false});
  agent.createConnection=(options,callback)=>{
    const headers={Host:target.hostname+':443'};
    if(proxy.username || proxy.password) headers['Proxy-Authorization']='Basic '+Buffer.from(decodeURIComponent(proxy.username)+':'+decodeURIComponent(proxy.password)).toString('base64');
    const req=(proxy.protocol==='https:'?https:http).request({hostname:proxy.hostname,port:proxy.port || (proxy.protocol==='https:'?443:80),method:'CONNECT',path:target.hostname+':443',headers,timeout:10000});
    req.on('connect',(res,socket,head)=>{if(res.statusCode!==200){socket.destroy();callback(new Error('proxy_connect_failed'));return;} if(head.length) socket.unshift(head); const secure=tls.connect({socket,servername:target.hostname}); let called=false; secure.once('secureConnect',()=>{called=true;callback(null,secure);});secure.once('error',e=>{if(!called) callback(e);});});
    req.once('error',callback);req.once('timeout',()=>req.destroy(new Error('proxy_timeout')));req.end();
  };
  return agent;
}
async function runApi({input=process.stdin,output=process.stdout,args=process.argv.slice(2)}={}) {
  let wire='',key='',request=null,agent=null,finished=false,timer;
  const flag=n=>{const i=args.indexOf(n);return i<0?null:args[i+1];};
  const seconds=Number(flag('--timeout-s')) || 900;
  const clean=(s,field='')=>redact.text(key ? String(s).split(key).join('[REDACTED]') : String(s),field);
  const finish=(code,doc)=>{if(finished)return;finished=true;clearTimeout(timer);if(request)request.destroy();if(agent)agent.destroy();output.write(JSON.stringify(redact.value(doc))+'\n');key='';wire='';if(!input.readableEnded && input.destroy)input.destroy();process.exitCode=code;};
  timer=setTimeout(()=>finish(3,{status:'TIMEOUT',response:'request timed out',conversation_id:null}),Math.min(1800,Math.max(1,seconds))*1000);
  try {
    for await(const chunk of input) {wire+=chunk.toString('utf8');if(Buffer.byteLength(wire)>1024*1024)throw new Error('stdin_too_large');}
    if(finished)return;
    const split=wire.indexOf('\n\n');if(split<0)throw new Error('invalid_stdin_header');
    let header;try{header=JSON.parse(wire.slice(0,split));}catch{throw new Error('invalid_stdin_header');}if(!header || typeof header!=='object')throw new Error('invalid_stdin_header');key=header.api_key;delete header.api_key;if(typeof key!=='string' || !key)throw new Error('gemini_key_missing');
    const endpoint=validEndpoint(header.endpoint),model=header.model;
    if(typeof model!=='string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(model))throw new Error('invalid_model');
    const prompt=wire.slice(split+2);wire='';
    const target=new URL(endpoint.href.replace(/\/$/,'')+'/models/'+encodeURIComponent(model)+':generateContent');
    const effort=flag('--effort') || 'medium';
    const body=JSON.stringify({systemInstruction:{parts:[{text:String(header.system || '')}]},contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{temperature:0,maxOutputTokens:({low:2048,medium:8192,high:32768})[effort] || 8192}});
    agent=agentFor(target);
    await new Promise(resolveDone=>{
      request=https.request(target,{method:'POST',agent,headers:{'x-goog-api-key':key,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
        let data='';res.on('data',d=>{data+=d;if(data.length>5*1024*1024){finish(2,{status:'ERROR',response:'response_too_large'});resolveDone();}});
        res.on('error',()=>{finish(2,{status:'ERROR',response:'response_stream_failed'});resolveDone();});
        res.on('end',()=>{if(finished){resolveDone();return;}try{const j=JSON.parse(data);if(res.statusCode<200 || res.statusCode>=300){finish(2,{status:'ERROR',http_status:res.statusCode,response:clean(j.error && j.error.message || 'API error','stderr_tail')});}else{const u=j.usageMetadata || {};const response=(j.candidates || []).flatMap(c=>(c.content && c.content.parts)||[]).filter(p=>!p.thought).map(p=>p.text || '').join('\n');finish(0,{status:'SUCCESS',response:clean(response),conversation_id:null,model,usage:{input_tokens:Math.max(0,(u.promptTokenCount || 0)-(u.cachedContentTokenCount || 0)),output_tokens:u.candidatesTokenCount || 0,cache_read_input_tokens:u.cachedContentTokenCount || 0,thinking_tokens:u.thoughtsTokenCount || 0,total_tokens:u.totalTokenCount || 0}});}}catch{finish(2,{status:'ERROR',response:'invalid_api_response'});}resolveDone();});
      });
      request.on('error',e=>{finish(2,{status:'ERROR',response:clean(e.message,'stderr_tail')});resolveDone();});request.end(body);
    });
  } catch(e) {finish(2,{status:'ERROR',response:clean(e.message,'stderr_tail')});}
}
function remove(ctx) { return platform.secretDelete(descriptor(ctx)); }
module.exports={delete:remove,present,resolve,set,writeHeader,validEndpoint,runApi};
