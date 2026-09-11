// Machine metadata merge shared by plan and apply; user-owned keys are retained.
import platform from '../../src/platform/index.js';
import fs from 'node:fs';
import {sha256,stable} from './survey.mjs';
export function machineBytes(machine,detect,ctx,profile,{shared=true}={}) {
  machine ||= {schema:2};
  const clis=detect.blocks.find(b=>b.name==='clis').clis;
  const binaries={...machine.binaries,...(ctx.platform||platform).systemBinaries(),node:ctx.node,
    ...(clis.claude.usable?{claude:clis.claude.path}:{}),...(clis.codex.usable?{codex_js:clis.codex.path}:{}),
    gemini_api_js:'%COUNCIL_APP%/backends/gemini-api-run.js'};
  if(clis.codex.rg)binaries.rg=clis.codex.rg;else delete binaries.rg;
  const written_at=ctx.now().toISOString();
  const notice_ack=machine.notice_ack || {notice_sha256:sha256(fs.readFileSync(new URL('../../NOTICE.md',import.meta.url))),accepted_at:written_at};
  const merged={...machine,schema:2,written_by:'council-setup 0.1.0',written_at,platform:ctx.dirs.id,binaries,npm_root_g:detect.blocks.find(b=>b.name==='npm').root,
    versions_at_install:{node:detect.blocks.find(b=>b.name==='node').version,claude:clis.claude.version,codex:clis.codex.version},notice_ack,
    shared:shared?{...machine.shared,skill:ctx.dirs.skill,app_versions:[...new Set([...(machine.shared?.app_versions||[]),'0.1.0'])],profiles:[...new Set([...(machine.shared?.profiles||[]),profile])]}:(machine.shared||{})};
  // A no-op plan must not become a write solely because the clock advanced.
  if(machine.written_at && stable({...merged,written_at:machine.written_at})===stable(machine))merged.written_at=machine.written_at;
  return JSON.stringify(merged,null,2)+'\n';
}
