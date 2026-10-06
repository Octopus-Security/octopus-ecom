'use strict';
const { routeAdapter } = require('../route');
const { createStub } = require('./stub');
const { createOpenAiImages } = require('./openai');

function create({ cfg, credentials, isDryRun, http, log }) {
  return routeAdapter({
    kind: 'imagegen', stub: createStub({ dataDir: cfg.dataDir }),
    real: createOpenAiImages({ http, credentials, log }),
    hasCredential: () => credentials.has('openai'), isDryRun, log,
  });
}
module.exports = { create };
