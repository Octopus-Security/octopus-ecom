'use strict';
/**
 * trends/metrics.js — the NUMERIC-METRICS validator (spec 5.4 / decision 3), beside watch/trend.js's FORBIDDEN_KEYS.
 *
 * POLICY (recorded in docs/COMPLIANCE.md section 6; the owner must accept this widening):
 *  - The text-signal path is UNCHANGED and strict: validateSignals() still accepts only {message, severity} and still
 *    rejects `price`, `listing`, `title`, ... FORBIDDEN_KEYS is not edited and not consulted here to LOOSEN anything.
 *  - Numbers are a second, separate path. A persisted metric is {term, source, metric, value, n?, week, label?}:
 *      term    a phrase WE supplied (a watchlist term, or one from a file the owner chose). It must be in the caller's
 *              allowedTerms set, so a string lifted out of a response body can never be stored as a "term".
 *      metric  a name from the closed WHITELIST below. A new metric is a code change plus a test, never an input.
 *      value   a finite number. No strings, no objects.
 *      n       how many items the aggregate was derived from. Aggregates over market listings (etm_*) need n >= 20, so
 *              no single listing can be identifiable from a stored number.
 *  - Any other key, any FORBIDDEN_KEYS-shaped key, a non-numeric value, an unknown source or an unlisted term rejects the
 *    whole batch (nothing is partially stored).
 */
const { FORBIDDEN_KEYS } = require('../watch/trend');

const MIN_AGGREGATE_N = 20;
const SOURCES = ['wikipedia', 'etsy-market', 'csv'];
const WHITELIST = {
  // wikipedia: attention to a topic (a proxy, not purchase intent)
  wp_level: 'wikipedia', wp_rise: 'wikipedia', wp_season_ratio: 'wikipedia', wp_low_volume: 'wikipedia',
  // etsy-market: aggregates of public active listings for one keyword phrase; prices in integer cents
  etm_count: 'etsy-market', etm_count_wow: 'etsy-market', etm_velocity: 'etsy-market', etm_sat: 'etsy-market',
  etm_price_p25: 'etsy-market', etm_price_p50: 'etsy-market', etm_price_p75: 'etsy-market',
  etm_fav_p25: 'etsy-market', etm_fav_p50: 'etsy-market', etm_fav_p75: 'etsy-market', etm_fav_per_week: 'etsy-market',
  etm_top_taxonomy_share: 'etsy-market', etm_sample_n: 'etsy-market',
  // csv: keyword-level estimates from a licensed tool the owner exported by hand (model outputs, not marketplace data)
  csv_volume_est: 'csv', csv_competition_est: 'csv', csv_trend_pct: 'csv', csv_sold_est: 'csv', csv_price_avg: 'csv',
};
const METRICS = Object.keys(WHITELIST);
const ALLOWED_KEYS = new Set(['term', 'source', 'metric', 'value', 'n', 'week', 'label']);

function validateMetrics(rows, { allowedTerms } = {}) {
  if (!Array.isArray(rows)) throw new Error('metrics must be an array');
  if (!(allowedTerms instanceof Set)) throw new Error('validateMetrics needs the set of terms we supplied (allowedTerms)');
  return rows.map((r, i) => {
    const at = `metric ${i}`;
    if (!r || typeof r !== 'object') throw new Error(`${at} rejected: not an object`);
    const extra = Object.keys(r).filter(k => !ALLOWED_KEYS.has(k));
    if (extra.length) {
      const forb = extra.filter(k => FORBIDDEN_KEYS.includes(k.toLowerCase()));
      throw new Error(`${at} rejected: unexpected field(s) ${extra.join(', ')}${forb.length ? ' (competitor-data shaped)' : ''}`);
    }
    if (!SOURCES.includes(r.source)) throw new Error(`${at} rejected: unknown source "${r.source}"`);
    if (!METRICS.includes(r.metric)) throw new Error(`${at} rejected: metric "${r.metric}" is not whitelisted`);
    if (WHITELIST[r.metric] !== r.source) throw new Error(`${at} rejected: ${r.metric} does not belong to ${r.source}`);
    if (typeof r.value !== 'number' || !Number.isFinite(r.value)) throw new Error(`${at} rejected: value must be a finite number`);
    if (typeof r.term !== 'string' || !allowedTerms.has(r.term)) throw new Error(`${at} rejected: term was not supplied by us`);
    if (r.n !== undefined && (!Number.isInteger(r.n) || r.n < 0)) throw new Error(`${at} rejected: n must be a non-negative integer`);
    if (r.source === 'etsy-market' && r.metric !== 'etm_count' && r.metric !== 'etm_count_wow' && r.metric !== 'etm_sat' && !(r.n >= MIN_AGGREGATE_N)) {
      throw new Error(`${at} rejected: a market aggregate needs n >= ${MIN_AGGREGATE_N} so no single listing is identifiable`);
    }
    if (typeof r.week !== 'string' || !/^\d{4}-W\d{2}$/.test(r.week)) throw new Error(`${at} rejected: week must look like 2026-W41`);
    if (r.label !== undefined && (typeof r.label !== 'string' || r.label.length > 40)) throw new Error(`${at} rejected: label must be a short string`);
    return { term: r.term, source: r.source, metric: r.metric, value: r.value, n: r.n === undefined ? null : r.n, week: r.week, label: r.label || '' };
  });
}

/** Validates, then upserts one row per (term, source, label, metric, week) in a single transaction. Returns how many rows. */
function storeMetrics(db, rows, { allowedTerms, now = () => new Date() } = {}) {
  const clean = validateMetrics(rows, { allowedTerms });
  const stamp = now().toISOString();
  const up = db.prepare(`INSERT INTO trend_metrics(term, source, label, metric, value, n, week, created_at) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(term, source, label, metric, week) DO UPDATE SET value=excluded.value, n=excluded.n, created_at=excluded.created_at`);
  db.exec('BEGIN');
  try { for (const m of clean) up.run(m.term, m.source, m.label, m.metric, m.value, m.n, m.week, stamp); db.exec('COMMIT'); }
  catch (e) { try { db.exec('ROLLBACK'); } catch { /* gone */ } throw e; }
  return clean.length;
}

/** The newest stored value of a metric for a term (any week), optionally not older than `sinceWeek`. null when none. */
function latest(db, term, metric, { source, minWeek } = {}) {
  const r = db.prepare(`SELECT value, n, week, label, source, created_at FROM trend_metrics
    WHERE term = ? AND metric = ? ${source ? 'AND source = ?' : ''} ${minWeek ? 'AND week >= ?' : ''} ORDER BY week DESC, id DESC LIMIT 1`)
    .get(...[term, metric, ...(source ? [source] : []), ...(minWeek ? [minWeek] : [])]);
  return r || null;
}

module.exports = { WHITELIST, METRICS, SOURCES, MIN_AGGREGATE_N, validateMetrics, storeMetrics, latest };
