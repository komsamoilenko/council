// Package-manager metadata is evidence printed before each attended decision (A-44).
import path from 'node:path';
import os from 'node:os';
import {which} from './survey.mjs';
import {requireTTY,confirm} from './attended.mjs';
export async function installPrereqs(options,ctx) {
  const {output}=requireTTY(ctx),items=[],selected=['node','claude','codex'].filter(k=>options[k]);
  const npm=path.join(path.dirname(ctx.node),'node_modules','npm','bin','npm-cli.js');
  let exitCode=0;
  for(const kind of selected.length?selected:['node','claude','codex']) {
    const pkg=kind==='claude'?'@anthropic-ai/claude-code':'@openai/codex';
    const url=kind==='node'?'https://nodejs.org/en/download':'https://www.npmjs.com/package/'+pkg;
    const file=kind==='node'?which('winget',ctx.env).find(p=>! /\.(cmd|bat|ps1)$/i.test(p)):ctx.node;
    const query=kind==='node'?['show','--exact','--id','OpenJS.NodeJS.LTS','--source','winget','--disable-interactivity']:[npm,'view',pkg,'version','dist.tarball','dist.integrity','--json'];
    // npm's read-only command must not create/prune cache logs or run its notifier.
    const env={...ctx.env,npm_config_cache:os.tmpdir(),npm_config_logs_dir:ctx.node,npm_config_logs_max:'0',npm_config_update_notifier:'false',npm_config_timing:'false'};
    let r,version,reason;
    try{r=file?ctx.run(file,query,{timeout:60000,stdio:['ignore','pipe','pipe'],env}):null;
      if(!r||r.status!==0||r.error)reason=r?.error||'metadata query failed';
      else if(kind!=='node'){try{version=JSON.parse(r.stdout).version;if(typeof version!=='string'||!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version))reason='metadata has no valid version';}catch{reason='metadata is not JSON';}}
    }catch{reason='metadata query failed';}
    if(r?.stdout)output.write(r.stdout);
    output.write('\nSource: '+url+'\n');
    if(kind==='node')output.write('No-admin alternative: official zip from '+url+' into %LOCALAPPDATA%\\Programs\\nodejs\n');
    if(reason){output.write('Skipped: '+reason+'\n');const confirmed=options['print-only']||await confirm(ctx,'Install '+kind+'? Metadata failed; this item will be skipped.');if(confirmed)exitCode=1;items.push({item:kind,skipped:reason,confirmed});continue;}
    const args=kind==='node'?['install','--exact','--id','OpenJS.NodeJS.LTS','--source','winget']:[npm,'install','-g',pkg+'@'+version];
    output.write((kind==='node'?'winget '+args.join(' '):'npm install -g '+pkg+'@'+version)+'\n');
    output.write(kind==='node'?'winget verifies the installer against this SHA256 before installing; council does not re-verify.\n':'npm verifies the tarball against this integrity value; council does not re-verify.\n');
    if(options['print-only']){items.push({item:kind,printed:true});continue;}
    if(!await confirm(ctx,'Install '+kind+'?')){items.push({item:kind,declined:true});continue;}
    let installed;try{installed=ctx.run(file,args,{timeout:600000,stdio:'inherit'});}catch{installed={status:1};}
    const ok=installed.status===0&&!installed.error;if(!ok)exitCode=1;items.push({item:kind,installed:ok});
  }
  return {items,exitCode};
}
