// Machine metadata merge shared by plan and apply; user-owned keys are retained.
import platform from '../../src/platform/index.js';
import fs from 'node:fs';
import path from 'node:path';
import {sha256,stable} from './survey.mjs';
import version from '../../src/version.js';
// The fixed-name copy every release attaches beside its versioned zip, so a zip install can
// update without knowing the next version's name: GitHub's releases/latest/download resolves it.
export const LATEST_ASSET='council-latest.zip';
// Where update should read the next release from, decided by the tree this installer runs from.
// A git worktree updates from its own checkout; an extracted release from the repository's
// latest release. Unknown origin records nothing, and update says update_source_missing.
export function updateSource(ctx) {
  const root=ctx.installerRoot;
  if(typeof root!=='string'||!path.isAbsolute(root))return null;
  if(fs.existsSync(path.join(root,'.git')))return {channel:'git',worktree:root,ref:'HEAD'};
  let repository=null;
  try{const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));repository=typeof pkg.repository==='string'?pkg.repository:pkg.repository?.url;}catch{}
  const m=/^(?:git\+)?(https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(repository||''));
  return m?{channel:'zip',asset:m[1]+'/releases/latest/download/'+LATEST_ASSET}:null;
}
export function machineBytes(machine,detect,ctx,profile,{shared=true}={}) {
  machine ||= {schema:2};
  const clis=detect.blocks.find(b=>b.name==='clis').clis;
  const binaries={...machine.binaries,...(ctx.platform||platform).systemBinaries(),node:ctx.node,
    ...(clis.claude.usable?{claude:clis.claude.path}:{}),...(clis.codex.usable?{codex_js:clis.codex.path}:{}),
    gemini_api_js:'%COUNCIL_APP%/backends/gemini-api-run.js'};
  if(clis.codex.rg)binaries.rg=clis.codex.rg;else delete binaries.rg;
  const written_at=ctx.now().toISOString();
  const notice_ack=machine.notice_ack || {notice_sha256:sha256(fs.readFileSync(new URL('../../NOTICE.md',import.meta.url))),accepted_at:written_at};
  // An existing source is the user's: a hand-pointed channel survives every re-apply.
  const source=machine.source && typeof machine.source==='object' ? machine.source : updateSource(ctx);
  const merged={...machine,schema:2,written_by:'council-setup '+version.APP_VERSION,written_at,platform:ctx.dirs.id,binaries,npm_root_g:detect.blocks.find(b=>b.name==='npm').root,
    versions_at_install:{node:detect.blocks.find(b=>b.name==='node').version,claude:clis.claude.version,codex:clis.codex.version},notice_ack,...(source?{source}:{}),
    shared:shared?{...machine.shared,skill:ctx.dirs.skill,app_versions:[...new Set([...(machine.shared?.app_versions||[]),version.APP_VERSION])],profiles:[...new Set([...(machine.shared?.profiles||[]),profile])]}:(machine.shared||{})};
  // A no-op plan must not become a write solely because the clock advanced.
  if(machine.written_at && stable({...merged,written_at:machine.written_at})===stable(machine))merged.written_at=machine.written_at;
  return JSON.stringify(merged,null,2)+'\n';
}
