// Batched provider attribute checks; retain literal paths and validate every result.
import platform from '../../src/platform/index.js';

export async function attributeBatch(files, ctx) {
  const attributes = new Map();
  if (ctx.dirs.id !== 'win32') {
    for (const file of files) attributes.set(file, await ctx.attributes(file));
    return attributes;
  }
  for (let offset = 0; offset < files.length; offset += 200) {
    const list = files.slice(offset,offset + 200);
    const probes = list.map(file => platform.fileAttributesProbe(file,ctx.env));
    const first = probes[0];
    if (!first || probes.some(p => p.file !== first.file || JSON.stringify(p.args.slice(0,-1)) !== JSON.stringify(first.args.slice(0,-1))))
      throw new Error('attribute_probe_mismatch');
    const literals = list.map(file => "'" + file.replaceAll("'","''") + "'").join(',');
    const command = "$ErrorActionPreference='Stop'; @(@(" + literals + ") | ForEach-Object { [int64](Get-Item -LiteralPath $_ -Force -ErrorAction Stop).Attributes }) | ConvertTo-Json -Compress";
    const result = ctx.run(first.file,[...first.args.slice(0,-1),command]);
    if (result.status !== 0) throw new Error('attribute_probe_failed');
    const bits = JSON.parse(result.stdout);
    if (!Array.isArray(bits) || bits.length !== list.length || bits.some(n => !Number.isFinite(n))) throw new Error('attribute_probe_payload');
    list.forEach((file,i) => attributes.set(file,{bits:bits[i]}));
  }
  return attributes;
}
