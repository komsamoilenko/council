// Owns quota.js runtime behavior; port specification §§2–6.
'use strict';
/**
 * lib/quota.js — the two READ-ONLY quota readings of SPEC §10.4 and §0.
 * `snapshotCodex` locates the codex rollout for a finished leg under
 * %USERPROFILE%\.codex\sessions\YYYY\MM\DD\, reads only its LAST 64 KB with a positioned
 * read, scans backwards for `rate_limits` and reports the primary window with its age;
 * an unrecognised shape returns {error:'shape_unknown'} — a stale number presented as
 * current is worse than no number at all.
 * `planUsageInferred` reads %APPDATA%\Claude\plan-usage-history.json (v2) and returns the
 * newest sample per org, which council_ledger labels `inferred`.
 * This module never writes, never spawns and never opens a credential file.
 */

const fs = require('fs');
const path = require('path');

const jobstore = require('./jobstore.js');
const paths = require('./paths.js');

/** SPEC §10.4: only the tail of a rollout is ever read. */
const TAIL_BYTES = 64 * 1024;

/** The head carries the session_meta line with `cli_version`. */
const HEAD_BYTES = 8 * 1024;

const ROLLOUT_RE = /^rollout-.*\.jsonl$/i;

/* ---------------- codex rollout -- */

/**
 * The codex quota snapshot taken after every codex leg (SPEC §10.4).
 * @param {Object} ctx
 * @param {{jobId?:string, sessionId?:string|null, startedAtMs?:number}} opts
 * @returns {Promise<Object>} the reading, or {error:'not_found'|'shape_unknown'}
 */
async function snapshotCodex(ctx, opts) {
  const o = opts || {};
  const startedAtMs = Number.isFinite(Number(o.startedAtMs)) ? Number(o.startedAtMs) : Date.now() - 3600000;
  const root = sessionsRoot();
  if (!jobstore.exists(root)) return { error: 'not_found', detail: 'no sessions dir: ' + root };

  const file = pickRollout(root, o.sessionId, startedAtMs);
  if (!file) {
    return { error: 'not_found', detail: 'no rollout for session ' + (o.sessionId || '(unknown)') + ' after job start' };
  }

  const hit = findRateLimits(file);
  if (!hit) return { error: 'shape_unknown', source_file: file };

  const primary = hit.rate_limits.primary;
  if (!primary || typeof primary !== 'object' || primary.used_percent == null) {
    return { error: 'shape_unknown', source_file: file };
  }

  const resetsAt = Number(primary.resets_at);
  const takenMs = hit.line_ms || jobstore.mtimeMs(file) || Date.now();
  return {
    used_percent: Number(primary.used_percent),
    window_minutes: primary.window_minutes == null ? null : Number(primary.window_minutes),
    resets_at: Number.isFinite(resetsAt) ? resetsAt : null,
    resets_at_iso: Number.isFinite(resetsAt) ? new Date(resetsAt * 1000).toISOString() : null,
    plan_type: hit.rate_limits.plan_type == null ? null : String(hit.rate_limits.plan_type),
    cli_version: readCliVersion(file),
    source_file: file,
    stale_minutes: Math.max(0, Math.round((Date.now() - takenMs) / 60000)),
  };
}

function sessionsRoot() {
  return path.join(paths.homeDir(), '.codex', 'sessions');
}

/**
 * The rollout whose filename carries the session id; failing that, the newest rollout
 * touched after the job started (SPEC §10.4 fallback).
 */
function pickRollout(root, sessionId, startedAtMs) {
  const recent = listRollouts(root, startedAtMs - 86400000);
  if (sessionId) {
    const byId = recent.find((f) => path.basename(f).indexOf(String(sessionId)) !== -1);
    if (byId) return byId;
    const wide = listRollouts(root, 0).find((f) => path.basename(f).indexOf(String(sessionId)) !== -1);
    if (wide) return wide;
  }
  let best = null;
  let bestMs = 0;
  for (const f of recent) {
    const ms = jobstore.mtimeMs(f);
    if (ms < startedAtMs) continue;
    if (ms > bestMs) { bestMs = ms; best = f; }
  }
  return best;
}

/** Rollout files under YYYY\MM\DD dirs whose date is not older than `sinceMs`. */
function listRollouts(root, sinceMs) {
  const out = [];
  const minKey = sinceMs > 0 ? dateKey(new Date(sinceMs)) : '0000-00-00';
  for (const y of childNames(root, /^\d{4}$/)) {
    const yDir = path.join(root, y);
    for (const m of childNames(yDir, /^\d{2}$/)) {
      const mDir = path.join(yDir, m);
      for (const d of childNames(mDir, /^\d{2}$/)) {
        if (y + '-' + m + '-' + d < minKey) continue;
        const dDir = path.join(mDir, d);
        for (const f of fileNames(dDir, ROLLOUT_RE)) out.push(path.join(dDir, f));
      }
    }
  }
  return out;
}

function childNames(dir, re) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && re.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch { return []; }
}

function fileNames(dir, re) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && re.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch { return []; }
}

/** Local-date key, matching how codex names its YYYY\MM\DD rollout directories. */
function dateKey(d) {
  const p2 = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
}

/**
 * Scan the LAST 64 KB backwards for a line carrying a `rate_limits` object.
 * @returns {{rate_limits:Object, line_ms:number|null}|null}
 */
function findRateLimits(file) {
  const size = jobstore.sizeOf(file);
  if (!size) return null;
  let text = jobstore.readTail(file, TAIL_BYTES);
  if (size > TAIL_BYTES) {
    const nl = text.indexOf('\n');
    text = nl === -1 ? '' : text.slice(nl + 1); // the first line is a fragment
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i].trim();
    if (!s || s.indexOf('rate_limits') === -1) continue;
    let obj = null;
    try { obj = JSON.parse(s); } catch { continue; }
    const rl = extractRateLimits(obj);
    if (!rl) continue;
    const ms = Date.parse(obj && obj.timestamp);
    return { rate_limits: rl, line_ms: Number.isFinite(ms) ? ms : null };
  }
  return null;
}

/** The three places 0.153.2 has been observed to put the object. */
function extractRateLimits(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const candidates = [
    obj.rate_limits,
    obj.payload && obj.payload.rate_limits,
    obj.payload && obj.payload.info && obj.payload.info.rate_limits,
  ];
  for (const c of candidates) if (c && typeof c === 'object') return c;
  return null;
}

/** `cli_version` lives in the session_meta line at the head of the rollout. */
function readCliVersion(file) {
  let head = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const read = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
      head = buf.subarray(0, read).toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return null; }
  const line = head.split('\n')[0];
  if (line) {
    try {
      const obj = JSON.parse(line);
      const v = (obj && obj.payload && obj.payload.cli_version) || (obj && obj.cli_version);
      if (v) return String(v);
    } catch { /* the session_meta line is routinely longer than HEAD_BYTES */ }
  }
  const m = /"cli_version"\s*:\s*"([^"]{1,40})"/.exec(head);
  return m ? m[1] : null;
}

/* ---------------- plan usage (Pro) -- */

/**
 * The newest %APPDATA%\Claude\plan-usage-history.json sample per org (SPEC §0). This is
 * the Desktop app's own local log, so council_ledger labels it `inferred`: it is not a
 * reading the council took and it is not a bill.
 * @param {Object} ctx
 * @returns {{orgs:Array<Object>, source:string, samples:number, version:*}|null}
 */
function planUsageInferred(ctx) {
  const file = planUsagePath();
  if (!file || !jobstore.exists(file)) return null;
  const doc = jobstore.readJSON(file);
  if (!doc || !Array.isArray(doc.samples)) return null;

  const newest = new Map();
  for (const s of doc.samples) {
    if (!s || typeof s !== 'object') continue;
    const org = s.org == null ? 'unknown' : String(s.org);
    const t = Number(s.t);
    if (!Number.isFinite(t)) continue;
    const prev = newest.get(org);
    if (!prev || t > prev.t) {
      newest.set(org, {
        org,
        t,
        t_iso: new Date(t).toISOString(),
        u: (s.u && typeof s.u === 'object') ? { fh: numOrNull(s.u.fh), sd: numOrNull(s.u.sd) } : null,
      });
    }
  }
  if (!newest.size) return null;
  return {
    orgs: Array.from(newest.values()).sort((a, b) => b.t - a.t),
    source: file,
    samples: doc.samples.length,
    version: doc.version == null ? null : doc.version,
  };
}

function planUsagePath() {
  return require('../platform').planUsagePath();
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = {
  TAIL_BYTES, HEAD_BYTES,
  snapshotCodex, planUsageInferred,
  sessionsRoot, planUsagePath, listRollouts, pickRollout, findRateLimits,
};
