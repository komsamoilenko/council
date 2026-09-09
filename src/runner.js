// Owns runner.js runtime behavior; port specification §§2–6.
'use strict';
/**
 * runner.js — tier 2: the per-job supervisor (SPEC §1 timer table, §2.1 single-writer
 * rule, §2.2 log cap, §8 fuses 1/6/9, §9 kill paths, §10 ledger rows).
 * It owns state.json, progress.json, legs/*, result.json, error.json and DONE, spawns the
 * leaves with stdio pipes (prompt over stdin, then end()), holds the ONLY primary deadline
 * timer, watches cancel.json at 500 ms and the two STOP files at 5 s, and appends one
 * job_started and one job_finished ledger row per leg.
 * Usage: node runner.js <jobDir>.  Logs to <jobDir>\runner.log; stdout is unused.
 */

const child_process = require('child_process');
const fs = require('fs');
const path = require('path');

const paths = require('./lib/paths.js');
const guard = require('./lib/guard.js');
const envlib = require('./lib/env.js');
const jobstore = require('./lib/jobstore.js');
const ledger = require('./lib/ledger.js');
const procwin = require('./platform');
const platform = procwin;
const profile = require('./lib/profile');
const integrity = require('./lib/integrity');
const secrets = require('./lib/secrets');
const redact = require('./lib/redact');
const quota = require('./lib/quota.js');
const fuses = require('./lib/fuses.js');

const BACKENDS = {
  claude: require('./backends/claude.js'),
  codex: require('./backends/codex.js'),
  gemini: require('./backends/gemini.js'),
  echo: require('./backends/echo.js'),
};

const PROMPT_TOKEN = '<prompt.md>';

/* ---------------- boot ------ */

function bootRunner() {
  const loaded = profile.resolve();
  const config = loaded.config || {};
  const P = paths.computePaths(config);
  const trust = guard.checkConfigTrust(loaded);
  const appIntegrity = integrity.check();
  trust.failures.push(...appIntegrity.failures.map(reason=>({key:'app',reason})));
  trust.ok = trust.ok && appIntegrity.ok;
  const accountsDoc = jobstore.readJSON(P.accountsPath);
  return {
    version: paths.COUNCIL_VERSION,
    host: process.env.COUNCIL_HOST || null,
    serverPid: process.pid,
    runnerPid: process.pid,
    depth: Number(process.env.COUNCIL_DEPTH || 0) || 0,
    profile: loaded.profile, integrity: appIntegrity,
    configPath: loaded.path,
    configMeta: loaded,
    config,
    paths: P,
    trust,
    mode: !platform.implemented.proc ? 'unsupported-platform' : trust.ok ? 'normal' : 'doctor-only',
    accounts: (accountsDoc && accountsDoc.accounts) || {},
    clientInfo: null,
    log: () => {},
  };
}

/* ---------------- the job ---- */

function main() {
  const jobDir = process.argv[2];
  if (!jobDir) { process.stderr.write('usage: node runner.js <jobDir>\n'); process.exit(2); }
  const ctx = bootRunner();
  const files = jobstore.jobFiles(jobDir);
  const logFd = openLog(files.runnerLog);
  const rlog = (m) => { try { fs.writeSync(logFd, new Date().toISOString() + ' ' + redact.text(m, 'stderr_tail') + '\n'); } catch {} };

  // Fuse 0 (SPEC §8): an untrusted config means doctor-only, and a doctor-only server
  // would never have spawned this runner. Computing `mode` and then ignoring it left the
  // one case where the runner is started by hand or by a stale spawn silently spawning
  // leaves under a config that failed its trust check.
  if (ctx.mode !== 'normal') {
    const why = (ctx.trust.failures || []).map((f) => f.key + ': ' + f.reason).join('; ');
    rlog('config untrusted, refusing to spawn anything: ' + why);
    process.stderr.write('[runner] config untrusted: ' + why + '\n');
    process.exit(4);
  }

  const request = jobstore.readJSON(files.request);
  const spawnDoc = jobstore.readJSON(files.spawn);
  if (!request || !spawnDoc) { rlog('missing request.json or spawn.json — nothing to do'); process.exit(3); }
  if (request.profile !== ctx.profile) { rlog('profile_mismatch'); process.exit(5); }
  ctx.host = (request.requester && request.requester.host) || ctx.host;

  let promptText = '';
  try { promptText = fs.readFileSync(files.prompt, 'utf8'); } catch (e) { rlog('prompt.md unreadable: ' + e.message); }

  const job = new Job({ ctx, jobDir, files, request, spawnDoc, promptText, rlog });
  job.start();
}

function openLog(p) {
  try { return fs.openSync(p, 'a'); } catch { return fs.openSync(platform.nullDevice(), 'a'); }
}

class Job {
  constructor(o) {
    Object.assign(this, o);
    this.startedMs = Date.now();
    this.deadlineMs = Number(this.request.deadline_ms) || (this.startedMs + 900000);
    this.legs = new Map();      // legId -> leg runtime record
    this.timers = [];
    this.finalizing = false;
    this.finalized = false;
    this.cancel = null;         // {ts, source, reason}
    this.timedOut = false;
    this.lastProgressWrite = 0;
  }

  /* ---------------- lifecycle */

  start() {
    const t = this.ctx.config.timing || {};
    for (const legMeta of (this.request.legs || [])) {
      this.legs.set(legMeta.leg_id, {
        leg_id: legMeta.leg_id, backend: legMeta.backend, meta: legMeta,
        pid: null, state: 'pending', started_ms: null, ended_ms: null,
        exit_code: null, signal: null, kill_refused: null,
        bytes_out: 0, bytes_err: 0, events: 0, last_label: null, capped: false,
        child: null, out: null, err: null, spawn_error: null,
      });
    }
    this.writeState('running');
    this.writeProgress(true);

    this.timers.push(setInterval(() => this.writeState(), (Number(t.heartbeat_s) || 10) * 1000));
    this.timers.push(setInterval(() => this.checkCancelFile(), Number(t.cancel_watch_ms) || 500));
    this.timers.push(setInterval(() => this.checkStopFiles(), (Number(t.stop_file_check_s) || 5) * 1000));
    this.timers.push(setTimeout(() => this.onDeadline(), Math.max(0, this.deadlineMs - Date.now())));

    for (const leg of this.legs.values()) this.spawnLeg(leg);
    this.rlog('spawned ' + this.legs.size + ' leg(s); deadline in ' + Math.round((this.deadlineMs - Date.now()) / 1000) + ' s');
    /* Publish the real leg pids at once. Without this the next state.json write is the
       10 s heartbeat, so council_poll would render a live leg as pending/pid:null for up
       to a full heartbeat (SPEC section 5.2 wants the running screen honest) and any
       reader that needs a leaf pid (the cancel path, T-06) would have to wait for it. */
    this.writeState('running');
    this.maybeFinish();
  }

  clearTimers() {
    for (const t of this.timers) { clearInterval(t); clearTimeout(t); }
    this.timers = [];
  }

  /* ---------------- legs */

  spawnLeg(leg) {
    const spec = (this.spawnDoc.legs || {})[leg.leg_id];
    if (!spec) { leg.state = 'error'; leg.spawn_error = 'no spawn.json entry'; leg.ended_ms = Date.now(); return; }
    // spawn.json lives in the Vault and is written milliseconds before this read, so the
    // binary it names is re-checked against the SAME two authorities the server used:
    // config.binaries (the fixed set, §12.2/§19) and guard's ALLOWED_ROOTS. Cheap, and
    // it closes the spawn.json-swap race without touching the §19 residual.
    const binOk = this.binaryAllowed(spec.file, spec.args, leg.backend);
    if (!binOk.ok) {
      leg.state = 'error'; leg.spawn_error = 'spawn.json file rejected: ' + binOk.reason; leg.ended_ms = Date.now();
      this.rlog(leg.leg_id + ' refused: ' + binOk.reason + ' (' + spec.file + ')');
      return;
    }
    const gatedBinary=(this.ctx.config.binaries || {}).agy;
    if(gatedBinary && platform.sameFile(spec.file,gatedBinary)) {
      const gate=leg.backend==='gemini' && (this.ctx.config.gemini || {}).provider==='agy' ? BACKENDS.gemini.available(this.ctx,{job:this.request,leg:leg.meta,promptText:this.promptText}) : {ok:false,reason:'agy_gate_missing'};
      if(!gate.ok){leg.state='error';leg.spawn_error=gate.reason;leg.ended_ms=Date.now();return;}
    }
    try { guard.assertArgvSafe(spec.args, this.ctx.config); }
    catch (e) { leg.state = 'error'; leg.spawn_error = 'guard: ' + e.message; leg.ended_ms = Date.now(); this.rlog(leg.leg_id + ' refused by guard: ' + e.message); return; }

    const api = leg.backend === 'gemini' && ((this.ctx.config.gemini || {}).provider || 'api') === 'api';
    if (api && (!platform.sameFile(spec.file,this.ctx.config.binaries.node) || !platform.sameFile(spec.args[0],this.ctx.config.binaries.gemini_api_js) || spec.args.length !== 7 || spec.args[1] !== '--model' || spec.args[3] !== '--timeout-s' || spec.args[5] !== '--effort' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(spec.args[2]) || !['low','medium','high'].includes(spec.args[6]) || !Number.isFinite(Number(spec.args[4])) || Number(spec.args[4]) < 1 || Number(spec.args[4]) > 1800 || !platform.sameFile(spec.cwd,this.ctx.paths.sandboxFor('gemini')) || spec.promptVia !== 'stdin' || spec.stdinHeader !== 'gemini-api')) { leg.state='error';leg.spawn_error='api_spawn_rejected';leg.ended_ms=Date.now();return; }
    const env = envlib.childEnv({
      provider: api ? 'api' : null, binaries: this.ctx.config.binaries,
      backend: leg.backend, depth: Number(this.request.depth) || 0,
      jobId: this.request.job_id, rootJobId: this.request.root_job_id || this.request.job_id,
      extra: api ? envlib.proxyEnvFor(this.ctx).env : spec.env_extra || {},
    });
    const promptText = this.promptFor(spec);
    const args = spec.promptVia === 'argv'
      ? spec.args.map((a) => String(a).split(PROMPT_TOKEN).join(promptText))
      : spec.args.slice();

    const lf = this.files.leg(leg.leg_id);
    try { fs.mkdirSync(lf.dir, { recursive: true }); } catch {}
    leg.out = jobstore.makeLogAppender(lf.stdout);
    leg.err = jobstore.makeLogAppender(lf.stderr);

    this.appendLedger({
      event: 'job_started', leg,
      binary: this.binaryRow(leg, spec),
      cwd: spec.cwd, argv_flags: spec.args.filter((a) => String(a).startsWith('-')),
      env_added: envlib.addedKeys(env),
      flags: Array.isArray(spec.flags) ? spec.flags : null,
    });

    let child;
    try {
      child = child_process.spawn(spec.file, args, {
        cwd: spec.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      leg.state = 'error'; leg.spawn_error = String(e.message); leg.ended_ms = Date.now();
      this.rlog(leg.leg_id + ' spawn failed: ' + e.message);
      return;
    }
    leg.child = child;
    leg.pid = child.pid;
    leg.state = 'running';
    leg.started_ms = Date.now();
    this.rlog(leg.leg_id + ' pid=' + child.pid + ' file=' + spec.file);

    child.stdout.on('data', (d) => this.onChunk(leg, 'out', d));
    child.stderr.on('data', (d) => this.onChunk(leg, 'err', d));
    child.on('error', (e) => {
      leg.spawn_error = String(e.message);
      this.rlog(leg.leg_id + ' child error: ' + e.message);
    });
    child.on('close', (code, signal) => {
      if (leg.state === 'running') leg.state = code === 0 ? 'done' : 'error';
      leg.exit_code = code;
      leg.signal = signal || null;
      leg.ended_ms = Date.now();
      if (leg.out) leg.out.close();
      if (leg.err) leg.err.close();
      this.rlog(leg.leg_id + ' closed exit=' + code + ' signal=' + (signal || '-'));
      this.writeState();
      this.maybeFinish();
    });

    child.stdin.on('error', () => {});
    if (spec.promptVia === 'stdin') {
      try { if (api) secrets.writeHeader(this.ctx, child.stdin, {model:leg.meta.model,system:this.request.guard_paragraph}); child.stdin.write(promptText); } catch (e) { this.rlog(leg.leg_id + ' stdin write: ' + e.message); }
      try { child.stdin.end(); } catch {}
    } else {
      try { child.stdin.end(); } catch {}
    }
  }

  /**
   * The prompt bytes for ONE leg. Every leg reads the job's prompt.md except a leg whose
   * spawn.json entry names its own prompt_path — today the judge leg whose A/B blocks
   * the server transposed (SPEC §7). A missing per-leg file falls back to prompt.md
   * rather than sending an empty prompt.
   * @param {Object} spec @returns {string}
   */
  promptFor(spec) {
    const p = spec && spec.prompt_path ? String(spec.prompt_path) : null;
    if (!p || p === this.files.prompt) return this.promptText;
    try {
      const t = fs.readFileSync(p, 'utf8');
      if (t) return t;
    } catch (e) { this.rlog('per-leg prompt unreadable (' + p + '): ' + e.message); }
    return this.promptText;
  }

  /**
   * SPEC §12.2 / §19: the set of binaries this build will ever exec is fixed in code and
   * in config.binaries. spawn.json may only ever name one of them.
   * @param {string} file @returns {{ok:boolean, reason?:string}}
   */
  binaryAllowed(file, args, backend) {
    const configured = Object.values((this.ctx.config && this.ctx.config.binaries) || {});
    const want = paths.normCase(String(file || ''));
    if (!want) return { ok: false, reason: 'empty file' };
    if (!configured.some((b) => typeof b === 'string' && paths.normCase(b) === want)) {
      return { ok: false, reason: 'not one of config.binaries' };
    }
    const bins=this.ctx.config.binaries || {};
    if(args && paths.normCase(file)===paths.normCase(bins.node || '')) {
      const first=args[0];
      const echo=backend==='echo' && first==='-e' && args.length===4 && args[1]===BACKENDS.echo.SCRIPT && /^echo(?:-[1-9][0-9]*)?$/.test(String(args[2])) && args[3]===JSON.stringify(platform.longLivedChildArgv());
      if(!echo && ![bins.codex_js,bins.gemini_api_js].filter(Boolean).some(p=>paths.normCase(p)===paths.normCase(first || ''))) return {ok:false,reason:'node_script_rejected'};
      if(!echo) {const script=guard.checkBinaryPath('spawn.script',first,this.ctx.config._machine,this.ctx.config);if(!script.ok)return script;}
    }
    const g = guard.checkBinaryPath('spawn.file', String(file), this.ctx.config._machine, this.ctx.config);
    return g.ok ? { ok: true } : { ok: false, reason: g.reason };
  }

  /**
   * SPEC §6.0 "Version drift": the version is read AGAIN at spawn, not copied from boot.
   * One `--version` per leg, zero quota, 12 s budget; a failed probe records null rather
   * than a guess. version_at_boot comes from spawn.json (a deep council_doctor fills it).
   * @param {Object} leg @param {Object} spec @returns {Object} the ledger row's binary{}
   */
  binaryRow(leg, spec) {
    const atBoot = (spec.binary && spec.binary.version_at_boot) || null;
    const now = this.probeVersion(leg.backend);   // cached: one probe per backend per job
    const row = { path: spec.file, version: now, version_at_boot: atBoot };
    if (now && atBoot && now !== atBoot) {
      row.version_drift = true;
      this.rlog(leg.backend + ' version drift: boot ' + atBoot + ' now ' + now);
    } else {
      row.version_drift = false;
    }
    return row;
  }

  /** @param {string} backend @returns {string|null} the first line of `--version` */
  probeVersion(backend) {
    if (this.versions && Object.prototype.hasOwnProperty.call(this.versions, backend)) return this.versions[backend];
    if (!this.versions) this.versions = {};
    let v = null;
    try {
      const b = BACKENDS[backend];
      const spec = b && typeof b.versionSpec === 'function' ? b.versionSpec(this.ctx) : null;
      if (spec && this.binaryAllowed(spec.file).ok) {
        const env = envlib.childEnv({ backend, depth: Number(this.request.depth) || 0, jobId: this.request.job_id, rootJobId: this.request.root_job_id || this.request.job_id });
        const r = child_process.spawnSync(spec.file, spec.args, { env, windowsHide: true, timeout: 12000, encoding: 'utf8' });
        if (r && r.status === 0 && r.stdout) v = String(r.stdout).trim().split('\n')[0].slice(0, 120);
      }
    } catch (e) { this.rlog('version probe (' + backend + '): ' + e.message); }
    this.versions[backend] = v;
    return v;
  }

  onChunk(leg, which, chunk) {
    const sink = which === 'out' ? leg.out : leg.err;
    if (sink) { sink.write(chunk); leg.capped = leg.capped || sink.capped; }
    if (which === 'out') leg.bytes_out += chunk.length; else leg.bytes_err += chunk.length;
    if (which === 'out') {
      const text = chunk.toString('utf8');
      for (const line of text.split('\n')) {
        const s = line.trim();
        if (!s.startsWith('{')) continue;
        leg.events++;
        try {
          const o = JSON.parse(s);
          const label = o.type || o.msg || o.event || (o.item && o.item.type) || null;
          if (label) leg.last_label = String(label).slice(0, 60);
        } catch { /* partial frame; the parser sees the whole file later */ }
      }
    }
    const now = Date.now();
    if (now - this.lastProgressWrite > 1000) this.writeProgress();
  }

  /* ---------------- watchers */

  checkCancelFile() {
    if (this.finalizing || this.cancel) return;
    if (!jobstore.exists(this.files.cancel)) return;
    const c = jobstore.readJSON(this.files.cancel) || { source: 'unknown' };
    this.cancel = c;
    this.rlog('cancel.json seen source=' + c.source);
    this.finish('cancelled');
  }

  checkStopFiles() {
    if (this.finalizing || this.cancel) return;
    // fuses.stopFiles is the ONE reader of fuse 1, so the extra paths in
    // COUNCIL_STOP_FILES cancel in-flight jobs too (the runner inherits the server's
    // env). Checking only the two built-in paths meant a configured STOP path refused
    // new starts but never stopped a running job, against the §8 "on trip" column.
    const s = fuses.stopFiles(this.ctx);
    const tripped = s.tripped ? s.which : null;
    if (!tripped) return;
    this.rlog('STOP file present: ' + tripped);
    jobstore.writeNewFile(this.files.cancel, JSON.stringify({ v: 1, ts: new Date().toISOString(), source: 'stop-file', reason: tripped }));
    this.cancel = { source: 'stop-file', reason: tripped };
    this.finish('cancelled');
  }

  onDeadline() {
    if (this.finalizing) return;
    this.timedOut = true;
    this.rlog('deadline reached');
    this.finish('timeout');
  }

  /* ---------------- writers */

  writeState(stateName) {
    const now = Date.now();
    const legs = {};
    for (const leg of this.legs.values()) {
      legs[leg.leg_id] = {
        backend: leg.backend, pid: leg.pid, state: leg.state,
        started_at: leg.started_ms ? new Date(leg.started_ms).toISOString() : null,
        ended_at: leg.ended_ms ? new Date(leg.ended_ms).toISOString() : null,
        exit_code: leg.exit_code,
      };
    }
    jobstore.atomicWriteJSON(this.files.state, {
      v: 1,
      job_id: this.request.job_id,
      runner_pid: process.pid,
      state: stateName || (this.finalized ? 'finished' : 'running'),
      started_at: new Date(this.startedMs).toISOString(),
      heartbeat_at: new Date(now).toISOString(),
      heartbeat_ms: now,
      cancel_timing: this.cancelTiming || [],
      deadline_at: this.request.deadline_at,
      deadline_ms: this.deadlineMs,
      legs,
    });
  }

  writeProgress(force) {
    const now = Date.now();
    if (!force && now - this.lastProgressWrite < 900) return;
    this.lastProgressWrite = now;
    const legs = {};
    for (const leg of this.legs.values()) {
      legs[leg.leg_id] = {
        backend: leg.backend, bytes_out: leg.bytes_out, bytes_err: leg.bytes_err,
        events: leg.events, last_label: leg.last_label, capped: !!leg.capped,
        updated_at: new Date(now).toISOString(),
      };
    }
    jobstore.atomicWriteJSON(this.files.progress, { v: 1, updated_at: new Date(now).toISOString(), legs });
  }

  /* ---------------- finish */

  maybeFinish() {
    if (this.finalizing) return;
    for (const leg of this.legs.values()) {
      if (leg.state === 'running' || leg.state === 'pending') return;
    }
    this.finish(null);
  }

  /**
   * @param {string|null} forced 'cancelled' | 'timeout' | null (natural completion)
   */
  async finish(forced) {
    if (this.finalizing) return;
    this.finalizing = true;
    this.clearTimers();
    this.writeProgress(true);

    const killReport = [];
    const cancelTiming = this.cancelTiming = [];
    const killCtx = { ...this.ctx, cancelTiming, saveCancelTiming: () => {
      const state = jobstore.readJSON(this.files.state);
      if (state) jobstore.atomicWriteJSON(this.files.state, { ...state, cancel_timing: cancelTiming });
    } };
    if (forced) {
      for (const leg of this.legs.values()) {
        if (leg.state !== 'running' || !leg.pid) continue;
        leg.state = forced;
        const v = await procwin.verifyLeaf(killCtx, leg.pid, {
          expectedImage: leg.meta.expected_image, runnerPid: process.pid,
          createdAtMs: this.request.created_ms,
        }).catch((e) => ({ ok: false, reason: 'verify_failed: ' + e.message }));
        if (!v.ok) {
          // 'not-running' is a proven death; a mismatch or an unevaluable identity probe
          // is not, and both leave a possibly-live leaf behind (SPEC §9).
          if (v.reason === 'not-running' || v.reason === 'no-pid') {
            killReport.push({ leg: leg.leg_id, pid: leg.pid, tree_kill_exit: null });
            leg.ended_ms = leg.ended_ms || Date.now();
            continue;
          }
          leg.kill_refused = v.reason === 'identity_unevaluable' ? 'identity_unevaluable' : 'pid-identity-mismatch';
          killReport.push({ leg: leg.leg_id, pid: leg.pid, refused: leg.kill_refused });
          this.rlog(leg.leg_id + ' kill refused: ' + v.reason);
          continue;
        }
        const k = await procwin.treeKill(killCtx, leg.pid).catch((e) => ({ ok: false, error: e.message }));
        killReport.push({ leg: leg.leg_id, pid: leg.pid, tree_kill_exit: k.exit == null ? null : k.exit, verified_dead: k.verified_dead === true });
        leg.ended_ms = leg.ended_ms || Date.now();
        try { if (leg.out) leg.out.close(); if (leg.err) leg.err.close(); } catch {}
      }
    }

    for (const k of killReport) k.cancel_timing = cancelTiming.filter(s => s.pid === k.pid);

    const legRecords = [];
    for (const leg of this.legs.values()) {
      legRecords.push(await this.parseLeg(leg, forced));
    }

    const okCount = legRecords.filter((r) => r.ok).length;
    let outcome;
    if (forced === 'cancelled') outcome = 'cancelled';
    else if (forced === 'timeout') outcome = 'timeout';
    else if (okCount === legRecords.length && okCount > 0) outcome = 'done';
    else if (okCount > 0) outcome = 'partial';
    else outcome = 'error';

    const orphan = killReport.some(k => k.refused || k.verified_dead === false);
    if (orphan) outcome = 'error';
    const endedMs = Date.now();
    const payload = {
      v: 1,
      job_id: this.request.job_id,
      state: outcome,
      outcome,
      ended_at: new Date(endedMs).toISOString(),
      wall_ms: endedMs - this.startedMs,
      legs: legRecords,
      artifacts: { dir: this.jobDir },
      similarity_hint: null,
      divergence_prompt: null,
      judge: this.request.judge || null,
      cancel_source: this.cancel ? this.cancel.source : null,
      orphan_suspected: orphan,
      kill_report: killReport,
      reason: forced === 'timeout' ? 'wall clock deadline' : (this.cancel && this.cancel.reason) || null,
    };

    if (jobstore.exists(this.files.done)) {
      this.rlog('DONE already exists (finalised elsewhere) — not writing result/error');
      this.finalized = true;
      this.writeState('finished');
      process.exit(0);
      return;
    }

    const target = (outcome === 'done' || outcome === 'partial') ? this.files.result : this.files.error;
    jobstore.atomicWriteJSON(target, payload);
    const created = jobstore.writeNewFile(this.files.done, '');
    this.finalized = true;
    this.writeState('finished');

    if (!created) {
      this.rlog('lost the DONE race — ledger rows suppressed to avoid duplicates');
      process.exit(0);
      return;
    }

    for (const rec of legRecords) {
      this.appendLedger({ event: 'job_finished', legRecord: rec, outcome, wallMs: payload.wall_ms });
      if (rec.backend === 'codex') {
        try {
          const snap = await quota.snapshotCodex(this.ctx, { jobId: this.request.job_id, sessionId: rec.session_id, startedAtMs: this.startedMs });
          ledger.append(this.ctx, ledger.baseRow(this.ctx, { event: 'quota_snapshot', job_id: this.request.job_id, backend: 'codex', quota: snap }));
        } catch (e) { this.rlog('quota snapshot: ' + e.message); }
      }
    }
    this.rlog('finished outcome=' + outcome + ' wall_ms=' + payload.wall_ms);
    process.exit(0);
  }

  /** Run the adapter parser and write legs/<id>/answer.md + meta.json. */
  async parseLeg(leg, forced) {
    const lf = this.files.leg(leg.leg_id);
    const backend = BACKENDS[leg.backend];
    let parsed = { ok: false, text: '', meta: {} };
    try {
      parsed = backend.parse(this.ctx, {
        exitCode: leg.exit_code,
        stdoutPath: lf.stdout,
        stderrPath: lf.stderr,
        legDir: lf.dir,
        job: this.request,
        leg: leg.meta,
        promptChars: Number(this.request.prompt_chars) || 0,
        timedOut: forced === 'timeout',
        cancelled: forced === 'cancelled',
        spawnError: leg.spawn_error,
      }) || parsed;
    } catch (e) {
      parsed = { ok: false, text: '', meta: { parse_failed: true, parse_error: String(e.message) } };
      this.rlog(leg.leg_id + ' parse threw: ' + e.message);
    }
    parsed = redact.value(parsed);
    const meta = parsed.meta || {};
    try { jobstore.atomicWrite(lf.answer, String(parsed.text == null ? '' : parsed.text)); } catch {}
    try { jobstore.atomicWriteJSON(lf.meta, Object.assign({ leg_id: leg.leg_id, backend: leg.backend, ok: !!parsed.ok }, meta)); } catch {}

    const stderrTail = meta.stderr_tail !== undefined ? meta.stderr_tail : (jobstore.readTail(lf.stderr, 2000).slice(-800) || null);
    return {
      leg_id: leg.leg_id,
      backend: leg.backend,
      ok: !!parsed.ok && !forced,
      state: forced || leg.state,
      model: leg.meta.model || meta.model || null,
      effort: leg.meta.effort || null,
      effort_clamped_from: leg.meta.effort_clamped_from || null,
      account: (this.ctx.accounts[leg.backend] || {}).label || null,
      session_id: meta.session_id || null,
      raw_ids: meta.raw_ids || null,
      resumable: meta.resumable !== undefined ? meta.resumable : (leg.meta.resumable !== false),
      duration_ms: (leg.ended_ms || Date.now()) - (leg.started_ms || this.startedMs),
      num_turns: meta.num_turns == null ? null : meta.num_turns,
      est_cost_usd: meta.est_cost_usd == null ? null : meta.est_cost_usd,
      cost_is_estimate: meta.cost_is_estimate !== false,
      cost_source: meta.cost_source || null,
      usage: meta.usage || null,
      model_usage: meta.model_usage || null,
      total_input_tokens: meta.total_input_tokens == null ? null : meta.total_input_tokens,
      overhead_input_tokens: meta.overhead_input_tokens == null ? null : meta.overhead_input_tokens,
      budget_usd: this.request.max_cost_usd == null ? null : this.request.max_cost_usd,
      budget_hit: !!meta.budget_hit,
      exit_code: leg.exit_code,
      spawn_error: leg.spawn_error || null,
      kill_refused: leg.kill_refused || null,
      judge_order: (leg.meta && leg.meta.judge_order) || null,
      prompt_swapped: !!(leg.meta && leg.meta.prompt_swapped),
      parse_failed: !!meta.parse_failed,
      capped: !!leg.capped,
      bytes_out: leg.bytes_out,
      events: leg.events,
      last_label: leg.last_label,
      stderr_tail: stderrTail == null ? null : redact.text(stderrTail, 'stderr_tail'),
      answer_chars: String(parsed.text || '').length,
      answer_path: path.join('legs', leg.leg_id, 'answer.md'),
      child_enumeration: meta.child_enumeration || null,
    };
  }

  /* ---------------- ledger */

  appendLedger(o) {
    try {
      const leg = o.leg || null;
      const rec = o.legRecord || null;
      const legMeta = leg ? leg.meta : (rec ? (this.request.legs || []).find((l) => l.leg_id === rec.leg_id) : null);
      const row = ledger.baseRow(this.ctx, Object.assign({
        event: o.event,
        job_id: this.request.job_id,
        parent_job_id: this.request.parent_job_id || null,
        root_job_id: this.request.root_job_id || this.request.job_id,
        round: this.request.round || 1,
        depth: this.request.depth || 0,
        backend: (leg && leg.backend) || (rec && rec.backend) || null,
        leg_id: (leg && leg.leg_id) || (rec && rec.leg_id) || null,
        account: (this.ctx.accounts[(leg && leg.backend) || (rec && rec.backend)] || {}).label || null,
        requester: this.request.requester || null,
        task_class: (this.request.router && this.request.router.task_class) || null,
        router_rule: (this.request.router && this.request.router.matched_rule) || null,
        router_source: (this.request.router && this.request.router.source) || null,
        stakes: this.request.stakes || 'normal',
        model: (legMeta && legMeta.model) || null,
        effort: (legMeta && legMeta.effort) || null,
        effort_clamped_from: (legMeta && legMeta.effort_clamped_from) || null,
        started_at: new Date(this.startedMs).toISOString(),
        prompt_chars: this.request.prompt_chars || 0,
        prompt_sha256: this.request.prompt_sha256 || null,
        prompt_preview: this.request.prompt_preview || null,
        continued_from: this.request.parent_job_id || null,
      }, o.binary ? { binary: o.binary } : {},
        o.cwd ? { cwd: o.cwd } : {},
        o.argv_flags ? { argv_flags: o.argv_flags } : {},
        o.env_added ? { env_added: o.env_added } : {},
        o.flags ? { flags: o.flags } : {},
        rec ? {
          binary: this.binaryFor(rec),
          ended_at: new Date().toISOString(),
          wall_ms: o.wallMs == null ? null : o.wallMs,
          outcome: rec.ok ? o.outcome : (rec.state === 'done' ? 'error' : rec.state),
          exit_code: rec.exit_code,
          cancel_source: this.cancel ? this.cancel.source : null,
          orphan_suspected: !!rec.kill_refused,
          // SPEC §9: a kill the RUNNER itself refused has to reach council_doctor's
          // warnings, and the doctor reads this field off job_finished rows.
          kill_refused: rec.kill_refused || null,
          // SPEC §10 sample row: present-and-null beats absent.
          refuse_reason: null,
          ask_degrade_reason: this.askDegradeReason(),
          flags: this.legFlags(rec.leg_id),
          capped: !!rec.capped,
          session_id: rec.session_id,
          raw_ids: rec.raw_ids,
          resumable: rec.resumable,
          usage: rec.usage,
          model_usage: rec.model_usage,
          total_input_tokens: rec.total_input_tokens,
          overhead_input_tokens: rec.overhead_input_tokens,
          est_cost_usd: rec.est_cost_usd,
          cost_is_estimate: rec.cost_is_estimate,
          cost_source: rec.cost_source,
          budget_usd: rec.budget_usd,
          budget_hit: rec.budget_hit,
          num_turns: rec.num_turns,
          result_chars: rec.answer_chars,
          parse_failed: rec.parse_failed,
        } : {}));
      ledger.append(this.ctx, row);
    } catch (e) {
      this.rlog('ledger append failed: ' + e.message);
    }
  }

  /**
   * SPEC §10 puts ask_degrade_reason on the job_finished row. The server only learns it
   * after this runner booted (it is written into request.json when a council_ask
   * degrades), so request.json is re-read once, at finish time.
   * @returns {string|null}
   */
  askDegradeReason() {
    if (this.askDegrade !== undefined) return this.askDegrade;
    const fresh = jobstore.readJSON(this.files.request);
    this.askDegrade = (fresh && fresh.ask_degrade_reason) || this.request.ask_degrade_reason || null;
    return this.askDegrade;
  }

  /** @param {string} legId @returns {string[]|null} the adapter's flags from spawn.json */
  legFlags(legId) {
    const spec = (this.spawnDoc.legs || {})[legId];
    return spec && Array.isArray(spec.flags) ? spec.flags : null;
  }

  /**
   * The §10 `binary` object for a job_finished row: the same shape job_started carries,
   * reusing the cached spawn-time version reading (no second `--version` process).
   * @param {Object} rec LegRecord @returns {Object|null}
   */
  binaryFor(rec) {
    const spec = (this.spawnDoc.legs || {})[rec.leg_id];
    if (!spec) return null;
    return this.binaryRow({ backend: rec.backend }, spec);
  }
}

process.on('uncaughtException', (e) => {
  try { process.stderr.write('[runner] uncaught: ' + (e && e.stack || e) + '\n'); } catch {}
});

if (require.main === module) main();

module.exports = { Job, bootRunner, PROMPT_TOKEN };
