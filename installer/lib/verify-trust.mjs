// Child read-only probe: profile expansion and binary guards use this process's env.
import profile from '../../src/lib/profile.js';
import guard from '../../src/lib/guard.js';
import agy from '../../src/backends/gemini-agy.js';
import paths from '../../src/lib/paths.js';
const loaded=profile.resolve();
const checked=guard.checkConfigTrust(loaded);
const gate=loaded.config?agy.available({config:loaded.config,paths:paths.computePaths(loaded.config)}):{reason:'config_unavailable'};
process.stdout.write(JSON.stringify({ok:checked.ok,failures:checked.failures,allowed_roots:checked.allowed_roots,agy:{reason:gate.reason||'available',notice:'see NOTICE.md'}})+'\n');
