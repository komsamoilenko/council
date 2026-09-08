// Owns byte-preserving marker scanning and merging; specification §8.2.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import platform from '../../src/platform/index.js';
import { safewrite, writeSplice, rejectReparse } from './safewrite.mjs';

export const hashBody = bytes => createHash('sha256').update(Buffer.from(bytes).toString('utf8').replace(/\r\n/g, '\n')).digest('hex');
export function linesOf(bytes) {
  const bom = bytes.subarray(0, 3).equals(Buffer.from([239,187,191])) ? 3 : 0;
  const lines = []; let start = bom, crlf = 0, lf = 0;
  for (let i = bom; i < bytes.length; i++) if (bytes[i] === 10) {
    const cr = i > start && bytes[i-1] === 13;
    cr ? crlf++ : lf++;
    lines.push({ start, end: i + 1, text: bytes.subarray(start, cr ? i-1 : i).toString('utf8') }); start = i + 1;
  }
  if (start < bytes.length) lines.push({ start, end: bytes.length, text: bytes.subarray(start).toString('utf8') });
  return { bom, lines, eol: crlf > lf ? '\r\n' : '\n' };
}
export const refusal = code => ({ ok: false, code, exitCode: 4 });

export function scanMarkers(input, { style = 'markdown', ignoreLines = new Set() } = {}) {
  const bytes = Buffer.from(input), info = linesOf(bytes);
  let fence = null, open = null, block = null, outside = '';
  const begin = style === 'hash' ? /^# council:begin(?:\s+v=(\d+))?$/ : /^<!-- council:begin(?:\s+v=(\d+))?\s*-->$/;
  const end = style === 'hash' ? '# council:end' : '<!-- council:end -->';
  for (const line of info.lines) {
    if (ignoreLines.has(line.start)) continue;
    const text = line.text.trim();
    if (style === 'markdown') {
      const f = /^(\x60{3,}|~{3,})(.*)$/.exec(text);
      if (f) {
        if (!fence) fence = { char: f[1][0], count: f[1].length };
        else if (f[1][0] === fence.char && f[1].length >= fence.count && !f[2].trim()) fence = null;
        continue;
      }
      if (fence) continue;
    }
    const m = begin.exec(text);
    if (m) {
      if (m[1] !== undefined && Number(m[1]) !== 1) return { ...info, ...refusal('E_MARKER_VERSION_UNKNOWN') };
      if (open || block) return { ...info, ...refusal('E_MARKER_DUPLICATE') };
      open = { start: line.start, bodyStart: line.end, version: 1, upgraded: m[1] === undefined };
    } else if (text === end) {
      if (!open) return { ...info, ...refusal(block ? 'E_MARKER_DUPLICATE' : 'E_MARKER_UNTERMINATED') };
      block = { ...open, bodyEnd: line.start, end: line.end };
      block.body = bytes.subarray(block.bodyStart, block.bodyEnd);
      open = null;
    } else if (!open) outside += line.text + '\n';
  }
  // An unclosed example cannot safely hide markers through EOF. Refuse the file.
  if (fence) return { ...info, ...refusal('E_MARKER_FENCE_UNTERMINATED') };
  if (open) return { ...info, ...refusal('E_MARKER_UNTERMINATED') };
  return { ...info, ok: true, block, contractPresent: /## Council|council_start/.test(outside) };
}

export function canonicalBlock(body, { style = 'markdown', eol = '\n' } = {}) {
  // This boundary owns unwrapping readable, already-marked templates (including
  // their outside ownership comment). Callers may pass the real template whole.
  const scan = scanMarkers(Buffer.from(body), { style });
  if (scan.ok && scan.block) body = scan.block.body;
  const normalized = Buffer.from(body).toString('utf8').replace(/\r\n/g, '\n').replace(/\n*$/, '');
  const begin = style === 'hash' ? '# council:begin v=1' : '<!-- council:begin v=1 -->';
  const end = style === 'hash' ? '# council:end' : '<!-- council:end -->';
  return Buffer.from(begin + eol + (normalized ? normalized.replace(/\n/g, eol) + eol : '') + end + eol);
}

export function mergeMarkers(input, body, options = {}) {
  const before = Buffer.from(input), scan = scanMarkers(before, options);
  const strategy = options.strategy || 'block';
  if (!['block', 'none', 'sidecar', 'ask'].includes(strategy)) throw new Error('invalid_merge_strategy');
  if (strategy === 'none') return { ok: true, changed: false, action: 'none', reason: 'strategy_none', bytes: before };
  const proposal = canonicalBlock(body, { ...options, eol: scan.eol });
  if (!scan.ok) return { ...scan, proposal };
  const proposed = scanMarkers(proposal, { ...options, ignoreLines: new Set() });
  if (!proposed.ok) return { ...proposed, proposal };
  if (!proposed.block) return { ...refusal('E_MARKER_UNTERMINATED'), proposal };
  if (strategy === 'none' || (!scan.block && scan.contractPresent && !options.forceBlock))
    return { ok: true, changed: false, action: 'none', reason: scan.contractPresent ? 'contract_already_present' : 'strategy_none', bytes: before };
  if (strategy === 'sidecar') return { ok: true, action: 'sidecar', proposal };
  if (strategy === 'ask') return { ...refusal('E_MERGE_CHOICE_REQUIRED'), proposal };
  if (scan.block) {
    const actual = hashBody(scan.block.body);
    const known = options.recordedHash ? actual === options.recordedHash : (options.templateHashes || []).includes(actual);
    if (!known && !options.allowRewrite) return { ...refusal(options.recordedHash ? 'E_BLOCK_CHANGED' : 'E_BLOCK_NOT_TEMPLATE'), proposal };
  }
  let replacement = proposal, oldRange;
  if (scan.block) {
    oldRange = { start: scan.block.start, end: scan.block.end };
    // Preserve an end marker's missing final newline.
    if (before[scan.block.end-1] !== 10) replacement = proposal.subarray(0, proposal.length - Buffer.byteLength(scan.eol));
  } else {
    // Existing trailing blank lines are user bytes. Add only enough for a blank line.
    const tail = before.subarray(scan.bom).toString('utf8');
    const breaks = /(?:\r?\n[\t ]*)*$/.exec(tail)[0].match(/\n/g)?.length || 0;
    const separator = tail.length ? scan.eol.repeat(Math.max(0, 2 - breaks)) : '';
    replacement = Buffer.concat([Buffer.from(separator), proposal]);
    oldRange = { start: before.length, end: before.length };
  }
  const bytes = Buffer.concat([before.subarray(0, oldRange.start), replacement, before.subarray(oldRange.end)]);
  return { ok: true, action: 'block', bytes, oldRange, newRange: { start: oldRange.start, end: oldRange.start + replacement.length },
    changed: !before.equals(bytes), upgraded: !!scan.block?.upgraded, adopted: !!scan.block && !options.recordedHash,
    blockHash: hashBody(proposed.block.body) };
}

export async function mergeMarkerFile(file, body, options = {}) {
  if (await rejectReparse(file, options.platform || platform)) return refusal('E_REPARSE_TARGET');
  let before;
  try { before = fs.readFileSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; before = Buffer.alloc(0); }
  if (path.basename(file) === '.gitignore') {
    const scan = scanMarkers(before, { style: 'hash' });
    if (scan.ok) {
      const outside = scan.block ? Buffer.concat([before.subarray(0, scan.block.start), before.subarray(scan.block.end)]) : before;
      const existing = new Set(linesOf(outside).lines.map(l => l.text));
      body = String(body).split(/\r?\n/).filter(line => !existing.has(line)).join('\n');
    }
    options = { ...options, style: 'hash' };
  }
  const result = mergeMarkers(before, body, options);
  if (!result.ok || result.action === 'sidecar') {
    const sibling = result.action === 'sidecar' ? path.join(path.dirname(file), path.parse(file).name + '.council.md') : file + '.council-new';
    if (fs.existsSync(sibling)) return { ...result, sibling, proposalConflict: true,
      ...(result.action === 'sidecar' ? refusal('E_SIDECAR_EXISTS') : {}) };
    if (options.dryRun === false) {
      try { await safewrite(sibling, result.proposal, { exclusive: true }); }
      catch (e) { if (e.code !== 'EEXIST') throw e; return { ...result, sibling, proposalConflict: true }; }
    }
    return { ...result, sibling, ...(result.action === 'sidecar' ? { importLine: '@' + path.basename(sibling) } : {}) };
  }
  if (result.action === 'none') return result;
  return writeSplice(file, before, result, options);
}
