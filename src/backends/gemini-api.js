// Owns Gemini API spawn plans and response parsing; specification §6.2.
'use strict';
const fs=require('fs'),platform=require('../platform'),envlib=require('../lib/env'),guard=require('../lib/guard'),secrets=require('../lib/secrets'),ledger=require('../lib/ledger'),redact=require('../lib/redact');
function binaryPath(ctx) {return (ctx.config.binaries || {}).gemini_api_js || null;}
function available(ctx,o={}) {
  if(((ctx.config.gemini || {}).provider || 'api')!=='api')return {ok:false,reason:'gemini_provider_not_api'};
  if(!secrets.present(ctx))return {ok:false,reason:'gemini_key_missing'};
  if(!binaryPath(ctx) || !fs.existsSync(binaryPath(ctx)))return {ok:false,reason:'gemini_api_runner_missing'};
  if(o.continueFrom || (o.leg && o.leg.session_id))return {ok:false,reason:'gemini_session_not_persisted'};
  return {ok:true};
}
function buildSpawn(ctx,o) {
  const model=o.model || (o.leg || {}).model || (ctx.config.gemini || {}).model || 'gemini-3-pro';
  const args=[binaryPath(ctx),'--model',model,'--timeout-s',String(o.timeoutS || 900),'--effort',o.effort || 'medium'];
  const envExtra=envlib.proxyEnvFor(ctx).env;
  const env=envlib.childEnv({backend:'gemini',provider:'api',binaries:ctx.config.binaries,depth:ctx.depth,jobId:o.job.job_id,rootJobId:o.job.root_job_id,extra:envExtra});
  guard.assertArgvSafe(args,ctx.config);
  return {file:ctx.config.binaries.node,args,cwd:ctx.paths.sandboxFor('gemini'),env,envExtra,promptVia:'stdin',stdinHeader:'gemini-api',expectedImage:platform.expectedImage('node'),flags:['api','no_tools','stdin_prompt']};
}
function parse(ctx,o) {
  let j;try{j=JSON.parse(fs.readFileSync(o.stdoutPath,'utf8'));}catch{return {ok:false,text:'',meta:{resumable:false,session_id:null,parse_failed:true,parse_error:'invalid_api_response',est_cost_usd:null}};}
  const usage=j.usage || null,pricing=(ctx.config.gemini || {}).pricing;
  const cost=pricing && Number.isFinite(pricing.input_per_million) && Number.isFinite(pricing.output_per_million) && usage ? ((usage.input_tokens || 0)*pricing.input_per_million+(usage.output_tokens || 0)*pricing.output_per_million)/1e6 : null;
  return redact.value({ok:o.exitCode===0 && j.status==='SUCCESS' && !o.cancelled && !o.timedOut,text:j.response || '',meta:{session_id:null,resumable:false,model:j.model || (o.leg || {}).model,usage,est_cost_usd:cost,cost_is_estimate:true,...ledger.tokenTotals(usage,o.promptChars)}});
}
module.exports={id:'gemini',vendor:'google',expectedImage:platform.expectedImage('node'),expectedImageFor:()=>platform.expectedImage('node'),effortLevels:['low','medium','high'],defaultTimeoutS:900,maxTimeoutS:1800,binaryPath,versionSpec:()=>null,available,buildSpawn,parse};
