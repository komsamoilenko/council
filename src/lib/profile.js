// Owns profile resolution and machine merge; specification §4.
'use strict';
const fs = require('fs'), path = require('path'), platform = require('../platform');
const paths = require('./paths'), redact = require('./redact');
function read(p) { return JSON.parse(paths.stripBom(fs.readFileSync(p,'utf8'))); }
function resolve(explicit) {
  const id = process.env.COUNCIL_PROFILE || 'default', fromEnv = paths.envConfigPath();
  const result = { ok:false, profile:id, path:null, raw:null, machine:{}, config:null, expanded:{}, errors:[], warnings:[], env_ignored:fromEnv.ignored };
  const fail = (key,reason) => result.errors.push({key,reason});
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) { fail('profile','bad_profile_name'); return result; }
  const dirs = platform.appDirs(), profileDir = path.join(dirs.etc,'profiles',id);
  result.path = explicit || fromEnv.path || path.join(profileDir,'config.json');
  let raw, machine;
  try { raw = read(result.path); } catch { fail('profile','profile_not_installed: council-setup apply --profile ' + id); return result; }
  try { machine = read(path.join(dirs.etc,'machine.json')); } catch { if (explicit || fromEnv.path) machine = {schema:2,binaries:raw.binaries || {}}; else { fail('machine','machine_not_installed'); return result; } }
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
  const zones = [{vault:config.vault,runtime_root:config.runtime_root}];
  try { for (const name of fs.readdirSync(path.join(dirs.etc,'profiles'))) { if (name === id || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) continue; try { const other=read(path.join(dirs.etc,'profiles',name,'config.json')); const t=platform.tokens(); const vault=paths.expandPercentNames(other.vault,t).value; t.COUNCIL_VAULT=vault; zones.push({vault,runtime_root:paths.expandPercentNames(other.runtime_root,t).value}); } catch { fail('profiles.'+name,'profile_unreadable'); } } } catch {}
  const policyMachine = {...machine,profileVaults:zones.map(z=>z.vault),profileRuntimeRoots:zones.map(z=>z.runtime_root)};
  Object.defineProperties(config,{_machine:{value:policyMachine},_profileDir:{value:explicit || fromEnv.path ? path.dirname(result.path) : profileDir},_configPath:{value:result.path}});
  result.raw=raw; result.machine=policyMachine; result.config=config;
  if (fs.existsSync(path.join(config.vault,'bin','council','config.json'))) result.warnings.push('vault_config_ignored');
  const npm=platform.npmRootInfo(policyMachine); if(npm.warning) result.warnings.push(npm.warning);
  result.ok=result.errors.length===0;
  return result;
}
module.exports={resolve};
