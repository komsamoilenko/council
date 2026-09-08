// Owns router.js runtime behavior; port specification §§2–6.
'use strict';
/**
 * lib/router.js -- SPEC section 7 (router). Pure: no I/O, no model call, never throws.
 * Owns the class table (default backends, per-backend model + effort, the claude --tools
 * string, timeout and budget), the ordered regex rules and their stable `matched_rule`
 * labels, the per-backend effort clamps, and every pre-spawn routing refusal:
 * same_vendor, judge / self_judge / judge_needs_markers, round_cap, and the
 * claude_session_not_persisted case of continue_from.
 * Returns the Plan of INTERFACES 4.3; refusals are returned as data in `plan.refuse`.
 */

/** Rules are matched over the first 2,000 chars of the prompt (SPEC section 7). */
const MATCH_CHARS = 2000;

/** backend -> vendor, for the same_vendor rule. `echo` is its own vendor and exempt. */
const VENDORS = { claude: 'anthropic', codex: 'openai', gemini: 'google', echo: 'echo' };

/** The judge always runs claude with this model alias (SPEC section 7). */
const JUDGE_MODEL_ALIAS = 'fable';

/**
 * The only shape a vendor session id may have before it is allowed anywhere near a leaf
 * command line. All three vendors issue a plain UUID (claude session_id, codex
 * thread_id, agy conversation_id — the last verified live on 2026-09-07), and `codex
 * exec resume <SESSION_ID>` is a clap POSITIONAL, so a token that begins with `-` IS a
 * flag. The id is read out of the parent job's result.json, which every host can rewrite
 * through the vault filesystem MCP server, so it is untrusted input (SPEC section 5:
 * "every string re-validated in code") and each adapter re-checks it before pushing it.
 */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @param {*} v @returns {boolean} */
function isSessionId(v) { return typeof v === 'string' && SESSION_ID_RE.test(v); }

/* ---------------- classes -- */

/**
 * The SPEC section 7 table, verbatim. `claude.model` is an alias key resolved through
 * config.models.claude; codex/gemini models come from config.models. `tools` is the
 * claude --tools value ("" means no tools).
 */
const CLASSES = {
  quick: {
    backends: ['codex'],
    claude: { model: 'sonnet', effort: 'low' }, codex: { effort: 'low' }, gemini: { effort: 'low' },
    tools: '', timeout_s: 180, budget_usd: 0.20,
  },
  writing: {
    backends: ['claude'],
    claude: { model: 'sonnet', effort: 'medium' }, codex: { effort: 'medium' }, gemini: { effort: 'medium' },
    tools: '', timeout_s: 600, budget_usd: 0.60,
  },
  code_review: {
    backends: ['claude', 'codex'],
    claude: { model: 'opus', effort: 'high' }, codex: { effort: 'xhigh' }, gemini: { effort: 'high' },
    tools: 'Read,Grep,Glob', timeout_s: 900, budget_usd: 1.50,
  },
  architecture: {
    backends: ['claude', 'codex'],
    claude: { model: 'opus', effort: 'high' }, codex: { effort: 'xhigh' }, gemini: { effort: 'high' },
    tools: 'Read,Grep,Glob', timeout_s: 900, budget_usd: 1.50,
    // SPEC section 7 says "+ gemini if enabled". The router may not touch the disk, so the
    // gate is read by the caller: ctx.geminiEnabled === true adds the third leg.
    gemini_when_enabled: true,
  },
  research: {
    backends: ['codex', 'claude'],
    claude: { model: 'opus', effort: 'high' }, codex: { effort: 'high' }, gemini: { effort: 'high' },
    tools: 'Read,Grep,Glob', timeout_s: 1200, budget_usd: 1.50,
  },
  verify: {
    backends: ['codex'],
    claude: { model: 'fable', effort: 'high' }, codex: { effort: 'high' }, gemini: { effort: 'high' },
    tools: 'Read,Grep,Glob', timeout_s: 600, budget_usd: 0.80,
  },
  judge: {
    backends: ['claude', 'claude'],
    claude: { model: JUDGE_MODEL_ALIAS, effort: 'high' }, codex: { effort: 'high' }, gemini: { effort: 'high' },
    tools: '', timeout_s: 600, budget_usd: 1.00,
  },
  general: {
    backends: ['claude'],
    claude: { model: 'opus', effort: 'medium' }, codex: { effort: 'medium' }, gemini: { effort: 'medium' },
    tools: '', timeout_s: 900, budget_usd: 1.00,
  },
};

/* ---------------- rules -- */

// Russian triggers (SPEC section 7), written as \u escapes so this file stays pure ASCII
// on disk and cannot be broken by a re-save in a non-UTF-8 code page.
const RU = {
  chto: '\u0447\u0442\u043e',                                                          // "chto"  = what
  gde: '\u0433\u0434\u0435',                                                           // "gde"   = where
  kakoy: '\u043a\u0430\u043a(?:\u043e\u0439|\u0430\u044f|\u043e\u0435|\u0438\u0435)',  // "kakoy" = which
  napishi: '\u043d\u0430\u043f\u0438\u0448\u0438',                                     // "napishi"   = write
  perepishi: '\u043f\u0435\u0440\u0435\u043f\u0438\u0448\u0438',                       // "perepishi" = rewrite
  revyu: '\u0440\u0435\u0432\u044c\u044e',                                             // "revyu"     = review
  stoitLi: '\u0441\u0442\u043e\u0438\u0442 \u043b\u0438',                              // "stoit li"  = should we
  naydiIstochniki: '\u043d\u0430\u0439\u0434\u0438 \u0438\u0441\u0442\u043e\u0447\u043d\u0438\u043a\u0438', // "naydi istochniki" = find sources
  sravni: '\u0441\u0440\u0430\u0432\u043d\u0438',                                      // "sravni" = compare
  prover: '\u043f\u0440\u043e\u0432\u0435\u0440(?:\u044c|\u0438\u0442\u044c)',          // "prover'" / "proverit'" = verify
};

/** Unicode-aware word boundary: no letter or digit on either side (works for Cyrillic). */
function w(term) { return '(?<![\\p{L}\\p{N}])(?:' + term + ')(?![\\p{L}\\p{N}])'; }

/** @param {string[]} terms @returns {RegExp} case-insensitive alternation of `terms` */
function anyOf(terms) { return new RegExp(terms.map(w).join('|'), 'iu'); }

const QUICK_START_RE = new RegExp(
  '^\\s*(?:what|where|which|does|is|' + RU.chto + '|' + RU.gde + '|' + RU.kakoy + ')(?![\\p{L}\\p{N}])', 'iu');
const WRITING_RE = anyOf(['draft', 'write', 'rewrite', 'translate', 'summari[sz]e', 'email', RU.napishi, RU.perepishi]);
const CODE_KW_RE = new RegExp(
  [w('review'), w('refactor'), w('bug'), w('fails?'), w(RU.revyu), 'stack trace', 'Error:'].join('|'), 'iu');
const DIFF_RE = /^(?:diff --git |@@ -\d|\+\+\+ |--- )/m;
const FENCE_RE = /^```[a-z0-9_+-]*\r?\n([\s\S]*?)^```/im;
const ARCH_RE = anyOf(['should we', 'trade-?offs?', 'design', 'choose between', 'migrate', 'architect(?:ure|s)?', RU.stoitLi]);
const RESEARCH_RE = anyOf(['research', 'sources', 'is it true', 'find out whether', 'survey', RU.naydiIstochniki, RU.sravni]);
const VERIFY_RE = anyOf(['verify', 'confirm that', 'check whether', RU.prover]);
const JUDGE_MARKER_RE = /<<<A>>>[\s\S]*<<<B>>>/;
const JUDGE_KW_RE = anyOf(['judge', 'verdict', 'which answer']);
const FENCE_TOKEN = '`' + '`' + '`';

/** @param {string} text @returns {number} lines inside the first fenced block, 0 if none */
function fencedLines(text) {
  const m = FENCE_RE.exec(text);
  if (!m) return 0;
  return m[1].split('\n').length;
}

/**
 * The ordered rules, in SPEC section 7 table order. `label` is the stable `matched_rule`
 * value the ledger groups by; it never changes shape once shipped.
 */
const RULES = [
  {
    class: 'quick', label: 'kw:what|where|which|short', re: QUICK_START_RE,
    why: 'short interrogative prompt (<=240 chars, no code fence)',
    test: (t) => t.length <= 240 && t.indexOf(FENCE_TOKEN) === -1 && QUICK_START_RE.test(t),
  },
  {
    class: 'writing', label: 'kw:write|draft|translate', re: WRITING_RE,
    why: 'asks for text to be drafted, rewritten or translated',
    test: (t) => WRITING_RE.test(t),
  },
  {
    class: 'code_review', label: 'kw:review|bug|diff|fence', re: CODE_KW_RE,
    why: 'code fence of 10+ lines, diff markers, or review/bug wording',
    test: (t) => fencedLines(t) >= 10 || DIFF_RE.test(t) || CODE_KW_RE.test(t),
  },
  {
    class: 'architecture', label: 'kw:should-we|tradeoff', re: ARCH_RE,
    why: 'a design or trade-off decision',
    test: (t) => ARCH_RE.test(t),
  },
  {
    class: 'research', label: 'kw:research|sources|survey', re: RESEARCH_RE,
    why: 'asks for sources, a survey or a comparison',
    test: (t) => RESEARCH_RE.test(t),
  },
  {
    class: 'verify', label: 'kw:verify|confirm|check', re: VERIFY_RE,
    why: 'asks to verify a checkable claim',
    // "+ a checkable claim": the trigger alone is not enough, a claim must follow it.
    test: (t) => VERIFY_RE.test(t) && t.trim().length >= 20,
  },
  {
    class: 'judge', label: 'kw:judge|verdict|markers', re: JUDGE_KW_RE,
    why: 'A/B markers or judge/verdict wording',
    test: (t) => JUDGE_MARKER_RE.test(t) || JUDGE_KW_RE.test(t),
  },
];

/* ---------------- helpers -- */

/** @param {*} v @returns {number|null} */
function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

/** @param {Object} cfg @param {string} alias @returns {string} claude alias -> config value */
function claudeModel(cfg, alias) {
  const m = (cfg && cfg.models && cfg.models.claude) || {};
  return m[alias] || alias;
}

/** @param {Object} cfg @param {string} backend @param {Object} spec @returns {string|null} */
function defaultModel(cfg, backend, spec) {
  if (backend === 'claude') return claudeModel(cfg, spec.claude.model);
  if (backend === 'codex') return (cfg && cfg.models && cfg.models.codex) || 'gpt-6-astra';
  if (backend === 'gemini') { if ((cfg.gemini || {}).provider !== 'agy') return (cfg.gemini || {}).model || 'gemini-3-pro'; const g = cfg && cfg.models ? cfg.models.gemini : null; return g == null ? null : g; }
  return null; // echo has no model
}

/** @param {Object} spec @param {string} backend @returns {string} the class default effort */
function defaultEffort(spec, backend) {
  if (backend === 'claude') return spec.claude.effort;
  if (backend === 'codex') return spec.codex.effort;
  if (backend === 'gemini') return spec.gemini.effort;
  return 'low'; // echo
}

/**
 * SPEC section 7 clamps: gemini xhigh/max -> high, codex max -> xhigh.
 * @param {string} backend @param {string} effort
 * @returns {{effort:string|null, effort_clamped_from:string|null}}
 */
function clampEffort(backend, effort) {
  const e = String(effort || '').toLowerCase();
  if (!e) return { effort: null, effort_clamped_from: null };
  if (backend === 'gemini' && (e === 'xhigh' || e === 'max')) return { effort: 'high', effort_clamped_from: e };
  if (backend === 'codex' && e === 'max') return { effort: 'xhigh', effort_clamped_from: e };
  return { effort: e, effort_clamped_from: null };
}

/** Caller values may only LOWER the class value; the fuse hard cap wins over both. */
function lowerOnly(classValue, callerValue, hardCap) {
  let v = classValue;
  const c = num(callerValue);
  if (c != null && c > 0 && c < v) v = c;
  return Math.min(v, hardCap);
}

/** @param {Object} plan @param {Object} refuse @returns {Object} the plan, refused */
function refusePlan(plan, refuse) {
  plan.refuse = { reason: refuse.reason, detail: refuse.detail || null, extra: refuse.extra || null };
  plan.legs = [];
  return plan;
}

/* ---------------- classify -- */

/**
 * Precedence: caller task_class -> ordered rules over the first 2,000 chars -> general.
 * @param {string} head @param {*} callerClass
 * @returns {{task_class:string, matched_rule:string, source:string, why:string}}
 */
function classify(head, callerClass) {
  if (callerClass && Object.prototype.hasOwnProperty.call(CLASSES, callerClass)) {
    return {
      task_class: callerClass, matched_rule: 'caller:' + callerClass,
      source: 'caller', why: 'the caller named the task class',
    };
  }
  for (const rule of RULES) {
    let hit = false;
    try { hit = rule.test(head); } catch { hit = false; }
    if (hit) return { task_class: rule.class, matched_rule: rule.label, source: 'router', why: rule.why };
  }
  return {
    task_class: 'general', matched_rule: 'default:general',
    source: 'default', why: 'no rule matched the first ' + MATCH_CHARS + ' chars',
  };
}

/* ---------------- judge -- */

const JUDGE_HEADER_FORMAT = 'participants: claude/<model>, codex/<model>';
const PARTICIPANT_RE = /^([a-z][a-z0-9_-]*)(?:\/([a-z0-9][a-z0-9._-]*))?$/i;
const HEADER_RE = /(?:^|\n)[ \t]*participants[ \t]*:[ \t]*([^\n]+)/i;

/**
 * Parse the mandatory judge header (SPEC section 7). Model-level, not vendor-level:
 * self_judge only when an entry names the judge's own model.
 * @param {string} head @param {string} judgeModel the resolved alias the judge runs
 * @returns {{judge:Object}|{refuse:Object}}
 */
function parseParticipants(head, judgeModel) {
  const m = HEADER_RE.exec(head);
  if (!m) {
    return {
      refuse: {
        reason: 'judge_needs_markers',
        detail: 'a judge prompt needs a header line, exactly: ' + JUDGE_HEADER_FORMAT,
      },
    };
  }
  const raw = m[1].split(',').map((s) => s.trim()).filter(Boolean);
  const participants = [];
  for (const entry of raw) {
    const pm = PARTICIPANT_RE.exec(entry);
    if (!pm) {
      return {
        refuse: {
          reason: 'judge_needs_markers',
          detail: 'unparsable participant "' + entry.slice(0, 40) + '"; the header must read exactly: ' + JUDGE_HEADER_FORMAT,
        },
      };
    }
    if (pm[2]) participants.push({ vendor: pm[1].toLowerCase(), model: pm[2].toLowerCase() });
    else participants.push({ vendor: null, model: pm[1].toLowerCase() });
  }
  if (participants.length < 2) {
    return {
      refuse: {
        reason: 'judge_needs_markers',
        detail: 'a judge needs at least two participants; the header must read exactly: ' + JUDGE_HEADER_FORMAT,
      },
    };
  }
  const jm = String(judgeModel || JUDGE_MODEL_ALIAS).toLowerCase();
  const self = participants.find((p) => (p.vendor === 'claude' || p.vendor === null)
    && (p.model === jm || p.model === JUDGE_MODEL_ALIAS));
  if (self) {
    return {
      refuse: {
        reason: 'self_judge',
        detail: 'the judge runs claude/' + jm + ' and a participant names the same model ('
          + (self.vendor ? self.vendor + '/' : '') + self.model + ')',
      },
    };
  }
  return {
    judge: {
      participants,
      judge_shares_vendor: participants.some((p) => p.vendor === 'claude'),
      orders: ['AB', 'BA'],
    },
  };
}

/* ---------------- backends -- */

/**
 * Caller backends win; otherwise the class defaults. stakes:"high" forces a cross-vendor
 * pair for any class (SPEC section 7).
 * @returns {{backends:string[]}|{refuse:Object}}
 */
function chooseBackends(ctx, taskClass, inp) {
  if (taskClass === 'judge') return { backends: ['claude', 'claude'] };
  const spec = CLASSES[taskClass];
  const callerGave = Array.isArray(inp.backends) && inp.backends.length > 0;
  const parentLegs = inp.parent && inp.parent.request && Array.isArray(inp.parent.request.legs)
    ? inp.parent.request.legs.map((l) => l && l.backend).filter(Boolean) : [];
  let list;
  if (callerGave) list = inp.backends.slice(0, 3).map((b) => String(b));
  // continue_from resumes EVERY leg of the parent job (SPEC 5.1), so the parent's
  // backends win over the class defaults when the caller named none.
  else if (parentLegs.length) list = parentLegs.slice(0, 3);
  else list = spec.backends.slice();
  for (const b of list) {
    if (!Object.prototype.hasOwnProperty.call(VENDORS, b)) {
      return { refuse: { reason: 'backend_unavailable', detail: 'unknown backend: ' + b.slice(0, 40) } };
    }
  }
  if (!callerGave && !parentLegs.length && spec.gemini_when_enabled && ctx && ctx.geminiEnabled === true && list.length < 3) {
    list.push('gemini');
  }
  // stakes:"high" forces a cross-vendor PAIR — but council_ask exposes only a singular
  // `backend` and its description says "Ask one agent and wait", so silently adding a
  // second vendor there would bill a second account the caller never asked for. The
  // fan-out stays a council_start feature.
  if (inp.stakes === 'high' && inp.tool !== 'council_ask') list = forceCrossVendor(list);
  return { backends: list };
}

/** @param {string[]} list @returns {string[]} the same list, guaranteed cross-vendor */
function forceCrossVendor(list) {
  const real = list.filter((b) => b !== 'echo');
  if (real.length === 0) return list; // echo-only fan-outs stay as they are (zero quota)
  const vendors = new Set(real.map((b) => VENDORS[b]));
  if (vendors.size >= 2) return list;
  const partner = vendors.has('openai') ? 'claude' : 'codex';
  if (list.length < 3) return list.concat([partner]);
  return [list[0], partner];
}

/**
 * SPEC section 7: two legs of the same vendor are refused, except task_class "judge"
 * (not evaluated at all) and echo legs (exempt, so an echo-only fan-out is legal).
 * @returns {Object|null} a refusal, or null
 */
function sameVendorRefusal(taskClass, backends) {
  if (taskClass === 'judge') return null;
  const seen = new Map();
  for (const b of backends) {
    if (b === 'echo') continue;
    const v = VENDORS[b];
    seen.set(v, (seen.get(v) || 0) + 1);
  }
  for (const [vendor, n] of seen) {
    if (n > 1) {
      return {
        reason: 'same_vendor',
        detail: 'two legs share the vendor "' + vendor + '" (' + backends.join(', ')
          + '); use a cross-vendor pair such as ["claude","codex"], or task_class:"judge" for a deliberate A/B judge',
      };
    }
  }
  return null;
}

/* ---------------- legs -- */

/**
 * One LegPlan (INTERFACES 1.3) without leg_id / account / expected_image, which the
 * server fills in.
 */
function buildLeg(cfg, taskClass, backend, index, inp) {
  const spec = CLASSES[taskClass];
  const override = inp.model && typeof inp.model === 'object' ? inp.model[backend] : null;
  const wanted = inp.effort ? String(inp.effort).toLowerCase() : defaultEffort(spec, backend);
  const clamped = clampEffort(backend, wanted);
  return {
    backend,
    model: override || defaultModel(cfg, backend, spec),
    effort: clamped.effort,
    effort_clamped_from: clamped.effort_clamped_from,
    tools: backend === 'claude' ? spec.tools : null,
    // the quick class runs claude with --no-session-persistence, so it cannot be resumed
    resumable: backend === 'claude' ? taskClass !== 'quick' : backend !== 'echo',
    session_id: null,
    // Set by applyContinueFrom; surfaced on the start screen so a "round 2" that is
    // really a fresh session can never look like a continuation.
    resumed: false,
    judge_order: taskClass === 'judge' ? (index === 0 ? 'AB' : 'BA') : null,
  };
}

/* ---------------- rounds -- */

/**
 * round > 2 is refused unless force_round AND a non-empty reason buy exactly one extra
 * round; round 4 is never allowed (SPEC section 7).
 * @returns {Object|null} a refusal, or null
 */
function checkRound(inp) {
  const round = Number(inp.round) || 1;
  if (round <= 2) return null;
  const reason = typeof inp.reason === 'string' ? inp.reason.trim() : '';
  if (round === 3 && inp.force_round === true && reason) return null;
  if (round === 3 && inp.force_round === true && !reason) {
    return { reason: 'round_cap', detail: 'round 3 needs force_round:true AND a reason naming the specific check to run' };
  }
  return {
    reason: 'round_cap',
    detail: round > 3
      ? 'round ' + round + ' is never allowed; the debate cap is 2 rounds (3 with force_round and a reason)'
      : 'round 3 needs force_round:true and a reason; more argument is not a reason, a specific check is',
  };
}

/* ---------------- continue_from -- */

/**
 * Copy each leg's vendor session id from the parent job's LegRecord of the same backend.
 * A parent claude leg with resumable === false refuses before any spawn (SPEC 6.1, T-12c).
 * @returns {Object|null} a refusal, or null
 */
function applyContinueFrom(legs, inp) {
  const parent = inp.parent;
  if (!parent || !parent.request) return null;
  const recs = (parent.result && parent.result.legs) || (parent.error && parent.error.legs) || [];
  const used = new Set();
  const parentClass = (parent.request.router && parent.request.router.task_class) || 'unknown';
  const parentId = parent.request.job_id || inp.continue_from || null;
  for (const leg of legs) {
    const i = recs.findIndex((r, idx) => r && r.backend === leg.backend && !used.has(idx));
    if (i < 0) {
      // Nothing to resume for this backend. A leg that never claimed resumability (echo,
      // a quick claude leg) may legitimately run fresh; anything else would be presented
      // to the caller as "round 2" while carrying zero round-1 context, so it refuses.
      if (leg.resumable === false) continue;
      return noSessionRefusal(leg, parentId, parentClass, 'the parent job has no ' + leg.backend + ' leg record');
    }
    used.add(i);
    const rec = recs[i];
    if (leg.backend === 'claude' && rec.resumable === false) {
      return {
        reason: 'backend_unavailable',
        detail: 'claude_session_not_persisted',
        extra: {
          backend: 'claude',
          parent_job_id: parentId,
          parent_task_class: parentClass,
          note: 'job ' + parentId + ' ran task_class "' + parentClass
            + '", which spawns claude with --no-session-persistence; there is no session to resume',
        },
      };
    }
    const sid = rec.session_id || null;
    if (sid != null && !isSessionId(sid)) {
      // result.json is runner-written from vendor stdout and is rewritable from any host.
      // A malformed id would land verbatim on a leaf command line (codex takes it as a
      // POSITIONAL), so it is refused here and never reaches buildSpawn.
      return {
        reason: 'backend_unavailable',
        detail: 'session_id_malformed',
        extra: {
          backend: leg.backend,
          parent_job_id: parentId,
          note: 'the ' + leg.backend + ' leg of job ' + parentId
            + ' carries a session id that is not a UUID; it was not passed to the vendor CLI',
        },
      };
    }
    if (!sid && leg.resumable !== false) {
      return noSessionRefusal(leg, parentId, parentClass, 'that leg recorded no session id');
    }
    leg.session_id = sid;
    leg.resumed = !!sid;
  }
  return null;
}

/** The shared "there is nothing to resume" refusal (SPEC section 7 Debate / 5.1). */
function noSessionRefusal(leg, parentId, parentClass, why) {
  return {
    reason: 'backend_unavailable',
    detail: 'no_session_to_resume',
    extra: {
      backend: leg.backend,
      parent_job_id: parentId,
      parent_task_class: parentClass,
      note: 'continue_from job ' + parentId + ' cannot resume the ' + leg.backend + ' leg: ' + why
        + '. Start a fresh council_start and put the round-1 context in the prompt.',
    },
  };
}

/* ---------------- route -- */

/**
 * The one entry point. Pure; every failure is data in `plan.refuse`.
 * @param {Object} ctx @param {Object} input see INTERFACES 4.3
 * @returns {Object} Plan
 */
function route(ctx, input) {
  const cfg = (ctx && ctx.config) || {};
  const fuses = cfg.fuses || {};
  const inp = input || {};
  const head = String(inp.prompt == null ? '' : inp.prompt).slice(0, MATCH_CHARS);

  const router = classify(head, inp.task_class);
  const spec = CLASSES[router.task_class];
  const plan = {
    router,
    legs: [],
    timeout_s: spec.timeout_s,
    budget_usd: spec.budget_usd,
    judge: null,
    refuse: null,
  };

  const roundRefusal = checkRound(inp);
  if (roundRefusal) return refusePlan(plan, roundRefusal);

  if (router.task_class === 'judge') {
    const j = parseParticipants(head, claudeModel(cfg, JUDGE_MODEL_ALIAS));
    if (j.refuse) return refusePlan(plan, j.refuse);
    plan.judge = j.judge;
  }

  const chosen = chooseBackends(ctx, router.task_class, inp);
  if (chosen.refuse) return refusePlan(plan, chosen.refuse);

  const sv = sameVendorRefusal(router.task_class, chosen.backends);
  if (sv) return refusePlan(plan, sv);

  const legs = chosen.backends.map((b, i) => buildLeg(cfg, router.task_class, b, i, inp));
  const cont = applyContinueFrom(legs, inp);
  if (cont) return refusePlan(plan, cont);

  plan.legs = legs;
  plan.timeout_s = lowerOnly(spec.timeout_s, inp.timeout_s, Number(fuses.max_timeout_s) || 1800);
  plan.budget_usd = lowerOnly(spec.budget_usd, inp.max_cost_usd, Number(fuses.max_cost_usd) || 5);
  return plan;
}

module.exports = {
  MATCH_CHARS, VENDORS, CLASSES, RULES, JUDGE_MODEL_ALIAS, JUDGE_HEADER_FORMAT,
  SESSION_ID_RE, isSessionId,
  route, classify, clampEffort, sameVendorRefusal, parseParticipants, checkRound,
};
