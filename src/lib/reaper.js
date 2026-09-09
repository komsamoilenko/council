// Owns reaper.js runtime behavior; port specification §§2–6.
'use strict';
/**
 * lib/reaper.js — cancel, the `lost` derivation and the periodic sweep (SPEC §9, §2.1).
 * Owns: cancelJob's six ordered steps, checkLost/finalizeLost (stale heartbeat AND a
 * failed PID-identity check — two facts, never one), the deadline backstop at
 * deadline+60 s, and the `.reaper.lock`-guarded tick (first 30 s after boot, then
 * timing.reaper_period_s). Every kill goes through lib/procwin.js's identity check.
 * It writes error.json + DONE ('wx') only after the runner is verified gone, appends
 * reaper_action / cancel_requested / job_finished ledger rows, and deletes nothing.
 */

const path = require('path');
const { performance } = require('perf_hooks');
const jobstore = require('./jobstore.js');
const ledger = require('./ledger.js');
const procwin = require('../platform');

/** SPEC §1 timer table + §9; the ones config.json does not carry are named here. */
const FIRST_TICK_MS = 30000;              // "30 s after boot, then reaper_period_s"
const REAPER_LOCK_TTL_MS = 90000;         // SPEC §3 mutex table
const DEADLINE_BACKSTOP_MS = 60000;       // "reaper at deadline+60 s is the backstop only"
const CANCEL_GRACE_MS = 2000;             // §9 step 3: wait <= 2 s for the runner itself
const CANCEL_POLL_MS = 100;
const SCAN_HOURS = 72;                    // a job can outlive fuses.max_timeout_s (1800 s) by a lot
const STDERR_TAIL_BYTES = 4096;
const STDERR_TAIL_CHARS = 800;

/* ---------------- helpers */

/** @param {Object} ctx @returns {Object} */
function timing(ctx) { return (ctx && ctx.config && ctx.config.timing) || {}; }

/** @param {*} v @param {number} d @returns {number} */
function num(v, d) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; }

/**
 * NOT unref'd on purpose. An unref'd timer lets the process exit mid-cancel when
 * nothing else holds the event loop, leaving `.reaper.lock` behind and the job
 * un-finalised (observed 2026-09-07 in a self-test). Only the periodic sweep timers
 * in start() are unref'd, and those are meant not to hold the process open.
 * @param {number} ms @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * A ledger append that can never break a cancel (SPEC §10: a ledger fault never fails a call).
 * @param {Object} ctx @param {Object} extra
 */
function row(ctx, extra) {
  try { ledger.append(ctx, ledger.baseRow(ctx, extra)); }
  catch (e) { if (ctx && ctx.log) ctx.log('reaper ledger: ' + (e && e.message)); }
}

/** @param {Object} ctx @param {string} jobId @returns {Object|null} */
function reload(ctx, jobId) {
  try { return jobstore.loadView(ctx.paths, ctx.config, jobId, Date.now()); } catch { return null; }
}

/** @param {Object} view @param {string} legId @returns {string|null} */
function stderrTail(view, legId) {
  try {
    const t = jobstore.readTail(view.files.leg(legId).stderr, STDERR_TAIL_BYTES);
    if (!t) return null;
    return t.slice(-STDERR_TAIL_CHARS);
  } catch { return null; }
}

/* ---------------- leg killing */

/**
 * Identity-check and tree-kill every leg still marked running in state.json.
 * A leg that fails the identity check is REFUSED, never killed (SPEC §9).
 * @param {Object} ctx @param {Object} view
 * @returns {Promise<{report:Array<Object>, orphans:number}>}
 */
async function killLegs(ctx, view) {
  const report = [];
  let orphans = 0;
  const stateLegs = (view.state && view.state.legs) || {};
  const plans = (view.request && view.request.legs) || [];
  const runnerPid = view.state ? view.state.runner_pid : null;
  const createdAtMs = Number(view.request && view.request.created_ms) || jobstore.jobMs(view.job_id);

  for (const legId of Object.keys(stateLegs)) {
    const sl = stateLegs[legId] || {};
    if (!sl.pid || (sl.state !== 'running' && sl.state !== 'pending')) continue;
    const plan = plans.find((p) => p.leg_id === legId) || {};
    const v = await procwin.verifyLeaf(ctx, sl.pid, {
      expectedImage: plan.expected_image,
      runnerPid,
      createdAtMs,
    });
    if (!v.ok) {
      if (v.reason === 'not-running' || v.reason === 'no-pid') {
        report.push({ leg_id: legId, pid: sl.pid, verified_dead: true, tree_kill_exit: null, refused: null });
      } else {
        // 'identity_unevaluable' means the probe never ran — the leaf may well be alive.
        // It is refused exactly like a mismatch and counted as an orphan, never as dead.
        const refused = v.reason === 'identity_unevaluable' ? 'identity_unevaluable' : 'pid-identity-mismatch';
        if (refused === 'identity_unevaluable') orphans++;
        report.push({ leg_id: legId, pid: sl.pid, verified_dead: false, tree_kill_exit: null, refused });
      }
      continue;
    }
    const k = await procwin.treeKill(ctx, sl.pid);
    if (!k.verified_dead) orphans++;
    report.push({ leg_id: legId, pid: sl.pid, verified_dead: !!k.verified_dead, tree_kill_exit: k.exit, refused: null });
  }
  return { report, orphans };
}

/* ---------------- finalisation */

/**
 * A LegRecord (§1.10) for a leg that never produced a parsed answer. Token fields are
 * null, not zero: a killed leg's usage is unknown and a fabricated 0 would be a lie.
 * @param {Object} ctx @param {Object} view @param {Object} plan
 * @param {string} outcome @param {Array<Object>} killReport
 * @returns {Object}
 */
function legRecordFor(ctx, view, plan, outcome, killReport) {
  const legId = plan.leg_id;
  const sl = ((view.state && view.state.legs) || {})[legId] || {};
  const pr = ((view.progress && view.progress.legs) || {})[legId] || {};
  const kill = (killReport || []).find((k) => k.leg_id === legId) || null;
  const account = plan.account || (ctx.accounts && ctx.accounts[plan.backend] &&
    (ctx.accounts[plan.backend].label || ctx.accounts[plan.backend])) || null;
  return {
    leg_id: legId,
    backend: plan.backend,
    ok: false,
    state: outcome,
    model: plan.model == null ? null : plan.model,
    effort: plan.effort == null ? null : plan.effort,
    effort_clamped_from: plan.effort_clamped_from == null ? null : plan.effort_clamped_from,
    account,
    session_id: null,
    raw_ids: null,
    resumable: plan.resumable !== false,
    duration_ms: null,
    num_turns: null,
    est_cost_usd: null,
    cost_is_estimate: true,
    cost_source: null,
    usage: null,
    model_usage: null,
    total_input_tokens: null,
    overhead_input_tokens: null,
    usage_unknown: true,
    budget_usd: null,
    budget_hit: false,
    exit_code: sl.exit_code == null ? null : sl.exit_code,
    spawn_error: null,
    kill_refused: kill ? kill.refused : null,
    judge_order: plan.judge_order || null,
    prompt_swapped: !!plan.prompt_swapped,
    parse_failed: false,
    capped: !!pr.capped,
    bytes_out: Number(pr.bytes_out) || 0,
    events: Number(pr.events) || 0,
    last_label: pr.last_label == null ? null : pr.last_label,
    stderr_tail: stderrTail(view, legId),
    answer_chars: 0,
    answer_path: path.join('legs', legId, 'answer.md'),
    child_enumeration: null,
  };
}

/**
 * One job_finished ledger row per leg, matching runner.js's shape as far as a
 * reaper-side finalisation can honestly fill it.
 * @param {Object} ctx @param {Object} view @param {Object} rec
 * @param {{outcome:string, cancel_source:string|null, orphan:boolean}} o @param {number} wallMs
 * @returns {Object}
 */
function jobFinishedRow(ctx, view, rec, o, wallMs) {
  const req = view.request || {};
  const r = (req.router) || {};
  const acct = ((ctx.accounts && ctx.accounts[rec.backend]) || {}).label || null;
  return {
    event: 'job_finished',
    job_id: view.job_id,
    parent_job_id: req.parent_job_id || null,
    root_job_id: req.root_job_id || view.job_id,
    round: req.round || 1,
    depth: req.depth || 0,
    backend: rec.backend,
    leg_id: rec.leg_id,
    account: acct,
    requester: req.requester || null,
    task_class: r.task_class || null,
    router_rule: r.matched_rule || null,
    router_source: r.source || null,
    stakes: req.stakes || 'normal',
    model: rec.model,
    effort: rec.effort,
    effort_clamped_from: rec.effort_clamped_from,
    started_at: req.created_at || null,
    ended_at: new Date().toISOString(),
    wall_ms: wallMs,
    outcome: o.outcome,
    exit_code: rec.exit_code,
    cancel_source: o.cancel_source || null,
    orphan_suspected: !!o.orphan,
    // SPEC §9: a refused kill must reach council_doctor.warnings, and the doctor reads
    // `kill_refused` off job_finished rows as well as reaper_action rows.
    kill_refused: rec.kill_refused || null,
    refuse_reason: null,
    ask_degrade_reason: req.ask_degrade_reason || null,
    flags: null,
    capped: !!rec.capped,
    session_id: null,
    raw_ids: null,
    resumable: rec.resumable,
    usage: null,
    model_usage: null,
    total_input_tokens: null,
    overhead_input_tokens: null,
    usage_unknown: true,
    est_cost_usd: null,
    cost_is_estimate: true,
    cost_source: null,
    budget_usd: null,
    budget_hit: false,
    num_turns: null,
    prompt_chars: req.prompt_chars || 0,
    prompt_sha256: req.prompt_sha256 || null,
    prompt_preview: req.prompt_preview || null,
    result_chars: 0,
    parse_failed: false,
    finalized_by: 'reaper',
  };
}

/**
 * Write error.json then DONE ('wx'). Whoever loses the race just re-reads (§1.12), so a
 * lost race writes no ledger rows and reports finalized:false.
 * @param {Object} ctx @param {Object} view
 * @param {{outcome:string, cancel_source?:string|null, reason?:string|null,
 *          killReport?:Array<Object>, orphan?:boolean}} o
 * @returns {boolean} true when THIS call finalised the job
 */
function finalizeJob(ctx, view, o) {
  if (!view || !view.files || !view.request) return false;
  if (jobstore.exists(view.files.done)) return false;

  const plans = view.request.legs || [];
  const killReport = o.killReport || [];
  const legs = plans.map((p) => legRecordFor(ctx, view, p, o.outcome, killReport));
  const endedMs = Date.now();
  const createdMs = Number(view.request.created_ms) || jobstore.jobMs(view.job_id);

  const payload = {
    v: 1,
    job_id: view.job_id,
    state: o.outcome,
    outcome: o.outcome,
    ended_at: new Date(endedMs).toISOString(),
    wall_ms: endedMs - createdMs,
    legs,
    artifacts: { dir: view.dir },
    similarity_hint: null,
    divergence_prompt: null,
    judge: view.request.judge || null,
    cancel_source: o.cancel_source || null,
    orphan_suspected: !!o.orphan,
    // §1.9 kill_report uses `leg`, the same spelling runner.js writes.
    kill_report: killReport.map((k) => ({ leg: k.leg_id, pid: k.pid, tree_kill_exit: k.tree_kill_exit == null ? null : k.tree_kill_exit, refused: k.refused || null })),
    reason: o.reason || null,
    finalized_by: 'reaper',
  };

  jobstore.atomicWriteJSON(view.files.error, payload);
  const created = jobstore.writeNewFile(view.files.done, '');
  if (!created) return false;                    // the runner won: its rows stand, ours do not

  for (const rec of legs) {
    row(ctx, jobFinishedRow(ctx, view, rec, {
      outcome: o.outcome, cancel_source: o.cancel_source || null, orphan: !!o.orphan,
    }, payload.wall_ms));
  }
  return true;
}

/* ---------------- lost */

/**
 * Kill the surviving leaves and write error.json{outcome:"lost"} + DONE.
 * Only ever called after the runner failed its identity check.
 * @param {Object} ctx @param {Object} view
 * @returns {Promise<{finalized:boolean, outcome:'lost', orphans:number}>}
 */
async function finalizeLost(ctx, view) {
  const kills = await killLegs(ctx, view);
  const lostAfter = num(timing(ctx).lost_after_s, 60);
  const finalized = finalizeJob(ctx, view, {
    outcome: 'lost',
    cancel_source: null,
    reason: 'runner gone; heartbeat older than ' + lostAfter + ' s',
    killReport: kills.report,
    orphan: kills.orphans > 0,
  });
  row(ctx, {
    event: 'reaper_action',
    action: 'lost',
    job_id: view.job_id,
    finalized,
    runner_pid: (view.state && view.state.runner_pid) || null,
    heartbeat_age_s: view.heartbeat_age_s,
    legs_killed: kills.report.length,
    orphans: kills.orphans,
  });
  return { finalized, outcome: 'lost', orphans: kills.orphans };
}

/**
 * The read path (SPEC §2.1): `lost` needs TWO facts — a stale heartbeat (disk evidence,
 * already in the view) and a failed runner PID-identity check (done here, never by a
 * plain reader). A genuinely alive runner leaves the job untouched.
 * @param {Object} ctx @param {Object} view
 * @returns {Promise<{finalized:boolean, view:Object, orphans?:number}>}
 */
async function checkLost(ctx, view) {
  if (!view || view.done || !view.lost_candidate) return { finalized: false, view };
  const runnerPid = view.state ? view.state.runner_pid : null;
  const v = await procwin.verifyRunner(ctx, runnerPid, { jobId: view.job_id });
  if (v.ok) {
    // Stale heartbeat, LIVE runner. The disk half of §2.1 said `lost`, the identity check
    // says otherwise, so the caller must not go on showing "lost = runner gone; safe to
    // cancel" about a job that is still running.
    const alive = Object.assign({}, view, {
      state_derived: (view.state && view.state.state) || 'running',
      lost_candidate: false,
      lost_verified: false,
      heartbeat_stale: true,
    });
    return { finalized: false, view: alive };
  }
  if (v.reason === 'identity_unevaluable') {
    // The probe did not run, so the runner's fate is UNKNOWN. §2.1 allows `lost` only
    // after the runner is verified dead, so nothing is finalised and nothing is killed;
    // the next sweep tries again. The reason is recorded so the doctor can show it.
    row(ctx, {
      event: 'reaper_action', action: 'lost_check_unevaluable', job_id: view.job_id,
      runner_pid: runnerPid || null, heartbeat_age_s: view.heartbeat_age_s,
      detail: (v.error || 'identity probe unavailable'),
    });
    // Still `lost` on the disk evidence, but UNVERIFIED: renderers say "lost?" so nobody
    // reads "runner gone; safe to cancel" as a proven fact.
    const unknown = Object.assign({}, view, { lost_verified: false, lost_unevaluable: true });
    return { finalized: false, view: unknown, unevaluable: true };
  }
  const res = await finalizeLost(ctx, view);
  const fresh = reload(ctx, view.job_id) || view;
  return { finalized: res.finalized, view: fresh, orphans: res.orphans };
}

/* ---------------- cancel */

/**
 * @param {Array<Object>} killReport @returns {Array<{leg_id:string,pid:number,verified_dead:boolean}>}
 */
function childrenOf(killReport) {
  return (killReport || []).map((k) => ({
    leg_id: k.leg_id, pid: k.pid, verified_dead: !!k.verified_dead,
    refused: k.refused || null,
  }));
}

/** Children as recorded by the runner's own kill_report (it finalised on its own). */
function childrenFromPayload(payload) {
  const kr = (payload && payload.kill_report) || [];
  return kr.map((k) => ({
    leg_id: k.leg || k.leg_id || null, pid: k.pid == null ? null : k.pid,
    verified_dead: !k.refused, refused: k.refused || null,
  }));
}

/**
 * SPEC §9 cancelJob, the six steps in order. Idempotent.
 * @param {Object} ctx @param {string} jobId
 * @param {{source?:string, reason?:string|null, cascade?:boolean}} [o]
 * @returns {Promise<Object>} CancelResult (INTERFACES §4.7)
 */
async function cancelJob(ctx, jobId, o) {
  const started = performance.now();
  const stages = [];
  const local = { ...ctx, cancelTiming: stages, cancelStarted: started };
  const result = await cancelJobImpl(local, jobId, o);
  const elapsed = Math.round(performance.now() - started);
  const polls = stages.filter(s => s.stage === 'death_poll');
  const fresh = reload(ctx, jobId) || {};
  const runnerStages = (fresh.state && fresh.state.cancel_timing) || [];
  result.cancel_timing = {
    total_ms: elapsed,
    // Null means this request did not establish death of every reported target.
    verified_dead_ms: result.found && result.killed.verified_dead &&
      result.children_cancelled.every(c => c.verified_dead) ? local.cancelVerifiedMs : null,
    taskkill_ms: stages.filter(s => s.stage === 'tree_kill').reduce((n, s) => n + s.ms, 0),
    death_poll_count: polls.length,
    death_poll_ms: polls.reduce((n, s) => n + s.ms, 0),
    stages,
    runner: runnerStages,
  };
  row(ctx, { event: 'reaper_action', action: 'cancel_timing', job_id: jobId, cancel_timing: result.cancel_timing });
  return result;
}

async function cancelJobImpl(ctx, jobId, o) {
  const opts = o || {};
  const source = opts.source || 'tool';
  const reason = opts.reason == null ? null : String(opts.reason);
  const cascade = opts.cascade !== false;

  let view = reload(ctx, jobId);
  if (!view) {
    return {
      job_id: jobId, state: 'not_found', found: false, already_terminal: false,
      killed: { runner_pid: null, verified_dead: true, tree_kill_exit: null, refused: null },
      children_cancelled: [],
    };
  }

  /* 1. DONE (or a pre-spawn refusal) => nothing to do. */
  if (view.done || view.terminal) {
    const rp = view.state ? view.state.runner_pid : null;
    const dead = rp ? !(await procwin.isAlive(ctx, rp)) : true;
    ctx.cancelVerifiedMs = Math.round(performance.now() - ctx.cancelStarted);
    return {
      job_id: jobId, state: view.state_derived, found: true, already_terminal: true,
      killed: { runner_pid: rp || null, verified_dead: dead, tree_kill_exit: null, refused: null },
      children_cancelled: childrenFromPayload(view.result || view.error),
    };
  }

  /* 2. durable intent first: cancel.json ('wx') + a cancel_requested ledger row. */
  const created = jobstore.writeNewFile(view.files.cancel, JSON.stringify({
    v: 1, ts: new Date().toISOString(), source, reason,
  }));
  row(ctx, {
    event: 'cancel_requested', job_id: jobId, cancel_source: source, reason,
    cancel_file_created: created, cascade,
  });

  /* 3. give the runner up to ~2 s to finalise on its own 500 ms cancel.json watch. */
  const grace = Math.max(CANCEL_GRACE_MS, 4 * num(timing(ctx).cancel_watch_ms, 500));
  const graceStarted = performance.now();
  const graceDeadline = Date.now() + grace;
  while (Date.now() < graceDeadline) {
    await sleep(CANCEL_POLL_MS);
    const v2 = reload(ctx, jobId);
    if (!v2) break;
    view = v2;
    if (v2.done) {
      ctx.cancelTiming.push({ stage: 'grace', ms: Math.round(performance.now() - graceStarted) });
      const rp = v2.state ? v2.state.runner_pid : null;
      const dead = rp ? !(await procwin.isAlive(ctx, rp)) : true;
    ctx.cancelVerifiedMs = Math.round(performance.now() - ctx.cancelStarted);
      return {
        job_id: jobId, state: v2.state_derived, found: true, already_terminal: false,
        killed: { runner_pid: rp || null, verified_dead: dead, tree_kill_exit: null, refused: null },
        children_cancelled: childrenFromPayload(v2.result || v2.error),
        finalized_by: 'runner',
      };
    }
  }

  ctx.cancelTiming.push({ stage: 'grace', ms: Math.round(performance.now() - graceStarted) });

  /* 4. identity-check the runner, then tree kill /T /F. */
  const runnerPid = view.state ? view.state.runner_pid : null;
  const killed = { runner_pid: runnerPid || null, verified_dead: false, tree_kill_exit: null, refused: null };
  let orphan = false;
  const rv = await procwin.verifyRunner(ctx, runnerPid, { jobId });
  if (rv.ok) {
    const k = await procwin.treeKill(ctx, runnerPid);
    killed.tree_kill_exit = k.exit;
    killed.verified_dead = !!k.verified_dead;
    if (!k.verified_dead) orphan = true;          // survived /F => orphan_suspected, not "cancelled"
  } else if (rv.reason === 'not-running' || rv.reason === 'no-pid') {
    killed.verified_dead = true;                  // the runner was already gone
  } else {
    // Either that PID is somebody else's process now, or the identity probe could not
    // run. Both leave the runner's fate UNKNOWN, so the job is finalised as `error` with
    // orphan_suspected (step 6), never as a silent `cancelled` (SPEC §9).
    killed.refused = rv.reason === 'identity_unevaluable' ? 'identity_unevaluable' : 'pid-identity-mismatch';
    orphan = true;
    row(ctx, {
      event: 'reaper_action', action: 'kill_refused', job_id: jobId, target: 'runner',
      pid: runnerPid || null, reason: killed.refused, detail: rv.error || null,
      observed: rv.info ? { name: rv.info.Name, ppid: rv.info.ParentProcessId } : null,
    });
  }

  /* 5. the leaves, each identity-checked the same way. */
  let kills = { report: [], orphans: 0 };
  if (cascade) {
    kills = await killLegs(ctx, view);
    if (kills.orphans > 0) orphan = true;
    for (const k of kills.report) {
      if (k.refused) {
        row(ctx, {
          event: 'reaper_action', action: 'kill_refused', job_id: jobId, target: 'leg',
          leg_id: k.leg_id, pid: k.pid, reason: k.refused,
        });
      }
    }
  }

  ctx.cancelVerifiedMs = Math.round(performance.now() - ctx.cancelStarted);

  /* 5b. the runner may have finalised while we were killing; never double-write. */
  const v3 = reload(ctx, jobId) || view;
  if (v3.done) {
    return {
      job_id: jobId, state: v3.state_derived, found: true, already_terminal: false,
      killed, children_cancelled: childrenOf(kills.report), finalized_by: 'runner',
    };
  }

  /* 6. error.json + DONE + ledger. A survivor of /F is `error` + orphan_suspected. */
  const outcome = orphan ? 'error' : 'cancelled';
  const finalized = finalizeJob(ctx, v3, {
    outcome,
    cancel_source: source,
    reason: reason || ('cancelled by ' + source),
    killReport: kills.report.concat(runnerPid ? [{
      leg_id: 'runner', pid: runnerPid, verified_dead: killed.verified_dead,
      tree_kill_exit: killed.tree_kill_exit, refused: killed.refused,
    }] : []),
    orphan,
  });
  row(ctx, {
    event: 'reaper_action', action: 'cancel_finalized', job_id: jobId, outcome,
    finalized, cancel_source: source, orphan_suspected: orphan,
  });

  return {
    job_id: jobId, state: outcome, found: true, already_terminal: false,
    killed, children_cancelled: childrenOf(kills.report), finalized,
    orphan_suspected: orphan,
  };
}

/* ---------------- sweep */

/**
 * The deadline backstop: the runner's one-shot timer is primary, this fires only when
 * the job is still un-finalised 60 s past its deadline.
 * @param {Object} ctx @param {Object} view
 * @returns {Promise<{finalized:boolean, orphans:number}>}
 */
async function enforceDeadline(ctx, view) {
  // Durable intent first, exactly as a cancel does — a wedged-but-alive runner may still
  // notice cancel.json inside its 500 ms watch and finalise itself.
  jobstore.writeNewFile(view.files.cancel, JSON.stringify({
    v: 1, ts: new Date().toISOString(), source: 'reaper', reason: 'deadline backstop',
  }));
  await sleep(Math.max(CANCEL_POLL_MS, num(timing(ctx).cancel_watch_ms, 500) * 2));
  const fresh = reload(ctx, view.job_id) || view;
  if (fresh.done) return { finalized: false, orphans: 0 };

  const runnerPid = fresh.state ? fresh.state.runner_pid : null;
  let orphan = false;
  const killed = { runner_pid: runnerPid || null, verified_dead: false, tree_kill_exit: null, refused: null };
  const rv = await procwin.verifyRunner(ctx, runnerPid, { jobId: fresh.job_id });
  if (rv.ok) {
    const k = await procwin.treeKill(ctx, runnerPid);
    killed.tree_kill_exit = k.exit;
    killed.verified_dead = !!k.verified_dead;
    if (!k.verified_dead) orphan = true;
  } else if (rv.reason === 'not-running' || rv.reason === 'no-pid') {
    killed.verified_dead = true;
  } else {
    // Unverified runner (wrong identity, or a probe that could not run) => orphan, so
    // the row says orphan_suspected instead of pretending the deadline kill was clean.
    killed.refused = rv.reason === 'identity_unevaluable' ? 'identity_unevaluable' : 'pid-identity-mismatch';
    orphan = true;
    row(ctx, {
      event: 'reaper_action', action: 'kill_refused', job_id: fresh.job_id, target: 'runner',
      pid: runnerPid || null, reason: killed.refused, detail: rv.error || null,
    });
  }

  const kills = await killLegs(ctx, fresh);
  if (kills.orphans > 0) orphan = true;

  const finalized = finalizeJob(ctx, fresh, {
    outcome: 'timeout',
    cancel_source: 'reaper',
    reason: 'wall clock deadline (reaper backstop at deadline+60 s)',
    killReport: kills.report.concat(runnerPid ? [{
      leg_id: 'runner', pid: runnerPid, verified_dead: killed.verified_dead,
      tree_kill_exit: killed.tree_kill_exit, refused: killed.refused,
    }] : []),
    orphan,
  });
  return { finalized, orphans: kills.orphans + (orphan && !kills.orphans ? 1 : 0) };
}

/**
 * One sweep, under `.reaper.lock` (SPEC §9). Returns immediately when another process
 * holds the lock — the sweep is not worth queueing for.
 * @param {Object} ctx
 * @returns {Promise<{scanned:number, lost:number, deadline_killed:number, orphans:number, skipped_lock:boolean}>}
 */
async function tick(ctx) {
  const out = { scanned: 0, lost: 0, deadline_killed: 0, orphans: 0, skipped_lock: false };
  if (!ctx || !ctx.paths || !ctx.paths.reaperLock) { out.skipped_lock = true; return out; }

  const lock = jobstore.acquireLock(ctx.paths.reaperLock, REAPER_LOCK_TTL_MS, { role: 'reaper', pid: ctx.serverPid });
  if (!lock.ok) { out.skipped_lock = true; return out; }

  try {
    const dirs = jobstore.listJobDirs(ctx.paths, { since_hours: SCAN_HOURS });
    for (const d of dirs) {
      const now = Date.now();
      const view = jobstore.loadView(ctx.paths, ctx.config, d.job_id, now);
      if (!view || !view.request) continue;
      if (view.done || view.terminal) continue;
      out.scanned++;

      const deadlineMs = Number(view.request.deadline_ms);
      if (Number.isFinite(deadlineMs) && now > deadlineMs + DEADLINE_BACKSTOP_MS) {
        const r = await enforceDeadline(ctx, view);
        if (r.finalized) out.deadline_killed++;
        out.orphans += r.orphans;
        row(ctx, {
          event: 'reaper_action', action: 'deadline_backstop', job_id: view.job_id,
          finalized: r.finalized, orphans: r.orphans,
          overdue_s: Math.round((now - deadlineMs) / 1000),
        });
        continue;
      }

      if (view.lost_candidate) {
        const r = await checkLost(ctx, view);
        if (r.finalized) { out.lost++; out.orphans += Number(r.orphans) || 0; }
      }
    }
  } finally {
    lock.release();
  }
  return out;
}

/**
 * Start the periodic sweep: first tick 30 s after boot, then every
 * timing.reaper_period_s. Ticks never overlap; timers are unref'd so they never keep
 * the process alive on their own.
 * @param {Object} ctx @returns {{stop:function():void}}
 */
function start(ctx) {
  let stopped = false;
  let busy = false;
  let interval = null;

  const periodMs = num(timing(ctx).reaper_period_s, 60) * 1000;
  const runTick = () => {
    if (stopped || busy) return;
    busy = true;
    tick(ctx)
      .catch((e) => { if (ctx.log) ctx.log('reaper tick: ' + (e && e.message)); })
      .then(() => { busy = false; }, () => { busy = false; });
  };

  const first = setTimeout(() => {
    runTick();
    interval = setInterval(runTick, periodMs);
    if (interval.unref) interval.unref();
  }, FIRST_TICK_MS);
  if (first.unref) first.unref();

  return {
    stop() {
      stopped = true;
      clearTimeout(first);
      if (interval) clearInterval(interval);
    },
  };
}

module.exports = {
  FIRST_TICK_MS, REAPER_LOCK_TTL_MS, DEADLINE_BACKSTOP_MS, CANCEL_GRACE_MS, SCAN_HOURS,
  start, tick, checkLost, finalizeLost, cancelJob,
  // exported for tests / stop.ps1-equivalent sweeps
  killLegs, finalizeJob, enforceDeadline,
};
