// Owns additive task scaffolding and optional index registration; specification §7.13.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import profile from '../lib/profile.js';
import paths from '../lib/paths.js';
import guard from '../lib/guard.js';
import redact from '../lib/redact.js';
export function newTask(config,slug,{agents,verbose=false}={}) {
  if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug || '') || slug.length>80)throw new Error('Use a kebab-case task slug of at most 80 characters.');
  const P=paths.computePaths(config),dir=path.join(P.workDir,new Date().toISOString().slice(0,10)+'-'+slug);
  if(!paths.isUnder(guard.canonical(dir),guard.canonical(P.workDir)))throw new Error('task_path_escapes_work');
  const selected=agents || ['claude','codex','gemini'].filter(id=>(config.binaries || {})[id==='codex'?'codex_js':id==='gemini'?'gemini_api_js':id]);
  if(!selected.every(x=>['claude','codex','gemini','echo'].includes(x)))throw new Error('invalid_agent');
  fs.mkdirSync(dir,{recursive:true});for(const name of selected)fs.mkdirSync(path.join(dir,name),{recursive:true});
  for(const [name,text] of [['BRIEF.md','# '+slug+'\n\nRequest and success criteria.\n'],['NOTES.md','# Task notes\n\nAppend-only cross-agent log.\n']]){const p=path.join(dir,name);if(!fs.existsSync(p))fs.writeFileSync(p,text,{flag:'wx'});}
  const index=path.join(P.vault,'INDEX.md'),relative=path.relative(P.vault,dir).split(path.sep).join('/');
  if(fs.existsSync(index)){if(!paths.isUnder(fs.realpathSync(index),guard.canonical(P.vault)))throw new Error('index_outside_vault');const text=fs.readFileSync(index,'utf8');if(!text.includes(relative))fs.appendFileSync(index,'\n- '+relative+'/ — '+slug+' — council — '+new Date().toISOString().slice(0,10)+'\n');}else if(verbose)process.stderr.write('INDEX.md absent; registration skipped.\n');
  return dir;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))try{const loaded=profile.resolve();if(!guard.checkConfigTrust(loaded).ok)throw new Error('Configuration trust failed.');const args=process.argv.slice(2),i=args.indexOf('--agents');process.stdout.write(newTask(loaded.config,args[0],{agents:i<0?undefined:args[i+1].split(','),verbose:args.includes('--verbose')})+'\n');}catch(e){process.stderr.write(redact.text(e.message)+'\n');process.exitCode=2;}
