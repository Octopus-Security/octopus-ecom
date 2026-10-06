'use strict';
/** Stub PODProvider: fake blueprints, costs, product and mockups. Nothing leaves the process. */
function createStub() {
  const products = new Map();
  let seq = 0;
  const blueprints = [
    { id: 'stub-tee', title: 'Unisex Tee (stub)', printArea: { width: 4500, height: 5400, dpi: 150 } },
    { id: 'stub-mug', title: '11oz Mug (stub)', printArea: { width: 2475, height: 1155, dpi: 300 } },
  ];
  return {
    implemented: true,
    async listBlueprints() { return blueprints; },
    async listPrintProviders(blueprintId) { return [{ id: 'stub-pp', title: 'Stub Print Provider', blueprintId }]; },
    async getVariantCosts(blueprintId /*, providerId */) {
      return { currency: 'USD', variants: [{ id: `${blueprintId}-m`, title: 'M', costCents: blueprintId === 'stub-mug' ? 650 : 1250 }] };
    },
    // READ (watchers). Added for the product-watch feature; NOT yet in adapters/contract.js CONTRACTS, so
    // routed adapters do not expose it until the contract gains `getAvailability: 'read'`.
    // TODO(M2, real Printify adapter): implement getAvailability(blueprintId, providerId) in pod/printify.js
    // as {variants:[{id,title,inStock}]} from the provider's variant listing (source unverified).
    async getAvailability(blueprintId /*, providerId */) {
      return { variants: [{ id: `${blueprintId}-m`, title: 'M', inStock: true }] };
    },
    async createProduct({ blueprintId, providerId, title }) {
      const externalId = `stub-prod-${++seq}`;
      products.set(externalId, { externalId, blueprintId, providerId, title, published: false });
      return { externalId, baseCostCents: blueprintId === 'stub-mug' ? 650 : 1250, faked: true };
    },
    async getMockups(externalId) { return [{ url: `stub://mockup/${externalId}/front`, placement: 'front' }]; },
    async publish(externalId /*, storeRef */) {
      const p = products.get(externalId);
      if (p) p.published = true;
      return { ok: true, faked: true, externalId };
    },
  };
}
module.exports = { createStub };
