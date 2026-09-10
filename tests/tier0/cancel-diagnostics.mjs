// Exercise the real cancel/timing code without access to a process table or vendor.
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export async function cancelDiagnostics(t, source) {
  const load = (file, overrides, globals = {}) => {
    const module = { exports: {} };
    const local = createRequire(file);
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
      module, exports: module.exports, __dirname: require("node:path").dirname(file),
      require: name => overrides[name] || local(name),
      process, setTimeout, clearTimeout, setInterval, clearInterval, Buffer,
      ...globals,
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
  const result = await reaper.cancelJob({ config: {}, paths: { cancelFor: () => 'fixture-cancel', binaries: {
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

  // Publish the runner's death report DURING step 4, after grace read the old view.
  // Terminal states in that fresh view must not hide targets without death proofs.
  const cases = [
    ['proven', { verified_dead: true }, false],
    ['legacy-leg-id', { verified_dead: true, leg: undefined, leg_id: 'legacy-leg-id' }, false],
    ['refused', { verified_dead: true, refused: 'pid-identity-mismatch' }, true],
    ['unevaluable', { refused: 'identity_unevaluable' }, true],
    ['absent', null, true],
    ['unverified', { verified_dead: false }, true],
    ['missing-proof', {}, true],
    ['wrong-pid', { verified_dead: true, pid: 999 }, true],
    ['wrong-leg', { verified_dead: true, leg: 'other' }, true],
    ['nonboolean', { verified_dead: 'true' }, true],
  ];
  const stateLegs = Object.fromEntries(cases.map(([leg], i) => [leg, {pid: 200 + i, state: 'running'}]));
  const before = { ...view, request: { legs: cases.map(([leg]) => ({leg_id: leg, backend: 'echo'})) }, state: { runner_pid: 123, legs: stateLegs } };
  const killReport = cases.flatMap(([leg, proof], i) => proof ? [{leg, pid: 200 + i, ...proof}] : []);
  let latest = before;
  const probed = [], killed = [];
  const racingPlatform = load(path.join(source, 'platform/win32.js'), {
    child_process: { execFile(file, args, options, callback) {
      let stdout = '';
      if (file === 'fixture-powershell') {
        const pid = Number(args.at(-1).match(/ProcessId=(\d+)/)[1]);
        probed.push(pid);
        if (pid === 123) {
          latest = { ...before, done: true, state_derived: 'cancelled',
            state: { ...before.state, legs: Object.fromEntries(Object.entries(stateLegs).map(([id, sl]) => [id, {...sl, state: 'cancelled'}])) },
            error: {kill_report: killReport} };
          stdout = JSON.stringify({ProcessId: pid, Name: 'node.exe', CommandLine: 'runner.js fixture-job'});
        }
        // Unproven leaves are independently probed and found gone.
      }
      if (file === 'fixture-taskkill') killed.push(Number(args[1]));
      setTimeout(() => callback(null, stdout, ''), 5);
    } },
  });
  const racingReaper = load(path.join(source, 'lib/reaper.js'), {
    '../platform': racingPlatform,
    './jobstore.js': { loadView: () => latest, writeNewFile: () => true, jobMs: () => Date.now() },
    './ledger.js': {baseRow: (ctx, row) => row, append() {}},
  });
  const ctx = { config: {}, paths: { cancelFor: () => 'fixture-cancel', binaries: {
    powershell: 'fixture-powershell', taskkill: 'fixture-taskkill', tasklist: 'fixture-tasklist',
  } } };
  const raced = await racingReaper.cancelJob(ctx, 'fixture-job');
  t.eq(raced.finalized_by, 'runner', 'report published during runner probe is read');
  t.eq(probed.join(','), [123, ...cases.flatMap((c, i) => c[2] ? [200 + i] : [])].join(','), 'only exact explicit unrefused death proofs skip leaf probes');
  t.eq(killed.join(','), '123', 'only the identity-verified runner is killed');
  t.eq(raced.children_cancelled.length, cases.length, 'fresh terminal states do not hide unproven targets');
  t.ok(raced.children_cancelled.every(c => c.verified_dead), 'proofs and independent death checks retained');
  t.note('T-06 diagnostic report race (simulated helpers): cancel_timing=' + JSON.stringify(raced.cancel_timing));

  // A restart/reaper caller without a report retains every original leaf probe.
  probed.length = 0;
  await racingReaper.killLegs(ctx, before, {ok:true});
  t.eq(probed.join(','), cases.map((c, i) => 200 + i).join(','), 'disk-only targets keep identity checks');

  const runnerPlatform = load(path.join(source, 'platform/win32.js'), {
    child_process: { execFile(file, args, options, callback) {
      const stdout = file === 'fixture-powershell' ? JSON.stringify({
        ProcessId: 456, Name: 'node.exe', ParentProcessId: process.pid,
        CreationDate: new Date().toISOString(),
      }) : '';
      setTimeout(() => callback(null, stdout, ''), 5);
    } },
  });
  const {Job} = load(path.join(source, 'runner.js'), {
    './platform': runnerPlatform,
    './lib/jobstore.js': {readJSON: () => null, exists: () => true},
  }, {process: {...process, on() {}, exit() {}}});
  const job = new Job({ctx, files: {}, request: {created_ms: Date.now()}, rlog() {}});
  job.legs.set('echo', {leg_id: 'echo', backend: 'echo', pid: 456, state: 'running', meta: {expected_image: 'node.exe'},
    child: {pid: 456, exitCode: null, signalCode: null}});
  job.writeProgress = job.writeState = () => {};
  job.parseLeg = async () => ({ok: false});
  await job.finish('cancelled');
  t.eq(job.cancelTiming.filter(s => s.stage === 'identity').length, 1, 'runner keeps probe despite a retained child object');
  t.ok(job.cancelTiming.some(s => s.stage === 'tree_kill'), 'runner kills after identity verification');
  t.note('T-06 diagnostic runner (simulated helpers): stages=' + JSON.stringify(job.cancelTiming));
}
