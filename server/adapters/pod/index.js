'use strict';
const { routeAdapter } = require('../route');
const { createStub } = require('./stub');
const { createPrintify } = require('./printify');

function create({ credentials, isDryRun, http, log }) {
  return routeAdapter({
    kind: 'pod', stub: createStub(), real: createPrintify({ http, credentials, log }),
    hasCredential: () => credentials.has('printify'), isDryRun, log,
  });
}
module.exports = { create };
