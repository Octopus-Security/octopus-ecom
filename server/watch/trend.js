'use strict';
/**
 * watch/trend.js — pluggable TrendSource. Interface:
 *   { name, describe() -> string, check(entry) -> Promise<Signal[]> }
 *   Signal = { message: string, severity?: 'info'|'warn' }
 * The ONLY implementation is manual: the operator's own keywords and notes, no data fetched.
 *
 * GUARDRAIL (decisions 11): no competitor listing titles, images, shop data, prices. validateSignals()
 * rejects any signal carrying fields that could hold such data, so a future source cannot smuggle them
 * through the alert path.
 *
 * PROPOSAL, NOT IMPLEMENTED — needs Etsy API ToS check: an aggregate count (e.g. number of active
 * listings for a keyword) might be a legitimate demand/saturation signal. Not built; whether the
 * Open API terms permit storing it is unchecked (assumed, unverified).
 */
const FORBIDDEN_KEYS = ['title', 'titles', 'image', 'images', 'img', 'url', 'urls', 'link', 'shop', 'shops', 'seller', 'listing', 'listings', 'price', 'prices', 'thumbnail'];

function validateSignals(signals) {
  if (!Array.isArray(signals)) throw new Error('TrendSource.check must return an array of signals');
  return signals.map(s => {
    const bad = Object.keys(s || {}).filter(k => !['message', 'severity'].includes(k));
    if (bad.length) {
      const forbidden = bad.filter(k => FORBIDDEN_KEYS.includes(k.toLowerCase()));
      throw new Error(`trend signal rejected: unexpected field(s) ${bad.join(', ')}${forbidden.length ? ' (competitor-data shaped)' : ''}`);
    }
    if (typeof s.message !== 'string' || !s.message) throw new Error('trend signal needs a message');
    return { message: s.message.slice(0, 500), severity: s.severity === 'warn' ? 'warn' : 'info' };
  });
}

function createManualTrendSource() {
  return {
    name: 'manual',
    describe: () => 'Manual: the operator maintains the watchlist by hand; no market data is fetched.',
    async check() { return []; },
  };
}
module.exports = { createManualTrendSource, validateSignals, FORBIDDEN_KEYS };
