// Exact, recorded ownership only: never discover old fixtures by globbing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const base = fs.realpathSync(os.tmpdir());
const owner = crypto.createHash('sha256').update(import.meta.url).digest('hex').slice(0,16);
const pending = new Set();
process.once('exit', () => { for (const finish of pending) finish(false); });
export function tempRoot(suite, prefix) {
  if (!/^[a-z0-9-]+$/.test(suite) || !/^council-[a-z-]+-$/.test(prefix)) throw new Error('unsafe_fixture_name');
  const record = path.join(base, `council-retained-${owner}-${suite}.json`);
  const guard = root => {
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== base || !path.basename(resolved).startsWith(prefix) ||
        (fs.existsSync(resolved) && (!fs.lstatSync(resolved).isDirectory() || fs.lstatSync(resolved).isSymbolicLink() || fs.realpathSync(resolved) !== resolved))) throw new Error('unsafe_fixture_cleanup');
    return resolved;
  };
  const root = fs.mkdtempSync(path.join(base, prefix));
  let finished = false;
  const finish = success => {
    if (finished) return;
    guard(root);
    if (success) fs.rmSync(root, {recursive:true, force:true});
    else {
      if (fs.existsSync(record)) {
        if (fs.lstatSync(record).isSymbolicLink()) throw new Error('unsafe_fixture_record');
        const previous = JSON.parse(fs.readFileSync(record, 'utf8'));
        if (previous.owner !== owner || previous.suite !== suite) throw new Error('unsafe_fixture_owner');
        const old = guard(previous.root);
        if (old !== root) fs.rmSync(old, {recursive:true, force:true});
      }
      fs.writeFileSync(record, JSON.stringify({owner,suite,root}));
      process.stdout.write(`Retained ${suite} fixture: ${root}\n`);
    }
    finished = true;
    pending.delete(finish);
  };
  // Includes setup exceptions and explicit nonzero exits before normal teardown.
  pending.add(finish);
  return {root, finish};
}
