'use strict';
/**
 * watch/performance.js — own-listing performance watcher. OUR listings only, via the Storefront
 * adapter's read method getListingStats(externalId) -> {views, favorites, sales} (cumulative counters).
 * Alerts: zero sales after N cumulative views; sudden view drop between consecutive intervals.
 * Reads our own shop stats; no competitor data of any kind.
 */
const { intEnv } = require('./util');

async function runPerformanceWatch({ db, readers, alerts, state, log, env = process.env, hooks = {} }) {
  // M3: bring published products up to date from Etsy and ingest new receipts first, so the stats below are about
  // listings that are really live. A failure here is reported in the summary and never stops the watcher.
  const pre = [];
  for (const [name, fn] of [['reconcile', hooks.reconcile], ['sales sync', hooks.syncSales]]) {
    if (typeof fn !== 'function') continue;
    try { const r = await fn(); pre.push(`${name}: ${r && r.skipped ? 'skipped' : r && r.error ? 'error' : 'ok'}${r && r.newSales !== undefined ? ` (${r.newSales} new)` : ''}${r && r.live ? ` (${r.live} live)` : ''}`); }
    catch (e) { pre.push(`${name}: failed (${e.message})`); log.warn(`[watch] ${name} failed: ${e.message}`); }
  }
  const zeroViews = intEnv(env.WATCH_ZERO_SALES_VIEWS, 100);
  const dropPct = intEnv(env.WATCH_VIEW_DROP_PCT, 50);
  const minPrev = intEnv(env.WATCH_VIEW_DROP_MIN_PREV, 20);
  const rows = db.prepare(`SELECT l.id AS listing_id, l.external_id, l.title AS ltitle, p.id AS product_id, p.title AS ptitle
    FROM listings l JOIN products p ON p.id = l.product_id
    WHERE l.external_id IS NOT NULL AND l.external_id != '' AND p.stage IN ('published','live')`).all();
  let checked = 0, zero = 0, drops = 0, errors = 0; const sources = new Set();
  for (const r of rows) {
    try {
      const s = await readers.getListingStats(r.external_id);
      sources.add(s.source); checked++;
      const name = r.ptitle || r.ltitle || `Product ${r.product_id}`;
      const key = `perf.listing.${r.listing_id}`;
      const prev = state.get(key);
      // Etsy has no per-listing sales counter, so the real adapter reports sales: null and ingested sales are the source.
      const ingested = db.prepare("SELECT COALESCE(SUM(quantity),0) AS n FROM sales WHERE listing_id = ? AND source != 'stub'").get(r.listing_id).n;
      const views = Number(s.views) || 0, sales = Math.max(Number(s.sales) || 0, ingested), favorites = Number(s.favorites) || 0;
      const delta = prev ? Math.max(0, views - prev.views) : null;
      if (sales === 0 && views >= zeroViews) {
        zero++;
        alerts.raise({ kind: 'views_no_sales', productId: r.product_id, severity: 'warn',
          message: `${name}: ${views} views and ${favorites} favorites but no sales (threshold ${zeroViews} views).`,
          playbookId: 'views-no-sales', dedupeKey: `views_no_sales.${r.listing_id}` });
      }
      if (prev && prev.delta !== null && prev.delta >= minPrev && delta !== null && delta <= prev.delta * (100 - dropPct) / 100) {
        drops++;
        alerts.raise({ kind: 'view_drop', productId: r.product_id, severity: 'info',
          message: `${name}: views this interval ${delta}, down from ${prev.delta} (>=${dropPct}% drop).`,
          playbookId: 'views-no-sales', dedupeKey: `view_drop.${r.listing_id}.${prev.views}` });
      }
      state.set(key, { views, sales, favorites, delta, at: new Date().toISOString() });
    } catch (e) { errors++; log.warn(`[watch] listing stats read failed for listing ${r.listing_id}: ${e.message}`); }
  }
  return `checked ${checked} listing(s) [source: ${[...sources].join('+') || 'none'}]; zero-sales ${zero}, view drops ${drops}, read errors ${errors}${pre.length ? `; ${pre.join('; ')}` : ''}`;
}
module.exports = { runPerformanceWatch };
