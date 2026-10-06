'use strict';
const { routeAdapter } = require('../route');
const { createStub } = require('./stub');
const { createEtsy } = require('./etsy');

// Real needs BOTH halves of the app credential: Etsy's x-api-key is `keystring:shared_secret`.
function create({ credentials, etsyAuth, isDryRun, http, log, env }) {
  return routeAdapter({
    kind: 'storefront', stub: createStub(), real: createEtsy({ http, etsyAuth, log, env: env || process.env }),
    hasCredential: () => credentials.has('etsy_api_key') && (credentials.has('etsy_shared_secret') || credentials.get('etsy_api_key').includes(':')), isDryRun, log,
  });
}
module.exports = { create };
