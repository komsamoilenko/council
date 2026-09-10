// Pure merge shared by plan and apply; user-owned machine keys are retained.
import platform from '../../src/platform/index.js';
export function machineBytes(machine,detect,ctx,profile,{shared=true}={}) {
  machine ||= {schema:2};
  const clis=detect.blocks.find(b=>b.name==='clis').clis;
  const binaries={...machine.binaries,...(ctx.platform||platform).systemBinaries(),node:ctx.node,
    ...(clis.claude.usable?{claude:clis.claude.path}:{}),...(clis.codex.usable?{codex_js:clis.codex.path}:{})};
  return JSON.stringify({...machine,schema:2,written_by:'council-setup 0.1.0',platform:ctx.dirs.id,binaries,npm_root_g:detect.blocks.find(b=>b.name==='npm').root,
    shared:shared?{...machine.shared,skill:ctx.dirs.skill,app_versions:[...new Set([...(machine.shared?.app_versions||[]),'0.1.0'])],profiles:[...new Set([...(machine.shared?.profiles||[]),profile])]}:(machine.shared||{})},null,2)+'\n';
}
