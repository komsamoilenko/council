// Owns strict contract substitution and conditional rendering; specification §§2,14.2.
import fs from 'node:fs';
import path from 'node:path';
export const FLAGS=Object.freeze(['INDEX','CONVENTIONS']);
export function render(text,values={},flags={},options={}) {
  for(const key of Object.keys(flags))if(!FLAGS.includes(key) || typeof flags[key]!=='boolean')throw new Error('unknown_or_invalid_flag:'+key);
  let active=null,out='';const tokens=String(text).split(/(\{\{#if [^}]+\}\}|\{\{\/if\}\})/g);
  for(const part of tokens){const open=/^\{\{#if ([^}]+)\}\}$/.exec(part);if(open){if(active!==null || !FLAGS.includes(open[1]))throw new Error('invalid_conditional');active=open[1];}else if(part==='{{/if}}'){if(active===null)throw new Error('unmatched_conditional');active=null;}else if(active===null || flags[active])out+=part;}
  if(active!==null)throw new Error('unclosed_conditional');
  out=out.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g,(_,key)=>{if(!Object.hasOwn(values,key))throw new Error('missing_value:'+key);const v=String(values[key]);return options.json?JSON.stringify(v).slice(1,-1):v;});
  if(/\{\{|\}\}/.test(out))throw new Error('unknown_template_markup');
  // Conditional ground rules remain consecutively numbered.
  const ground=out.indexOf('## Ground rules'),end=out.indexOf('## Layout');
  if(ground>=0 && end>ground){let n=0;out=out.slice(0,ground)+out.slice(ground,end).replace(/^\d+\./gm,()=>String(++n)+'.')+out.slice(end);}
  if(options.json)JSON.parse(out);
  return out;
}
export function layout(vault,{workDir='work',create=[],conventions=false}={}) {
  const wanted=new Set(['AGENTS.md','CLAUDE.md',workDir,...create]);
  for(const name of ['INDEX.md','inbox','shared','output'])if(conventions || fs.existsSync(path.join(vault,name)))wanted.add(name);
  return '```\nVault/\n'+[...wanted].map(n=>'  '+n+(/\.md$/.test(n)?'':'/')).join('\n')+'\n```';
}
export function renderVault(templateDir,name,values,flags,options={}) {
  let source=fs.readFileSync(path.join(templateDir,name),'utf8');
  if(name==='AGENTS.block.md.tmpl' && options.fullContract){const full=fs.readFileSync(path.join(templateDir,'AGENTS.md.tmpl'),'utf8');const parts=full.slice(full.indexOf('## Task folders'),full.indexOf('## Council'));source=source.replace('## Council',parts+'## Council');}
  return render(source,values,flags,options);
}
