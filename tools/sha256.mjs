// Exact first-token digest consumed by the update zip channel.
import fs from 'node:fs';
import crypto from 'node:crypto';
try {
  if (process.argv.length !== 3) throw new Error('usage: sha256.mjs <file>');
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(process.argv[2])) hash.update(chunk);
  process.stdout.write(hash.digest('hex') + '\n');
} catch (error) { process.stderr.write('sha256: ' + error.message + '\n'); process.exitCode = 1; }
