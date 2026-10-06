'use strict';
/**
 * Stub Storefront: in-memory listings and FAKE receipts. Every method takes the same arguments as the real
 * Etsy adapter (storeId first where there is one). Nothing leaves the process, and nothing it returns is real:
 * receipts are marked `simulated`, and the sales ingest stores them with source 'stub' so they never reach NET.
 */
function createStub() {
  const listings = new Map();
  let seq = 0;
  return {
    implemented: true,
    async getShop() { return { hasShop: false, connected: false, stub: true, message: 'Stub storefront: no real shop is connected (no Etsy app credentials).' }; },
    buildAuthUrl() { return { url: null, stub: true, message: 'No Etsy app credentials: Etsy OAuth is not available in stub mode.' }; },
    async exchangeCode() { throw new Error('Stub storefront has no OAuth.'); },
    async refreshToken() { throw new Error('Stub storefront has no OAuth.'); },
    async getListing(_storeId, id) { return listings.get(String(id)) || null; },
    async createListing(_storeId, data) { const id = `stub-listing-${++seq}`; listings.set(id, { id, state: 'draft', ...data }); return listings.get(id); },
    async updateListing(_storeId, id, patch) { return { id: String(id), faked: true, ...patch }; },
    // READ (watchers): our OWN listing's cumulative counters. Deterministic fake data, derived from the id.
    async getListingStats(externalId) {
      let h = 0; for (const c of String(externalId)) h = (h * 31 + c.charCodeAt(0)) % 997;
      return { views: h % 40, favorites: h % 5, sales: 0, stub: true };
    },
    /**
     * One simulated paid receipt (one transaction, quantity 1, $25.00) per known listing id passed in
     * `listingIds`, with a number that rises each call so repeated syncs stay distinct. Computed fees, no payment API.
     */
    async getReceipts(_storeId, { listingIds = [], sinceTs = 0 } = {}) {
      const t = Math.floor(Date.now() / 1000);
      const receipts = listingIds.map((lid, i) => ({
        receiptId: `stub-rcpt-${lid}-${t}`, createdTs: t - i, isPaid: true, refunds: 0, currency: 'USD', processingFeeCents: null, simulated: true,
        transactions: [{ transactionId: `stub-tx-${lid}-${t}`, listingId: String(lid), quantity: 1, unitCents: 2500, shippingCents: 0, title: 'Simulated sale' }],
      }));
      return { receipts, complete: true, maxCreated: Math.max(sinceTs, t), requests: 0, simulated: true };
    },
  };
}
module.exports = { createStub };
