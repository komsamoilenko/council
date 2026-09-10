// Structural deletion authority shared by uninstall's manifest and A-37 paths.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {under,realFuture,linked,hostPaths,exists,readJSON} from './survey.mjs';

const source=fileURLToPath(new URL('../../src/',import.meta.url));
const vaultNames=new Set(['AGENTS.md','CLAUDE.md','INDEX.md','.gitignore','AGENTS.council.md','CLAUDE.council.md','INDEX.council.md','.council/vault.json','shared/debate-prompt.md']);
export function protectedPath(p,m,ctx) {
  return /(?:^|[\\/])(?:STOP|agy-enabled|sandbox)(?:[\\/]|$)/i.test(p) || /\.council-new(?:\.|$)/i.test(p) ||
    [path.join(m.vault.path,'work','jobs'),path.join(m.vault.path,'ledger'),path.join(ctx.dirs.etc,'backups')].some(r=>under(p,r));
}
export async function scope(entry,m,ctx,{purge=false}={}) {
  const p=entry.path||entry.file;
  if(typeof p!=='string'||!path.isAbsolute(p))return false;
  const recordedSkill=readJSON(ctx.dirs.machine)?.shared?.skill;
  const skill=recordedSkill===ctx.dirs.skill?ctx.dirs.skill:null;
  if(entry.template==='skill'&&p!==skill)return false;
  const lexicalRoots=[m.vault.path,m.runtime_root,ctx.dirs.etc,path.join(ctx.dirs.root,'app'),path.dirname(ctx.dirs.launcher),...(skill?[skill]:[])];
  if(!entry.file&&!lexicalRoots.some(r=>under(p,r))&&p!==ctx.dirs.current)return false;
  if(await linked(p,ctx))return false;
  const real=realFuture(p),vault=realFuture(m.vault.path),runtime=realFuture(ctx.dirs.runtimeRoot);
  if(!path.isAbsolute(m.vault.path)||vault!==m.vault.real||under(ctx.dirs.root,vault)||under(vault,ctx.dirs.root)||!path.isAbsolute(m.runtime_root)||!under(realFuture(m.runtime_root),realFuture(ctx.dirs.stateAnchor))||under(realFuture(m.runtime_root),vault)||[ctx.dirs.etc,path.join(ctx.dirs.root,'app')].some(r=>under(realFuture(m.runtime_root),realFuture(r))))return false;
  if(entry.file)return (hostPaths(ctx)[entry.host]||[]).includes(p)&&real===realFuture(p);
  if(purge) {
    if(exists(p)&&!fs.lstatSync(p).isDirectory())return false;
    if(/(?:^|[\\/])(?:STOP|agy-enabled|sandbox)(?:[\\/]|$)/i.test(p))return false;
    const backups=path.join(ctx.dirs.backups);
    return [ctx.dirs.secrets,ctx.dirs.jobs,ctx.dirs.ledger].includes(p)&&under(real,runtime)||
      path.dirname(p)===backups&&under(real,realFuture(backups))&&/^[A-Za-z0-9_-]+$/.test(path.basename(p));
  }
  if(protectedPath(p,m,ctx))return false;
  const roots=[m.vault.path,m.runtime_root,path.join(ctx.dirs.root,'app'),ctx.dirs.etc,path.dirname(ctx.dirs.launcher),...(skill?[skill]:[])];
  if(!roots.some(r=>under(p,r)&&under(real,realFuture(r)))&&p!==ctx.dirs.current)return false;
  if(entry.kind==='file'&&entry.removal==='delete_if_hash_matches') {
    if(!entry.created||!entry.sha256)return false;
    if(under(p,m.vault.path))return vaultNames.has(path.relative(m.vault.path,p).split(path.sep).join('/'));
    if(under(p,path.join(ctx.dirs.root,'app'))) {
      const parts=path.relative(path.join(ctx.dirs.root,'app'),p).split(path.sep);
      return [m.app_version,...(m.app_versions||[])].includes(parts.shift())&&exists(path.join(source,...parts))&&fs.statSync(path.join(source,...parts)).isFile();
    }
    return [ctx.dirs.config,ctx.dirs.accounts,ctx.dirs.machine,ctx.dirs.current,ctx.dirs.launcher,...[m.app_version,...(m.app_versions||[])].map(v=>path.join(ctx.dirs.manifests,'app-'+v+'.json')),ctx.dirs.skill].includes(p);
  }
  if(entry.kind==='block')return vaultNames.has(path.relative(m.vault.path,p).split(path.sep).join('/'));
  return true;
}

// Walk only regular files and directories, with containment/reparse checks at each node.
export async function inventory(root,ctx) {
  const files=[],directories=[];
  async function walk(p) {
    if(!under(p,root)||!under(realFuture(p),realFuture(root))||await linked(p,ctx))throw new Error('out_of_scope: '+p);
    const st=fs.lstatSync(p);
    if(st.isDirectory()){directories.push(p);for(const name of fs.readdirSync(p).sort())await walk(path.join(p,name));}
    else if(st.isFile())files.push({path:p,size:st.size,mtime:st.mtime.toISOString(),ino:st.ino});
    else throw new Error('out_of_scope: '+p);
  }
  if(exists(root))await walk(root);
  return {files,directories};
}
