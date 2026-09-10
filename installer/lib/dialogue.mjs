// Owns unattended defaults and actionable installer errors; specification §§7.3,12.2.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

const catalogue = {
  'E-SETKEY-NON-TTY': [2,'Key deletion requires a terminal','each key deletion needs attended confirmation','Run set-key --delete in an interactive terminal.'],
  'E-NODE-MISSING': [2, 'Node was not found', 'the installer needs Node', 'Install Node LTS from https://nodejs.org/en/download, then re-run.'],
  'E-NODE-OLD': [2, 'Node is below 20.11', 'this runtime is unsupported', 'Install Node LTS, then re-run.'],
  'E-PLATFORM': [6, 'Platform capabilities are not implemented', '0.1.0 supports process supervision on Windows', 'Use Windows or plan with --allow-unsupported-platform.'],
  'E-VAULT-NOT-A-DIR': [2, 'The vault is not a directory', 'a vault must be a directory', 'Choose a directory with --vault.'],
  'E-VAULT-UNWRITABLE': [2, 'The first vault write failed', 'plan cannot test writability without writing; this is the first write council attempts', 'Make the vault writable and re-run apply.'],
  'E-VAULT-CONTAINS-APP-DATA': [2, 'The vault contains council app data', 'notes and the local installation must be separate', 'Choose a vault outside the council installation.'],
  'E-VAULT-ROOT-REFUSED': [2, 'This vault root is refused', 'drive, home, application-data, cloud roots and UNC paths are unsafe roots', 'Choose a dedicated local notes subdirectory.'],
  'E-MARKER-FENCE-UNTERMINATED': [4, 'A Markdown fence is unclosed', 'markers may be hidden through EOF', 'Close the code fence and retry.'],
  'E-MARKER-DUPLICATE': [4, 'Multiple council markers found', 'the intended block is ambiguous', 'Keep one balanced council block.'],
  'E-MARKER-UNTERMINATED': [4, 'A council marker is unpaired', 'the block boundary is unknown', 'Repair the begin/end pair.'],
  'E-MARKER-VERSION-UNKNOWN': [4, 'The marker version is unknown', 'this build understands v=1 only', 'Use an installer supporting this marker version.'],
  'E-REPARSE-TARGET': [4, 'A target is a link or reparse point', 'the write could reach another tree', 'Choose a regular file or directory.'],
  'E-PLAN-STALE': [3, 'The plan inputs changed', 'the reviewed plan no longer matches detection', 'Run plan again.'],
  'E-JOURNAL-OPEN': [5, 'An unfinished journal exists', 'an earlier apply did not commit', 'Resume its plan with apply --plan <same> --resume or use rollback --journal <ts>.'],
  'E-HOST-WRITE': [1, 'A host configuration write failed', 'the host may have locked the file', 'Close Codex and retry.'],
  'E-HOST-READBACK': [1, 'Host registration readback failed', 'the saved entry differs from the requested entry', 'Inspect the host configuration and retry.'],
  'E-HOST-NAME-TAKEN': [4, 'The server name is already in use', 'replacing it needs a human decision', 'Choose another --register-as name.'],
  'E-TOML-CONFLICT': [4, 'The Codex TOML span is ambiguous', 'a safe council-only splice is not possible', 'Repair the council tables and re-run plan.'],
  'E-SHIM-REGISTRATION': [1, 'A registration uses a shell shim', 'stdio requires absolute Node and launcher paths', 'Register the absolute Node executable and launcher.'],
  'E-CMD-SHIM': [1, 'A CLI resolves only to a shell shim', 'shell shims cannot safely frame stdio', 'Install the vendor CLI so its executable or JavaScript entry can be found.'],
  'E-AMBIGUOUS-BINARY': [4, 'Several CLI candidates were found', 'choosing one silently could use the wrong account or version', 'Remove the unintended PATH candidate.'],
  'E-PROFILE-EXISTS': [2, 'The profile belongs to another vault', 'a profile identifies one vault', 'Choose another --profile id.'],
  'E-SCHEMA-NEWER': [1, 'A configuration schema is newer', 'this installer cannot interpret it safely', 'Use a newer installer.'],
  'E-TIER0-FAILED': [1, 'Tier 0 failed; registration was NOT performed', 'the server did not pass its local checks', 'Fix the failing Tier 0 check and retry.'],
  'E-VERIFY-SLOW': [7, 'A registration round trip exceeded 30 seconds', 'the 30 s bound prevents overlap with the first reaper tick', 'Inspect the slow host and retry verify.'],
  'E-GEMINI-KEY-REJECTED': [1, 'Gemini rejected the key', 'the key or regional account eligibility may be unsuitable (EEA/CH/UK)', 'Check the key and vendor regional requirements.'],
  'E-NO-MANIFEST': [4, 'No ownership manifest exists', 'ownership cannot be inferred from a filename', 'Review adoption with apply --adopt-existing.'],
  'E-RUNTIME-ROOT-SYNCED': [2, 'The runtime root is cloud-synced', 'concurrent sync can corrupt journals and lock files', 'Choose a local unsynced runtime root.'],
  'E-BLOCK-NOT-TEMPLATE': [4, 'The block is not one of our template versions', 'its hand-written body must be left alone', 'Choose merge none or sidecar after reviewing the block.'],
  'E-BLOCK-CHANGED': [4, 'The council block was edited', 'the recorded hash no longer matches', 'Review the edits and choose merge none or sidecar.'],
  'E-SIDECAR-EXISTS': [4, 'The sidecar already exists', 'an existing user file cannot be overwritten', 'Review the sidecar and choose merge none.'],
  'E-LARGE-VAULT': [2, 'The vault contains more than 5,000 files', 'a broad root may have been selected accidentally', 'Review the root and re-run with --large-vault.'],
  'E-RELOCATE-NONEMPTY': [2, 'Runtime source directories are not empty', 'plan cannot move existing jobs or ledger rows', 'Copy the named directories using the printed commands, then review a new plan.'],
  'E-USAGE': [2, 'The command is invalid', 'a verb, flag or answer is unsupported', 'Run council-setup --help.'],
  'E-STEP': [1, 'The read or publication failed', 'the filesystem or probe could not complete the operation', 'Check the named path and retry.'],
};
export const ERROR_CATALOGUE = Object.freeze(catalogue);
export function fail(code, detail = '') {
  code = code.replaceAll('_', '-');
  if (code.startsWith('E-TOML-') && !catalogue[code]) code = 'E-TOML-CONFLICT';
  const [exitCode, what, why, fix] = catalogue[code] || catalogue['E-STEP'];
  return Object.assign(new Error(`${what}. ${why}. ${fix}${detail ? '\n' + detail : ''}`), { code, exitCode, what, why, fix, detail });
}
export function errorObject(error, verbose = false) {
  const normalized = error.code?.replaceAll('_','-');
  const byExit = {1:'E-STEP',2:'E-USAGE',3:'E-PLAN-STALE',4:'E-NO-MANIFEST',5:'E-JOURNAL-OPEN',6:'E-PLATFORM',7:'E-VERIFY-SLOW'};
  const e = error.what && error.why && error.fix ? error : fail(catalogue[normalized] ? normalized : byExit[error.exitCode] || 'E-STEP',error.code || error.message);
  return { code: e.code || 'E-STEP', exitCode: e.exitCode, what: e.what || e.message,
    why: e.why, fix: e.fix, detail: e.detail || '', ...(verbose ? { stack: error.stack } : {}) };
}
export const sanitize = value => [...String(value).replace(/[\r\n\u2028\u2029]/g, ' ').replaceAll('<!--', '').replace(/[\x00-\x1f\x7f]/g, '')].slice(0, 80).join('');
export function loadAnswers(file) {
  if (!file) return {};
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw fail('E-USAGE', 'Cannot parse --answers JSON.'); }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw fail('E-USAGE', '--answers must contain an object.');
  const keys = ['vault','owner','chat-language','merge','relocate-runtime','gemini-key','duplicates','hosts','desktop-config', 'conventions','git-init','large-vault','allow-unsupported-platform'];
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw fail('E-USAGE', 'Unknown answer: ' + key);
  return value;
}
export async function questions(options, { home, cloud = false, fresh = false, input = process.stdin, output = process.stderr } = {}) {
  const result = { ...options };
  if (result.merge === 'ask') delete result.merge;
  const entries = [
    ['vault', 'Vault root', path.join(home, 'Notes')], ['owner', 'Owner name', 'Owner'],
    ['chat-language', 'Chat language', 'English'], ['merge', 'Merge strategy (or JSON object per conflicting file)', 'block'],
    ['relocate-runtime', 'Keep jobs and ledger local', cloud], ['gemini-key', 'Gemini key now/later (set-key is a later step)', 'later'],
    ['duplicates', 'Scan for duplicates (report only)', false], ['hosts', 'Hosts (or JSON {hosts, desktop-config})', 'all'],
  ];
  const rl = input.isTTY && !options.json && !options.answers ? readline.createInterface({ input, output }) : null;
  try {
    for (const [key, title, fallback] of entries) {
      if (result[key] !== undefined) continue;
      const raw = rl ? (await rl.question(`${title} [${fallback}]: `)).trim() : '';
      let value = raw || fallback;
      if (typeof fallback === 'boolean') value = raw ? /^(y|yes|true|1)$/i.test(raw) : fallback;
      if (raw.startsWith('{')) { try { value = JSON.parse(raw); } catch { throw fail('E-USAGE', title + ': invalid JSON.'); } }
      if (key === 'hosts' && typeof value === 'object') { result['desktop-config'] = value['desktop-config']; value = value.hosts; }
      result[key] = value;
    }
  } finally { rl?.close(); }
  result.conventions ??= fresh;
  if (result.merge && typeof result.merge === 'object') result.merge = Object.fromEntries(Object.entries(result.merge).map(([key,value]) => [key,value === 'ask' ? 'block' : value]));
  result.owner = sanitize(result.owner); result['chat-language'] = sanitize(result['chat-language']);
  return result;
}
