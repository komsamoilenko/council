// Owns bounded, opt-in duplicate reporting; specification §10.2.
import fs from 'node:fs';
import path from 'node:path';
import { exists, realFuture, under, sha256, linked, which, accessDenied, unreadable, vaultRequired } from './survey.mjs';
import { safewrite } from './safewrite.mjs';
import { attributeBatch } from './attribute-batch.mjs';
import { fail } from './dialogue.mjs';

export const DUPLICATE_NOTICE = 'Nothing was deleted or moved. Byte-identical is not the same as redundant.';
export const stamp = date => date.toISOString().replace(/[-:]/g, '').replace('T','-').replace(/Z$/, '').replace('.', '-');
const slash = file => file.split(path.sep).join('/');
function glob(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') { i++; if (pattern[i + 1] === '/') { i++; out += '(?:.*/)?'; } else out += '.*'; }
      else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '[') { const end = pattern.indexOf(']',i + 1); if (end > i + 1) { out += pattern.slice(i,end + 1).replace(/^\[!/, '[^'); i = end; } else out += '\\['; }
    else if (c === '\\' && i + 1 < pattern.length) out += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}
export function ignoreRules(text, base = '') {
  const rules = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/(?<!\\) +$/, '');
    if (!line || line[0] === '#') continue;
    const negate = line[0] === '!'; if (negate) line = line.slice(1);
    const directory = line.endsWith('/'); if (directory) line = line.slice(0,-1);
    const anchored = line.startsWith('/') || line.includes('/'); if (line.startsWith('/')) line = line.slice(1);
    rules.push({ base, negate, directory, regex: new RegExp((anchored ? '^' : '(?:^|/)') + glob(line) + '$') });
  }
  return rules;
}
export function ignored(relative, directory, rules) {
  let result = false;
  for (const rule of rules) {
    if (rule.base && !relative.startsWith(rule.base + '/')) continue;
    const name = rule.base ? relative.slice(rule.base.length + 1) : relative;
    if ((!rule.directory || directory) && rule.regex.test(name)) result = !rule.negate;
  }
  return result;
}
export async function scanDuplicates(vault, ctx, { maxFiles = 200000, maxBytes = 2 * 1024 ** 3 } = {}) {
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 200000) throw fail('E-USAGE', '--max-files must be between 1 and 200000.');
  if (!Number.isInteger(maxBytes) || maxBytes < 0 || maxBytes > 2 * 1024 ** 3) throw fail('E-USAGE','Hash budget cannot exceed 2 GiB.');
  const io = ctx.io || fs, warnings = [];
  const required = vaultRequired(vault,ctx);
  const root = fs.realpathSync(vault), files = [], notHashed = [], sizeGroups = new Map();
  const git = which('git',ctx.env).find(p => !/\.(cmd|bat|ps1)$/i.test(p));
  let count = 0, hashedBytes = 0, capped = false;
  const walk = async (directory, inherited) => {
    try { await listing(directory,inherited); }
    catch (e) { if (!accessDenied(e)) throw e; unreadable(root,directory,warnings,required); }
  };
  const listing = async (directory, inherited) => {
    const entries = io.readdirSync(directory).sort();
    const batch = await attributeBatch(entries.map(name => path.join(directory,name)),ctx);
    let rules = inherited;
    const ignore = path.join(directory,'.gitignore');
    if (exists(ignore) && !await linked(ignore, ctx)) {
      const a = batch.get(ignore);
      if (!(a?.offline || a?.recallOnDataAccess || (a?.bits & 0x401000)) && fs.statSync(ignore).size <= 8 * 1024 ** 2)
        rules = [...rules, ...ignoreRules(fs.readFileSync(ignore,'utf8'), slash(path.relative(root,directory)))];
    }
    let gitIgnored = null;
    if (git && entries.length) {
      const paths = entries.map(name => slash(path.relative(root,path.join(directory,name))));
      const r = ctx.run(git,['-C',root,'-c','core.fsmonitor=false','check-ignore','--no-index','-z','--stdin'], {input:paths.join('\0')+'\0'});
      if ([0,1].includes(r.status) && (!r.stdout || r.stdout.endsWith('\0'))) gitIgnored = new Set(r.stdout.split('\0').filter(Boolean));
    }
    for (const entry of entries) {
      if (capped) break;
      const file = path.join(directory,entry), rel = slash(path.relative(root,file));
      let st;
      try { st = io.lstatSync(file); }
      catch (e) { if (!accessDenied(e)) throw e; unreadable(root,file,warnings,required); continue; }
      if (st.isSymbolicLink() || !under(file, root)) continue;
      const lower = rel.toLowerCase();
      if (entry.toLowerCase() === '.git' || entry.toLowerCase() === 'node_modules' || /^\.obsidian\/workspace/.test(lower) || /^(work\/jobs|ledger)(\/|$)/.test(lower)) continue;
      if (gitIgnored ? gitIgnored.has(rel) : ignored(rel, st.isDirectory(), rules)) continue;
      if (st.isFile()) { if (count === maxFiles) { capped = true; break; } count++; }
      const attributes = batch.get(file);
      if (attributes?.reparsePoint || (attributes?.bits & 0x400)) {
        if (attributes?.offline || attributes?.recallOnDataAccess || (attributes?.bits & 0x401000)) notHashed.push({ path: rel, reason: 'cloud-only, not hashed' });
        continue;
      }
      if (st.isDirectory()) { await walk(file, rules); continue; }
      if (!st.isFile()) continue;
      if (attributes?.offline || attributes?.recallOnDataAccess || (attributes?.bits & 0x401000)) { notHashed.push({ path: rel, reason: 'cloud-only, not hashed' }); continue; }
      if (st.size > 8 * 1024 ** 2) { notHashed.push({ path: rel, reason: 'larger than 8 MiB, not hashed' }); continue; }
      const item = { file, path: rel, size: st.size }; files.push(item);
      const group = sizeGroups.get(st.size) || []; group.push(item); sizeGroups.set(st.size,group);
    }
  };
  await walk(root, []);
  const hashes = new Map();
  for (const group of sizeGroups.values()) {
    if (group.length < 2) continue;
    for (let offset = 0; offset < group.length; offset += 200) {
      const chunk = group.slice(offset,offset + 200);
      const batch = await attributeBatch(chunk.map(item => item.file),ctx);
      for (const item of chunk) {
        if (hashedBytes + item.size > maxBytes) { capped = true; notHashed.push({ path: item.path, reason: '2 GiB hash cap, not hashed' }); continue; }
        // Recheck lstat and attributes immediately before content access.
        let st;
        try { st = io.lstatSync(item.file); }
        catch (e) { if (!accessDenied(e)) throw e; unreadable(root,item.file,warnings,required); continue; }
        const a = batch.get(item.file);
        if (!st.isFile() || st.isSymbolicLink() || st.size !== item.size || a?.offline || a?.recallOnDataAccess || a?.reparsePoint || (a?.bits & 0x401400)) { notHashed.push({ path: item.path, reason: 'changed or cloud-only, not hashed' }); continue; }
        // Fixed-size reads prevent a concurrently growing file from exceeding either cap.
        let bytes, fd;
        try {
          fd=io.openSync(item.file,fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
          const before=fs.fstatSync(fd);
          if (!before.isFile() || before.size!==item.size) {notHashed.push({path:item.path,reason:'changed, not hashed'});continue;}
          bytes=Buffer.alloc(item.size);let offset=0;
          while(offset<bytes.length){const n=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);if(!n)break;offset+=n;}
          const after=fs.fstatSync(fd);
          if(offset!==bytes.length || after.size!==before.size || after.mtimeMs!==before.mtimeMs){notHashed.push({path:item.path,reason:'changed, not hashed'});continue;}
        } catch (e) {
          if (!accessDenied(e)) throw e;
          unreadable(root,item.file,warnings,required); continue;
        } finally {if(fd!==undefined)fs.closeSync(fd);}
        hashedBytes += bytes.length;
        const hash = sha256(bytes), matches = hashes.get(hash) || []; matches.push(item.path); hashes.set(hash,matches);
      }
    }
  }
  const groups = [...hashes.entries()].filter(([,paths]) => paths.length > 1).map(([hash,paths]) => ({ hash, paths: paths.sort(), keepFirst: paths.sort()[0] })).sort((a,b) => a.keepFirst < b.keepFirst ? -1 : 1);
  const indexRepeats = [];
  const index = files.find(f => f.path === 'INDEX.md');
  if (index) {
    const lines = fs.readFileSync(index.file,'utf8').split(/\r?\n/), seen = new Map();
    for (const line of lines) { const match = /^- `([^`]+)`/.exec(line); if (match) seen.set(match[1],(seen.get(match[1]) || 0) + 1); }
    for (const [file, occurrences] of seen) if (occurrences > 1) indexRepeats.push({ path: file, occurrences });
  }
  return { schema: 1, verb: 'duplicates', vault: root, files: count, hashedBytes, capped, groups, notHashed, indexRepeats, warnings, notice: DUPLICATE_NOTICE };
}
export function duplicateText(report) {
  return ['# council duplicate report', '', report.notice, '', `Files: ${report.files}; bytes hashed: ${report.hashedBytes}; capped: ${report.capped}`, '',
    ...(report.warnings || []).map(w => 'WARNING: ' + w),
    ...report.groups.flatMap(g => [`keep-first: ${g.keepFirst} (index suggestion only)`, ...g.paths.slice(1).map(p => `duplicate-of: ${p} → ${g.keepFirst}`)]),
    ...report.notHashed.map(p => `${p.path}: ${p.reason}`), ...report.indexRepeats.map(p => `INDEX.md repeated path: ${p.path} (${p.occurrences})`), ''].join('\n');
}
export async function reportTarget(options, ctx, vault) {
  const file = path.resolve(options.out || path.join(ctx.dirs.reports, `duplicates-${options.profile || 'default'}-${stamp(ctx.now())}.md`));
  const real = realFuture(file), allowed = realFuture(ctx.dirs.reports);
  if (!under(real, allowed) || under(real, realFuture(vault)) || await linked(path.dirname(file), ctx)) throw fail('E-USAGE', 'Duplicate reports must be under etc/reports and outside the vault.');
  if (exists(file)) throw fail('E-USAGE', 'Report already exists: ' + file);
  return file;
}
export async function publishDuplicate(report, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await safewrite(file, duplicateText(report), { exclusive: true });
  return { ...report, reportFile: file };
}
