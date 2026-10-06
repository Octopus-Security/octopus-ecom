'use strict';
/**
 * watch/readers.js — how watchers reach READ methods on the adapters.
 *
 * `adapters.pod` / `adapters.storefront` are built by adapters/route.js, which only exposes
 * methods named in adapters/contract.js CONTRACTS. Until that table gains
 *   pod.getAvailability: 'read'   and   storefront.getListingStats: 'read'
 * (see INTEGRATION.md) the routed adapter does not carry them, so we fall back to a private
 * STUB instance: watchers still run, on stub data, and say so in the run summary. Once the
 * contract is extended the routed adapter is used and real reads go through adapters/http.js.
 * No fake data is ever labelled real: every reader reports `source: 'stub' | 'adapter'`.
 */
const podStub = require('../adapters/pod/stub');
const storeStub = require('../adapters/storefront/stub');

function makeReaders(adapters = {}) {
  const fallbackPod = podStub.createStub();
  const fallbackStore = storeStub.createStub();
  const has = (a, m) => a && typeof a[m] === 'function';
  // The routed adapter falls back to its stub per call; ask it, so a run is never labelled real when it was not.
  const routedReal = (a, m) => { try { return !a.describe || a.describe().methods[m] === 'real'; } catch { return true; } };
  return {
    async getVariantCosts(blueprint, provider, opts) {
      if (has(adapters.pod, 'getVariantCosts')) return { source: routedReal(adapters.pod, 'getVariantCosts') ? 'adapter' : 'stub', ...(await adapters.pod.getVariantCosts(blueprint, provider, opts)) };
      return { source: 'stub', ...(await fallbackPod.getVariantCosts(blueprint, provider, opts)) };
    },
    async getAvailability(blueprint, provider) {
      if (has(adapters.pod, 'getAvailability')) return { source: routedReal(adapters.pod, 'getAvailability') ? 'adapter' : 'stub', ...(await adapters.pod.getAvailability(blueprint, provider)) };
      return { source: 'stub', ...(await fallbackPod.getAvailability(blueprint, provider)) };
    },
    async getListingStats(externalId) {
      if (has(adapters.storefront, 'getListingStats')) return { source: routedReal(adapters.storefront, 'getListingStats') ? 'adapter' : 'stub', ...(await adapters.storefront.getListingStats(externalId)) };
      return { source: 'stub', ...(await fallbackStore.getListingStats(externalId)) };
    },
  };
}
module.exports = { makeReaders };
