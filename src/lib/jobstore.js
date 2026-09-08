// Owns jobstore.js runtime behavior; port specification §§2–6.
'use strict';
/**
 * lib/jobstore.js — job identity, the on-disk job directory, and every cross-process
 * primitive of SPEC §3 (atomic replace with EPERM/EBUSY retry, 'wx' exactly-once,
 * one-writeSync appends, TTL-steal locks) plus the SPEC §2 readers and the §2.1
 * `lost` derivation input.
 * Single-writer rule (§2.1) is enforced by convention, not by this module: server owns
 * request/spawn/prompt + cancel.json, runner owns state, progress, legs, result, error and DONE.
 * Every unlink in the whole server lives here and there are exactly three, all of files
 * this process created: the lock release, the TTL-expired lock steal (`.rate.lock`,
 * `.reaper.lock`) and an atomicWrite's own unrenamed `.tmp` file. No job, ledger or user
 * file is ever removed, and there is no rmdir path (§5.9).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const JOB_ID_RE = /^j_[0-9]{13}_[0-9a-f]{6}$/;
const RETRY_DELAYS_MS = [15, 30, 60, 120, 250, 500];
const LOG_CAP_BYTES = 5 * 1024 * 1024;
const LEDGER_LINE_MAX = 8 * 1024;

/* ---------------- identity */

/** @param {number} [nowMs] @returns {string} `j_<13-digit epoch ms>_<6 hex>` */
function newJobId(nowMs) {
  const ms = String(Math.floor(nowMs == null ? Date.now() : nowMs)).padStart(13, '0').slice(-13);
  return 'j_' + ms + '_' + crypto.randomBytes(3).toString('hex');
}

/** @param {*} s @returns {boolean} */
function isJobId(s) { return typeof s === 'string' && JOB_ID_RE.test(s); }

/** @param {string} jobId @returns {number} the epoch-ms embedded in the id */
function jobMs(jobId) { return Number(String(jobId).slice(2, 15)); }

/** @param {string} jobId @returns {string} UTC date dir name `YYYY-MM-DD` */
function jobDateDir(jobId) {
  const d = new Date(jobMs(jobId));
  return d.toISOString().slice(0, 10);
}

/** @param {Object} P paths bag @param {string} jobId @returns {string} */
function jobDirFor(P, jobId) { return path.join(P.jobsRoot, jobDateDir(jobId), jobId); }

/**
 * The canonical directory, or a neighbouring date dir when the clock crossed midnight.
 * @param {Object} P @param {string} jobId @returns {string|null}
 */
function findJobDir(P, jobId) {
  if (!isJobId(jobId)) return null;
  const primary = jobDirFor(P, jobId);
  if (fs.existsSync(primary)) return primary;
  const base = jobMs(jobId);
  for (const delta of [-86400000, 86400000]) {
    const d = new Date(base + delta).toISOString().slice(0, 10);
    const p = path.join(P.jobsRoot, d, jobId);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Leg ids for a backends array. Duplicates are legal (judge runs claude twice, T-04b
 * runs echo twice): the 2nd occurrence of `b` becomes `b-2`, the 3rd `b-3`.
 * @param {string[]} backends @returns {string[]}
 */
function legIdsFor(backends) {
  const seen = Object.create(null);
  return (backends || []).map((b) => {
    seen[b] = (seen[b] || 0) + 1;
    return seen[b] === 1 ? b : b + '-' + seen[b];
  });
}

/** @param {string} legId @returns {string} the backend id a leg id belongs to */
function backendOfLeg(legId) { return String(legId).replace(/-\d+$/, ''); }

/* ---------------- low-level primitives */

/** Block the calling thread. Used only inside the retry ladder (§3). */
function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, Math.max(0, ms));
}

function isRetryable(e) {
  const c = e && e.code;
  return c === 'EPERM' || c === 'EBUSY' || c === 'EACCES' || c === 'EEXIST';
}

/**
 * Publish bytes atomically: tmp -> fsync -> rename, retrying EPERM/EBUSY 6 times
 * (15/30/60/120/250/500 ms). Never truncates the destination in place.
 * @param {string} file @param {string|Buffer} data
 * @returns {boolean} true on success; false after the ladder is exhausted
 */
function atomicWrite(file, data) {
  const tmp = file + '.tmp.' + process.pid + '.' + crypto.randomBytes(3).toString('hex');
  try {
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (e) {
    return false;
  }
  for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
    try { fs.renameSync(tmp, file); return true; } catch (e) {
      if (i === RETRY_DELAYS_MS.length || !isRetryable(e)) break;
      sleepSync(RETRY_DELAYS_MS[i]);
    }
  }
  try { fs.rmSync(tmp, { force: true }); } catch { /* tmp of our own making */ }
  return false;
}

/** @param {string} file @param {*} obj @returns {boolean} */
function atomicWriteJSON(file, obj) { return atomicWrite(file, JSON.stringify(obj, null, 1)); }

/**
 * Exactly-once create ('wx'): DONE, cancel.json, .idem markers, locks.
 * @param {string} file @param {string|Buffer} [data]
 * @returns {boolean} true when THIS call created the file
 */
function writeNewFile(file, data) {
  let fd;
  try { fd = fs.openSync(file, 'wx'); } catch (e) { return false; }
  try { if (data != null && String(data).length) fs.writeSync(fd, data); fs.fsyncSync(fd); }
  catch { /* content is best-effort; existence is the contract */ }
  finally { fs.closeSync(fd); }
  return true;
}

/**
 * Append exactly one line with a single writeSync on an 'a' fd (§3).
 * Lines longer than 8 KB are truncated with a marker rather than split.
 * @param {string} file @param {string} line (no trailing newline needed)
 * @returns {boolean}
 */
function appendLine(file, line) {
  let s = String(line).replace(/[\r\n]+/g, ' ');
  if (Buffer.byteLength(s, 'utf8') > LEDGER_LINE_MAX) s = s.slice(0, LEDGER_LINE_MAX - 20) + '"…truncated"}';
  let fd;
  try { fd = fs.openSync(file, 'a'); } catch { return false; }
  try { fs.writeSync(fd, s + '\n'); return true; } catch { return false; } finally { fs.closeSync(fd); }
}

/**
 * @param {string} file @returns {*|null} parsed JSON, or null when absent/corrupt
 * A leading UTF-8 BOM is stripped: etc/accounts.json is hand-editable and every
 * Windows platform helper 5.1 `-Encoding UTF8` write puts one there (see paths.stripBom).
 */
function readJSON(file) {
  try { return JSON.parse(stripBomText(fs.readFileSync(file, 'utf8'))); } catch { return null; }
}

/** @param {string} s @returns {string} */
function stripBomText(s) {
  const t = String(s == null ? '' : s);
  return t.charCodeAt(0) === 0xfeff ? t.slice(1) : t;
}

/** @param {string} file @returns {boolean} */
function exists(file) { try { fs.accessSync(file); return true; } catch { return false; } }

/** @param {string} file @returns {number} mtimeMs, or 0 when absent */
function mtimeMs(file) { try { return fs.statSync(file).mtimeMs; } catch { return 0; } }

/** @param {string} file @returns {number} size in bytes, or 0 */
function sizeOf(file) { try { return fs.statSync(file).size; } catch { return 0; } }

/**
 * Read the last `bytes` of a file without loading the whole thing.
 * @param {string} file @param {number} bytes
 * @returns {string}
 */
function readTail(file, bytes) {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - bytes);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(bytes, st.size));
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

/* ---------------- locks */

/**
 * 'wx' mutex with TTL steal (§3). The unlink inside is the only unlink in the server.
 * @param {string} lockPath @param {number} ttlMs `.rate.lock` 10_000, `.reaper.lock` 90_000
 * @param {Object} [meta] written into the lock file for forensics
 * @returns {{ok:boolean, stolen:boolean, release:function():void, age_ms?:number}}
 */
function acquireLock(lockPath, ttlMs, meta) {
  const token = process.pid + '.' + crypto.randomBytes(4).toString('hex');
  const body = JSON.stringify(Object.assign({ pid: process.pid, token, ts: new Date().toISOString() }, meta || {}));
  if (writeNewFile(lockPath, body)) return { ok: true, stolen: false, token, release: () => releaseLock(lockPath, token) };
  const age = Date.now() - mtimeMs(lockPath);
  if (age > ttlMs) {
    try { fs.unlinkSync(lockPath); } catch { /* someone else stole it first */ }
    if (writeNewFile(lockPath, body)) return { ok: true, stolen: true, age_ms: age, token, release: () => releaseLock(lockPath, token) };
  }
  return { ok: false, stolen: false, age_ms: age, token: null, release: () => {} };
}

/**
 * Release a lock only when it is still OURS. A sweep that outruns the 90 s
 * `.reaper.lock` TTL has its lock stolen by another server; unlinking unconditionally
 * on the way out would then delete the NEW owner's lock and let two sweeps run at once.
 * @param {string} lockPath @param {string} [token] the token acquireLock wrote
 */
function releaseLock(lockPath, token) {
  try {
    if (token) {
      const cur = readJSON(lockPath);
      if (cur && cur.token && cur.token !== token) return;   // TTL-stolen; not ours to remove
    }
    fs.unlinkSync(lockPath);
  } catch { /* already stolen or gone */ }
}

/**
 * Run fn under a lock, retrying acquisition for up to waitMs.
 * @template T
 * @param {string} lockPath @param {number} ttlMs @param {number} waitMs @param {function(boolean):T} fn
 * @returns {{ok:boolean, value?:T, stolen?:boolean}}
 */
function withLock(lockPath, ttlMs, waitMs, fn) {
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    const l = acquireLock(lockPath, ttlMs);
    if (l.ok) {
      try { return { ok: true, stolen: l.stolen, value: fn(l.stolen) }; } finally { l.release(); }
    }
    if (Date.now() >= deadline) return { ok: false };
    sleepSync(25);
  }
}

/* ---------------- job layout */

/**
 * Absolute paths of every file inside one job directory (SPEC §2).
 * @param {string} dir @returns {Record<string,string|function>}
 */
function jobFiles(dir) {
  return {
    dir,
    request: path.join(dir, 'request.json'),
    spawn: path.join(dir, 'spawn.json'),
    prompt: path.join(dir, 'prompt.md'),
    state: path.join(dir, 'state.json'),
    progress: path.join(dir, 'progress.json'),
    cancel: path.join(dir, 'cancel.json'),
    result: path.join(dir, 'result.json'),
    error: path.join(dir, 'error.json'),
    done: path.join(dir, 'DONE'),
    runnerLog: path.join(dir, 'runner.log'),
    legsDir: path.join(dir, 'legs'),
    /** @param {string} legId */
    leg(legId) {
      const d = path.join(dir, 'legs', legId);
      return {
        dir: d,
        stdout: path.join(d, 'stdout.log'),
        stderr: path.join(d, 'stderr.log'),
        answer: path.join(d, 'answer.md'),
        meta: path.join(d, 'meta.json'),
        last: path.join(d, 'last.md'),
        // Server-owned, written only when this leg's prompt differs from the job's
        // prompt.md — today that is the judge leg whose A/B blocks are transposed (§7).
        prompt: path.join(d, 'prompt.md'),
      };
    },
  };
}

/**
 * Create `<jobsRoot>/<YYYY-MM-DD>/<job_id>/legs/<legId>` for every leg.
 * @param {Object} P @param {string} jobId @param {string[]} legIds
 * @returns {{dir:string, files:Object}}
 */
function createJobDir(P, jobId, legIds) {
  const dir = jobDirFor(P, jobId);
  fs.mkdirSync(dir, { recursive: true });
  for (const id of (legIds || [])) fs.mkdirSync(path.join(dir, 'legs', id), { recursive: true });
  return { dir, files: jobFiles(dir) };
}

/* ---------------- idempotency */

/**
 * Reserve `.idem/<sha256(key)>`. A marker whose job dir no longer exists is treated as
 * free and rewritten by atomic replace — never unlinked (§5.9).
 * @param {Object} P @param {string} key @param {string} jobId
 * @returns {{reused:boolean, job_id:string, marker:string}}
 */
function reserveIdempotency(P, key, jobId) {
  const marker = path.join(P.idemDir, crypto.createHash('sha256').update(String(key)).digest('hex'));
  fs.mkdirSync(P.idemDir, { recursive: true });
  const body = JSON.stringify({ job_id: jobId, ts: new Date().toISOString() });
  if (writeNewFile(marker, body)) return { reused: false, job_id: jobId, marker };
  const prev = readJSON(marker);
  const priorDir = prev && isJobId(prev.job_id) ? findJobDir(P, prev.job_id) : null;
  if (priorDir) {
    // A marker pointing at a REFUSED job is as free as a dangling one: that job was
    // never spawned and never will be, so reusing it would answer "running" forever
    // (SPEC §5.1 reused_idempotent means the same job, not the same refusal).
    const req = readJSON(jobFiles(priorDir).request);
    if (!req || req.state !== 'refused') return { reused: true, job_id: prev.job_id, marker };
  }
  atomicWrite(marker, body);
  return { reused: false, job_id: jobId, marker };
}

/* ---------------- readers */

/**
 * Everything a reader needs about one job, from disk only (SPEC §2.1).
 * `state` is the DERIVED state; `lost_candidate` is true when the job qualifies for
 * `lost` on the disk evidence alone — the caller (reaper) still has to prove the runner
 * is dead with a PID-identity check before finalising (§9).
 * @param {Object} P @param {Object} config @param {string} jobId @param {number} [nowMs]
 * @returns {Object|null} view, or null when the job dir does not exist
 */
function loadView(P, config, jobId, nowMs) {
  const dir = findJobDir(P, jobId);
  if (!dir) return null;
  const f = jobFiles(dir);
  const now = nowMs == null ? Date.now() : nowMs;
  const request = readJSON(f.request);
  const spawn = readJSON(f.spawn);
  const state = readJSON(f.state);
  const progress = readJSON(f.progress);
  const cancel = readJSON(f.cancel);
  const done = exists(f.done);
  const result = done ? readJSON(f.result) : null;
  const error = done ? readJSON(f.error) : null;

  const lostAfterS = Number((config && config.timing && config.timing.lost_after_s) || 60);
  const createdMs = request && request.created_ms ? Number(request.created_ms) : jobMs(jobId);
  // No state.json at all means the runner died BEFORE its first heartbeat (runner.js
  // exits 3 on a missing request/spawn doc, and any throw in bootRunner does the same).
  // Falling back to the job's own creation time is what makes that case derive `lost`
  // after 60 s (SPEC §2.1) instead of sitting in `queued` until the deadline backstop.
  const hbMs = (state && state.heartbeat_ms ? Number(state.heartbeat_ms) : 0) || mtimeMs(f.state) || createdMs;
  const heartbeatAgeS = hbMs ? Math.max(0, Math.round((now - hbMs) / 1000)) : null;
  const deadlineMs = request && request.deadline_ms ? Number(request.deadline_ms) : null;

  let derived;
  if (request && request.state === 'refused') derived = 'refused';
  else if (done) derived = (result && result.state) || (error && error.state) || 'done';
  else if (heartbeatAgeS != null && heartbeatAgeS > lostAfterS) derived = 'lost';
  else derived = (state && state.state) || 'queued';

  return {
    found: true,
    job_id: jobId,
    dir,
    files: f,
    request, spawn, state, progress, cancel,
    done, result, error,
    state_derived: derived,
    terminal: derived === 'refused' || (done && !!(result || error)),
    lost_candidate: !done && heartbeatAgeS != null && heartbeatAgeS > lostAfterS && request && request.state !== 'refused',
    heartbeat_age_s: heartbeatAgeS,
    elapsed_s: Math.max(0, Math.round((now - createdMs) / 1000)),
    remaining_s: deadlineMs ? Math.round((deadlineMs - now) / 1000) : null,
    state_mtime_ms: mtimeMs(f.state),
  };
}

/**
 * Read a leg's answer with paging (council_poll offset/max_chars).
 * @param {Object} view @param {string} legId @param {{offset?:number,max_chars?:number}} [opts]
 * @returns {{text:string, total_chars:number, truncated:boolean, offset:number}}
 */
function readLegAnswer(view, legId, opts) {
  const o = opts || {};
  const offset = Math.max(0, Number(o.offset) || 0);
  const max = Math.max(1, Number(o.max_chars) || 60000);
  let all = '';
  try { all = fs.readFileSync(view.files.leg(legId).answer, 'utf8'); } catch { all = ''; }
  const slice = all.slice(offset, offset + max);
  return { text: slice, total_chars: all.length, truncated: offset + slice.length < all.length, offset };
}

/**
 * List job dirs newest-first, bounded by the date dirs inside the window (§5.5).
 * @param {Object} P @param {{since_hours?:number, limit?:number, nowMs?:number}} [opts]
 * @returns {Array<{job_id:string, dir:string, ms:number}>}
 */
function listJobDirs(P, opts) {
  const o = opts || {};
  const now = o.nowMs == null ? Date.now() : o.nowMs;
  const sinceMs = now - (Number(o.since_hours) || 24) * 3600 * 1000;
  const out = [];
  let dates = [];
  try { dates = fs.readdirSync(P.jobsRoot).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse(); } catch { return out; }
  const firstDate = new Date(sinceMs).toISOString().slice(0, 10);
  for (const d of dates) {
    if (d < firstDate) break;
    let ids = [];
    try { ids = fs.readdirSync(path.join(P.jobsRoot, d)); } catch { continue; }
    for (const id of ids) {
      if (!isJobId(id)) continue;
      const ms = jobMs(id);
      if (ms < sinceMs) continue;
      out.push({ job_id: id, dir: path.join(P.jobsRoot, d, id), ms });
    }
  }
  out.sort((a, b) => b.ms - a.ms);
  return out;
}

/**
 * Total bytes and 30-day-old terminal count under work\jobs (council_doctor §5.7).
 * @param {Object} P @returns {{bytes:number, jobs:number, older_than_30d:number}}
 */
function jobsFootprint(P) {
  let bytes = 0, jobs = 0, older = 0;
  const cutoff = Date.now() - 30 * 86400000;
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else bytes += sizeOf(p);
    }
  };
  for (const j of listJobDirs(P, { since_hours: 720 * 10 })) {
    jobs++;
    if (j.ms < cutoff && exists(path.join(j.dir, 'DONE'))) older++;
  }
  walk(P.jobsRoot);
  return { bytes, jobs, older_than_30d: older };
}

/* ---------------- log appending */

/**
 * Append-only leg log with the SPEC §2.2 cap: at 5 MB write one final
 * `[log capped at 5 MB]` line and stop appending. Never truncates, rotates or deletes.
 * @param {string} file @param {number} [capBytes]
 * @returns {{write:function(Buffer|string):void, bytes:number, capped:boolean, close:function():void}}
 */
function makeLogAppender(file, capBytes) {
  const cap = capBytes == null ? LOG_CAP_BYTES : capBytes;
  let fd = null;
  try { fd = fs.openSync(file, 'a'); } catch { fd = null; }
  const api = {
    bytes: sizeOf(file),
    capped: false,
    write(chunk) {
      if (fd == null || api.capped) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      if (api.bytes + buf.length >= cap) {
        const room = Math.max(0, cap - api.bytes);
        try {
          if (room > 0) fs.writeSync(fd, buf.subarray(0, room));
          fs.writeSync(fd, '\n[log capped at 5 MB]\n');
        } catch { /* capped anyway */ }
        api.bytes = cap;
        api.capped = true;
        return;
      }
      try { fs.writeSync(fd, buf); api.bytes += buf.length; } catch { /* keep the leaf running */ }
    },
    close() { if (fd != null) { try { fs.closeSync(fd); } catch {} fd = null; } },
  };
  return api;
}

module.exports = {
  JOB_ID_RE, LOG_CAP_BYTES, RETRY_DELAYS_MS,
  newJobId, isJobId, jobMs, jobDateDir, jobDirFor, findJobDir, legIdsFor, backendOfLeg,
  sleepSync, atomicWrite, atomicWriteJSON, writeNewFile, appendLine, readJSON, exists,
  mtimeMs, sizeOf, readTail,
  acquireLock, releaseLock, withLock,
  jobFiles, createJobDir, reserveIdempotency,
  loadView, readLegAnswer, listJobDirs, jobsFootprint, makeLogAppender,
};
