// Builds a public tree only after the local gate; never publishes it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const repo = fs.realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const directories = ['src', 'bin', 'installer', 'tools', 'docs', 'tests'];
const documents = ['README.md', 'NOTICE.md', 'LICENSE', 'CHANGELOG.md', 'SECURITY.md', 'CONTRIBUTING.md', 'package.json'];
const publicTools = new Set(['make-debate-prompt.mjs', 'scan-personal.mjs', 'scan-personal.test.mjs', 'win32-acl.live.test.mjs', 'stage-release.mjs', 'sha256.mjs']);
const under = (p, root) => { const rel = path.relative(root, p); return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep)); };
const hex = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const grouped = digest => digest.match(/.{2}/g).join(':');
function outputPath(value) {
  const absolute = path.resolve(value);
  if (!fs.existsSync(path.dirname(absolute)) || !fs.statSync(path.dirname(absolute)).isDirectory()) throw new Error('--out parent must already be a directory');
  let ancestor = absolute;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error('out has no existing ancestor');
    ancestor = parent;
  }
  const resolved = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, absolute));
  if (under(absolute, repo) || under(resolved, repo)) throw new Error('--out must be outside the repository');
  // Refuse existing targets entirely: no overwrites, merges or cleanup of prior data.
  try { fs.lstatSync(absolute); } catch (e) { if (e.code === 'ENOENT') return resolved; throw e; }
  throw new Error('--out must not already exist');
}
function run(label, file, args) {
  console.log('RUN ' + label);
  const result = spawnSync(file, args, {cwd:repo, stdio:'inherit', windowsHide:true, shell:false});
  if (result.error) throw result.error;
  console.log(label + ' exit ' + result.status);
  if (result.status !== 0) throw new Error(label + ' failed');
}
function git(args) {
  const result = spawnSync('git', ['-C', repo, ...args], {encoding:'utf8', windowsHide:true, shell:false});
  if (result.error || result.status !== 0) throw new Error('cannot read source provenance: ' + (result.error?.message || result.stderr));
  return result.stdout.trim();
}
function inventory() {
  const files = [], excluded = [];
  const walk = (relative = '') => {
    for (const entry of fs.readdirSync(path.join(repo, relative), {withFileTypes:true}).sort((a,b)=>a.name < b.name ? -1 : 1)) {
      const rel = relative ? relative + '/' + entry.name : entry.name;
      let reason;
      if (!relative && !directories.includes(entry.name) && !documents.includes(entry.name)) reason = 'outside top-level allowlist';
      else if (entry.isDirectory() && /^(?:tmp|fixtures?|node_modules|jobs|ledger|secrets|run|\.git|\.port-fixture)$|^council-(?:smoke|sandbox|unit|diagnostics)-/i.test(entry.name)) reason = 'fixture, runtime or dependency root';
      else if (/\.log$/i.test(entry.name)) reason = 'log';
      else if (relative === 'tools' && !publicTools.has(entry.name)) reason = 'not a public tool';
      if (reason) { excluded.push({path:rel, reason}); continue; }
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error('unsupported source entry: ' + rel);
      if (entry.isDirectory()) walk(rel);
      else files.push({path:rel, bytes:fs.readFileSync(path.join(repo, rel))});
    }
  };
  walk();
  for (const name of documents) if (!files.some(f=>f.path===name)) throw new Error('missing required file: ' + name);
  for (const name of directories) if (!files.some(f=>f.path.startsWith(name+'/'))) throw new Error('missing required tree: ' + name);
  files.sort((a,b)=>a.path < b.path ? -1 : 1);
  return {files, excluded};
}
function main() {
  const args = process.argv.slice(2), options = {};
  for (let i=0; i<args.length; i+=2) {
    if (!['--out','--version'].includes(args[i]) || !args[i+1] || Object.hasOwn(options,args[i])) throw new Error('usage: stage-release.mjs --out <new-directory> --version <version>');
    options[args[i]] = args[i+1];
  }
  if (!options['--out'] || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(options['--version'] || '')) throw new Error('--out and a release version are required');
  const out = outputPath(options['--out']), version = options['--version'];
  const pkg = JSON.parse(fs.readFileSync(path.join(repo,'package.json'),'utf8'));
  const runtime = fs.readFileSync(path.join(repo,'src/version.js'),'utf8').match(/APP_VERSION:\s*'([^']+)'/)?.[1];
  if (pkg.version !== version || runtime !== version) throw new Error('version must match package.json and src/version.js');
  const commit = git(['rev-parse','HEAD']);
  run('node tests/run.mjs', process.execPath, [path.join(repo,'tests/run.mjs')]);
  if (git(['rev-parse','HEAD']) !== commit) throw new Error('source commit changed during gate');
  const {files, excluded} = inventory();
  const dirty = !!git(['status','--porcelain','--untracked-files=all']);
  // Revalidate after the gate, which may take several minutes.
  if (outputPath(options['--out']) !== out) throw new Error('out ancestor changed');
  fs.mkdirSync(out);
  for (const file of files) {
    const destination = path.join(out,file.path);
    fs.mkdirSync(path.dirname(destination), {recursive:true});
    fs.writeFileSync(destination, file.bytes, {flag:'wx'});
  }
  run('node tools/scan-personal.mjs <out>', process.execPath, [path.join(repo,'tools/scan-personal.mjs'),out]);
  const manifest = files.map(f=>[f.path,hex(fs.readFileSync(path.join(out,f.path)))]);
  const staged = {version, source_commit:grouped(commit), source_dirty:dirty,
    hash_encoding:'colon-separated hex bytes', file_count:files.length+1,
    tree_hash:grouped(hex(JSON.stringify(manifest)+'\n')),
    tree_hash_algorithm:'sha256 of UTF-8 JSON sorted [path, sha256 hex] pairs plus LF; STAGED.json excluded'};
  fs.writeFileSync(path.join(out,'STAGED.json'), JSON.stringify(staged,null,2)+'\n', {flag:'wx'});
  // Metadata is scanned too. Grouped hex is lossless, with no scanner exemption.
  run('node tools/scan-personal.mjs <out> (including STAGED.json)', process.execPath, [path.join(repo,'tools/scan-personal.mjs'),out]);
  for (const item of excluded) console.log('EXCLUDE ' + item.path + ' — ' + item.reason);
  console.log('STAGED ' + staged.file_count + ' files at ' + out);
}
try { main(); } catch (error) { console.error('stage-release: REFUSED: ' + error.message); process.exitCode = 1; }
