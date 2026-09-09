import fs from 'node:fs';
import path from 'node:path';
import {context} from '../../installer/lib/survey.mjs';
import {buildPlan,publishPlan} from '../../installer/lib/planning.mjs';
import {apply,applyReport} from '../../installer/lib/apply.mjs';
export async function aclApply(f,platform) {
  const dir=path.join(f.root,'apply-report');fs.mkdirSync(dir);
  const env={...process.env,PATH:'',COUNCIL_PLATFORM:'win32'};
  for(const key of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','CODEX_HOME','CLAUDE_CONFIG_DIR']){env[key]=path.join(dir,key.toLowerCase());fs.mkdirSync(env[key]);}
  const vault=path.join(dir,'vault');fs.mkdirSync(vault);fs.writeFileSync(path.join(vault,'AGENTS.md'),'# User canary\n');
  const ctx=context({env,platform:{...platform,implemented:{...platform.implemented,fileAttributes:false}},attributes:async()=>null,probe:()=>({status:1,stdout:''}),tier0:async()=> 'stubbed Tier-0',doctor:async()=>{throw new Error('unexpected registration');}});
  const built=await buildPlan({vault,hosts:'none',json:true},ctx);await publishPlan(built);
  return applyReport(await apply({plan:built.plan.file,yes:true},ctx));
}
