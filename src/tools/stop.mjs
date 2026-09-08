// Owns the dry-run-first STOP off-ramp; specification §§2,5.
import fs from 'node:fs';
import profile from '../lib/profile.js';
import paths from '../lib/paths.js';
import guard from '../lib/guard.js';
import integrity from '../lib/integrity.js';
import jobstore from '../lib/jobstore.js';
import reaper from '../lib/reaper.js';
import ledger from '../lib/ledger.js';
import redact from '../lib/redact.js';
const args=process.argv.slice(2);
try {
  const loaded=profile.resolve(),trust=guard.checkConfigTrust(loaded);
  if(!trust.ok || !integrity.check().ok)throw new Error('Configuration or app integrity failed; run council_doctor.');
  const ctx={config:loaded.config,paths:paths.computePaths(loaded.config),profile:loaded.profile,trust,mode:'normal',host:'stop',version:paths.COUNCIL_VERSION,accounts:{},log:s=>process.stderr.write(redact.text(s)+'\n')};
  ctx.accounts=(jobstore.readJSON(ctx.paths.accountsPath) || {}).accounts || {};
  const stops=[ctx.paths.stopVault,ctx.paths.stopLocal],confirm=args.includes('--confirm') && !args.includes('--status');
  const jobs=jobstore.listJobDirs(ctx.paths,{since_hours:24*365*20}).filter(j=>{const v=jobstore.loadView(ctx.paths,ctx.config,j.job_id);return v && !v.terminal;});
  process.stdout.write(JSON.stringify(redact.value({mode:confirm?'APPLY':'DRY_RUN',stops:stops.map(p=>({path:p,exists:fs.existsSync(p)})),jobs:jobs.map(j=>j.job_id)}))+'\n');
  if(confirm){const at=args.indexOf('--reason'),reason=at<0?'stopped by hand':args[at+1];for(const p of stops)if(!fs.existsSync(p))fs.writeFileSync(p,JSON.stringify(redact.value({ts:new Date().toISOString(),reason}))+'\n',{flag:'wx'});ledger.append(ctx,ledger.baseRow(ctx,{event:'reaper_action',action:'stop_files_written',reason}));if(args.includes('--kill-running'))for(const job of jobs)await reaper.cancelJob(ctx,job.job_id,{source:'stop-file',reason,cascade:true});}
  process.stdout.write('Remove the displayed STOP files yourself to resume. The global STOP may also be active.\n');
} catch(e){process.stderr.write(redact.text(e.message)+'\n');process.exitCode=2;}
