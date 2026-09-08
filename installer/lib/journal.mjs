// Owns durable intent records and open-journal discovery; specification §7.4.
import fs from 'node:fs';
import path from 'node:path';
import { safewrite } from './safewrite.mjs';

export const LINE_TYPES = Object.freeze(['begin', 'backup', 'pre', 'post', 'commit']);
const validHash = h => typeof h === 'string' && /^[a-f0-9]{64}$/.test(h);
function validate(record) {
  if (!record || !LINE_TYPES.includes(record.t)) throw new Error('invalid_journal_type');
  const fields = record.t === 'begin' ? ['plan_sha256'] : record.t === 'pre' ? ['sha256_before','sha256_expected'] : record.t === 'post' ? ['sha256_after'] : [];
  for (const key of fields) if (!validHash(record[key]) && !(record[key] === null && key !== 'plan_sha256')) throw new Error('invalid_journal_hash:' + key);
  if (['backup','pre','post'].includes(record.t) && (typeof record.path !== 'string' || !record.path)) throw new Error('invalid_journal_path');
  if (record.t === 'backup' && (typeof record.backup !== 'string' || !record.backup)) throw new Error('invalid_journal_backup');
}
export function readJournal(file) {
  const bytes = fs.readFileSync(file, 'utf8'), records = [];
  let corrupt = false;
  for (const line of bytes.split('\n').filter(Boolean)) {
    try { const record = JSON.parse(line); validate(record); records.push(record); }
    catch { corrupt = true; break; }
  }
  if (!bytes.endsWith('\n') || records[0]?.t !== 'begin' || records.slice(1).some(r => r.t === 'begin') ||
      records.slice(0,-1).some(r => r.t === 'commit')) corrupt = true;
  return { path: file, records, corrupt, open: corrupt || records.at(-1)?.t !== 'commit' };
}
export function openJournals(directory) {
  try { return fs.readdirSync(directory).filter(n => n.endsWith('.jsonl')).sort().map(n => readJournal(path.join(directory,n))).filter(j => j.open); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
export function journal(file, { writer = safewrite } = {}) {
  let queue = Promise.resolve();
  const before = (record, action = async () => undefined) => {
    const task = queue.then(async () => {
      validate(record);
      let existing = '';
      try {
        const state = readJournal(file);
        if (state.corrupt || !state.open || record.t === 'begin') throw new Error('journal_not_appendable');
        existing = fs.readFileSync(file, 'utf8');
      } catch (e) { if (e.code !== 'ENOENT' || record.t !== 'begin') throw e; }
      // Atomic full-file replacement preserves a complete JSONL prefix on a crash.
      await writer(file, existing + JSON.stringify(record) + '\n', { exclusive: record.t === 'begin' });
      return action();
    });
    // A failed action poisons this handle; a caller must explicitly resume from disk.
    queue = task;
    return task;
  };
  return { before };
}
