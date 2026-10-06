'use strict';
// TODO(M2): Printify adapter — signature-only scaffold in M0.
// Base URL https://api.printify.com/v1 and Bearer-token auth: assumed, unverified
// (Printify docs were not read this session). Endpoints, rate limits and webhook
// shapes must be verified against developers.printify.com before M2 relies on them.
const { NotImplemented } = require('../contract');

function createPrintify(/* { http, credentials, log } */) {
  const ni = n => async () => { throw new NotImplemented(`pod.printify.${n} (M2)`); };
  return {
    implemented: false,
    listBlueprints: ni('listBlueprints'), listPrintProviders: ni('listPrintProviders'), getVariantCosts: ni('getVariantCosts'),
    createProduct: ni('createProduct'), getMockups: ni('getMockups'), publish: ni('publish'),
  };
}
module.exports = { createPrintify };
