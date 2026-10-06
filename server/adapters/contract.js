'use strict';
/**
 * adapters/contract.js — the narrow interface of each adapter kind.
 * Each method is tagged:
 *   read  - external read; goes to the real API when a credential is present, even in DRY_RUN
 *   write - external marketplace/POD write; REAL only with a credential AND DRY_RUN off, else faked
 *   spend - costs money but is not a marketplace write (image/LLM generation); real whenever a
 *           key is present, governed by the daily cap
 */
const CONTRACTS = {
  imagegen:    { generate: 'spend' },
  pod:         { listBlueprints: 'read', listPrintProviders: 'read', listVariants: 'read', getVariantCosts: 'read', getAvailability: 'read', createProduct: 'write', getMockups: 'read', getShopInfo: 'read', getPublishState: 'read', publish: 'write' },
  storefront:  { getShop: 'read', buildAuthUrl: 'read', exchangeCode: 'read', refreshToken: 'read', getListing: 'read', createListing: 'write', updateListing: 'write', getReceipts: 'read', getListingStats: 'read' },
  trend:       { suggest: 'read' },
  listingcopy: { generate: 'spend' },
};

/** Throws if impl lacks any method of the kind's contract. */
function assertAdapter(kind, impl) {
  const missing = Object.keys(CONTRACTS[kind]).filter(m => typeof impl[m] !== 'function');
  if (missing.length) throw new Error(`${kind} adapter is missing: ${missing.join(', ')}`);
  return impl;
}

class NotImplemented extends Error {
  constructor(what) { super(`${what} is not implemented yet`); this.name = 'NotImplemented'; }
}

module.exports = { CONTRACTS, assertAdapter, NotImplemented };
