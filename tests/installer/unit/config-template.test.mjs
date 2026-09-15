// Owns the config template's cross-version render contract; specification §§2,14.2.
// A CONFIG_SCHEMA migration renders the NEW release's template with the OLD installer's
// code, so the template may never need a value that released code does not already pass.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '../../../installer/lib/render.mjs';
import version from '../../../src/version.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const templatePath = path.join(repo, 'installer', 'templates', 'profile', 'config.template.json');
const template = fs.readFileSync(templatePath, 'utf8');
const tokens = new Set([...template.matchAll(/\{\{([A-Z][A-Z0-9_]*)\}\}/g)].map(m => m[1]));

// The values the OLDEST installer that can run this migration passes. Frozen deliberately:
// reading them from the working tree would let a token added on both sides at once pass this
// test and still break the installer a user already has. Recorded from v0.1.0, the first
// published release; shortening this list drops support for the installers that shipped it.
const RELEASED_VALUES = ['VAULT', 'RUNTIME_ROOT', 'PROFILE', 'CREATED_AT', 'SERVER_NAME', 'WORK_DIR', 'JOBS_DIR', 'LEDGER_DIR'];

/** The token names today's CONFIG_SCHEMA migration supplies, read out of the shipped code. */
function currentValues() {
  const source = fs.readFileSync(path.join(repo, 'installer', 'lib', 'update.mjs'), 'utf8');
  const start = source.indexOf('render(template.toString(),{');
  assert.notEqual(start, -1, 'the CONFIG_SCHEMA migration still renders the config template');
  const open = source.indexOf('{', start);
  let depth = 0, end = -1;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) { end = i; break; }
  }
  assert.ok(end > open, 'the migration passes a literal value object');
  const keys = [...source.slice(open + 1, end).matchAll(/(?:^|[{,])\s*([A-Z][A-Z0-9_]*)\s*:/g)].map(m => m[1]);
  assert.ok(keys.length, 'the migration names its template values inline');
  return keys;
}

const migrationValues = () => Object.fromEntries(RELEASED_VALUES.map(key => [key, 'migration-supplied']));

export default async function(test) {
  await test('the template needs no value the released installer withholds', async () => {
    const values = migrationValues();
    // The assertion that catches a new {{TOKEN}}: the installer the user already has renders
    // the template the new release ships, and render() throws on a name it was not passed.
    for (const token of tokens)
      assert.ok(Object.hasOwn(values, token),
        'config.template.json uses {{' + token + '}}, which the released installer does not pass during a CONFIG_SCHEMA migration; the version belongs in code, not in this template');
    // The frozen list cannot rot unnoticed: today's migration must still pass all of it.
    const current = currentValues();
    for (const key of RELEASED_VALUES)
      assert.ok(current.includes(key),
        'installer/lib/update.mjs stopped passing ' + key + ', which released installers supply and this test assumes');
    const rendered = JSON.parse(render(template, values, {}, { json: true }));
    assert.equal(rendered.schema, version.CONFIG_SCHEMA, 'the template ships the current config schema');
  });
  await test('machine.template.json is a shape contract, not a rendered file', async () => {
    // Its every value is an unsubstituted {{TOKEN}}, including the version, which is safe only
    // because nothing renders it — machineBytes() builds machine.json from code. Pin that.
    const sources = ['apply', 'machine', 'planning', 'update', 'verify', 'survey', 'report', 'registration']
      .map(name => fs.readFileSync(path.join(repo, 'installer', 'lib', name + '.mjs'), 'utf8'));
    for (const source of sources)
      assert.equal(/machine\.template/.test(source), false,
        'a production module now names machine.template.json; if it renders it, every {{TOKEN}} in that file must be supplied');
  });
  await test('created_by carries the running version because the code writes it', async () => {
    const rendered = JSON.parse(render(template, migrationValues(), {}, { json: true }));
    assert.equal(Object.hasOwn(rendered, 'created_by'), true, 'the key stays in the template');
    assert.equal(/\d+\.\d+\.\d+/.test(rendered.created_by), false,
      'config.template.json states a version in created_by: ' + rendered.created_by);
    // planning.mjs stamps the S4 config; tests/installer/apply-cases.mjs asserts the written file.
    const planning = fs.readFileSync(path.join(repo, 'installer', 'lib', 'planning.mjs'), 'utf8');
    const stamped = /created_by:\s*'([^']*)'\s*\+\s*version\.APP_VERSION/.exec(planning);
    assert.ok(stamped, 'installer/lib/planning.mjs still writes created_by from version.APP_VERSION');
    assert.equal(stamped[1] + version.APP_VERSION, 'council-setup ' + version.APP_VERSION);
  });
}
