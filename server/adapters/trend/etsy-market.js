'use strict';
/**
 * adapters/trend/etsy-market.js — the ETSY MARKET source: AGGREGATES of public active listings for a keyword phrase.
 *
 * Endpoint: GET /v3/application/listings/active (findAllListingsActive; params keywords, limit, sort_on, sort_order,
 * taxonomy_id ...; response {count, results[]}, each result with created_timestamp, num_favorers, price {amount, divisor,
 * currency_code}, taxonomy_id). verified 2026-10-06 - Etsy's OpenAPI document https://www.etsy.com/openapi/generated/oas/3.0.0.json,
 * downloaded and parsed for the spec (octopus-vault/memory/ecom-trend-sources.md 2.1). That the endpoint needs only the
 * x-api-key header and no OAuth token is the spec's reading of the same document (no operation-level security). It has NEVER been
 * called from this app against live Etsy: behaviour (including what an unapproved app receives) is assumed, unverified.
 *
 * TERMS RISK — why this ships DISABLED. corroborated only, from search-result summaries (Etsy's legal pages returned HTTP 403):
 * the API Terms reportedly bar using the API "to collect, scan, or otherwise request Etsy content for analytics, machine learning,
 * licensing ... unless expressly authorized". Counting and pricing listings is analytics on Etsy content. So the source is OFF
 * until the owner turns it on through a confirm-gated action (routes.js) that tells them to read the live terms first, and it is
 * also off while Etsy credentials are missing or Etsy has refused the key (401/403 flips a "blocked" setting).
 *
 * WHAT IS STORED: numbers only. count, quartile prices (cents), new-listing velocity, favourites distribution, taxonomy
 * concentration. Never a title, tag, description, image, URL, shop name/id or listing id. This function reads those response
 * fields only to compute a number in memory and returns nothing but whitelisted metric rows; trends/metrics.js rejects anything
 * else, and a test asserts the stored rows contain none of it. It never calls a shop endpoint.
 *
 * RATE LIMITS: every request goes through adapters/http.js, whose per-host bucket for api.etsy.com (ETSY_QPS, default 4) and
 * rolling daily budget (ETSY_QPD, default 4000) are the same ones the storefront adapter uses. On top of that this source
 * stops when the remaining daily allowance is at or below ETSY_QPD_RESERVE (default 20): by the local tally (http.budget) and by
 * Etsy's own x-remaining-today header. Reads only, so DRY_RUN does not change it.
 */
const D = require('../../trends/dates');

const BASE = 'https://api.etsy.com';
const HOST = 'api.etsy.com';
const SAMPLE = 100;
const CONFIRM_SUMMARY = "Read Etsy's current API Terms first; search summaries suggest analytics use may need Etsy's authorisation.";

/** Linear-interpolated quantile of a sorted numeric array. */
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q; const lo = Math.floor(pos); const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
const sortNum = (a) => [...a].sort((x, y) => x - y);

/**
 * Pure: an Etsy response -> metrics object (no identifiers survive). `nowSec` is epoch seconds.
 * Distribution metrics exist only when the sample has >= 20 listings.
 */
function aggregate(body, nowSec) {
  const count = Number(body && body.count);
  if (!Number.isFinite(count) || count < 0) throw new Error('Etsy returned no usable count');
  const results = Array.isArray(body.results) ? body.results : [];
  const out = { etm_count: count, etm_sat: Math.min(1, Math.max(0, (Math.log10(Math.max(count, 1)) - 3) / 3)) };
  const n = results.length; out.n = n;
  if (n < 20) return out;
  const usd = results.filter(r => r && r.price && r.price.currency_code === 'USD' && Number(r.price.divisor) > 0 && Number.isFinite(Number(r.price.amount)));
  const cents = sortNum(usd.map(r => Math.round(Number(r.price.amount) * 100 / Number(r.price.divisor))));
  if (cents.length >= 20) { out.etm_price_p25 = Math.round(quantile(cents, 0.25)); out.etm_price_p50 = Math.round(quantile(cents, 0.5)); out.etm_price_p75 = Math.round(quantile(cents, 0.75)); }
  const fav = sortNum(results.map(r => Number(r && r.num_favorers)).filter(Number.isFinite));
  if (fav.length >= 20) { out.etm_fav_p25 = quantile(fav, 0.25); out.etm_fav_p50 = quantile(fav, 0.5); out.etm_fav_p75 = quantile(fav, 0.75); }
  const ts = results.map(r => Number(r && r.created_timestamp)).filter(t => Number.isFinite(t) && t > 0);
  if (ts.length >= 20) {
    const span = (Math.max(...ts) - Math.min(...ts)) / 86400;
    if (count >= 500 && span > 0) out.etm_velocity = ts.length / span;                 // newest-100 sample only means something when the market is bigger than the sample
    const perWeek = sortNum(results.filter(r => Number.isFinite(Number(r.created_timestamp)) && Number.isFinite(Number(r.num_favorers)))
      .map(r => Number(r.num_favorers) / Math.max(1, (nowSec - Number(r.created_timestamp)) / (7 * 86400))));
    if (perWeek.length >= 20) out.etm_fav_per_week = quantile(perWeek, 0.5);           // engagement per week of age, NOT sales
  }
  const tax = new Map();
  for (const r of results) if (r && r.taxonomy_id !== undefined && r.taxonomy_id !== null) tax.set(r.taxonomy_id, (tax.get(r.taxonomy_id) || 0) + 1);
  if (tax.size) out.etm_top_taxonomy_share = Math.max(...tax.values()) / n;
  out.etm_sample_n = n;
  return out;
}

function createEtsyMarket({ http, etsyAuth, settings, db, env = {}, now = () => new Date(), log = { info() {}, warn() {} } } = {}) {
  const reserve = () => (Number(env.ETSY_QPD_RESERVE) >= 0 && env.ETSY_QPD_RESERVE !== undefined && env.ETSY_QPD_RESERVE !== '' ? Number(env.ETSY_QPD_RESERVE) : 20);

  function enabled() {
    if (settings.get('trend_etsy_market_enabled') !== 'true') return { enabled: false, reason: 'Off by default. Turn it on in Trends after reading Etsy\'s current API Terms.' };
    let app; try { app = etsyAuth.app(); } catch { return { enabled: false, reason: 'Etsy auth is not wired.' }; }
    if (app.missing && app.missing.length) return { enabled: false, reason: `Etsy credentials are missing: ${app.missing.join(' and ')}.` };
    const blocked = settings.get('trend_etsy_market_blocked');
    if (blocked) return { enabled: false, reason: `Etsy refused the app key on ${blocked} (HTTP 401/403): the app may be unapproved, or the terms bar this use. Turn it on again to retry.` };
    return { enabled: true, reason: '' };
  }

  /**
   * collect({queries:[{phrase, taxonomyId?}], week, maxCalls}) -> {status, detail, rows, calls, stopped}
   * Sequential. `rows` are unvalidated metric rows keyed by the phrase WE built.
   */
  async function collect({ queries, week, maxCalls = 60 }) {
    const en = enabled();
    if (!en.enabled) return { source: 'etsy-market', status: 'disabled', detail: en.reason, rows: [], calls: 0 };
    const app = etsyAuth.app();
    const rows = []; let calls = 0; let ok = 0; let stopped = ''; let errors = 0;
    const nowSec = Math.floor(now().getTime() / 1000);
    for (const q of queries) {
      if (calls >= maxCalls) { stopped = `call cap for this run reached (${maxCalls})`; break; }
      const b = typeof http.budget === 'function' ? http.budget(HOST) : null;
      if (b && b.perDay && b.perDay - b.used <= reserve()) { stopped = `daily allowance reserve reached (${b.perDay - b.used} left, reserve ${reserve()})`; break; }
      const params = new URLSearchParams({ keywords: q.phrase, limit: String(SAMPLE), sort_on: 'created', sort_order: 'desc' });
      if (q.taxonomyId) params.set('taxonomy_id', String(q.taxonomyId));
      let res;
      try {
        calls++;
        res = await http.request(`${BASE}/v3/application/listings/active?${params}`, { headers: { 'x-api-key': app.header, Accept: 'application/json' } });
      } catch (e) {
        if (e && (e.status === 401 || e.status === 403)) { settings.set('trend_etsy_market_blocked', D.etDay(now())); return { source: 'etsy-market', status: 'disabled', detail: `Etsy answered HTTP ${e.status} to the public listing search: the app is probably unapproved or the use is not permitted. Source switched off.`, rows, calls }; }
        if (e && e.status === 429) { stopped = 'Etsy or the local daily budget refused further requests (429)'; break; }
        errors++; log.warn(`[trend] etsy market query failed: ${e.message}`); continue;
      }
      const left = res.headers && typeof res.headers.get === 'function' ? res.headers.get('x-remaining-today') : null;
      let m;
      try { m = aggregate(res.json(), nowSec); } catch (e) { errors++; log.warn(`[trend] etsy market response unusable: ${e.message}`); continue; }
      ok++;
      const n = m.n; delete m.n;
      const prev = db.prepare("SELECT value FROM trend_metrics WHERE term = ? AND source = 'etsy-market' AND metric = 'etm_count' AND week < ? ORDER BY week DESC LIMIT 1").get(q.phrase, week);
      if (prev && prev.value > 0) m.etm_count_wow = m.etm_count / prev.value - 1;
      for (const [metric, value] of Object.entries(m)) rows.push({ term: q.phrase, source: 'etsy-market', metric, value, n, week });
      if (left !== null && left !== undefined && left !== '' && Number(left) <= reserve()) { stopped = `Etsy reports ${left} requests left today (reserve ${reserve()})`; break; }
    }
    const status = ok ? 'ok' : errors ? 'error' : 'no_data';
    return { source: 'etsy-market', status, rows, calls, stopped, detail: `${ok}/${queries.length} phrase(s) read in ${calls} call(s)${errors ? `, ${errors} error(s)` : ''}${stopped ? `; stopped: ${stopped}` : ''}` };
  }

  return {
    kind: 'trend', name: 'etsy-market',
    describe: () => 'Etsy market: aggregate counts and price bands of public active listings (numbers only). Disabled by default; terms risk.',
    enabled, collect,
    async check() { return []; },
  };
}

module.exports = { createEtsyMarket, aggregate, quantile, CONFIRM_SUMMARY, SAMPLE };
