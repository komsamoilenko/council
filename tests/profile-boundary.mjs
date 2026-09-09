// Additional regression checks; the existing trust assertions remain untouched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture,json} from './trust/fixture.mjs';

const f=fixture();
let success=false;
try {
  const profile=f.load('lib/profile.js'), baseline=profile.resolve().config.binaries;
  const fakeVault=path.join(f.root,'claimed-vault');
  fs.mkdirSync(fakeVault);
  const hostile={...f.config,vault:fakeVault,binaries:{node:path.join(f.vault,'evil')}};
  const nested=json(path.join(f.vault,'notes','arbitrary-profile.json'),hostile);
  for (const host of ['', 'smoke', 'codex']) {
    process.env.COUNCIL_HOST=host;
    process.env.COUNCIL_CONFIG=nested;
    const r=profile.resolve();
    assert.deepEqual(r.config.binaries,baseline);
    assert.equal(r.config.vault,f.vault);
    assert.ok(r.warnings.includes('vault_config_ignored: '+nested));
  }
  delete process.env.COUNCIL_CONFIG;
  delete process.env.COUNCIL_HOST;
  assert.deepEqual(profile.resolve(nested).config.binaries,baseline);
  const dropped=json(path.join(f.vault,'notes','config.json'),hostile);
  assert.ok(profile.resolve().warnings.includes('vault_config_ignored: '+dropped));

  const alias=path.join(f.root,'vault-alias');
  fs.symlinkSync(f.vault,alias,'junction');
  assert.deepEqual(profile.resolve(path.join(alias,'notes','arbitrary-profile.json')).config.binaries,baseline);

  const second=path.join(f.root,'second-vault');
  fs.mkdirSync(second);
  json(path.join(f.dirs.etc,'profiles','second','config.json'),{...f.config,vault:second});
  const other=json(path.join(second,'override.json'),hostile);
  assert.deepEqual(profile.resolve(other).config.binaries,baseline);

  const bootstrap=json(path.join(f.root,'bootstrap.json'),{...f.config,binaries:{node:process.execPath}});
  assert.deepEqual(profile.resolve(bootstrap).config.binaries,{node:process.execPath});
  fs.writeFileSync(path.join(f.dirs.etc,'profiles','second','config.json'),'{');
  const closed=profile.resolve(bootstrap);
  assert.equal(closed.ok,false);
  assert.deepEqual(closed.config.binaries,baseline);
  assert.equal(f.spawns,0);
  assert.equal(f.networks,0);
  console.log('PASS profile boundary: forged vault, nested path, ignored host override, junction, second profile, bootstrap, unreadable boundary; zero external I/O');
  success=true;
} finally { f.close(success); }
