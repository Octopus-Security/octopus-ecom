'use strict';
function intEnv(v, fallback) { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : fallback; }
module.exports = { intEnv };
