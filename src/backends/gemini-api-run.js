// Owns the supervised Gemini HTTPS child entry point; specification §6.3.
'use strict';
// Plaintext parsing and network handling stay in the sole key-owning module.
if(require.main===module) require('../lib/secrets').runApi();
