// Owns platform selection, the only runtime platform read; specification §3.
'use strict';
const id = process.platform;
module.exports = require('./' + (['win32', 'darwin', 'linux'].includes(id) ? id : 'unsupported') + '.js');
