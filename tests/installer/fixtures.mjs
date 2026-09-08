// Owns read-only verb fixture construction; specification §16.4.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderVault, layout } from '../../installer/lib/render.mjs';
import { canonicalBlock, scanMarkers } from '../../installer/lib/markers.mjs';

export const names = ['empty','obsidian-like','git-repo','conflicting-agents','agents-with-protocol-text','agents-with-our-block','agents-marker-in-codefence','agents-marker-no-version','agents-two-blocks','agents-crlf','cloud-synced','transplanted','duplicates'];
export function put(file, text = '') { fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file,text); }
export function fixture(root, name, ctx) {
  const vault = name==='cloud-synced'?path.join(root,'cloud','vault'):path.join(root,'vault'); fs.mkdirSync(vault,{recursive:true});
  if (name === 'obsidian-like') {
    put(path.join(vault,'.obsidian','app.json'),'{}\n'); put(path.join(vault,'.obsidian','workspace.json'),'private workspace\n');
    put(path.join(vault,'note.md'),'# My notes\n'); put(path.join(vault,'AGENTS.md'),'# My rules\n\nKeep my notes intact.\n');
    fs.mkdirSync(path.join(vault,'work'));
    // Existing identical app: the report can focus on adoption instead of listing all source files.
    const src = fileURLToPath(new URL('../../src/',import.meta.url));
    fs.cpSync(src,ctx.dirs.app,{recursive:true});
  }
  if (name === 'git-repo') { put(path.join(vault,'.git','HEAD'),'ref: refs/heads/main\n'); put(path.join(vault,'.gitignore'),'mine/\nwork/jobs/\n'); }
  if (name === 'conflicting-agents') put(path.join(vault,'AGENTS.md'),'# Personal rules\n\nThese bytes belong to the user.\n');
  if (name === 'agents-with-protocol-text') put(path.join(vault,'AGENTS.md'),'# Personal rules\n\n## Council\nUse council_start.\n');
  if (name === 'agents-with-our-block') {
    const dir = fileURLToPath(new URL('../../installer/templates/vault/',import.meta.url));
    const values = {OWNER:'Owner',CHAT_LANGUAGE:'English',WORK_DIR:'work',LAYOUT:layout(vault),JOBS_DIR:'work/jobs',LEDGER_DIR:'ledger'};
    const body=scanMarkers(Buffer.from(renderVault(dir,'AGENTS.block.md.tmpl',values,{INDEX:false,CONVENTIONS:false},{fullContract:true}))).block.body;
    put(path.join(vault,'AGENTS.md'),Buffer.concat([Buffer.from('# User prefix\n\n'),canonicalBlock(body),Buffer.from('\nUser suffix\n')]));
  }
  if (name === 'agents-marker-in-codefence') put(path.join(vault,'AGENTS.md'),'# User example\n\n```markdown\n<!-- council:begin v=8 -->\n<!-- council:end -->\n```\n');
  if (name === 'agents-marker-no-version') put(path.join(vault,'AGENTS.md'),'prefix\r\n<!-- council:begin -->\r\nHand-written body\r\n<!-- council:end -->\r\nsuffix\r\n');
  if (name === 'agents-two-blocks') put(path.join(vault,'AGENTS.md'),canonicalBlock('a').toString()+canonicalBlock('b'));
  if (name === 'agents-crlf') put(path.join(vault,'AGENTS.md'),'\ufeff# Mine\r\n\r\n');
  if (name === 'cloud-synced') ctx.env.OneDrive = path.join(root,'cloud');
  if (name === 'transplanted') put(path.join(vault,'.council','vault.json'),JSON.stringify({schema:1,profile:'other',vault_id:'fixture-id',contract_version:1}));
  if (name === 'duplicates') {
    for (const file of ['a.md','b.md','nested/c.md']) put(path.join(vault,file),'same bytes\n');
    put(path.join(vault,'INDEX.md'),'- `a.md` — first\n- `a.md` — repeated\n');
    put(path.join(vault,'.gitignore'),'ignored/\n*.secret\n!keep.secret\n');
    for (const file of ['.git/object','node_modules/package','work/jobs/job','ledger/row','.obsidian/workspace.json','ignored/a.md','hidden.secret']) put(path.join(vault,file),'same bytes\n');
    put(path.join(vault,'keep.secret'),'same bytes\n'); put(path.join(vault,'cloud.md'),'same bytes\n');
    put(path.join(vault,'large.md'),Buffer.alloc(8*1024**2+1,65));
  }
  return vault;
}
