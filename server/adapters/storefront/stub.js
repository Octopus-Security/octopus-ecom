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
    // READ (watchers): our OWN listing's cumulative counters. Deterministic fake data, derived from the id.
    // Not yet in adapters/contract.js CONTRACTS (add `getListingStats: 'read'`).
    // TODO(M3, real Etsy adapter): implement getListingStats(externalId) in storefront/etsy.js
    // -> {views, favorites, sales}; which Etsy endpoint/scope supplies views is assumed, unverified.
    async getListingStats(externalId) {
      let h = 0; for (const c of String(externalId)) h = (h * 31 + c.charCodeAt(0)) % 997;
      return { views: h % 40, favorites: h % 5, sales: 0, stub: true };
    },
    async getReceipts() { return []; },
  };
}
module.exports = { createStub };
