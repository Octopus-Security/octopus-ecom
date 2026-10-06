'use strict';
const { routeAdapter } = require('../route');
const { createStub } = require('./stub');
const { createPrintify } = require('./printify');

function create({ cfg, credentials, isDryRun, http, log, env }) {
  return routeAdapter({
    kind: 'pod', stub: createStub({ dataDir: cfg && cfg.dataDir }), real: createPrintify({ http, credentials, log, env: env || process.env }),
    hasCredential: () => credentials.has('printify'), isDryRun, log,
  });
}
module.exports = { create };
