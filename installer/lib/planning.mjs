// Owns read-only plan construction, refusals and input fingerprints; specification §§7.3,10.3.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { questions, fail } from './dialogue.mjs';
import { inspectVault, survey, fingerprint, exists, under, realFuture, cloud, linked, readJSON, sha256, stable } from './survey.mjs';
import { render, renderVault, layout } from './render.mjs';
import { mergeMarkerFile, scanMarkers, hashBody } from './markers.mjs';
import { spliceTomlFile } from './tomlblock.mjs';
import { entryState, validateManifest } from './manifest.mjs';
import { safewrite, byteEdit } from './safewrite.mjs';
import { planBytes, planFileHash } from './report.mjs';
import { machineBytes } from './machine.mjs';
import { stamp, scanDuplicates, reportTarget, publishDuplicate } from './duplicates.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const templates = path.join(repo,'installer','templates');
const vaultTemplates = path.join(templates,'vault');
const SIX_IGNORE_LINES = ['work/jobs/','ledger/','STOP','.council/.write-probe','*.council-new.*','*.council-tmp-*'];
export async function sanity(vault, ctx, options) {
  if (typeof vault !== 'string' || !vault) throw fail('E-VAULT-NOT-A-DIR');
  if (/^(\\\\|\/\/)/.test(vault)) throw fail('E-VAULT-ROOT-REFUSED', vault);
  const resolved = realFuture(vault);
  if (!fs.statSync(nearestExisting(resolved)).isDirectory()) throw fail('E-VAULT-NOT-A-DIR',resolved);
  if (exists(vault) && !fs.statSync(vault).isDirectory()) throw fail('E-VAULT-NOT-A-DIR', resolved);
  const roots = [path.parse(resolved).root, ctx.dirs.home, ctx.env.USERPROFILE, ctx.env.APPDATA, ctx.env.LOCALAPPDATA,
    ctx.env.OneDrive, ctx.env.OneDriveConsumer, ctx.env.OneDriveCommercial].filter(Boolean).map(realFuture);
  if (roots.some(root => root === resolved)) throw fail('E-VAULT-ROOT-REFUSED', resolved);
  if (under(realFuture(ctx.dirs.root), resolved)) throw fail('E-VAULT-CONTAINS-APP-DATA', resolved);
  if (await linked(vault, ctx)) throw fail('E-REPARSE-TARGET', resolved);
  const config = readJSON(ctx.dirs.config);
  if (config?.schema > 2) throw fail('E-SCHEMA-NEWER', ctx.dirs.config);
  if (config?.vault && realFuture(config.vault) !== resolved) throw fail('E-PROFILE-EXISTS', ctx.dirs.config);
  let runtime = config?.runtime_root || ctx.dirs.runtimeRoot;
  runtime = runtime.replace(/%([^%]+)%/g, (_,key) => ctx.env[key] || '%'+key+'%');
  const runtimeReal = realFuture(runtime);
  const runtimeEvidence = await cloud(exists(runtimeReal) ? runtimeReal : nearestExisting(runtimeReal), ctx);
  if (runtimeEvidence.synced && runtimeEvidence.scope !== 'provider_presence') throw fail('E-RUNTIME-ROOT-SYNCED', runtimeReal);
  const info = await inspectVault(resolved, ctx);
  if (info.fileCount > 5000 && !options['large-vault']) throw fail('E-LARGE-VAULT', resolved);
  // A provider's configured root itself is also refused, without a write probe.
  const dropbox = ctx.dirs.providerPaths.dropbox ? readJSON(ctx.dirs.providerPaths.dropbox) : null;
  if (dropbox && Object.values(dropbox).some(v => typeof v?.path === 'string' && realFuture(v.path) === resolved)) throw fail('E-VAULT-ROOT-REFUSED', resolved);
  return { ...info, runtimeRoot: runtimeReal, config };
}
function nearestExisting(file) { while (!exists(file)) file = path.dirname(file); return file; }
function filesBelow(dir) {
  const result = [];
  for (const item of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir,item.name);
    if (item.isSymbolicLink()) throw fail('E-REPARSE-TARGET', p);
    if (item.isDirectory()) result.push(...filesBelow(p)); else if (item.isFile()) result.push(p);
  }
  return result;
}
function validateAnswers(a) {
  if (typeof a.vault !== 'string' || !a.vault || typeof a.owner !== 'string' || typeof a['chat-language'] !== 'string') throw fail('E-USAGE', 'Vault, owner and chat-language must be strings.');
  for (const key of ['relocate-runtime','duplicates','conventions','git-init','large-vault','allow-unsupported-platform']) if (a[key] !== undefined && typeof a[key] !== 'boolean') throw fail('E-USAGE', key + ' must be boolean.');
  const merges = typeof a.merge === 'string' ? [a.merge] : a.merge && !Array.isArray(a.merge) ? Object.values(a.merge) : [];
  if (!merges.length || merges.some(m => !['block','none','sidecar','ask'].includes(m))) throw fail('E-USAGE', 'Invalid merge strategy.');
  if (typeof a.merge === 'object' && Object.keys(a.merge).some(k => !['AGENTS.md','CLAUDE.md','INDEX.md','.gitignore'].includes(k))) throw fail('E-USAGE', 'Unknown merge filename.');
  if (!['now','later'].includes(a['gemini-key'])) throw fail('E-USAGE', 'gemini-key must be now or later; do not put a key in answers.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(a['register-as'] || 'council')) throw fail('E-USAGE', 'Invalid --register-as name.');
}
export async function buildPlan(options, ctx) {
  const tentative = options.vault || path.join(ctx.dirs.home,'Notes');
  // All refusals and conflict checks complete before either permitted publication.
  const first = await sanity(tentative, ctx, options);
  const a = await questions(options, { home: ctx.dirs.home, cloud: !!first.cloud?.synced && first.cloud.scope !== 'provider_presence', fresh: !first.exists || first.fileCount === 0 });
  validateAnswers(a);
  const info = await sanity(a.vault, ctx, a); a.vault = info.path;
  const detect = await survey(a, ctx);
  const blockers = detect.blocks.flatMap(b => b.errors).filter(e => !(e.code === 'E-PLATFORM' && a['allow-unsupported-platform']));
  if (blockers.length) throw fail(blockers[0].code, blockers[0].detail);
  const ts = stamp(ctx.now()), profile = a.profile || 'default';
  const file = path.join(ctx.dirs.plans, ts + '.json');
  if (under(realFuture(ctx.dirs.plans), a.vault) || await linked(ctx.dirs.plans,ctx) || exists(file)) throw fail('E-USAGE', 'Plan output location is unsafe or already exists.');
  const plan = { schema: 1, verb: 'plan', profile, created_at: ctx.now().toISOString(), file,
    answers: Object.fromEntries(Object.entries(a).filter(([key]) => !['answers','json','log','verbose','no-color'].includes(key))),
    detect_fingerprint: fingerprint(detect, a['register-as'] || 'council'), steps: [], registrations: [], pending_hosts: [], untouched: [], warnings: [...detect.warnings] };
  plan.adoptions=[];plan.proposals=[];
  if (a.log) plan.warnings.push('--log suppressed by the read-only output invariant.');
  if (info.cloud?.synced) plan.warnings.push('cloud sync: ' + info.cloud.signal + ' / ' + info.cloud.detail + (info.cloud.scope ? ' (' + info.cloud.scope + ')' : ''));
  if (a['gemini-key'] === 'now') plan.warnings.push('Key setup requested; run council-setup set-key after apply. No key is requested or stored by plan.');
  const contractInfo = info.contracts['.council/vault.json'];
  if (contractInfo?.reparse) throw fail('E-REPARSE-TARGET',path.join(a.vault,'.council','vault.json'));
  if (contractInfo?.notHashed) throw fail('E-STEP','Cloud-only vault contract; hydrate it before planning.');
  const config = info.config, contract = contractInfo?.exists ? readJSON(path.join(a.vault,'.council','vault.json')) : null;
  if (contract?.schema > 1 || contract?.contract_version > 1) throw fail('E-SCHEMA-NEWER',path.join(a.vault,'.council','vault.json'));
  const existingManifest = readJSON(ctx.dirs.manifest);
  if (existingManifest) validateManifest(existingManifest);
  const transplanted = !config && (!!contract || Object.values(info.contracts).some(v => v.marker));
  plan.transplanted = transplanted;
  const steps = new Map();
  const stage = (id, action) => { const item = { id, action, writes: [] }; steps.set(id,item); plan.steps.push(item); return item; };
  for (const [id, action] of [['S0','preflight'],['S1','lock+journal'],['S2','backups'],['S3','app'],['S4','machine+profile'],['S5','runtime'],['S6','vault'],['S7','tier0'],['S8','register'],['S9','manifest'],['S10','journal commit'],['S11','report']]) stage(id,action);
  const backup = (target, mirror) => path.join(ctx.dirs.backups,ts,mirror || path.relative(ctx.dirs.root,target));
  const add = (id, target, data, extra = {}) => {
    const present = exists(target), directory = extra.directory || false;
    if (present && directory) { if (!fs.statSync(target).isDirectory()) throw fail('E-VAULT-NOT-A-DIR',target); return; }
    if (present && data !== undefined && fs.readFileSync(target).equals(Buffer.from(data))) return;
    const w = { path: target, action: present ? 'rewrite' : 'create', bytes: directory ? 0 : data === undefined ? null : Buffer.byteLength(data), ...extra,
      before_sha256: present && !directory ? sha256(fs.readFileSync(target)) : null };
    if (data !== undefined) {
      if(present&&under(target,a.vault)) {
        const edit=byteEdit(fs.readFileSync(target),Buffer.from(data));
        w.splice={start:edit.oldRange.start,end:edit.oldRange.end,bytes_base64:edit.bytes.subarray(edit.newRange.start,edit.newRange.end).toString('base64')};
      } else w.content = String(data);
    }
    if (present) { w.beforeBytes = fs.statSync(target).size; w.backup ||= backup(target, under(target,a.vault) ? path.join('vault',path.relative(a.vault,target)) : undefined); }
    steps.get(id).writes.push(w); return w;
  };
  const dir = (id,p) => add(id,p,undefined,{directory:true});
  steps.get('S7').temporaries = [{root:'os.tmpdir()',prefix:'council-smoke-',cleanup:'success only; retain and report on failure'}];
  if (!transplanted) {
    dir('S0',path.join(a.vault,'.council'));
    add('S0',path.join(a.vault,'.council','.write-probe'),'',{ note: "created and removed inside apply's preflight", transient: true });
  }
  add('S1',ctx.dirs.lock,undefined,{transient:true,note:'pid and creation time; removed on commit'});
  add('S1',path.join(ctx.dirs.journal,ts+'.jsonl'),undefined,{note:'begin/pre/post/commit records; size determined by apply'});
  const src = path.join(repo,'src');
  const appFiles = [];
  for (const source of filesBelow(src)) {
    const target = path.join(ctx.dirs.app,path.relative(src,source));
    appFiles.push({path:path.relative(src,source).split(path.sep).join('/'),sha256:sha256(fs.readFileSync(source))});
    if (exists(target) && !fs.readFileSync(target).equals(fs.readFileSync(source))) throw fail('E-NO-MANIFEST','Installed app differs: ' + target);
    add('S3',target,fs.readFileSync(source));
  }
  add('S3',path.join(ctx.dirs.manifests,'app-0.1.0.json'),JSON.stringify({schema:1,version:'0.1.0',files:appFiles},null,2)+'\n',{ note: 'per-file SHA256 inventory' });
  add('S3',ctx.dirs.launcher,fs.readFileSync(path.join(repo,'bin','council-server.js')),{note:'stable launcher'});
  add('S3',ctx.dirs.current,JSON.stringify({ ...readJSON(ctx.dirs.current), version: '0.1.0' },null,2)+'\n');
  const relocated = a['relocate-runtime'];
  const layoutPaths = { work_dir: config?.layout?.work_dir || 'work', jobs_dir: relocated ? path.join(info.runtimeRoot,'jobs') : config?.layout?.jobs_dir || 'work/jobs', ledger_dir: relocated ? path.join(info.runtimeRoot,'ledger') : config?.layout?.ledger_dir || 'ledger' };
  if(transplanted&&!config) {
    layoutPaths.jobs_dir=path.join(info.runtimeRoot,'jobs');layoutPaths.ledger_dir=path.join(info.runtimeRoot,'ledger');
    plan.warnings.push('Transplanted profile uses new local jobs and ledger directories; existing vault runtime data is retained.');
  }
  for (const value of Object.values(layoutPaths)) {
    const target=path.resolve(a.vault,value);
    if (await linked(target,ctx)) throw fail('E-REPARSE-TARGET',target);
    const p=realFuture(target); if (!under(p,a.vault) && !under(p,info.runtimeRoot)) throw fail('E-USAGE','layout outside vault/runtime: ' + value);
  }
  if (relocated) for (const [key, sourceDefault] of [['jobs_dir','work/jobs'],['ledger_dir','ledger']]) {
    const source = path.resolve(a.vault,config?.layout?.[key] || sourceDefault), destination = layoutPaths[key];
    if (source !== destination && exists(source) && fs.readdirSync(source).length) {
      const quote = v => "'" + v.replaceAll("'", "''") + "'";
      throw fail('E-RELOCATE-NONEMPTY', `Copy-Item -LiteralPath ${quote(source)} -Destination ${quote(destination)} -Recurse\nKeep the source intact; configure layout.${key} to ${destination} after reviewing the copy.`);
    }
  }
  plan.layout = layoutPaths; plan.cloud_sync = { ...info.cloud, accepted: !!info.cloud?.synced && !relocated };
  const values = { VAULT: a.vault, OWNER: a.owner, CHAT_LANGUAGE: a['chat-language'], PROFILE: profile, CREATED_AT: plan.created_at,
    SERVER_NAME: a['register-as'] || 'council', RUNTIME_ROOT: info.runtimeRoot, WORK_DIR: layoutPaths.work_dir,
    JOBS_DIR: layoutPaths.jobs_dir, LEDGER_DIR: layoutPaths.ledger_dir,
    LAYOUT: layout(a.vault,{workDir:layoutPaths.work_dir, conventions:a.conventions}) };
  const proposedConfig = JSON.parse(render(fs.readFileSync(path.join(templates,'profile','config.template.json'),'utf8'),values,{}, {json:true}));
  add('S4',ctx.dirs.config,JSON.stringify({ ...proposedConfig, ...config, profile, vault:a.vault, runtime_root:info.runtimeRoot, layout:layoutPaths, server_name:values.SERVER_NAME, created_by:'council-setup 0.1.0' },null,2)+'\n');
  if (!exists(ctx.dirs.accounts)) add('S4',ctx.dirs.accounts,fs.readFileSync(path.join(templates,'profile','accounts.template.json')));
  add('S4',ctx.dirs.machine,machineBytes(readJSON(ctx.dirs.machine),detect,ctx,profile,{shared:false}),{note:'merge installer-owned machine keys; preserve all other keys'});
  for (const p of ['claude','codex','gemini','echo']) dir('S5',path.join(info.runtimeRoot,'sandbox',p));
  dir('S5',path.join(info.runtimeRoot,'secrets'));
  for (const p of ['control','control/idem','control/sessions','reads']) dir('S5',path.join(info.runtimeRoot,p));
  for (const p of [layoutPaths.jobs_dir,layoutPaths.ledger_dir]) dir(under(path.resolve(a.vault,p),info.runtimeRoot)?'S5':'S6',path.resolve(a.vault,p));
  const flags = { INDEX: a.conventions || exists(path.join(a.vault,'INDEX.md')), CONVENTIONS: a.conventions };
  const targetContract = { schema:1, profile, vault_id:contract?.vault_id || randomUUID(), contract_version:1, app_version:'0.1.0', installed_at:contract?.installed_at || plan.created_at, note:'Paths and credentials are local; this contract travels with the vault.' };
  add('S6',path.join(a.vault,'.council','vault.json'),JSON.stringify(targetContract,null,2)+'\n',{note:'path-free vault contract; preserve user keys', ...(contract ? { content: undefined } : {})});
  const contractWrite = steps.get('S6').writes.at(-1);
  if (contract && contractWrite?.path === path.join(a.vault,'.council','vault.json')) { contractWrite.content = JSON.stringify({...contract,...targetContract},null,2)+'\n'; contractWrite.bytes = Buffer.byteLength(contractWrite.content); }
  const manifest = existingManifest;
  for (const name of ['AGENTS.md','CLAUDE.md', ...(flags.INDEX ? ['INDEX.md'] : []), ...(info.git || a['git-init'] ? ['.gitignore'] : [])]) {
    const target = path.join(a.vault,name), item = info.contracts[name];
    if (await linked(target,ctx)) throw fail('E-REPARSE-TARGET',target);
    if (item?.notHashed) throw fail('E-STEP','Cloud-only contract; hydrate it before planning: ' + target);
    let strategy = typeof a.merge === 'object' ? a.merge[name] || 'block' : a.merge;
    if (item?.protocol && !item.marker) strategy = 'none';
    plan.answers.merge = typeof plan.answers.merge === 'object' ? plan.answers.merge : {};
    plan.answers.merge[name] = strategy;
    if (strategy === 'none' && item?.exists) { plan.untouched.push(target + (item?.protocol ? ' (contract already present; I will not write into this file)' : ' (strategy none)')); continue; }
    if (strategy === 'ask') throw fail('E-USAGE','Choose block, none or sidecar for ' + name + ' in --answers.');
    const full = name === '.gitignore' ? null : renderVault(vaultTemplates,name+'.tmpl',values,flags);
    const owned=manifest?.entries?.find(e=>e.path===target);
    if(item?.exists&&owned?.kind==='file'&&owned.sha256!==sha256(fs.readFileSync(target))) {
      const sibling=target+'.council-new.'+ts;
      if(exists(sibling))throw fail('E-SIDECAR-EXISTS',sibling);
      const proposal=full||fs.readFileSync(target,'utf8');
      add('S6',sibling,proposal);plan.proposals.push({path:target,sibling,before_source:target,after:proposal});plan.untouched.push(target+' (user edit retained)');continue;
    }
    const renderedBlock = name === 'AGENTS.md' ? renderVault(vaultTemplates,'AGENTS.block.md.tmpl',values,flags,{fullContract:true}) : null;
    const body = name === '.gitignore' ? SIX_IGNORE_LINES.join('\n') : name === 'AGENTS.md' ? scanMarkers(Buffer.from(renderedBlock)).block.body.toString('utf8') :
      name === 'CLAUDE.md' ? '@AGENTS.md\nUse council_start / council_poll for consultations.\nFollow AGENTS.md for the council protocol.\n' : '# Vault index\n\nOne line per artifact: path — description — agent — date.\nAppend new entries at the bottom.\nKeep prior entries unchanged.\nUse a vault-relative path.\n';
    if (!item?.exists) { if (!transplanted) add('S6',target,name === '.gitignore' ? '# council:begin v=1\n'+body+'\n# council:end\n' : full); continue; }
    const recorded = manifest?.entries?.find(f => f.path === target)?.block_sha256_eolnorm;
    const templateHashes = [hashBody(body),hashBody(body+'\n')];
    if (name === 'AGENTS.md') templateHashes.push(hashBody(scanMarkers(Buffer.from(renderVault(vaultTemplates,'AGENTS.block.md.tmpl',values,flags))).block.body));
    const merged = await mergeMarkerFile(target,body,{dryRun:true,strategy, recordedHash:recorded, templateHashes, platform:{implemented:{fileAttributes:false}}});
    if (!merged.ok) {
      if(owned?.kind==='block'&&merged.code.replaceAll('_','-')==='E-BLOCK-CHANGED') {
        const sibling=target+'.council-new';if(exists(sibling))throw fail('E-SIDECAR-EXISTS',sibling);
        const proposal=merged.proposal?.toString('utf8')||renderedBlock||full||body;
        add('S6',sibling,proposal);plan.proposals.push({path:target,sibling,before_source:target,after:proposal});plan.untouched.push(target+' (user block edit retained)');continue;
      }
      throw fail(merged.code,target);
    }
    if(merged.adopted&&!merged.changed)plan.adoptions.push({path:target,kind:'block',block_id:'council:contract',contract_version:1,block_sha256_eolnorm:hashBody(scanMarkers(fs.readFileSync(target),{style:name==='.gitignore'?'hash':'markdown'}).block.body),pre_existing:true,backup:null,adopted:true,removal:'excise_block'});
    if (transplanted) { plan.untouched.push(target + ' (transplanted contract left in place)'); continue; }
    if (merged.action === 'none') { plan.untouched.push(target); continue; }
    if (merged.action === 'sidecar') { if (merged.proposalConflict) throw fail('E-USAGE','Sidecar exists: '+merged.sibling); add('S6',merged.sibling,merged.proposal); plan.untouched.push(target+' (add '+merged.importLine+' manually)'); }
    else if (merged.changed) add('S6',target,merged.bytes,{action:'block',beforeBytes:item?.bytes || 0,backup:backup(target,path.join('vault',name)),note:merged.upgraded?'upgrades begin marker to v=1':merged.adopted?'adopts matching template block':undefined});
  }
  if (!transplanted) {
    dir('S6',path.resolve(a.vault,layoutPaths.work_dir));
    if (a.conventions) {
      for (const name of ['inbox','output','shared']) dir('S6',path.join(a.vault,name));
      const target = path.join(a.vault,'shared','debate-prompt.md');
      if (!exists(target)) add('S6',target,renderVault(vaultTemplates,'shared/debate-prompt.md.tmpl',values,flags)); else plan.untouched.push(target);
    }
    if (a['git-init'] && !info.git) steps.get('S6').git_init = { path:a.vault, note:'explicit git init requested; Git owns the resulting .git metadata' };
  }
  const surfaces = ['claude-code','codex','claude-desktop'];
  const chosen = a.hosts === 'all' ? surfaces : a.hosts === 'none' ? [] : typeof a.hosts === 'string' ? a.hosts.split(',') : [];
  if (typeof a.hosts !== 'string' || chosen.some(s => !surfaces.includes(s)) || new Set(chosen).size !== chosen.length) throw fail('E-USAGE','Invalid hosts list.');
  const hosts = detect.blocks.find(b => b.name === 'hosts').hosts, clis = detect.blocks.find(b => b.name === 'clis').clis;
  const desktop = hosts.filter(h => h.surface === 'claude-desktop' && h.exists);
  if (chosen.includes('claude-desktop') && desktop.length > 1 && !a['desktop-config']) throw fail('E-USAGE','Select desktop-config in --answers: ' + desktop.map(h => h.path).join(', '));
  if (a['desktop-config'] && !desktop.some(h => h.path === path.resolve(a['desktop-config']))) throw fail('E-USAGE','desktop-config must name a detected config.');
  for (const surface of chosen) {
    const host = hosts.find(h => h.surface === surface && (surface !== 'claude-desktop' || (a['desktop-config'] ? h.path === path.resolve(a['desktop-config']) : h.exists)));
    const available = surface === 'claude-code' ? clis.claude.usable || !!host?.exists : surface === 'codex' ? clis.codex.usable : !!host;
    if (!available || !host) { plan.pending_hosts.push(surface); continue; }
    const registration = { surface, path:host.path, name:values.SERVER_NAME, command:ctx.node,args:[ctx.dirs.launcher], env:{COUNCIL_HOST:surface,COUNCIL_PROFILE:profile} };
    if (host.entries[values.SERVER_NAME]) {
      const owned = manifest?.registrations.find(r => r.file === host.path && r.name === values.SERVER_NAME);
      if (owned && entryState(owned,manifest).state === 'unchanged') { plan.untouched.push(host.path+' (verified council registration)'); continue; }
      const target=host.entries[values.SERVER_NAME].pointsTo?.args?.[0];
      if(typeof target!=='string'||!/(?:^|[\\/])council[\\/](?:app[\\/][^\\/]+[\\/])?server\.js$/i.test(target))throw fail('E-HOST-NAME-TAKEN', host.path + ': ' + values.SERVER_NAME);
      registration.adoptExisting=true;
      plan.warnings.push('Adoption requires apply --adopt-existing: '+host.path);
    }
    plan.registrations.push(registration);
    if (surface === 'codex') {
      const body = `[mcp_servers.${values.SERVER_NAME}]\ncommand = ${JSON.stringify(ctx.node)}\nargs = [${JSON.stringify(ctx.dirs.launcher)}]\ntool_timeout_sec = 60\n[mcp_servers.${values.SERVER_NAME}.env]\nCOUNCIL_HOST = "codex"\nCOUNCIL_PROFILE = ${JSON.stringify(profile)}\n`;
      const merge = await spliceTomlFile(host.path,body,{dryRun:true,name:values.SERVER_NAME,adoptExisting:registration.adoptExisting,platform:{implemented:{fileAttributes:false}}});
      if (!merge.ok) throw fail(merge.code,host.path);
      add('S8',host.path,undefined,{backup:host.exists?backup(host.path,path.join('hosts',surface,path.basename(host.path))):undefined,note:'marked TOML block; other tables preserved'});
    } else add('S8',host.path,undefined,{backup:host.exists?backup(host.path,path.join('hosts',surface,path.basename(host.path))):undefined,note:surface === 'claude-code' ? 'via claude mcp add-json; user scope' : 'mcpServers.'+values.SERVER_NAME+' only'});
  }
  const skillBytes=render(fs.readFileSync(path.join(templates,'skill','SKILL.md.tmpl'),'utf8'),{});
  const skillHash=sha256(skillBytes),skillPresent=exists(ctx.dirs.skill);
  const knownSkill=existingManifest?.entries.find(e=>e.path===ctx.dirs.skill&&e.template==='skill');
  const actualSkill=skillPresent?sha256(fs.readFileSync(ctx.dirs.skill)):null;
  const trustedSkills=new Set([skillHash]);
  if(exists(path.join(ctx.dirs.etc,'profiles')))for(const id of fs.readdirSync(path.join(ctx.dirs.etc,'profiles'))) {
    if(!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id))continue;
    const m=readJSON(path.join(ctx.dirs.etc,'profiles',id,'manifest.json'));
    for(const e of m?.entries||[])if(e.template==='skill'&&!e.kept&&e.sha256)trustedSkills.add(e.sha256);
  }
  const kept=skillPresent&&!trustedSkills.has(actualSkill);
  plan.skill={path:ctx.dirs.skill,kind:'file',sha256:kept?actualSkill:skillHash,created:knownSkill?.created??!skillPresent,template:'skill',removal:'never_while_profile_exists',...(kept?{kept:'user_modified'}:{})};
  if(kept)plan.warnings.push('Skill kept: user_modified — '+ctx.dirs.skill);
  else add('S9',ctx.dirs.skill,skillBytes,{backup:skillPresent?backup(ctx.dirs.skill,path.join('shared','SKILL.md')):undefined,template:'skill'});
  const machineWrite=add('S9',ctx.dirs.machine,machineBytes(readJSON(ctx.dirs.machine),detect,ctx,profile),{note:'shared skill and profile refcount'});
  const machineStage4=steps.get('S4').writes.find(w=>w.path===ctx.dirs.machine);
  if(machineWrite&&machineStage4){
    machineWrite.before_sha256=sha256(machineStage4.content);machineWrite.after_stage='S4';
    machineWrite.backup=backup(ctx.dirs.machine,path.join('stages','S9','machine.json'));
    const staged=add('S9',machineWrite.backup,undefined,{stage_backup:true,source:ctx.dirs.machine,bytes:Buffer.byteLength(machineStage4.content),note:'S4 pre-image captured before S9 shared refcount'});
    steps.get('S9').writes.splice(steps.get('S9').writes.indexOf(staged),1);steps.get('S9').writes.splice(steps.get('S9').writes.indexOf(machineWrite),0,staged);
  }
  add('S9',ctx.dirs.manifest,undefined,{note:'ownership manifest; generated by apply'});
  // Every touched pre-image gets a whole-file backup, including local metadata.
  for (const w of plan.steps.flatMap(s => s.writes)) if (w.backup&&!w.after_stage) add('S2',w.backup,undefined,{source:w.path,bytes:fs.statSync(w.path).size,source_sha256:sha256(fs.readFileSync(w.path)),note:'whole-file pre-image; owner-only ACL checked by apply'});
  if (transplanted) {
    // Transplant narrows vault edits, not transaction safety stages.
    steps.get('S6').writes = steps.get('S6').writes.filter(w => w.path === path.join(a.vault,'.council','vault.json'));
    plan.warnings.push('Transplanted vault: S3–S5 and S8, plus path-free vault contract refresh; existing vault structure is retained.');
  }
  if (plan.pending_hosts.length) plan.warnings.push('Pending hosts: '+plan.pending_hosts.join(', '));
  // Include structural creations as well as file publications, in stage order.
  const declared = new Set();
  for (const step of plan.steps) {
    const writes = [];
    for (const write of step.writes) {
      if (await linked(write.path,ctx)) throw fail('E-REPARSE-TARGET',write.path);
      const parents = [];
      for (let p=path.dirname(write.path); !exists(p) && !declared.has(p); p=path.dirname(p)) parents.unshift(p);
      for (const p of parents) { writes.push({path:p,action:'create',directory:true,bytes:0}); declared.add(p); }
      if (write.directory && declared.has(write.path)) continue;
      writes.push(write);declared.add(write.path);
    }
    step.writes = writes;
  }
  const duplicates = a.duplicates ? { file:await reportTarget(a,ctx,a.vault), report:await scanDuplicates(a.vault,ctx) } : null;
  if (duplicates) plan.duplicates = { reportFile:duplicates.file, files:duplicates.report.files, hashedBytes:duplicates.report.hashedBytes, capped:duplicates.report.capped };
  plan.file_sha256 = planFileHash(plan);
  return { plan, detect, duplicates };
}
export async function publishPlan(result) {
  const { plan, duplicates } = result;
  fs.mkdirSync(path.dirname(plan.file),{recursive:true});
  await safewrite(plan.file, planBytes(plan), {exclusive:true});
  if (duplicates) await publishDuplicate(duplicates.report,duplicates.file);
}
