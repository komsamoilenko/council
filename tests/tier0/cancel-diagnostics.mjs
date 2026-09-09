// Exercise the real cancel/timing code without access to a process table or vendor.
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export async function cancelDiagnostics(t, source) {
  const load = (file, overrides) => {
    const module = { exports: {} };
    const local = createRequire(file);
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
      module, exports: module.exports, __dirname: require("node:path").dirname(file),
      require: name => overrides[name] || local(name),
      process, setTimeout, clearTimeout, setInterval, clearInterval, Buffer,
    }, { filename: file });
    return module.exports;
  };
  const path = require('node:path');
  const calls = [];
  const platform = load(path.join(source, 'platform/win32.js'), {
    child_process: { execFile(file, args, options, callback) {
      calls.push(file);
      // A known runner; taskkill succeeds; tasklist subsequently proves it gone.
      const stdout = file === 'fixture-powershell' ? JSON.stringify({
        ProcessId: 123, Name: 'node.exe', CommandLine: 'runner.js fixture-job',
      }) : '';
      setTimeout(() => callback(null, stdout, ''), 5);
    } },
  });
  const view = { job_id: 'fixture-job', state_derived: 'running',
    state: { runner_pid: 123, legs: {} }, request: { legs: [] },
    files: { cancel: 'fixture-cancel', done: 'fixture-done', error: 'fixture-error' } };
  const rows = [];
  const reaper = load(path.join(source, 'lib/reaper.js'), {
    '../platform': platform,
    './jobstore.js': { loadView: () => view, writeNewFile: () => true,
      exists: () => false, atomicWriteJSON() {}, jobMs: () => Date.now() },
    './ledger.js': { baseRow: (ctx, row) => row, append: (ctx, row) => rows.push(row) },
  });
  const result = await reaper.cancelJob({ config: {}, paths: { binaries: {
    powershell: 'fixture-powershell', taskkill: 'fixture-taskkill', tasklist: 'fixture-tasklist',
  } } }, 'fixture-job');
  const d = result.cancel_timing;
  t.eq(result.state, 'cancelled', 'diagnostic fixture cancelled');
  t.eq(result.killed.verified_dead, true, 'diagnostic fixture verified dead');
  t.eq(d.death_poll_count, 1, 'one measured death poll');
  t.ok(d.taskkill_ms >= 0 && d.death_poll_ms >= 0 && d.verified_dead_ms <= d.total_ms, 'finite stage durations');
  t.ok(['identity', 'tree_kill', 'death_poll', 'wait_for_death', 'grace'].every(stage => d.stages.some(s => s.stage === stage)), 'all cancel stages measured');
  t.eq(calls.join(','), 'fixture-powershell,fixture-taskkill,fixture-tasklist', 'identity precedes kill and death verification');
  t.ok(rows.some(r => r.cancel_timing === d), 'diagnostics retained in ledger');
  t.note('T-06 diagnostic fixture (simulated helpers, not a live tree): cancel_timing=' + JSON.stringify(d));
}
