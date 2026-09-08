// Owns fuses.js runtime behavior; port specification §§2–6.
'use strict';
const path = require('path');
/**
 * lib/fuses.js — SPEC §8, evaluated in fuse order before any spawn; anything that cannot
 * be evaluated REFUSES. Owns fuse 1 (STOP files), fuse 2 (depth), the vault check, fuse 8
 * (prompt size / binary content) in `preflight`, and fuses 3/4/5 (rolling hour, rolling
 * day, concurrency) in `reserveLegs`, which reserves ALL legs of a fan-out or none under
 * `.rate.lock` by appending to `ledger\spawns.jsonl` (SPEC §2, §7).
 * `spawns.jsonl` is append-only: a failed spawn is compensated by `releaseReservation`,
 * which appends a `{released:true}` row that the counters here subtract — never a delete.
 * Fuses 6/7/9 live in the runner and the adapters; the agy 20,000-char cap is per leg.
 */

const fs = require('fs');

const jobstore = require('./jobstore.js');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** How far back the concurrency scan looks for live runners (a job's hard max is 1800 s). */
const RUNNING_SCAN_HOURS = 24;

/** Fuse 8: a prompt with more than this share of C0 control characters is not text. */
const C0_LIMIT_RATIO = 0.01;

/** How long a reserved, awaiting heartbeat job still counts as running. */
const GRACE_MS = 30000;

const warnedEnv = new Set();

/* ---------------- settings -- */

/**
 * Config value, overridden by an env var; an unparsable env var is ignored and warned
 * once to stderr (SPEC §8 env column).
 */
function envNum(ctx, name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    warnOnce(ctx, name + '=' + raw + ' is not a non-negative number — ignored, using ' + fallback);
    return fallback;
  }
  return Math.floor(n);
}

function warnOnce(ctx, msg) {
  if (warnedEnv.has(msg)) return;
  warnedEnv.add(msg);
  try {
    if (ctx && typeof ctx.log === 'function') ctx.log('fuses: ' + msg);
    else process.stderr.write('[council] fuses: ' + msg + '\n');
  } catch { /* stderr only, never stdout */ }
}

function fuseConf(ctx) {
  const f = (ctx && ctx.config && ctx.config.fuses) || {};
  return {
    max_depth: envNum(ctx, 'COUNCIL_MAX_DEPTH', numOr(f.max_depth, 2)),
    max_per_hour: envNum(ctx, 'COUNCIL_MAX_PER_HOUR', numOr(f.max_per_hour, 20)),
    max_per_day: envNum(ctx, 'COUNCIL_MAX_PER_DAY', numOr(f.max_per_day, 80)),
    max_running: envNum(ctx, 'COUNCIL_MAX_RUNNING', numOr(f.max_running, 3)),
    max_prompt_bytes: numOr(f.max_prompt_bytes, 200000),
  };
}

function numOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function lostAfterS(ctx) {
  const t = (ctx && ctx.config && ctx.config.timing) || {};
  return numOr(t.lost_after_s, 60);
}

/* ---------------- fuse 1: STOP -- */

/**
 * Fuse 1. Both STOP files plus any extra path listed in `COUNCIL_STOP_FILES`
 * (`;`-separated). STOP file #2 lives outside the Vault on purpose (SPEC §2).
 * @param {Object} ctx
 * @returns {{tripped:boolean, which:string|null,
 *            vault:{path:string|null,exists:boolean},
 *            local:{path:string|null,exists:boolean},
 *            extra:Array<{path:string,exists:boolean}>}}
 */
function stopFiles(ctx) {
  const P = (ctx && ctx.paths) || null;
  const vaultPath = P ? P.stopVault : null;
  const localPath = P ? P.stopLocal : null;
  const vault = { path: vaultPath, exists: vaultPath ? jobstore.exists(vaultPath) : false };
  const local = { path: localPath, exists: localPath ? jobstore.exists(localPath) : false };
  const extra = [require('path').join(require('../platform').appDirs().root, 'STOP')].concat(extraStopPaths()).map((p) => ({ path: p, exists: jobstore.exists(p) }));
  const hit = [vault, local].concat(extra).find((e) => e.path && e.exists) || null;
  return { tripped: !!hit, which: hit ? hit.path : null, vault, local, extra };
}

function extraStopPaths() {
  const raw = process.env.COUNCIL_STOP_FILES;
  if (!raw) return [];
  return String(raw).split(path.delimiter).map((s) => s.trim()).filter(Boolean);
}

/* ---------------- preflight --- */

/**
 * Fuses 1, 2, the vault check and fuse 8, in SPEC §8 order, before anything is written.
 * @param {Object} ctx
 * @param {{prompt:*, backendsHint?:string[], tool?:string}} input
 * @returns {{ok:true}|{ok:false, refuse_reason:string, detail:string, resets_in_s?:number}}
 */
function preflight(ctx, input) {
  const o = input || {};
  const conf = fuseConf(ctx);

  // Fuse 1 — STOP files.
  const stop = stopFiles(ctx);
  if (stop.tripped) return refusal('stop_file', 'STOP file present: ' + stop.which);

  // Fuse 2 — depth. Garbage (NaN) refuses; children are spawned with depth+1.
  const depth = ctx ? ctx.depth : 0;
  if (!Number.isFinite(depth)) {
    return refusal('depth_limit', 'COUNCIL_DEPTH is not a number: ' + String(process.env.COUNCIL_DEPTH));
  }
  if (depth >= conf.max_depth) {
    return refusal('depth_limit', 'depth ' + depth + ' >= max_depth ' + conf.max_depth
      + ' — a consultation may not consult');
  }

  // The vault must be there and writable, or nothing downstream can be recorded.
  const vault = vaultCheck(ctx);
  if (!vault.ok) return refusal('vault_unavailable', vault.detail);

  // Fuse 8 — prompt size and binary content. DELIBERATE reorder against the SPEC §8
  // table, which puts it after fuses 3/4/5: those three run inside reserveLegs() under
  // `.rate.lock`, and checking the prompt first avoids taking that lock for a request
  // that can never spawn. Nothing spawns either way; only the reported refuse_reason
  // differs when two fuses would trip at once (an over-cap prompt sent while the hour
  // cap is exhausted reports prompt_too_large, not rate_limit).
  const p = promptCheck(o.prompt, conf.max_prompt_bytes);
  if (!p.ok) return refusal(p.refuse_reason, p.detail);

  return { ok: true };
}

function refusal(reason, detail, extra) {
  return Object.assign({ ok: false, refuse_reason: reason, detail: detail }, extra || {});
}

function vaultCheck(ctx) {
  const P = (ctx && ctx.paths) || null;
  if (!P || !P.vault) return { ok: false, detail: 'config did not yield a vault path' };
  if (!jobstore.exists(P.vault)) return { ok: false, detail: 'vault does not exist: ' + P.vault };
  if (!isWritable(P.vault)) return { ok: false, detail: 'vault is not writable: ' + P.vault };
  if (!jobstore.exists(P.jobsRoot)) return { ok: false, detail: 'job root missing: ' + P.jobsRoot };
  if (!isWritable(P.jobsRoot)) return { ok: false, detail: 'job root is not writable: ' + P.jobsRoot };
  if (!jobstore.exists(P.ledgerDir)) return { ok: false, detail: 'ledger dir missing: ' + P.ledgerDir };
  return { ok: true, detail: null };
}

function isWritable(dir) {
  try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; }
}

/**
 * Fuse 8. Size in BYTES (the schema caps characters; a UTF-8 prompt can be bigger), plus
 * the binary test: any NUL, or more than 1 % C0 controls (tab/newline/CR excluded).
 */
function promptCheck(prompt, maxBytes) {
  if (typeof prompt !== 'string') {
    return { ok: false, refuse_reason: 'prompt_binary', detail: 'prompt is not a string' };
  }
  const bytes = Buffer.byteLength(prompt, 'utf8');
  if (bytes > maxBytes) {
    return { ok: false, refuse_reason: 'prompt_too_large', detail: bytes + ' bytes > max_prompt_bytes ' + maxBytes };
  }
  if (prompt.indexOf('\u0000') !== -1) {
    return { ok: false, refuse_reason: 'prompt_binary', detail: 'prompt contains a NUL byte' };
  }
  let controls = 0;
  for (let i = 0; i < prompt.length; i++) {
    const c = prompt.charCodeAt(i);
    if (c < 0x20 && c !== 9 && c !== 10 && c !== 13) controls++;
  }
  if (prompt.length && controls / prompt.length > C0_LIMIT_RATIO) {
    return {
      ok: false,
      refuse_reason: 'prompt_binary',
      detail: controls + ' C0 control characters in ' + prompt.length + ' chars (> 1 %)',
    };
  }
  return { ok: true };
}

/* ---------------- fuses 3, 4, 5: reserve -- */

/**
 * Fuses 3 (rolling hour), 4 (rolling day) and 5 (concurrency). All legs of a fan-out are
 * reserved atomically or the whole job is refused (SPEC §7). The reservation rows are
 * appended to `spawns.jsonl` BEFORE the runner is spawned (SPEC §8).
 * @param {Object} ctx
 * @param {{job_id:string, legs:Array<{leg_id:string, backend:string}>, host:string|null}} input
 * @returns {{ok:true, reserved:Array<{leg_id:string, ms:number}>, snapshot:Object}
 *          |{ok:false, refuse_reason:string, detail:string, resets_in_s?:number, running?:string[]}}
 */
function reserveLegs(ctx, input) {
  const o = input || {};
  const legs = Array.isArray(o.legs) ? o.legs : [];
  const P = (ctx && ctx.paths) || null;
  if (!P) return refusal('vault_unavailable', 'no paths available to reserve against');
  if (!legs.length) return refusal('concurrency_limit', 'nothing to reserve');

  const conf = fuseConf(ctx);
  const held = jobstore.withLock(P.rateLock, 10000, 2000, () => reserveUnderLock(ctx, P, conf, o, legs));
  if (!held.ok) {
    // Unevaluable (the lock never came free) → refuse, never spawn on a guess.
    return refusal('rate_limit', 'could not take .rate.lock within 2 s — refusing rather than spawning unchecked');
  }
  return held.value;
}

function reserveUnderLock(ctx, P, conf, o, legs) {
  const now = Date.now();
  const rows = readSpawns(P);
  const hourUsed = countWindow(rows, now - HOUR_MS, now);
  const dayUsed = countWindow(rows, now - DAY_MS, now);
  const live = liveLegs(ctx, P, now);
  const n = legs.length;

  if (n > conf.max_per_hour) {
    return refusal('rate_limit', n + ' legs requested but max_per_hour is ' + conf.max_per_hour);
  }
  if (hourUsed + n > conf.max_per_hour) {
    return refusal('rate_limit',
      hourUsed + ' legs in the last 60 min + ' + n + ' requested > cap ' + conf.max_per_hour,
      { resets_in_s: resetsInS(rows, now - HOUR_MS, now, HOUR_MS, hourUsed + n - conf.max_per_hour) });
  }
  if (dayUsed + n > conf.max_per_day) {
    return refusal('day_limit',
      dayUsed + ' legs in the last 24 h + ' + n + ' requested > cap ' + conf.max_per_day,
      { resets_in_s: resetsInS(rows, now - DAY_MS, now, DAY_MS, dayUsed + n - conf.max_per_day) });
  }
  if (live.legs + n > conf.max_running) {
    return refusal('concurrency_limit',
      live.legs + ' legs already running + ' + n + ' requested > cap ' + conf.max_running,
      { running: live.jobs });
  }

  const reserved = [];
  for (const leg of legs) {
    const ms = Date.now();
    const row = {
      ts: new Date(ms).toISOString(),
      ms,
      job_id: o.job_id,
      leg_id: leg.leg_id || leg.backend,
      backend: leg.backend,
      host: o.host || (ctx && ctx.host) || null,
      pid: (ctx && ctx.serverPid) || process.pid,
    };
    if (!jobstore.appendLine(P.spawnsPath, JSON.stringify(row))) {
      // A reservation we cannot record is a reservation we do not make: compensate what
      // did land and refuse, rather than spawning legs the counters cannot see.
      releaseReservation(ctx, { ok: true, job_id: o.job_id, reserved: reserved.slice() });
      return refusal('rate_limit', 'could not append to spawns.jsonl: ' + P.spawnsPath);
    }
    reserved.push({ leg_id: row.leg_id, ms });
  }

  return {
    ok: true,
    job_id: o.job_id,
    reserved,
    snapshot: {
      hour_used: hourUsed + reserved.length,
      hour_cap: conf.max_per_hour,
      day_used: dayUsed + reserved.length,
      day_cap: conf.max_per_day,
      running: live.legs + reserved.length,
      running_cap: conf.max_running,
      depth_max: conf.max_depth,
    },
  };
}

/**
 * Best-effort compensation when the runner could not be spawned after a successful
 * reserve. `spawns.jsonl` is append-only, so nothing is deleted: one `{released:true}` row
 * per leg is appended and `countWindow` ignores both halves of a released pair.
 * @param {Object} ctx @param {Object} reservation the object reserveLegs returned
 * @returns {void}
 */
function releaseReservation(ctx, reservation) {
  const P = (ctx && ctx.paths) || null;
  if (!P || !reservation || !reservation.ok) return;
  const jobId = reservation.job_id || (reservation.reserved && reservation.reserved.job_id) || null;
  for (const r of (reservation.reserved || [])) {
    const ms = Date.now();
    const row = {
      ts: new Date(ms).toISOString(),
      ms,
      job_id: jobId,
      leg_id: r.leg_id,
      released: true,
      reserved_ms: r.ms,
      pid: (ctx && ctx.serverPid) || process.pid,
    };
    try { jobstore.appendLine(P.spawnsPath, JSON.stringify(row)); } catch { /* best effort */ }
  }
}

/**
 * Current fuse counters for council_start / council_doctor (SPEC §5.1, §5.7). Read-only,
 * taken without the lock: it is a report, not a decision.
 * @param {Object} ctx
 * @returns {{hour_used:number, hour_cap:number, day_used:number, day_cap:number,
 *            running:number, running_cap:number, depth_max:number}}
 */
function snapshot(ctx) {
  const conf = fuseConf(ctx);
  const P = (ctx && ctx.paths) || null;
  const now = Date.now();
  const rows = P ? readSpawns(P) : [];
  const live = P ? liveLegs(ctx, P, now) : { legs: 0, jobs: [] };
  return {
    hour_used: countWindow(rows, now - HOUR_MS, now),
    hour_cap: conf.max_per_hour,
    day_used: countWindow(rows, now - DAY_MS, now),
    day_cap: conf.max_per_day,
    running: live.legs,
    running_cap: conf.max_running,
    depth_max: conf.max_depth,
  };
}

/* ---------------- spawns.jsonl */

/** Every parseable row of spawns.jsonl. Unparseable lines are skipped, never repaired. */
function readSpawns(P) {
  const out = [];
  if (!P.spawnsPath || !jobstore.exists(P.spawnsPath)) return out;
  let text = '';
  const size = jobstore.sizeOf(P.spawnsPath);
  const CAP = 4 * 1024 * 1024;
  if (size > CAP) {
    text = jobstore.readTail(P.spawnsPath, CAP);
    const nl = text.indexOf('\n');
    text = nl === -1 ? '' : text.slice(nl + 1);
  } else {
    try { text = fs.readFileSync(P.spawnsPath, 'utf8'); } catch { return out; }
  }
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let row = null;
    try { row = JSON.parse(s); } catch { continue; }
    if (row && typeof row === 'object') out.push(row);
  }
  return out;
}

function reservationKey(row) {
  return String(row.job_id) + '\u0000' + String(row.leg_id);
}

/**
 * Rows inside [fromMs, toMs] that are still counted: a `{released:true}` row cancels its
 * own reservation row, so both halves drop out of every window.
 */
function countWindow(rows, fromMs, toMs) {
  return windowRows(rows, fromMs, toMs).length;
}

function windowRows(rows, fromMs, toMs) {
  const released = new Set();
  for (const r of rows) if (r.released) released.add(reservationKey(r));
  const out = [];
  for (const r of rows) {
    if (r.released) continue;
    if (released.has(reservationKey(r))) continue;
    const ms = Number(r.ms);
    if (!Number.isFinite(ms) || ms < fromMs || ms > toMs) continue;
    out.push(r);
  }
  out.sort((a, b) => Number(a.ms) - Number(b.ms));
  return out;
}

/**
 * Seconds until enough rows leave the window for `need` more legs to fit.
 * Null when that cannot be worked out from the rows we have.
 */
function resetsInS(rows, fromMs, toMs, windowMs, need) {
  if (!Number.isFinite(need) || need <= 0) return null;
  const inWindow = windowRows(rows, fromMs, toMs);
  if (inWindow.length < need) return null;
  const freeing = Number(inWindow[need - 1].ms) + windowMs;
  return Math.max(1, Math.ceil((freeing - toMs) / 1000));
}

/* ---------------- fuse 5: running -- */

/**
 * Live legs across ALL server processes: any job with no DONE whose runner heartbeat is
 * younger than `timing.lost_after_s` (plus a short grace for a job reserved seconds ago
 * whose runner has not written state.json yet).
 * @returns {{legs:number, jobs:string[]}}
 */
function liveLegs(ctx, P, nowMs) {
  const lostMs = lostAfterS(ctx) * 1000;
  const jobs = [];
  let legs = 0;
  let dirs = [];
  try { dirs = jobstore.listJobDirs(P, { since_hours: RUNNING_SCAN_HOURS, nowMs }); } catch { dirs = []; }
  for (const j of dirs) {
    const files = jobstore.jobFiles(j.dir);
    if (jobstore.exists(files.done)) continue;
    const request = jobstore.readJSON(files.request);
    if (request && request.state === 'refused') continue;
    const state = jobstore.readJSON(files.state);
    let running = 0;
    if (state) {
      const hb = Number(state.heartbeat_ms) || jobstore.mtimeMs(files.state);
      if (!hb || nowMs - hb > lostMs) continue;
      if (state.state === 'finished') continue;
      const legMap = (state.legs && typeof state.legs === 'object') ? state.legs : {};
      for (const id of Object.keys(legMap)) {
        const st = legMap[id] && legMap[id].state;
        if (st === 'done' || st === 'error' || st === 'timeout' || st === 'cancelled' || st === 'skipped') continue;
        running++;
      }
      if (!running) running = 1; // a live runner with no leg lines yet still occupies a slot
    } else {
      // No state.json yet: only the reservation grace window keeps it counted.
      if (nowMs - j.ms > GRACE_MS) continue;
      running = Array.isArray(request && request.legs) ? request.legs.length : 1;
    }
    legs += running;
    jobs.push(j.job_id);
  }
  return { legs, jobs };
}

module.exports = {
  HOUR_MS, DAY_MS, C0_LIMIT_RATIO,
  stopFiles, preflight, reserveLegs, releaseReservation, snapshot,
  fuseConf, promptCheck, readSpawns, countWindow, liveLegs,
};
