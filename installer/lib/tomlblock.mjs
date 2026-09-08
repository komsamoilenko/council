// Owns exact TOML table splices without serialization; specification §9.4.
import fs from 'node:fs';
import platform from '../../src/platform/index.js';
import { linesOf, scanMarkers, mergeMarkers, canonicalBlock, refusal } from './markers.mjs';
import { safewrite, writeSplice, rejectReparse } from './safewrite.mjs';

function tableName(text) {
  const match = /^\s*(\[\[?)(.*?)\]\]?\s*(?:#.*)?$/.exec(text);
  if (!match) return null;
  const names = []; let rest = match[2].trim();
  while (rest) {
    const m = /^(?:([A-Za-z0-9_-]+)|"((?:\\.|[^"\\])*)"|'([^']*)')\s*(\.|$)/.exec(rest);
    if (!m) throw new Error('invalid_table_header');
    names.push(m[1] ?? (m[2] !== undefined ? JSON.parse('"' + m[2] + '"') : m[3]));
    rest = rest.slice(m[0].length).trim();
    if (m[4] && !rest) throw new Error('invalid_table_header');
  }
  return { names, array: match[1] === '[[' };
}

export function tokenizeToml(input) {
  const info = linesOf(Buffer.from(input)), headers = [], ignoreLines = new Set();
  let quote = null;
  for (const line of info.lines) {
    if (quote) ignoreLines.add(line.start);
    else { const header = tableName(line.text); if (header) headers.push({ ...header, start: line.start }); }
    for (let i = 0; i < line.text.length;) {
      const s = line.text, c = s[i];
      if (quote) {
        if (quote[0] === '"' && c === '\\') { i += 2; continue; }
        if (s.startsWith(quote, i)) {
          i += quote.length;
          if (quote.length === 3) while (s[i] === quote[0]) i++;
          quote = null;
        } else i++;
      } else if (c === '#') break;
      else if (c === '"' || c === "'") { quote = s.startsWith(c.repeat(3), i) ? c.repeat(3) : c; i += quote.length; }
      else i++;
    }
    if (quote?.length === 1) throw new Error('unterminated_toml_string');
  }
  if (quote) throw new Error('unterminated_toml_string');
  return { ...info, headers, ignoreLines };
}

export function councilSpan(input, { name = 'council' } = {}) {
  const bytes = Buffer.from(input), tokens = tokenizeToml(bytes);
  const ours = h => h.names.length >= 2 && h.names[0] === 'mcp_servers' && h.names[1] === name;
  const indices = tokens.headers.map((h,i) => ours(h) ? i : -1).filter(i => i >= 0);
  if (!indices.length) return { ...tokens, ok: true, span: null };
  if (indices.some((v,i) => i && v !== indices[i-1] + 1)) return { ...tokens, ...refusal('E_TOML_NONCONTIGUOUS') };
  if (indices.some(i => tokens.headers[i].array)) return { ...tokens, ...refusal('E_TOML_ARRAY_TABLE') };
  const first = indices[0], last = indices.at(-1);
  return { ...tokens, ok: true, span: { start: tokens.headers[first].start, end: tokens.headers[last+1]?.start ?? bytes.length } };
}

export function spliceToml(input, body, options = {}) {
  const before = Buffer.from(input), span = councilSpan(before, options);
  if (!span.ok) return span;
  const opts = { ...options, style: 'hash', ignoreLines: span.ignoreLines, forceBlock: true };
  const marked = scanMarkers(before, opts);
  if (!marked.ok || marked.block || !span.span) {
    if (marked.block && span.headers.some(h => h.names[0] === 'mcp_servers' && h.names[1] === (options.name || 'council') &&
        (h.start < marked.block.start || h.start >= marked.block.end))) return refusal('E_TOML_OUTSIDE_BLOCK');
    if (marked.block && span.headers.some(h => h.start >= marked.block.start && h.start < marked.block.end &&
        !(h.names[0] === 'mcp_servers' && h.names[1] === (options.name || 'council')))) return refusal('E_TOML_FOREIGN_TABLE');
    return mergeMarkers(before, body, opts);
  }
  if (!options.adoptExisting) return { ...refusal('E_TOML_ADOPTION_REQUIRED'), proposal: canonicalBlock(body, { style: 'hash', eol: span.eol }) };
  const replacement = canonicalBlock(body, { style: 'hash', eol: span.eol }), oldRange = span.span;
  const bytes = Buffer.concat([before.subarray(0, oldRange.start), replacement, before.subarray(oldRange.end)]);
  return { ok: true, bytes, changed: !before.equals(bytes), adopted: true, oldRange,
    newRange: { start: oldRange.start, end: oldRange.start + replacement.length },
    pre_existing_table: before.subarray(oldRange.start, oldRange.end).toString('utf8') };
}

export function exciseToml(input, options = {}) {
  const bytes = Buffer.from(input), tokens = tokenizeToml(bytes);
  const scan = scanMarkers(bytes, { style: 'hash', ignoreLines: tokens.ignoreLines });
  if (!scan.ok) return scan;
  if (!scan.block) return { ok: true, changed: false, bytes };
  const { start, end } = scan.block;
  if (tokens.headers.some(h => h.start >= start && h.start < end &&
      !(h.names[0] === 'mcp_servers' && h.names[1] === (options.name || 'council')))) return refusal('E_TOML_FOREIGN_TABLE');
  return { ok: true, changed: true, bytes: Buffer.concat([bytes.subarray(0, start), bytes.subarray(end)]),
    oldRange: { start, end }, newRange: { start, end: start } };
}

export async function spliceTomlFile(file, body, options = {}) {
  if (await rejectReparse(file, options.platform || platform)) return refusal('E_REPARSE_TARGET');
  let before;
  try { before = fs.readFileSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; before = Buffer.alloc(0); }
  const result = spliceToml(before, body, options);
  if (!result.ok) {
    const sibling = file + '.council-new';
    if (fs.existsSync(sibling)) return { ...result, sibling, proposalConflict: true };
    if (options.dryRun === false) {
      try { await safewrite(sibling, result.proposal || canonicalBlock(body, { style: 'hash' }), { exclusive: true }); }
      catch (e) { if (e.code !== 'EEXIST') throw e; return { ...result, sibling, proposalConflict: true }; }
    }
    return { ...result, sibling };
  }
  return writeSplice(file, before, result, options);
}
