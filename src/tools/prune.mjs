// Owns terminal-job pruning with containment and ledger-before-delete; specification §§2,5.
import fs from 'node:fs';
import path from 'node:path';
import profile from '../lib/profile.js';
import paths from '../lib/paths.js';
import guard from '../lib/guard.js';
import integrity from '../lib/integrity.js';
import jobstore from '../lib/jobstore.js';
import ledger from '../lib/ledger.js';
import redact from '../lib/redact.js';
const args=process.argv.slice(2);
try {
  const loaded=profile.resolve(),trust=guard.checkConfigTrust(loaded);
  if(!trust.ok || !integrity.check().ok)throw new Error('Configuration or app integrity failed; run council_doctor.');
  const ctx={config:loaded.config,paths:paths.computePaths(loaded.config),mode:'normal',host:'prune',version:paths.COUNCIL_VERSION};
  const i=args.indexOf('--older-than-days'),days=i<0?30:Number(args[i+1]);if(!Number.isInteger(days) || days<1)throw new Error('older-than-days must be a positive integer');
  const whole=args.includes('--whole-job'),confirm=args.includes('--confirm'),cutoff=Date.now()-days*86400000;
  const root=fs.existsSync(ctx.paths.jobsRoot)?fs.realpathSync(ctx.paths.jobsRoot):ctx.paths.jobsRoot,ledgerRoot=guard.canonical(ctx.paths.ledgerDir);
  function safe(p) {const real=fs.realpathSync(p);return paths.isUnder(real,root) && paths.normCase(real)!==paths.normCase(root) && !paths.isUnder(real,ledgerRoot) && !paths.isUnder(ledgerRoot,real) && paths.normCase(real)===paths.normCase(path.resolve(p)) && !fs.lstatSync(p).isSymbolicLink();}
  function collect(dir){if(!safe(dir))throw new Error('unsafe_prune_path');const out=[];for(const ent of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,ent.name);if(!safe(p))throw new Error('unsafe_prune_path');if(ent.isDirectory())out.push(...collect(p));else out.push(p);}return out;}
  const candidates=[];
  for(const j of jobstore.listJobDirs(ctx.paths,{since_hours:24*365*20})){if(Number(j.job_id.split('_')[1])>=cutoff)continue;const view=jobstore.loadView(ctx.paths,ctx.config,j.job_id);if(!view || !view.terminal)continue;const dir=jobstore.jobDirFor(ctx.paths,j.job_id);if(!safe(dir))continue;const files=collect(dir),targets=whole?[dir]:files.filter(p=>['stdout.log','stderr.log'].includes(path.basename(p)) && paths.isUnder(p,path.join(dir,'legs')));if(targets.length)candidates.push({job_id:j.job_id,targets,bytes:files.filter(p=>whole || targets.includes(p)).reduce((n,p)=>n+fs.statSync(p).size,0)});}
  process.stdout.write(JSON.stringify(redact.value({mode:confirm?'DELETE':'DRY_RUN',candidates}))+'\n');
  if(confirm && candidates.length){if(!ledger.append(ctx,ledger.baseRow(ctx,{event:'prune',older_than_days:days,whole_job:whole,jobs:candidates.map(c=>c.job_id),bytes:candidates.reduce((n,c)=>n+c.bytes,0),dry_run:false})))throw new Error('ledger_write_failed; nothing removed');for(const c of candidates){const v=jobstore.loadView(ctx.paths,ctx.config,c.job_id);if(!v || !v.terminal)continue;for(const p of c.targets){if(!safe(p))throw new Error('unsafe_prune_path');if(whole)collect(p);fs.rmSync(p,{recursive:whole,force:false});}}}
} catch(e){process.stderr.write(redact.text(e.message)+'\n');process.exitCode=2;}
