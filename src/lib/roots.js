// Owns derived executable roots; specification §4.6.
'use strict';
const path = require('path'), platform = require('../platform');
function allowedRoots(machine) {
  return [...new Set(platform.allowedRootsBase(machine || {}).filter(Boolean).map(p => p.endsWith(path.sep) ? p : p + path.sep))];
}
module.exports = { allowedRoots };
