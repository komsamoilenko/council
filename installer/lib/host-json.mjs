// Owns byte-preserving JSON member edits for host live-state files; §9.
// Parse spans independently of JSON.parse so unrelated whitespace and values are
// never serialized. Ambiguous duplicate object keys are refused.
export function jsonTree(input) {
  const bytes = Buffer.from(input), text = bytes.toString('utf8');
  JSON.parse(text.replace(/^\ufeff/, ''));
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const ws = () => { while (/\s/.test(text[i] || '') && i < text.length) i++; };
  const string = () => { const start = i++; while (i < text.length) { if (text[i++] === '\\') i++; else if (text[i - 1] === '"') break; } return JSON.parse(text.slice(start, i)); };
  const node = () => {
    ws(); const start = i; let members;
    if (text[i] === '{') {
      members = []; i++; ws(); const names = new Set();
      while (text[i] !== '}') {
        ws(); const memberStart = i, key = string();
        if (names.has(key)) throw new Error('ambiguous_json_key'); names.add(key);
        ws(); i++; const value = node(); ws();
        const member = { key, start: memberStart, end: i, value }; members.push(member);
        if (text[i] !== ',') break;
        member.comma = i++;
      }
      i++;
    } else if (text[i] === '[') { i++; ws(); while (text[i] !== ']') { node(); ws(); if (text[i] !== ',') break; i++; } i++; }
    else if (text[i] === '"') string();
    else { while (i < text.length && !/[\s,}\]]/.test(text[i])) i++; }
    return { start, end: i, members };
  };
  const root = node();
  const offset = n => Buffer.byteLength(text.slice(0, n));
  const convert = n => { n.start = offset(n.start); n.end = offset(n.end); for (const m of n.members || []) { m.start = offset(m.start); m.end = offset(m.end); if (m.comma !== undefined) m.comma = offset(m.comma); convert(m.value); } };
  convert(root); return root;
}
export function spliceJsonEntry(input, name, value) {
  const before = Buffer.from(input), original = before.length ? before : Buffer.from('{}');
  const root = jsonTree(original);
  if (!root.members) throw new Error('host_json_not_object');
  const servers = root.members.find(m => m.key === 'mcpServers');
  if (servers && !servers.value.members) throw new Error('host_servers_not_object');
  const object = servers?.value || root;
  const key = servers ? name : 'mcpServers';
  const member = object.members.find(m => m.key === key);
  const oldValue = servers?.value.members.find(m => m.key === name);
  const previous = oldValue ? JSON.parse(original.subarray(oldValue.value.start, oldValue.value.end)) : null;
  let start, end, replacement;
  if (value === null && !oldValue) return { ok: true, bytes: before, changed: false, previous, oldRange: { start: 0, end: 0 }, newRange: { start: 0, end: 0 } };
  if (member) {
    if (value !== null) { start = member.value.start; end = member.value.end; replacement = JSON.stringify(value); }
    else {
      const index = object.members.indexOf(member);
      start = index ? object.members[index - 1].comma : member.start;
      end = index ? member.end : member.comma === undefined ? member.end : member.comma + 1;
      replacement = '';
    }
  } else {
    start = end = object.end - 1;
    const eol = original.includes(Buffer.from('\r\n')) ? '\r\n' : '\n';
    const indent = /\n([ \t]+)"/.exec(original.toString('utf8'))?.[1] || '  ';
    replacement = (object.members.length ? ',' : '') + eol + indent + JSON.stringify(key) + ': ' + JSON.stringify(servers ? value : { [name]: value }) + eol;
  }
  if (!before.length) { start = 0; end = 0; replacement = '{' + replacement + '}\n'; }
  const inserted = Buffer.from(replacement);
  return { ok: true, previous, changed: true,
    bytes: Buffer.concat([before.subarray(0, start), inserted, before.subarray(end)]),
    oldRange: { start, end }, newRange: { start, end: start + inserted.length } };
}
