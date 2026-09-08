// Owns task scaffolding and the optional index append; specification §7.13.
import fs from 'node:fs';
import path from 'node:path';
import { safewrite } from './safewrite.mjs';
import { exists, linked, survey, resolveVault, under } from './survey.mjs';
import { fail } from './dialogue.mjs';

export async function newTask(slug, options, ctx) {
  if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80 || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(slug)) throw fail('E-USAGE','Use a kebab-case task slug.');
  const vault = options.vault || resolveVault(ctx);
  if (!vault || !exists(vault) || !fs.statSync(vault).isDirectory()) throw fail('E-VAULT-NOT-A-DIR',vault || 'No vault selected.');
  const root = fs.realpathSync(vault), date = ctx.now().toISOString().slice(0,10), relative = 'work/'+date+'-'+slug, target = path.join(root,relative);
  if (await linked(vault,ctx) || await linked(target,ctx)) throw fail('E-REPARSE-TARGET',target);
  let agents = options.agents?.split(',');
  if (!agents) { const detect = await survey({...options,vault:root},ctx); agents = Object.entries(detect.blocks.find(b => b.name === 'clis').clis).filter(([,v]) => v.usable).map(([k]) => k); }
  if (agents.some(a => !['claude','codex','gemini'].includes(a)) || new Set(agents).size !== agents.length) throw fail('E-USAGE','--agents accepts claude,codex,gemini.');
  if (exists(target)) throw fail('E-USAGE','Task already exists: '+target);
  const index = path.join(root,'INDEX.md');
  if (exists(index) && (await linked(index,ctx) || !fs.statSync(index).isFile())) throw fail('E-REPARSE-TARGET',index);
  let before = exists(index) ? fs.readFileSync(index) : null;
  const listed = before?.toString('utf8').split(/\r?\n/).some(line => { const m = /^- `([^`]+)`/.exec(line); return m && m[1].replace(/\/$/,'') === relative; });
  const files = [[path.join(target,'BRIEF.md'),`# ${slug}\n\n## Request\n\n## Success criteria\n`], [path.join(target,'NOTES.md'),'# Notes\n\nAppend cross-agent findings below.\n']];
  if (!under(target,root)) throw fail('E-USAGE','Task escaped vault.');
  fs.mkdirSync(target,{recursive:true});
  for (const agent of agents) fs.mkdirSync(path.join(target,agent));
  for (const [file, content] of files) await safewrite(file,content,{exclusive:true});
  let appended = false;
  if (before && !listed) {
    if (!fs.readFileSync(index).equals(before)) throw fail('E-PLAN-STALE',index);
    const eol = before.includes(Buffer.from('\r\n')) ? '\r\n' : '\n';
    const line = (before.length && before.at(-1) !== 10 ? eol : '') + '- `'+relative+'` — task — council — '+date+eol;
    await safewrite(index,Buffer.concat([before,Buffer.from(line)])); appended = true;
  }
  return { schema:1,verb:'new-task',path:target,agents,files:files.map(([p]) => p),indexAppended:appended,...(!before && options.verbose ? {note:'INDEX.md absent; skipped index append.'} : {}) };
}
