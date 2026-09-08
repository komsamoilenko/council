// Owns outbound redaction and config secret detection; specification §6.5.
'use strict';
const patterns = [/AIza[0-9A-Za-z_\-]{20,}/g, /sk-ant-[A-Za-z0-9_-]+/g, /sk-[A-Za-z0-9_-]{12,}/g, /ya29\.[A-Za-z0-9_.-]+/g, /Bearer [A-Za-z0-9_\-.]{16,}/g];
const opaque = /[A-Za-z0-9_\-]{32,}/g;
function text(value, field='') { let s=String(value); for(const re of patterns) s=s.replace(re,'[REDACTED]'); if(['stderr_tail','parse_error'].includes(field)) s=s.replace(opaque,'[REDACTED]'); return s; }
function value(v, field='') { if(typeof v==='string') return text(v,field); if(Array.isArray(v)) return v.map(x=>value(x,field)); if(v && typeof v==='object') return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,value(x,k)])); return v; }
function findSecrets(v, prefix='') { const hits=[]; if(typeof v==='string') { if(patterns.some(re=>{re.lastIndex=0; return re.test(v);})) hits.push(prefix); } else if(v && typeof v==='object') for(const [k,x] of Object.entries(v)) { const p=prefix ? prefix+'.'+k:k; if(/(?:api[_-]?key|secret|password|access[_-]?token)/i.test(k) && typeof x==='string' && x) hits.push(p); else hits.push(...findSecrets(x,p)); } return hits; }
module.exports={text,value,findSecrets};
