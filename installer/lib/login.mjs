// Guidance only: existence checks and login status, no credential reads or login commands.
import path from 'node:path';
import platform from '../../src/platform/index.js';
import {readJSON,exists,which} from './survey.mjs';
import {fail} from './dialogue.mjs';
import {requireTTY,ask} from './attended.mjs';
export async function login(options,ctx) {
  if(options.only&&!['claude','codex','gemini'].includes(options.only))throw fail('E-USAGE','Invalid --only.');
  const {output}=requireTTY(ctx),machine=readJSON(ctx.dirs.machine,{binaries:{}}),profile=options.profile||'default';
  output.write('council-setup 0.1.0 · login\nI never automate a login, never ask for a password, and never read, store or forward a vendor credential.\n');
  const steps=[];
  for(const kind of options.only?[options.only]:['claude','codex','gemini']) {
    if(kind==='claude') {
      const credential=(ctx.platform||platform).credentialProbePaths().claude;
      const file=machine.binaries?.claude||which('claude',ctx.env).find(p=>! /\.(cmd|bat|ps1)$/i.test(p));
      const r=file?ctx.run(file,['--version']):null;
      output.write('[1/3] Claude Code   '+(r?.status===0?'claude --version runs ('+(/\d+\.\d+\.\d+/.exec(r.stdout||'')?.[0]||'version unavailable')+').':'Claude Code was not found.')+' Whether you are signed in, only Claude Code knows.\nCouncil checks only that Claude Code\'s own credential store EXISTS and never opens it.\nStore '+(exists(credential)?'exists.':'not found.')+'\nIn another terminal run: claude — sign in if asked, then /exit.\nNote: council does not forward CLAUDE_CONFIG_DIR to the child (src/lib/env.js DENIED_EXACT). If you keep your Claude configuration somewhere else with that variable, the claude leg will look in the default location and may report "not signed in" even though your own terminal is. See docs/TROUBLESHOOTING.md.\n');
      const skipped=(await ask(ctx,'[Enter] when done, s to skip: ')).toLowerCase()==='s';
      steps.push({kind,skipped,store_exists:exists(credential)});
    }else if(kind==='codex') {
      const file=machine.binaries?.codex_js||which('codex',ctx.env).find(p=>! /\.(cmd|bat|ps1)$/i.test(p));
      const status=()=>file?(/\.[cm]?js$/i.test(file)?ctx.run(ctx.node,[file,'login','status']):ctx.run(file,['login','status'])):{status:1};
      output.write('[2/3] Codex   codex login status → '+(status().status===0?'logged in.':'not logged in.')+' Run in another terminal: codex login\n');
      const skipped=(await ask(ctx,'[Enter] when done, s to skip: ')).toLowerCase()==='s';
      const logged_in=skipped?null:status().status===0;if(!skipped)output.write('re-check → '+(logged_in?'logged in. OK':'not logged in.')+'\n');steps.push({kind,skipped,logged_in});
    }else {
      output.write('[3/3] Gemini   The supported path is an AI Studio or Vertex API key (Google\'s own recommendation — NOTICE.md).\nCreate one at https://aistudio.google.com/apikey. In the EEA, Switzerland or the UK use a project with billing enabled.\nThen: council-setup set-key --profile '+profile+' (hidden prompt; stored DPAPI-protected under run\\'+profile+'\\secrets\\; never in your vault, never in a host config council writes, never in the ledger)\n');
      steps.push({kind,skipped:(await ask(ctx,'[Enter] when done, s to skip: ')).toLowerCase()==='s'});
    }
  }
  output.write('Antigravity (agy) is not part of this walk-through. See NOTICE.md.\n');return {steps,exitCode:0};
}
