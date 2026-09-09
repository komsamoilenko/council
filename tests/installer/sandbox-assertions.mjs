// Whole-tree read-only checks; A-39 permits only measured OS-owned profile prefixes.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {hostPaths,realFuture,under,sha256} from '../../installer/lib/survey.mjs';

export function assertHostTargetsOutsideProfile(ctx) {
  const profile=realFuture(ctx.env.USERPROFILE), targets=hostPaths(ctx);
  for(const file of Object.values(targets).flat())
    assert.ok(!under(realFuture(file),profile),'installer host target resolves inside profile: '+file);
  if(ctx.dirs.id==='win32')for(const host of ['claude-code','codex','claude-desktop'])
    assert.ok(targets[host].length>0,'missing installer host target: '+host);
  return targets;
}

export function snapshot(dir) {
  const result={};
  const walk=p=>{for(const e of fs.readdirSync(p,{withFileTypes:true})) {
    const f=path.join(p,e.name),s=fs.lstatSync(f),rel=path.relative(dir,f);
    if(s.isSymbolicLink())result[rel]={link:fs.readlinkSync(f),mtime:s.mtimeMs};
    else if(s.isDirectory()){result[rel]={directory:true};walk(f);}
    else result[rel]={hash:sha256(fs.readFileSync(f)),mtime:s.mtimeMs};
  }};
  walk(dir);return result;
}

export function assertUnchanged(root,profile,before,after,allowed=[],platform='win32') {
  const prefixes=['AppData/Local','AppData/Roaming','AppData/Local/Microsoft/Windows/PowerShell'].map(p=>path.join(profile,...p.split('/')));
  for(const p of new Set([...Object.keys(before),...Object.keys(after)])) {
    if(isDeepStrictEqual(before[p],after[p]))continue;
    const file=path.resolve(root,p);
    if(under(file,profile)) {
      assert.ok(platform==='win32' && prefixes.some(prefix=>under(file,prefix)),
        'unexpected profile-root change: '+p);
    } else if(Object.hasOwn(before,p)) {
      assert.deepEqual(after[p],before[p],'existing path changed: '+p);
    } else {
      assert.ok(allowed.some(a=>p===a || after[p].directory && a.startsWith(p+path.sep)),
        'unexpected new path: '+p);
    }
  }
}
