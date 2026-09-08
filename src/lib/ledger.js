// Owns ledger.js runtime behavior; port specification §§2–6.
'use strict';
/**
 * lib/ledger.js — the append-only ledger of SPEC §10 plus the council_ledger report data
 * of SPEC §5.8. Owns baseRow (the common head of every row), append (ONE <=8 KB line via
 * jobstore.appendLine, monthly rotation, never throws — failures go to ledger-errors.log),
 * readRows (month-file scan over a window), tokenTotals (the single normative
 * implementation of the SPEC §6.1 token formula every adapter calls), health
 * (council_doctor.ledger) and report (council_ledger).
 * Nothing here rewrites, rotates in place, prunes or deletes a ledger file.
 */

const fs = require('fs');
const redact = require('./redact');

const jobstore = require('./jobstore.js');

/** One row must fit in one writeSync of at most 8 KB (SPEC §3, §10). */
const LINE_MAX = 8 * 1024;

/** Order in which fat fields are dropped when a row does not fit. */
const SHRINK_KEYS = ['stack', 'model_usage', 'argv_flags', 'env_added', 'raw_ids', 'quota', 'usage', 'prompt_preview', 'detail'];

const FOOTER = '~ = vendor client-side estimate, not a bill and not a quota reading';

const WINDOW_MS = { hour: 3600000, day: 86400000, week: 7 * 86400000, month: 30 * 86400000 };

const GROUP_BY = ['account', 'backend', 'host', 'task_class'];

/** Never read more than this from one ledger file in a single report. */
const READ_CAP_BYTES = 8 * 1024 * 1024;

/* ---------------- rows -- */

/**
 * The common head of every ledger row (SPEC §10). `extra` wins over the head, except that
 * a missing or null `requester` is filled from ctx.
 * @param {Object} ctx @param {Object} extra
 * @returns {Object} row
 */
function baseRow(ctx, extra) {
  const e = extra || {};
  const row = {
    v: 1,
    ts: new Date().toISOString(),
    event: e.event || 'unknown',
    requester: defaultRequester(ctx),
  };
  Object.assign(row, e);
  if (!row.requester) row.requester = defaultRequester(ctx);
  if (!row.ts) row.ts = new Date().toISOString();
  if (row.backend && ctx.accounts && ctx.accounts[row.backend]) row.account = ctx.accounts[row.backend].label;
  return redact.value(row);
}

function defaultRequester(ctx) {
  const c = ctx || {};
  return {
    host: c.host || null,
    client_claimed: clientLabel(c.clientInfo),
    server_pid: c.serverPid || c.runnerPid || process.pid,
    council_version: c.version || null,
  };
}

function clientLabel(info) {
  if (!info || typeof info !== 'object') return null;
  const s = [info.name, info.version].filter(Boolean).join('/');
  return s || null;
}

/**
 * Append one row to `council-YYYY-MM.jsonl`. Never throws: a failure is appended to
 * ledger-errors.log and reported as `false` (SPEC §10, "a ledger fault never fails a call").
 * @param {Object} ctx @param {Object} row
 * @returns {boolean}
 */
function append(ctx, row) {
  const P = ctx && ctx.paths;
  if ((ctx.mode && ctx.mode !== 'normal') || !P || !P.ledgerDir) return false;
  let line = null;
  try {
    try { fs.mkdirSync(P.ledgerDir, { recursive: true }); } catch { /* exists, or unwritable */ }
    line = toLine(row);
    if (jobstore.appendLine(P.ledgerFileFor(new Date()), line)) return true;
    noteFailure(P, 'appendLine returned false', line);
    return false;
  } catch (e) {
    noteFailure(P, String((e && e.message) || e), line);
    return false;
  }
}

function noteFailure(P, reason, line) {
  try {
    jobstore.appendLine(P.ledgerErrors, new Date().toISOString()
      + ' ledger append failed: ' + reason + ' :: ' + String(line || '').slice(0, 400));
  } catch { /* the ledger must never fail a call */ }
}

/**
 * Serialise a row so it always stays ONE parseable <=8 KB line: long strings are clipped,
 * then fat keys are dropped in a fixed order, and only as a last resort the row collapses
 * to a minimal identifying row. Every reduction is recorded in `truncated`, so a shrunken
 * row is visibly shrunken instead of quietly wrong.
 * @param {Object} row @returns {string}
 */
function toLine(row) {
  row = redact.value(row);
  let obj = row && typeof row === 'object' ? row : { v: 1, event: 'unknown', value: String(row) };
  let s = safeStringify(obj);
  if (Buffer.byteLength(s, 'utf8') <= LINE_MAX) return s;

  obj = JSON.parse(safeStringify(obj));
  const dropped = [];
  for (const k of Object.keys(obj)) {
    if (typeof obj[k] === 'string' && obj[k].length > 400) {
      obj[k] = obj[k].slice(0, 400) + '...';
      dropped.push(k + ':clipped');
    }
  }
  obj.truncated = dropped.slice();
  s = safeStringify(obj);
  if (Buffer.byteLength(s, 'utf8') <= LINE_MAX) return s;

  for (const k of SHRINK_KEYS) {
    if (!(k in obj)) continue;
    delete obj[k];
    dropped.push(k + ':dropped');
    obj.truncated = dropped.slice();
    s = safeStringify(obj);
    if (Buffer.byteLength(s, 'utf8') <= LINE_MAX) return s;
  }

  return safeStringify({
    v: 1, ts: obj.ts, event: obj.event,
    job_id: obj.job_id || null, leg_id: obj.leg_id || null,
    backend: obj.backend || null, outcome: obj.outcome || null,
    requester: obj.requester || null,
    truncated: dropped.concat(['row:collapsed']),
  });
}

function safeStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch (e) {
    return JSON.stringify({ v: 1, event: 'unserialisable', reason: String((e && e.message) || e) });
  }
}

/* ---------------- reading -- */

/**
 * Read rows whose `ts` falls inside [sinceMs, untilMs] from the month files spanning it.
 * Unparseable lines are skipped and counted, never repaired (SPEC §3).
 * @param {Object} ctx @param {{sinceMs?:number, untilMs?:number, files?:string[]}} opts
 * @returns {{rows:Object[], unparseable:number, files:string[]}}
 */
function readRows(ctx, opts) {
  const o = opts || {};
  const out = { rows: [], unparseable: 0, files: [] };
  const P = ctx && ctx.paths;
  if ((ctx.mode && ctx.mode !== 'normal') || !P || !P.ledgerDir) return out;
  const until = Number.isFinite(Number(o.untilMs)) ? Number(o.untilMs) : Date.now();
  const since = Number.isFinite(Number(o.sinceMs)) ? Number(o.sinceMs) : until - WINDOW_MS.day;
  const files = o.files || monthFiles(P, since, until);

  for (const file of files) {
    if (!jobstore.exists(file)) continue;
    out.files.push(file);
    for (const line of readBoundedLines(file)) {
      let row = null;
      try { row = JSON.parse(line); } catch { out.unparseable++; continue; }
      if (!row || typeof row !== 'object') { out.unparseable++; continue; }
      const ms = Date.parse(row.ts);
      if (!Number.isFinite(ms) || ms < since || ms > until) continue;
      out.rows.push(row);
    }
  }
  out.rows.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return out;
}

/** Month files (council-YYYY-MM.jsonl) covering the window, oldest first. */
function monthFiles(P, sinceMs, untilMs) {
  const files = [];
  const start = new Date(sinceMs);
  const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  for (let i = 0; i < 240 && cur.getTime() <= untilMs; i++) {
    files.push(P.ledgerFileFor(new Date(cur.getTime())));
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  if (!files.length) files.push(P.ledgerFileFor(new Date(untilMs)));
  return files;
}

/** Non-empty lines of a file, reading at most READ_CAP_BYTES from its tail. */
function readBoundedLines(file) {
  const size = jobstore.sizeOf(file);
  let text;
  if (size > READ_CAP_BYTES) {
    text = jobstore.readTail(file, READ_CAP_BYTES);
    const nl = text.indexOf('\n');
    text = nl === -1 ? '' : text.slice(nl + 1); // drop the partial first line
  } else {
    try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  }
  return text.split('\n').map((s) => s.trim()).filter(Boolean);
}

/* ---------------- tokens -- */

/**
 * The ONE normative implementation of SPEC §6.1 / §10. Every adapter calls it; nobody
 * computes these two numbers by hand.
 *   total_input_tokens    = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
 *   overhead_input_tokens = total_input_tokens - ceil(prompt_chars / 3.7)
 * Missing fields count as 0. The codex spelling `cached_input_tokens` and the agy spelling
 * `cache_read_tokens` are SUBSETS of their own `input_tokens` (verified 2026-09-07: a codex
 * rollout reports input 16223 / cached 12160 / total_tokens 16228 = input + output, and an
 * agy result reports input 22963 / total 23027 = input + output), so they are accepted only
 * as a fallback when `input_tokens` is absent — adding them would double count.
 * @param {Object|null} usage @param {number} promptChars
 * @returns {{total_input_tokens:number, overhead_input_tokens:number}}
 */
function tokenTotals(usage, promptChars) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const input = num(u.input_tokens);
  const created = num(u.cache_creation_input_tokens);
  const read = num(u.cache_read_input_tokens);
  let total = input + created + read;
  if (!input) total += num(u.cached_input_tokens) + num(u.cache_read_tokens);
  return {
    total_input_tokens: total,
    overhead_input_tokens: total - Math.ceil(num(promptChars) / 3.7),
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/* ---------------- health -- */

/**
 * council_doctor.ledger (SPEC §5.7).
 * @param {Object} ctx
 * @returns {{path:string|null, writable:boolean, last_rows_parseable:boolean,
 *            error_log_bytes:number, rows_24h:number}}
 */
function health(ctx) {
  const P = ctx && ctx.paths;
  if (!P || !P.ledgerDir) {
    return { path: null, writable: false, last_rows_parseable: false, error_log_bytes: 0, rows_24h: 0 };
  }
  const file = P.ledgerFileFor(new Date());
  const out = {
    path: file,
    writable: isWritable(P.ledgerDir),
    last_rows_parseable: true,
    error_log_bytes: jobstore.sizeOf(P.ledgerErrors),
    rows_24h: 0,
  };
  const size = jobstore.sizeOf(file);
  if (size > 0) {
    const tail = jobstore.readTail(file, 64 * 1024);
    let lines = tail.split('\n').map((s) => s.trim()).filter(Boolean);
    if (size > 64 * 1024) lines = lines.slice(1); // the first line may be a fragment
    for (const line of lines.slice(-20)) {
      try { JSON.parse(line); } catch { out.last_rows_parseable = false; }
    }
  }
  try { out.rows_24h = readRows(ctx, { sinceMs: Date.now() - WINDOW_MS.day }).rows.length; } catch { out.rows_24h = 0; }
  return out;
}

function isWritable(dir) {
  try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; }
}

/* ---------------- report -- */

/**
 * The data behind council_ledger (SPEC §5.8). Rendering belongs to lib/render.js.
 * @param {Object} ctx
 * @param {{window?:string, group_by?:string, include_refusals?:boolean, plan_usage?:Object}} opts
 * @returns {Object} LedgerReport (INTERFACES §4.2)
 */
function report(ctx, opts) {
  const o = opts || {};
  const window = WINDOW_MS[o.window] ? o.window : 'day';
  const groupBy = GROUP_BY.indexOf(o.group_by) !== -1 ? o.group_by : 'account';
  const now = Date.now();
  const since = now - WINDOW_MS[window];
  const read = readRows(ctx, { sinceMs: since, untilMs: now });
  const finished = read.rows.filter((r) => r.event === 'job_finished');

  return {
    window,
    from: new Date(since).toISOString(),
    to: new Date(now).toISOString(),
    group_by: groupBy,
    groups: aggregate(finished, groupBy),
    by_host: aggregate(finished, 'host'),
    top_wall: topWall(finished),
    refusals: o.include_refusals === false ? [] : countRefusals(read.rows),
    quota_snapshot: newestQuota(ctx, read.rows, since, now),
    plan_usage_inferred: o.plan_usage || null,
    unparseable: read.unparseable,
    legs: finished.length,
    rows_scanned: read.rows.length,
    files: read.files,
    footer: FOOTER,
  };
}

/** One aggregation bucket per distinct key, biggest wall time first. */
function aggregate(rows, groupBy) {
  const map = new Map();
  for (const r of rows) {
    const key = groupKey(r, groupBy);
    let g = map.get(key);
    if (!g) {
      g = { key, legs: 0, wall_ms: 0, est_cost_usd: 0, total_input_tokens: 0, outcomes: {} };
      map.set(key, g);
    }
    g.legs++;
    g.wall_ms += num(r.wall_ms);
    g.est_cost_usd += Number.isFinite(Number(r.est_cost_usd)) ? Number(r.est_cost_usd) : 0;
    g.total_input_tokens += num(r.total_input_tokens);
    const outcome = r.outcome || 'unknown';
    g.outcomes[outcome] = (g.outcomes[outcome] || 0) + 1;
  }
  const out = Array.from(map.values());
  for (const g of out) g.est_cost_usd = Math.round(g.est_cost_usd * 10000) / 10000;
  out.sort((a, b) => b.wall_ms - a.wall_ms || b.legs - a.legs);
  return out;
}

function groupKey(row, groupBy) {
  if (groupBy === 'backend') return row.backend || 'unknown';
  if (groupBy === 'host') return (row.requester && row.requester.host) || 'unknown';
  if (groupBy === 'task_class') return row.task_class || 'unknown';
  return accountLabel(row);
}

/** `account` is written as an object by the runner and may be a bare label elsewhere. */
function accountLabel(row) {
  const a = row.account;
  if (typeof a === 'string' && a) return a;
  if (a && typeof a === 'object' && a.label) return a.label;
  return row.backend ? row.backend + ':unknown' : 'unknown';
}

function topWall(rows) {
  return rows
    .filter((r) => Number.isFinite(Number(r.wall_ms)))
    .sort((a, b) => Number(b.wall_ms) - Number(a.wall_ms))
    .slice(0, 5)
    .map((r) => ({
      job_id: r.job_id || null,
      backend: r.backend || null,
      wall_ms: Number(r.wall_ms),
      task_class: r.task_class || null,
      label: r.label || null,
    }));
}

function countRefusals(rows) {
  const map = new Map();
  for (const r of rows) {
    if (r.event !== 'refused') continue;
    const reason = r.refuse_reason || 'unknown';
    map.set(reason, (map.get(reason) || 0) + 1);
  }
  return Array.from(map.entries())
    .map((pair) => ({ reason: pair[0], n: pair[1] }))
    .sort((a, b) => b.n - a.n);
}

/**
 * The newest usable codex quota snapshot. A snapshot carrying `error` is never presented
 * as a reading (SPEC §10: a stale number shown as current is worse than no number). If the
 * report window holds none, look back 30 days — the age is always reported alongside.
 */
function newestQuota(ctx, windowRows, sinceMs, nowMs) {
  let row = pickQuotaRow(windowRows);
  if (!row && nowMs - sinceMs < WINDOW_MS.month) {
    try {
      row = pickQuotaRow(readRows(ctx, { sinceMs: nowMs - WINDOW_MS.month, untilMs: nowMs }).rows);
    } catch { row = null; }
  }
  if (!row) return null;
  const q = row.quota;
  const rowMs = Date.parse(row.ts);
  return {
    used_percent: q.used_percent == null ? null : Number(q.used_percent),
    window_minutes: q.window_minutes == null ? null : Number(q.window_minutes),
    resets_at: q.resets_at == null ? null : q.resets_at,
    resets_at_iso: q.resets_at_iso || null,
    plan_type: q.plan_type || null,
    cli_version: q.cli_version || null,
    age_minutes: Number.isFinite(rowMs) ? Math.round((nowMs - rowMs) / 60000) : null,
    stale_minutes: q.stale_minutes == null ? null : Number(q.stale_minutes),
    source_file: q.source_file || null,
    taken_at: row.ts || null,
  };
}

function pickQuotaRow(rows) {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.event !== 'quota_snapshot') continue;
    const q = r.quota;
    if (!q || typeof q !== 'object' || q.error) continue;
    if (q.used_percent == null) continue;
    return r;
  }
  return null;
}

module.exports = {
  LINE_MAX, FOOTER, WINDOW_MS, GROUP_BY,
  baseRow, append, readRows, tokenTotals, health, report,
  toLine, monthFiles,
};
