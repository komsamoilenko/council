// Council-owned continuation records. Never import sessions from vault job files.
'use strict';
const path = require('path');
const store = require('./jobstore');
const router = require('./router');

function fileFor(ctx, jobId) {
  if (!store.isJobId(jobId)) throw new Error('invalid_job_id');
  return path.join(ctx.paths.sessionsDir, jobId + '.json');
}
function reserve(ctx, request) {
  return store.writeNewFile(fileFor(ctx, request.job_id), JSON.stringify({
    job_id: request.job_id, profile: ctx.profile, round: request.round,
    root_job_id: request.root_job_id, router: request.router,
    legs: request.legs.map(l => ({ leg_id: l.leg_id, backend: l.backend, resumable: l.resumable,
      resume_session_id: l.session_id || null, session_id: null, reported: false })),
  }));
}
function read(ctx, jobId) { return store.readJSON(fileFor(ctx, jobId)); }
function report(ctx, jobId, legId, sessionId) {
  const record = read(ctx, jobId);
  if (!record || record.profile !== ctx.profile) return false;
  const leg = record.legs.find(l => l.leg_id === legId);
  if (!leg || (sessionId != null && !router.isSessionId(sessionId))) return false;
  leg.session_id = sessionId || null;
  leg.reported = true;
  return store.atomicWriteJSON(fileFor(ctx, jobId), record);
}
function parent(ctx, jobId) {
  const r = read(ctx, jobId);
  if (!r) return { reason: 'continue_from_unrecorded' };
  if (r.profile !== ctx.profile) return { reason: 'continue_from_profile_mismatch' };
  if (!r.legs.some(l => l.reported)) return { reason: 'continue_from_unrecorded' };
  return { request: { ...r, job_id: jobId }, result: { legs: r.legs.filter(l => l.reported) } };
}
module.exports = { reserve, read, report, parent };
