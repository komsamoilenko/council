// Owns rpc.js runtime behavior; port specification §§2–6.
'use strict';
/**
 * lib/rpc.js — the JSON-RPC stdio loop and everything in SPEC §4 that is not tool logic:
 * protocolVersion negotiation, stdout discipline (raw writer captured once, console.*
 * and process.stdout.write pushed to stderr), a bounded send queue, notifications/cancelled
 * routing into the inflight map, and the protocol-fault error mapping (-32601/-32602/-32603).
 * Tool semantics live in server.js; this file never touches a job directory.
 */

const readline = require('readline');

const CODES = { PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603 };
const SEND_QUEUE_MAX = 64;
const FALLBACK_PROTOCOL = '2025-06-18';

class RpcError extends Error {
  /** @param {number} code @param {string} message @param {*} [data] */
  constructor(code, message, data) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

/** @param {string} m @param {*} [d] */
const invalidParams = (m, d) => new RpcError(CODES.INVALID_PARAMS, m, d);
/** @param {string} m @param {*} [d] */
const methodNotFound = (m, d) => new RpcError(CODES.METHOD_NOT_FOUND, m, d);

/**
 * @typedef {Object} CallCtx
 * @property {string|number} requestId
 * @property {{name?:string,version?:string}|null} clientInfo
 * @property {function(string, string=):void} setKind  record {kind, job_id} in the inflight map
 * @property {function():boolean} isCancelled
 * @property {function(function():void):void} onCancel  register a cancellation callback
 * @property {function(string):void} log
 */

/**
 * @param {Object} opts
 * @param {{name:string, version:string}} opts.serverInfo
 * @param {string[]} opts.protocolVersions           accepted list; anything else -> 2025-06-18
 * @param {function():Array<Object>} opts.listTools
 * @param {function(string, Object, CallCtx):Promise<Object>} opts.callTool  resolves an MCP tool result
 * @param {function(Object):void} [opts.onInitialize] receives the initialize params
 * @param {function(string|number, *):void} [opts.onCancelled]
 * @param {function(Error, string):void} [opts.onCrash]
 * @param {function(string):void} [opts.log]
 * @returns {Object} connection
 */
function createConnection(opts) {
  const log = opts.log || ((m) => { try { process.stderr.write(String(m) + '\n'); } catch {} });

  /* ---- stdout discipline: capture the raw writer once, then close the door ---- */
  const rawWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = function blocked(chunk, enc, cb) {
    try { log('[stdout-blocked] ' + String(chunk).slice(0, 300)); } catch {}
    const done = typeof enc === 'function' ? enc : cb;
    if (typeof done === 'function') done();
    return true;
  };
  const toStderr = (...a) => log(a.map((x) => (typeof x === 'string' ? x : safeJson(x))).join(' '));
  console.log = toStderr; console.info = toStderr; console.warn = toStderr;
  console.debug = toStderr; console.error = toStderr; console.trace = toStderr;

  /* ---------------------------- bounded send queue --------------------------- */
  const queue = [];
  let draining = false;
  let dropped = 0;

  function enqueue(frame) {
    if (queue.length >= SEND_QUEUE_MAX) {
      dropped++;
      log('[send-queue] full (' + SEND_QUEUE_MAX + '), dropped frame #' + dropped);
      return;
    }
    queue.push(JSON.stringify(require('./redact').value(frame)) + '\n');
    drain();
  }

  function drain() {
    if (draining) return;
    draining = true;
    while (queue.length) {
      const line = queue.shift();
      let ok = true;
      try { ok = rawWrite(line); } catch (e) { log('[send] write failed: ' + (e && e.message)); }
      if (!ok) {
        draining = false;
        process.stdout.once('drain', drain);
        return;
      }
    }
    draining = false;
  }

  /* ------------------------------ inflight map ------------------------------- */
  /** @type {Map<string|number, {kind:string, job_id:string|null, cancelled:boolean, hooks:Array<function():void>}>} */
  const inflight = new Map();

  const state = {
    initialized: false,
    protocolVersion: FALLBACK_PROTOCOL,
    clientInfo: null,
    counts: { requests: 0, errors: 0, dropped: 0 },
  };

  function reply(id, result) {
    const rec = inflight.get(id);
    if (rec && rec.cancelled) { log('[cancelled] suppressing response for id ' + id); return; }
    enqueue({ jsonrpc: '2.0', id, result });
  }

  function replyError(id, code, message, data) {
    const rec = inflight.get(id);
    if (rec && rec.cancelled) { log('[cancelled] suppressing error for id ' + id); return; }
    state.counts.errors++;
    const err = { code, message: String(message) };
    if (data !== undefined) err.data = data;
    enqueue({ jsonrpc: '2.0', id, error: err });
  }

  /* ---------------- dispatch ---------------- */
  async function dispatch(msg) {
    const { id, method, params } = msg;
    const hasId = id !== undefined && id !== null;

    if (method === 'initialize') {
      const want = params && params.protocolVersion;
      const accepted = Array.isArray(opts.protocolVersions) ? opts.protocolVersions : [FALLBACK_PROTOCOL];
      if (want && !accepted.includes(want)) log('[initialize] unknown protocolVersion ' + JSON.stringify(want) + ' -> ' + FALLBACK_PROTOCOL);
      state.protocolVersion = (want && accepted.includes(want)) ? want : FALLBACK_PROTOCOL;
      state.clientInfo = (params && params.clientInfo) || null;
      log('[initialize] clientInfo=' + safeJson(state.clientInfo) + ' protocol=' + state.protocolVersion);
      if (opts.onInitialize) { try { opts.onInitialize(params || {}); } catch (e) { log('[initialize] hook: ' + e.message); } }
      state.initialized = true;
      return reply(id, {
        protocolVersion: state.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: opts.serverInfo,
      });
    }

    if (method === 'notifications' + '/initialized' || method === 'notifications' + '/roots/list_changed') return;

    if (method === 'notifications' + '/cancelled') {
      const rid = params && params.requestId;
      const rec = inflight.get(rid);
      log('[cancelled] requestId=' + rid + ' known=' + !!rec + ' reason=' + ((params && params.reason) || ''));
      if (rec) {
        rec.cancelled = true;
        for (const h of rec.hooks) { try { h(); } catch (e) { log('[cancelled] hook: ' + e.message); } }
      }
      if (opts.onCancelled) { try { opts.onCancelled(rid, rec || null); } catch (e) { log('[cancelled] handler: ' + e.message); } }
      return;
    }

    if (method === 'ping') return reply(id, {});

    if (method === 'tools/list') {
      let tools = [];
      try { tools = opts.listTools(); } catch (e) { return replyError(id, CODES.INTERNAL, e.message); }
      return reply(id, { tools });
    }

    if (method === 'tools/call') {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      if (typeof name !== 'string') return replyError(id, CODES.INVALID_PARAMS, 'tools/call requires params.name');
      const rec = { kind: name, job_id: null, cancelled: false, hooks: [] };
      inflight.set(id, rec);
      state.counts.requests++;
      /** @type {CallCtx} */
      const ctx = {
        requestId: id,
        clientInfo: state.clientInfo,
        setKind(kind, jobId) { rec.kind = kind; if (jobId) rec.job_id = jobId; },
        isCancelled() { return rec.cancelled; },
        onCancel(fn) { rec.hooks.push(fn); if (rec.cancelled) { try { fn(); } catch {} } },
        log,
      };
      try {
        const result = await opts.callTool(name, args, ctx);
        reply(id, result);
      } catch (e) {
        if (e instanceof RpcError) replyError(id, e.code, e.message, e.data);
        else { log('[tools/call] internal: ' + (e && e.stack || e)); replyError(id, CODES.INTERNAL, String(e && e.message || e)); }
      } finally {
        inflight.delete(id);
      }
      return;
    }

    if (!hasId) { log('[drop] id-less notification: ' + method); return; }
    return replyError(id, CODES.METHOD_NOT_FOUND, 'Method not found: ' + method);
  }

  /* ---------------- lifecycle ---------------- */
  let rl = null;

  function start() {
    process.on('uncaughtException', (e) => {
      log('[uncaughtException] ' + (e && e.stack || e));
      if (opts.onCrash) { try { opts.onCrash(e, 'uncaughtException'); } catch {} }
    });
    process.on('unhandledRejection', (e) => {
      log('[unhandledRejection] ' + (e && e.stack || e));
      if (opts.onCrash) { try { opts.onCrash(e instanceof Error ? e : new Error(String(e)), 'unhandledRejection'); } catch {} }
    });
    rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const s = String(line).trim();
      if (!s) return;
      let msg;
      try { msg = JSON.parse(s); } catch { log('[parse] dropping unparsable line (' + s.length + ' bytes)'); return; }
      if (!msg || typeof msg !== 'object') return;
      Promise.resolve()
        .then(() => dispatch(msg))
        .catch((e) => {
          log('[dispatch] ' + (e && e.stack || e));
          if (msg.id !== undefined && msg.id !== null) replyError(msg.id, CODES.INTERNAL, String(e && e.message || e));
        });
    });
    // stdin closed = the host is gone. Tell the server so it can exit instead of idling
    // (or, before this hook existed, looping on EPIPE while logging that the host left).
    rl.on('close', () => {
      log('[stdin] closed');
      if (opts.onStdinClose) { try { opts.onStdinClose(); } catch {} }
    });
    return connection;
  }

  function stop() { if (rl) { try { rl.close(); } catch {} rl = null; } }

  const connection = {
    CODES, RpcError,
    start, stop,
    inflight,
    state,
    /** Send a server-initiated notification (unused in iteration 1; §18 forbids progress). */
    notify(method, params) { enqueue({ jsonrpc: '2.0', method, params }); },
    stats() { return { queued: queue.length, dropped, inflight: inflight.size, counts: state.counts }; },
    get clientInfo() { return state.clientInfo; },
    get protocolVersion() { return state.protocolVersion; },
  };
  return connection;
}

function safeJson(v) { try { return JSON.stringify(v); } catch { return String(v); } }

module.exports = { createConnection, RpcError, CODES, invalidParams, methodNotFound, FALLBACK_PROTOCOL, SEND_QUEUE_MAX };
