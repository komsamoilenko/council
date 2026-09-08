// Owns the mandatory D2 report and stable human survey rendering; specification §7.3.
import { createHash } from 'node:crypto';
export function planBytes(plan) {
  const { file_sha256, ...document } = plan;
  return JSON.stringify(document,null,2)+'\n';
}
export const planFileHash = plan => createHash('sha256').update(planBytes(plan)).digest('hex');
export const NOTICE = 'council starts CLIs you installed, signed in with your own accounts. It stores no credentials of theirs. Your vendor terms apply — see NOTICE.md.';
export function planReport(plan) {
  const writes = plan.steps.flatMap(s => s.writes || []);
  const create = writes.filter(w => w.action === 'create'), append = writes.filter(w => w.action === 'block'), rewrite = writes.filter(w => w.action === 'rewrite');
  const describe = w => w.path + (w.directory ? ' (directory, 0 bytes)' : w.bytes === null || w.bytes === undefined ? ' (size determined by apply)' : ` (${w.bytes} bytes)`) + (w.note ? ' — ' + w.note : '');
  return [
    `council-setup 0.1.0 · plan  (profile: ${plan.profile} · vault: ${plan.answers.vault})`, NOTICE, '',
    `WILL CREATE (${create.length})             ${create.map(describe).join('\n                           ') || 'none'}`,
    `WILL APPEND A MARKED BLOCK TO (${append.length})   ${append.map(w => `${w.path}  ${w.beforeBytes} → ${w.bytes} bytes  backup → ${w.backup}${w.note ? ' — ' + w.note : ''}`).join('\n                                  ') || 'none'}`,
    `WILL REWRITE (semantics preserved) (${rewrite.length})      ${rewrite.map(w => `${w.path} (${w.note || 'installer-owned keys only'}) — backup → ${w.backup}`).join(' · ') || 'none'}   — each backed up whole first`,
    'WILL OVERWRITE (0)   WILL DELETE (0)   WILL MOVE OR RENAME (0)',
    `WILL REGISTER        ${plan.registrations.map(r => r.surface + (r.surface === 'claude-code' ? ' (user scope)' : r.surface === 'codex' ? ' (marked TOML block)' : '')).join(' · ') || 'none'}`,
    `WILL NOT TOUCH       ${[...plan.untouched, "other profiles' entries", "other servers' host entries"].join(' · ')}`,
    'NOT DOING            agy (disabled by policy — NOTICE.md) · duplicates (report only) · logins (yours, last) · Node/CLIs (install-prereqs)',
    `WARNINGS             ${plan.warnings.join(' · ') || 'none'}`,
    `PLAN FILE            ${plan.file}   sha256 ${planFileHash(plan)}`,
    `APPLY                council-setup apply --plan "${plan.file}"`,
  ].join('\n') + '\n';
}
export function detectReport(detect) {
  const ordered = [...detect.blocks.filter(b => b.name === 'journal' && b.journals.length), ...detect.blocks.filter(b => b.name !== 'journal' || !b.journals.length)];
  return `council-setup 0.1.0 · detect (profile: ${detect.profile})\n` + ordered.map(({name, ...facts}) => `${name}: ${JSON.stringify(facts)}`).join('\n') + '\n' + detect.warnings.map(w => 'WARNING: ' + w).join('\n') + '\n';
}
