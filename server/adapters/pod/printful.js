'use strict';
// Printful: signature-only scaffold, deliberately never implemented in this milestone
// sequence. It exists so the PODProvider contract is proven to fit a second provider.
// Nothing about the Printful API is assumed here.
const { NotImplemented } = require('../contract');

function createPrintful(/* { http, credentials, log } */) {
  const ni = n => async () => { throw new NotImplemented(`pod.printful.${n}`); };
  return {
    implemented: false,
    listBlueprints: ni('listBlueprints'), listPrintProviders: ni('listPrintProviders'), getVariantCosts: ni('getVariantCosts'),
    createProduct: ni('createProduct'), getMockups: ni('getMockups'), publish: ni('publish'),
  };
}
module.exports = { createPrintful };
