'use strict';
const { routeAdapter } = require('../route');
const { createStub } = require('./stub');
const { createEtsy } = require('./etsy');

function create({ credentials, keystore, isDryRun, http, log }) {
  return routeAdapter({
    kind: 'storefront', stub: createStub(), real: createEtsy({ http, credentials, keystore, log }),
    hasCredential: () => credentials.has('etsy_api_key'), isDryRun, log,
  });
}
module.exports = { create };
