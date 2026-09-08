// Owns deterministic English debate prompt generation; specification §14.1.
import fs from 'node:fs';
import {render} from '../installer/lib/render.mjs';
const source=fs.readFileSync(new URL('../templates/vault/' + 'shared/debate-prompt.md.tmpl',import.meta.url),'utf8');
const output=render(source,{CHAT_LANGUAGE:process.argv[2] || 'English',WORK_DIR:process.argv[3] || 'work'});
process.stdout.write(output);
