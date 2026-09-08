// Owns profile resolution and machine merge; specification §4.
'use strict';
const fs = require('fs'), path = require('path'), platform = require('../platform');
const paths = require('./paths'), redact = require('./redact');
function read(p) { return JSON.parse(paths.stripBom(fs.readFileSync(p,'utf8'))); }
function inside(file, vault) {
  return !!vault && (paths.isUnder(file,vault) || paths.isUnder(paths.realpathSafe(file) || file,paths.realpathSafe(vault) || vault));
}
function vaultConfigs(vault, found) {
  // Discover configs without following agent-controlled directory links.
  let entries; try { entries=fs.readdirSync(vault,{withFileTypes:true}); } catch { return; }
  for (const entry of entries) {
    const file=path.join(vault,entry.name);
    if (entry.name.toLowerCase()==='config.json') found.add(file);
    if (entry.isDirectory() && !entry.isSymbolicLink()) vaultConfigs(file,found);
  }
}
function resolve(explicit) {
  const id = process.env.COUNCIL_PROFILE || 'default', fromEnv = paths.envConfigPath();
  const result = { ok:false, profile:id, path:null, raw:null, machine:{}, config:null, expanded:{}, errors:[], warnings:[], env_ignored:fromEnv.ignored };
  const fail = (key,reason) => result.errors.push({key,reason});
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) { fail('profile','bad_profile_name'); return result; }
  const dirs = platform.appDirs(), profileDir = path.join(dirs.etc,'profiles',id);
  result.path = explicit || fromEnv.path || path.join(profileDir,'config.json');
  let raw, machine;
  try { raw = read(result.path); } catch { fail('profile','profile_not_installed: council-setup apply --profile ' + id); return result; }
  // Installed profiles, never the override, establish the authoritative vault zones.
  const zones = [], installed = new Map();
  try {
    for (const name of fs.readdirSync(path.join(dirs.etc,'profiles'))) {
      if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) continue;
      try {
        const doc=read(path.join(dirs.etc,'profiles',name,'config.json')), t=platform.tokens();
        const v=paths.expandPercentNames(doc.vault,t);
        if (typeof doc.vault !== 'string' || !v.ok || !platform.isAbsoluteNative(v.value)) throw new Error('invalid vault');
        t.COUNCIL_VAULT=v.value;
        zones.push({vault:v.value,runtime_root:paths.expandPercentNames(doc.runtime_root,t).value});
        installed.set(name,doc);
      } catch { fail('profiles.'+name,'profile_unreadable'); }
    }
  } catch (e) { if (e.code !== 'ENOENT') fail('profiles','profiles_unreadable'); }
  const declared=typeof raw?.vault === 'string' ? paths.expandPercentNames(raw.vault,platform.tokens()).value : '';
  const ignored=new Set();
  const inVault=file=>zones.some(z=>inside(file,z.vault)) || inside(file,declared);
  for (const file of [result.path,process.env.COUNCIL_CONFIG].filter(Boolean)) if (inVault(file)) ignored.add(path.resolve(file));
  const override=!!(explicit || fromEnv.path), ignoredOverride=override && inVault(result.path);
  if (ignoredOverride && installed.has(id)) raw=installed.get(id);
  // An override cannot make discovery walk an arbitrary tree by naming it a vault.
  for (const vault of new Set(zones.length ? zones.map(z=>z.vault) : [declared].filter(Boolean))) vaultConfigs(vault,ignored);
  if (ignored.size) result.warnings.push('vault_config_ignored',...Array.from(ignored,p=>'vault_config_ignored: '+p));
  // Bootstrap fixtures outside every vault can carry binaries; unknown installed
  // boundaries fail closed rather than granting an override binary authority.
  if (override && !ignoredOverride && !result.errors.length) machine = {schema:2,binaries:raw?.binaries || {}};
  else try { machine = read(path.join(dirs.etc,'machine.json')); }
  catch { fail('machine','machine_not_installed'); return result; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !machine || typeof machine !== 'object' || Array.isArray(machine)) { fail('config','invalid_config_shape'); return result; }
  for (const [name,doc] of [['profile',raw],['machine',machine]]) for (const key of redact.findSecrets(doc)) fail(name + '.' + key,'secret_in_config');
  if (raw.schema !== 2 || machine.schema !== 2) fail('schema','unsupported_config_schema');
  const config = {...raw, profile:id, binaries:{...(machine.binaries || {})}};
  const table = platform.tokens();
  const expand = (key,value) => { if (typeof value !== 'string') { fail(key,'missing_or_not_string'); return ''; } const r = paths.expandPercentNames(value,table); if(!r.ok) fail(key,'bad_percent_name: ' + r.bad.join(',')); result.expanded[key] = r.value; return r.value; };
  config.vault = expand('vault',config.vault); table.COUNCIL_VAULT = config.vault;
  config.runtime_root = expand('runtime_root',config.runtime_root);
  config.layout = {...(config.layout || {})};
  for (const [key,def] of Object.entries({work_dir:'work',jobs_dir:'work/jobs',ledger_dir:'ledger'})) config.layout[key] = expand('layout.'+key,config.layout[key] || def);
  for (const key of Object.keys(config.binaries)) config.binaries[key] = expand('binaries.'+key,config.binaries[key]);
  if (raw.profile && raw.profile !== id) fail('profile','profile_mismatch');
  zones.push({vault:config.vault,runtime_root:config.runtime_root});
  const policyMachine = {...machine,profileVaults:zones.map(z=>z.vault),profileRuntimeRoots:zones.map(z=>z.runtime_root)};
  Object.defineProperties(config,{_machine:{value:policyMachine},_profileDir:{value:explicit || fromEnv.path ? path.dirname(result.path) : profileDir},_configPath:{value:result.path}});
  result.raw=raw; result.machine=policyMachine; result.config=config;
  const npm=platform.npmRootInfo(policyMachine); if(npm.warning) result.warnings.push(npm.warning);
  result.ok=result.errors.length===0;
  return result;
}
module.exports={resolve};
