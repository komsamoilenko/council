#!/usr/bin/env node
// Owns the closed installer command line and read-only verbs; specification §7.1.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { context, survey, resolveVault, exists, realFuture, under, linked, hostPaths } from './lib/survey.mjs';
import { loadAnswers, fail, errorObject } from './lib/dialogue.mjs';
import { buildPlan, publishPlan } from './lib/planning.mjs';
import { planReport, detectReport } from './lib/report.mjs';
import { scanDuplicates, reportTarget, publishDuplicate, duplicateText } from './lib/duplicates.mjs';
import { newTask } from './lib/new-task.mjs';
import { safewrite } from './lib/safewrite.mjs';
import { forceUnlock } from './lib/lock.mjs';

const verbs = ['detect','plan','apply','verify','update','uninstall','install-prereqs','login','migrate','rollback','set-key','duplicates','new-task','unlock'];
const globalValues = ['profile','log'], globalSwitches = ['json','no-color','verbose'];
const flags = {
  unlock: { values:[], switches:['force-unlock'] },
  detect: { values:['vault','out'], switches:['duplicates'] },
  plan: { values:['vault','merge','hosts','register-as','owner','chat-language','answers'], switches:['conventions','relocate-runtime','large-vault','git-init','allow-unsupported-platform','duplicates'] },
  duplicates: { values:['vault','max-files','out'], switches:[] },
  'new-task': { values:['vault','agents'], switches:[] },
};
export const usage = `Usage: node installer/setup.mjs <verb> [flags]
Verbs: ${verbs.join(' ')}
Implemented: detect plan duplicates new-task unlock. Other verbs are not in this build.
Global: --profile <id> --json --no-color --verbose --log <file>
detect: --vault <path> --duplicates --out <file>
plan: --vault <path> --merge block|sidecar|none|ask --conventions --relocate-runtime
      --hosts <list|none|all> --register-as <name> --owner <name> --chat-language <text>
      --answers <file> --large-vault --git-init --allow-unsupported-platform --duplicates
duplicates: --vault <path> --max-files <1..200000> --out <etc/reports/file>
new-task: <slug> --vault <path> --agents claude,codex,gemini
unlock: --force-unlock (recover stale setup lock/claim; live owners stay refused)
--log is accepted but does not write: detect/plan permit only their declared output files.
Exit codes: 0 ok; 1 step failed; 2 usage/precondition; 3 stale plan; 4 conflict;
            5 open journal/declined; 6 unsupported platform; 7 verify drift.
`;
export function parse(argv) {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) return {help:true};
  const verb = argv.find((value,i) => verbs.includes(value) && (i === 0 || !['--profile','--log'].includes(argv[i-1])));
  if (!verb) throw fail('E-USAGE','Unknown or missing verb.');
  if (!flags[verb]) throw fail('E-USAGE',verb+' is not in this build.');
  const values = new Set([...globalValues,...flags[verb].values]), switches = new Set([...globalSwitches,...flags[verb].switches]);
  const options = {}, positional = []; let seenVerb = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === verb && !seenVerb) { seenVerb = true; continue; }
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const key = arg.slice(2);
    if (Object.hasOwn(options,key)) throw fail('E-USAGE','Repeated flag: '+arg);
    if (switches.has(key)) options[key] = true;
    else if (values.has(key) && argv[i+1] !== undefined && !argv[i+1].startsWith('--')) options[key] = argv[++i];
    else throw fail('E-USAGE','Unknown flag or missing value: '+arg);
  }
  if (positional.length !== (verb === 'new-task' ? 1 : 0)) throw fail('E-USAGE','Unexpected or missing positional argument.');
  if (options.profile && !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(options.profile)) throw fail('E-USAGE','Invalid --profile id.');
  if (verb === 'unlock' && !options['force-unlock']) throw fail('E-USAGE','unlock requires --force-unlock.');
  return {verb,options,slug:positional[0]};
}
export async function run(argv, overrides = {}) {
  const stdout = overrides.stdout || (text => process.stdout.write(text)), stderr = overrides.stderr || (text => process.stderr.write(text));
  let options = {json:argv.includes('--json'),verbose:argv.includes('--verbose')};
  let reportPrinted = false;
  try {
    const command = parse(argv);
    if (command.help) { stdout(options.json ? JSON.stringify({usage})+'\n' : usage); return 0; }
    options = {...loadAnswers(command.options.answers),...command.options};
    const ctx = context({...overrides,profile:options.profile || 'default'});
    let result, human, exitCode = 0;
    if (command.verb === 'unlock') {
      if (await linked(ctx.dirs.etc,ctx)) throw fail('E-REPARSE-TARGET',ctx.dirs.etc);
      result = exists(ctx.dirs.etc) ? await forceUnlock(ctx.dirs.etc, overrides.lockOptions) : { ok:true };
      stdout(options.json ? JSON.stringify(result)+'\n' : (result.ok ? 'Setup lock cleared.\n' : JSON.stringify(result)+'\n'));
      return result.ok ? 0 : result.exitCode;
    }
    if (command.verb === 'plan') {
      const built = await buildPlan(options,ctx);
      result = built.plan; human = planReport(result);
      // D2 precedes publication, including in unattended mode.
      stdout(options.json ? JSON.stringify(result)+'\n' : human);
      reportPrinted = true;
      await publishPlan(built);
      return 0;
    }
    if (command.verb === 'detect') {
      result = await survey(options,ctx); exitCode = result.exitCode;
      if (options.duplicates) {
        const vault = options.vault || resolveVault(ctx);
        if (!vault || !exists(vault)) throw fail('E-VAULT-NOT-A-DIR');
        const file = await reportTarget({...options,out:undefined},ctx,vault);
        result.duplicates = await publishDuplicate(await scanDuplicates(vault,ctx),file);
      }
      human = detectReport(result);
      if (result.duplicates) human += duplicateText(result.duplicates)+'Report: '+result.duplicates.reportFile+'\n';
      if (options.out) {
        const file = path.resolve(options.out), real = realFuture(file), vault = result.blocks.find(b => b.name === 'vault').vault.path;
        if (vault && under(real,realFuture(vault)) || under(real,realFuture(path.join(ctx.dirs.root,'app'))) ||
            Object.values(hostPaths(ctx)).flat().some(p => realFuture(p) === real) || await linked(file,ctx) || exists(file)) throw fail('E-USAGE','--out must be a new file outside vault, app and host configs.');
        // Parent creation is intentionally not implicit for detect --out.
        await safewrite(file,JSON.stringify(result,null,2)+'\n',{exclusive:true});
      }
    } else if (command.verb === 'duplicates') {
      const vault = options.vault || resolveVault(ctx);
      if (!vault || !exists(vault) || !fs.statSync(vault).isDirectory()) throw fail('E-VAULT-NOT-A-DIR');
      if (await linked(vault,ctx)) throw fail('E-REPARSE-TARGET',vault);
      const file = await reportTarget(options,ctx,vault);
      result = await publishDuplicate(await scanDuplicates(vault,ctx,{maxFiles:options['max-files'] === undefined ? 200000 : Number(options['max-files'])}),file);
      human = duplicateText(result)+'Report: '+file+'\n';
    } else if (command.verb === 'new-task') {
      result = await newTask(command.slug,options,ctx); human = 'Created '+result.path+'\n'+(result.note?result.note+'\n':'');
    }
    if (options.log) { result.log = {path:options.log,written:false,reason:'suppressed by read-only output invariant'}; human += '--log suppressed by the read-only output invariant.\n'; }
    stdout(options.json ? JSON.stringify(result)+'\n' : human);
    return exitCode;
  } catch (error) {
    const item = errorObject(error,options.verbose);
    if (options.json) (reportPrinted ? stderr : stdout)(JSON.stringify({error:item,exitCode:item.exitCode})+'\n');
    else stderr(`${item.code}: ${item.what}. ${item.why || ''}. ${item.fix || ''}\n${item.detail ? item.detail+'\n' : ''}${options.verbose ? item.stack+'\n' : ''}`);
    return item.exitCode >= 0 && item.exitCode <= 7 ? item.exitCode : 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await run(process.argv.slice(2));
