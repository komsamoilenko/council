// Runs the scanner regressions and tracked-tree release checks together.
import './scan-personal.test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const repo = fs.realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const base = fs.realpathSync(os.tmpdir());
const root = fs.mkdtempSync(path.join(base, 'council-stage-test-'));
const copy = path.join(root, 'repo');
const env = {...process.env, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:path.join(root, 'no-global-config')};
const run = (file, args, cwd = copy) => spawnSync(file, args,
  {cwd, env, encoding:'utf8', windowsHide:true, shell:false, maxBuffer:16*1024*1024});
const checked = result => {
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
};
function snapshot() {
  const entries = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, {withFileTypes:true}).sort((a,b)=>a.name < b.name ? -1 : 1)) {
      const name = path.join(dir, entry.name);
      const stat = fs.lstatSync(name);
      entries.push([path.relative(root, name), stat.isDirectory() ? 'directory' : fs.readFileSync(name).toString('base64'), stat.mtimeMs]);
      if (stat.isDirectory()) walk(name);
    }
  };
  walk(root);
  return entries;
}
try {
  checked(run('git', ['clone', '--quiet', '--no-hardlinks', '--no-local', repo, copy], root));
  assert.equal(checked(run('git', ['status', '--porcelain', '--untracked-files=all'])), '');
  // Exercise the candidate even before it is committed in the source checkout.
  fs.copyFileSync(path.join(repo, 'tools/stage-release.mjs'), path.join(copy, 'tools/stage-release.mjs'));
  const expected = checked(run('git', ['ls-files', '-z'])).split('\0').filter(Boolean).sort();
  const before = snapshot();
  const inventory = checked(run(process.execPath, ['tools/stage-release.mjs', '--inventory-only']));
  assert.equal(inventory, expected.join('\n') + '\n');
  assert.deepEqual(snapshot(), before, 'inventory-only must create or change nothing');
  console.log('inventory == git ls-files: ' + expected.length + ' paths; diff empty; no writes');

  fs.writeFileSync(path.join(copy, 'scratch-untracked.txt'), 'dirty fixture\n');
  // If the gate starts at all it leaves evidence, even if its output is hidden.
  const marker = path.join(copy, 'gate-started');
  fs.writeFileSync(path.join(copy, 'tests/run.mjs'), "import fs from 'node:fs'; fs.writeFileSync('gate-started', 'started');\n");
  const out = path.join(root, 'council-public');
  const releaseVersion = JSON.parse(fs.readFileSync(path.join(copy, 'package.json'), 'utf8')).version;
  const dirty = run(process.execPath, ['tools/stage-release.mjs', '--out', out, '--version', releaseVersion]);
  assert.ifError(dirty.error);
  assert.equal(dirty.status, 1);
  assert.equal(dirty.stderr, 'stage-release: REFUSED: working tree is dirty\n');
  assert.equal(dirty.stdout, '', 'no RUN line: gate never started');
  assert.equal(fs.existsSync(marker), false, 'gate marker absent');
  assert.equal(fs.existsSync(out), false, 'output absent');
  process.stdout.write(dirty.stderr);
  console.log('gate did not start: stdout empty; gate marker absent; output absent');

  const mismatch = run(process.execPath, ['tools/stage-release.mjs', '--out', out, '--version', '9.9.9']);
  assert.ifError(mismatch.error);
  assert.equal(mismatch.status, 1);
  assert.equal(mismatch.stderr, 'stage-release: REFUSED: version must match package.json and src/version.js\n');
  assert.equal(fs.existsSync(out), false, 'output absent');
  console.log('version mismatch refused before the gate: ' + mismatch.stderr.trim());

  // The src/version.js half on its own: agreeing with package.json must not be enough.
  const runtimeFile = path.join(copy, 'src/version.js');
  const runtimeSource = fs.readFileSync(runtimeFile, 'utf8');
  const runtimeVersion = /APP_VERSION:\s*'([^']+)'/.exec(runtimeSource)[1];
  assert.equal(runtimeVersion, releaseVersion, 'the clone starts with package.json and src/version.js in step');
  const drifted = runtimeVersion.replace(/(\d+)$/, patch => String(Number(patch) + 1));
  assert.notEqual(drifted, runtimeVersion, 'the fixture must fabricate a different runtime version');
  fs.writeFileSync(runtimeFile, runtimeSource.replace(/APP_VERSION:\s*'[^']+'/, "APP_VERSION: '" + drifted + "'"));
  const runtimeDrift = run(process.execPath, ['tools/stage-release.mjs', '--out', out, '--version', releaseVersion]);
  fs.writeFileSync(runtimeFile, runtimeSource);
  assert.ifError(runtimeDrift.error);
  assert.equal(runtimeDrift.status, 1);
  assert.equal(runtimeDrift.stderr, 'stage-release: REFUSED: version must match package.json and src/version.js\n');
  assert.equal(runtimeDrift.stdout, '', 'no RUN line: gate never started');
  assert.equal(fs.existsSync(marker), false, 'gate marker absent');
  assert.equal(fs.existsSync(out), false, 'output absent');
  console.log('src/version.js drift refused although package.json agreed: ' + runtimeDrift.stderr.trim());
} finally {
  const resolved = fs.realpathSync(root);
  assert.equal(path.dirname(resolved), base);
  assert.ok(path.basename(resolved).startsWith('council-stage-test-'));
  fs.rmSync(resolved, {recursive:true, force:true});
}
console.log('stage-release regression checks passed');
