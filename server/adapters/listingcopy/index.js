'use strict';
const { routeAdapter } = require('../route');
const { createStub } = require('./stub');
const { createLlmCopy } = require('./llm');

function create({ llm, isDryRun, log }) {
  return routeAdapter({
    kind: 'listingcopy', stub: createStub(), real: createLlmCopy({ llm }),
    hasCredential: () => llm.describe().provider !== 'stub', isDryRun, log,
  });
}
module.exports = { create };
