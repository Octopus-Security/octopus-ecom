'use strict';
const { routeAdapter } = require('../route');
const { createStub } = require('./stub');

function create({ isDryRun, log }) {
  return routeAdapter({ kind: 'trend', stub: createStub(), real: null, hasCredential: () => false, isDryRun, log });
}
module.exports = { create };
