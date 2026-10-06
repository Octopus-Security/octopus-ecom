'use strict';
/** Stub Storefront: in-memory listings and fake receipts. */
function createStub() {
  const listings = new Map();
  let seq = 0;
  return {
    implemented: true,
    async getShop() { return { connected: false, stub: true, message: 'Stub storefront: no real shop is connected.' }; },
    buildAuthUrl() { return { url: null, stub: true, message: 'OAuth is not available in stub mode (M3).' }; },
    async exchangeCode() { throw new Error('Stub storefront has no OAuth (M3).'); },
    async refreshToken() { throw new Error('Stub storefront has no OAuth (M3).'); },
    async getListing(id) { return listings.get(id) || null; },
    async createListing(data) { const id = `stub-listing-${++seq}`; listings.set(id, { id, status: 'draft', ...data }); return listings.get(id); },
    async updateListing(id, patch) { const l = listings.get(id); if (!l) throw new Error(`No stub listing ${id}`); Object.assign(l, patch); return l; },
    async getReceipts() { return []; },
  };
}
module.exports = { createStub };
