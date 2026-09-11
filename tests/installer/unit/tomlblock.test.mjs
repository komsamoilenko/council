import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spliceToml, spliceTomlFile, exciseToml, councilSpan, tokenizeToml, councilFirstArg } from '../../../installer/lib/tomlblock.mjs';
import { canonicalBlock, scanMarkers, hashBody } from '../../../installer/lib/markers.mjs';
import { safewrite, assertOutside } from '../../../installer/lib/safewrite.mjs';
const body='[mcp_servers.council]\ncommand = "new"\n[mcp_servers.council.env]\nMODE = "test"\n';
const host={implemented:{fileAttributes:false}};

export default async function(test) {
  await test('first argument values: literal, basic and multiline strings', async () => {
    const expected = String.raw`C:\Program Files\previous\server.js`;
    for (const [label, encoded] of [
      ['literal', "'" + expected + "'"], ['basic', JSON.stringify(expected)],
      ['multiline literal', "'''\n" + expected + "'''"],
      ['multiline basic', '"""\n' + JSON.stringify(expected).slice(1,-1) + '"""'],
      ['multiline continuation', '"""C:\\\\Program \\\n   Files\\\\previous\\\\server.js"""'],
      ['unicode escape', JSON.stringify(expected).replace('C:', '\\u0043:')]
    ]) {
      assert.equal(councilFirstArg('[mcp_servers.council]\nargs = [ # first\n' + encoded + ', "ignored"]\n'), expected, label);
      process.stdout.write('PASS TOML first argument: ' + label + '\n');
    }
    assert.equal(councilFirstArg('[mcp_servers."council"]\n"args" = ["first", "second"]\n'), 'first');
    assert.equal(councilFirstArg("[mcp_servers.council]\nargs = ['''ends with quote'''' ]\n"), "ends with quote'");
    for (const text of [
      '[other]\nargs = ["decoy"]\n',
      '[mcp_servers.council.env]\nargs = ["decoy"]\n',
      '[mcp_servers.council]\n# args = ["decoy"]\ncommand = "decoy"\n',
      '[mcp_servers.council]\ndescription = """\nargs = [\'decoy\']\n"""\n',
      '[mcp_servers.council]\nargs = []\n',
      '[mcp_servers.council]\nargs = [42, "decoy"]\n',
      '[mcp_servers.council]\nargs = ["first"]\nargs = ["second"]\n',
      '[mcp_servers.council]\nargs = ["bad\\q"]\n',
      '[mcp_servers.council]\nargs = ["bad\\uD800"]\n'
    ]) assert.equal(councilFirstArg(text), null, text);
  });
  await test('adjacent sibling tables survive adoption and excision on disk', async root => {
    const prefix='[mcp_servers.vault]\ncommand = "vault"\n[mcp_servers.ask-claude]\ncommand = "own"\n';
    const old='[mcp_servers.council]\ncommand = "old"\n[mcp_servers.council.env]\nA="b"\n\n';
    const suffix='[windows]\nsandbox = "standard"\n';
    const before=Buffer.from(prefix+old+suffix), file=path.join(root,'config.toml'), backup=path.join(root,'preimage');
    await safewrite(file,before); await safewrite(backup,before);
    const options={platform:host,adoptExisting:true,backup};
    const dry=await spliceTomlFile(file,body,{...options,dryRun:true}); assert.deepEqual(fs.readFileSync(file),before);
    const wet=await spliceTomlFile(file,body,{...options,dryRun:false}); assert.deepEqual(dry,wet);
    assert.equal(wet.pre_existing_table,old); assertOutside(before,fs.readFileSync(file),wet.oldRange,wet.newRange);
    assert.equal(exciseToml(wet.bytes).bytes.toString(),prefix+suffix);
  });
  for (const delimiter of ['"""',"'''"]) await test('multiline string '+delimiter, async () => {
    const prefix='developer_instructions = '+delimiter+'\n[mcp_servers.council]\n# council:begin v=9\n# council:end\n'+delimiter+'\n';
    const bytes=Buffer.from(prefix+'[mcp_servers.council]\ncommand="old"\n[windows]\na=1\n');
    assert.equal(tokenizeToml(bytes).headers.length,2);
    const r=spliceToml(bytes,body,{adoptExisting:true}); assert.equal(r.ok,true); assert.ok(r.bytes.toString().startsWith(prefix));
  });
  await test('escaped quotes and comments do not change multiline state', async () => {
    const input=Buffer.from('x="a\\\"b" # """\ny="""one \\"" two\n[mcp_servers.fake]\nend"""\n[windows]\na=1\n');
    assert.equal(tokenizeToml(input).headers.length,1);
    assert.throws(() => tokenizeToml(Buffer.from('x="""unfinished')),/unterminated/);
  });
  await test('prefix sibling and quoted names are exact', async () => {
    const prefix='[mcp_servers.council-work]\na=1\n[mcp_servers.council2]\nb=2\n';
    const input=Buffer.from(prefix+'[mcp_servers."council"]\nx=1\n[mcp_servers.council.env]\ny=2\n[other]\nz=3\n');
    const r=spliceToml(input,body,{adoptExisting:true}); assert.equal(r.ok,true); assert.ok(r.bytes.toString().startsWith(prefix));
    assert.equal(councilSpan(Buffer.from('[mcp_servers."council.env"]\nx=1\n')).span,null);
  });
  await test('absent appends at EOF; adoption requires confirmation', async () => {
    const input=Buffer.from('[windows]\na=1\n'); const r=spliceToml(input,body);
    assert.ok(r.bytes.toString().startsWith(input.toString()+'\n# council:begin v=1\n'));
    assert.equal(spliceToml(Buffer.from(body),body).code,'E_TOML_ADOPTION_REQUIRED');
  });
  await test('noncontiguous and array tables refuse', async () => {
    assert.equal(spliceToml(Buffer.from('[mcp_servers.council]\na=1\n[other]\nx=1\n[mcp_servers.council.env]\nb=2\n'),body).code,'E_TOML_NONCONTIGUOUS');
    assert.equal(councilSpan(Buffer.from('[[mcp_servers.council]]\nx=1\n')).code,'E_TOML_ARRAY_TABLE');
  });
  await test('marked hash rule and foreign table protection', async () => {
    const input=canonicalBlock(body,{style:'hash'}), recordedHash=hashBody(scanMarkers(input,{style:'hash'}).block.body);
    assert.equal(spliceToml(input,body,{recordedHash}).changed,false);
    assert.equal(spliceToml(input,body,{recordedHash:hashBody('changed')}).code,'E_BLOCK_CHANGED');
    const bad=canonicalBlock(body+'[windows]\nx=1',{style:'hash'});
    assert.equal(spliceToml(bad,body,{allowRewrite:true}).code,'E_TOML_FOREIGN_TABLE');
    assert.equal(exciseToml(bad).code,'E_TOML_FOREIGN_TABLE');
    const outside=Buffer.concat([input,Buffer.from('[mcp_servers.council.extra]\nx=1\n')]);
    assert.equal(spliceToml(outside,body,{allowRewrite:true}).code,'E_TOML_OUTSIDE_BLOCK');
  });
  await test('post-write failure restores only council and preserves live surrounding bytes', async root => {
    const file=path.join(root,'config.toml'), backup=path.join(root,'preimage'), before=Buffer.from('[first]\nx=1\n'+body+'[last]\nx=2\n');
    await safewrite(file,before); await safewrite(backup,before);
    await assert.rejects(spliceTomlFile(file,body+'extra=1\n',{platform:host,adoptExisting:true,dryRun:false,backup,
      writer:async (p,b) => { const corrupt=Buffer.from(b); corrupt[corrupt.length-2]^=1; await safewrite(p,corrupt); }}),{code:'E_OUTSIDE_RANGE'});
    const live = Buffer.from(before); live[live.length-2]^=1;
    assert.deepEqual(fs.readFileSync(file),live);
    assert.deepEqual(fs.readFileSync(backup),before);
  });
}
