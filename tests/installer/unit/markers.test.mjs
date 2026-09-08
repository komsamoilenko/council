import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { scanMarkers, mergeMarkers, mergeMarkerFile, hashBody, canonicalBlock } from '../../../installer/lib/markers.mjs';
import { safewrite, assertOutside } from '../../../installer/lib/safewrite.mjs';
const host = { implemented: { fileAttributes:false } };

export default async function(test) {
  for (const [begin,end,style] of [
    ['<!-- council:begin v=1 -->','<!-- council:end -->','markdown'],
    ['<!-- council:begin -->','<!-- council:end -->','markdown'],
    ['# council:begin v=1','# council:end','hash'],['# council:begin','# council:end','hash']]) {
    await test('accepted begin ' + begin, async () => {
      const input = Buffer.from('prefix\n'+begin+'\nold\n'+end+'\nsuffix\n');
      const scan = scanMarkers(input,{style}); assert.equal(scan.ok,true); assert.equal(scan.block.version,1);
      const r = mergeMarkers(input,'new',{style,recordedHash:hashBody(scan.block.body)});
      assert.equal(r.ok,true); assert.match(r.bytes.toString(),/begin v=1/); assertOutside(input,r.bytes,r.oldRange,r.newRange);
    });
  }
  await test('fences including nested shorter delimiter', async () => {
    const input = Buffer.from('````md\n```\n<!-- council:begin v=9 -->\n<!-- council:end -->\n````\n');
    assert.equal(scanMarkers(input).block,null); assert.equal(mergeMarkers(input,'new').ok,true);
  });
  for (const [body,code] of [[canonicalBlock('x').toString().repeat(2),'E_MARKER_DUPLICATE'],
    ['<!-- council:begin -->\nx','E_MARKER_UNTERMINATED'],['<!-- council:begin v=2 -->\nx\n<!-- council:end -->','E_MARKER_VERSION_UNKNOWN'],
    ['<!-- council:end -->','E_MARKER_UNTERMINATED']]) {
    await test(code, async () => { const r=mergeMarkers(Buffer.from(body),'new'); assert.equal(r.code,code); assert.equal(r.exitCode,4); });
  }
  await test('invalid attributes are not marker lines', async () => {
    assert.equal(scanMarkers(Buffer.from('<!-- council:begin profile=x -->\n')).block,null);
  });
  await test('BOM CRLF and dry/wet equality', async root => {
    const file=path.join(root,'AGENTS.md'), backup=path.join(root,'preimage');
    const before=Buffer.concat([Buffer.from([239,187,191]),Buffer.from('前\r\n<!-- council:begin -->\r\nold\r\n<!-- council:end -->\r\nafter\r\n')]);
    await safewrite(file,before); await safewrite(backup,before);
    const options={platform:host,allowRewrite:true,backup};
    const dry=await mergeMarkerFile(file,'new\nline',{...options,dryRun:true}); assert.deepEqual(fs.readFileSync(file),before);
    const wet=await mergeMarkerFile(file,'new\nline',{...options,dryRun:false}); assert.deepEqual(dry,wet); assert.deepEqual(fs.readFileSync(file),dry.bytes);
    assert.deepEqual(dry.bytes.subarray(0,3),before.subarray(0,3)); assert.ok(!/(?<!\r)\n/.test(dry.bytes.toString()));
  });
  await test('post-write assertion fires and restores backup', async root => {
    const file=path.join(root,'AGENTS.md'), backup=path.join(root,'preimage');
    const before=Buffer.from('prefix\n'+canonicalBlock('old')+'suffix\n'); await safewrite(file,before); await safewrite(backup,before);
    const writer=async (p,b) => { const corrupt=Buffer.from(b); corrupt[0]^=1; await safewrite(p,corrupt); };
    await assert.rejects(mergeMarkerFile(file,'new',{platform:host,dryRun:false,allowRewrite:true,backup,writer}),{code:'E_OUTSIDE_RANGE'});
    assert.deepEqual(fs.readFileSync(file),before);
  });
  await test('append, EOF, mixed EOL and empty file', async () => {
    for (const original of ['prefix','prefix\n','prefix\n\n','prefix\n\n\n','']) {
      const before=Buffer.from(original), r=mergeMarkers(before,'new'); assertOutside(before,r.bytes,r.oldRange,r.newRange);
      assert.ok(r.bytes.toString().startsWith(original));
      if (original && !original.endsWith('\n\n\n')) assert.match(r.bytes.toString(),/^prefix\n\n<!--/);
    }
    const input=Buffer.from('prefix\n'+canonicalBlock('old').toString().trimEnd());
    assert.ok(!mergeMarkers(input,'new',{allowRewrite:true}).bytes.toString().endsWith('\n'));
    assert.equal(scanMarkers(Buffer.from('a\r\nb\r\nc\n')).eol,'\r\n');
  });
  await test('transplant, changed body and sibling without overwriting', async root => {
    const file=path.join(root,'AGENTS.md'), before=canonicalBlock('handwritten'); await safewrite(file,before);
    const dry=await mergeMarkerFile(file,'new',{platform:host,dryRun:true}); assert.equal(dry.code,'E_BLOCK_NOT_TEMPLATE'); assert.ok(!fs.existsSync(dry.sibling));
    const wet=await mergeMarkerFile(file,'new',{platform:host,dryRun:false}); assert.deepEqual(dry,wet); assert.deepEqual(fs.readFileSync(file),before);
    assert.deepEqual(fs.readFileSync(wet.sibling),canonicalBlock('new'));
    const conflict=await mergeMarkerFile(file,'other',{platform:host,dryRun:false}); assert.equal(conflict.proposalConflict,true);
    assert.deepEqual(fs.readFileSync(wet.sibling),canonicalBlock('new'));
    assert.equal(mergeMarkers(before,'new',{templateHashes:[hashBody(scanMarkers(before).block.body)]}).adopted,true);
    assert.equal(mergeMarkers(before,'new',{recordedHash:hashBody('different')}).code,'E_BLOCK_CHANGED');
  });
  await test('real junction and metadata reparse refusal', async root => {
    const target=path.join(root,'target'), linked=path.join(root,'linked'); fs.mkdirSync(target); fs.symlinkSync(target,linked,'junction');
    assert.equal((await mergeMarkerFile(path.join(linked,'AGENTS.md'),'x',{platform:host})).code,'E_REPARSE_TARGET');
    const fake={implemented:{fileAttributes:true},fileAttributes:async () => ({bits:0x400})};
    assert.equal((await mergeMarkerFile(path.join(target,'AGENTS.md'),'x',{platform:fake})).code,'E_REPARSE_TARGET');
  });
  await test('strategies and gitignore line ownership', async root => {
    assert.equal(mergeMarkers(Buffer.from('## Council\n'), 'new').action,'none');
    assert.equal(mergeMarkers(Buffer.from('user'), 'new',{strategy:'none'}).changed,false);
    assert.equal(mergeMarkers(Buffer.from('<!-- council:begin v=9 -->'), 'new',{strategy:'none'}).action,'none');
    assert.equal(mergeMarkers(Buffer.from('user'), 'new',{strategy:'ask'}).code,'E_MERGE_CHOICE_REQUIRED');
    const side=await mergeMarkerFile(path.join(root,'AGENTS.md'),'new',{platform:host,strategy:'sidecar',dryRun:false});
    assert.equal(side.importLine,'@AGENTS.council.md'); assert.ok(fs.existsSync(side.sibling));
    const file=path.join(root,'.gitignore'); await safewrite(file,'STOP\n');
    const r=await mergeMarkerFile(file,'STOP\nledger/\n',{platform:host,dryRun:true});
    assert.equal(r.bytes.toString().match(/^STOP$/gm).length,1); assert.match(r.bytes.toString(),/# council:begin v=1/);
  });
}
