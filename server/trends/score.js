'use strict';
/**
 * trends/score.js — the opportunity score per (theme x product type), exactly the spec's formula
 * (octopus-vault/memory/ecom-trend-sources.md 5.2):
 *
 *   raw   = D^0.30 * R^0.15 * S^0.20 * C^0.25 * P^0.10        weighted geometric mean, weights sum to 1.00
 *   score = 100 * raw * (0.5 + 0.5*K)
 *   score = 0 if the trademark blocklist flags the theme       (same checkBlocklist() the keyword watcher uses)
 *
 * D demand, R rising, S season, C competition, P price, K confidence (the share of the five parts backed by real data rather
 * than a neutral default, floor 0.4). A geometric mean is deliberate: no demand or total saturation cannot be rescued by season.
 * Inputs are normalised to [0.05, 1]: by percentile rank within the watchlist once >= 20 themes have that input, otherwise by
 * the fixed anchors below.
 *
 * Every number here is a PROXY. No source reports other sellers' sales; D is attention (or a tool's estimated searches), C is
 * supply. "High demand, low competition" is a hypothesis to test with 3-5 designs, not a forecast.
 */
const D = require('./dates');
const { PRODUCT_TYPES, PRODUCT_WORDS } = require('./season-table');
const { latest } = require('./metrics');
const { checkBlocklist } = require('../domain/blocklist');
const { loadSchedule } = require('../domain/fee-schedule');
const { minListPrice } = require('../domain/fees');

/**
 * WEIGHTS ARE A STARTING GUESS, NOT FITTED: assumed, untested (2026-10-06). RECALIBRATE after 8-12 weeks: rank-correlate the
 * score a theme had when we launched it (trend_scores) with its views and sales 30 days later (the report's "our launches"
 * section is that data), then re-fit the weights or drop parts that do not predict. They sum to 1.00; a test enforces it.
 */
const WEIGHTS = { D: 0.30, R: 0.15, S: 0.20, C: 0.25, P: 0.10 };
/** What a part is when no source has data for it. Chosen to be unremarkable (assumed): neither rescues nor sinks a theme. */
const NEUTRAL = { D: 0.30, R: 0.35, S: 0.60, C: 0.50, P: 0.50 };
const MIN_CONFIDENCE = 0.4;
const FLOOR = 0.05;
/** Fixed anchors for fewer than PERCENTILE_MIN themes (spec 5.2 table). */
const ANCHORS = { wpViewsPerDayFull: 5000, csvVolumePerMonthFull: 10000 };   // the csv anchor is an assumption: tools quote monthly searches
const PERCENTILE_MIN = 20;
const FRESH_DAYS = 60;           // a stored metric older than this is not used
const MANUAL_DAYS = 21;
const MANUAL_R = { rising: 0.8, flat: 0.4, falling: 0.15 };
const clip = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const r3 = (x) => Math.round(x * 1000) / 1000;

/** Pure combine. parts {D,R,S,C,P} in (0,1]; k in [0.4,1]; blocked -> 0. */
function combine(parts, k, { blocked = false, weights = WEIGHTS } = {}) {
  const raw = Object.keys(weights).reduce((acc, key) => acc * Math.pow(parts[key], weights[key]), 1);
  const score = blocked ? 0 : 100 * raw * (0.5 + 0.5 * k);
  return { raw, score };
}
const confidenceOf = (realCount) => Math.max(MIN_CONFIDENCE, realCount / 5);

function phraseFor(theme, type) { return `${theme} ${PRODUCT_WORDS[type].suffix}`; }
function wordsMatch(term, type) { return PRODUCT_WORDS[type].words.some(w => ` ${term} `.includes(` ${w} `)); }
const hasAnyTypeWord = (term) => PRODUCT_TYPES.some(t => wordsMatch(term, t));

/** Lowest price that clears the margin floor for a product type, from an owner-set base cost or our own catalogue. null if neither. */
function priceFloor({ db, settings, type }) {
  let base = null; let from = null;
  try { const o = JSON.parse(settings.get('trend_base_cost_cents') || '{}'); if (Number.isInteger(o[type]) && o[type] >= 0) { base = o[type]; from = 'setting'; } } catch { /* ignore */ }
  if (base === null) {
    const costs = db.prepare("SELECT pod_base_cost_cents AS c, lower(coalesce(title,'') || ' ' || coalesce(niche,'') || ' ' || coalesce(blueprint,'')) AS t FROM products WHERE pod_base_cost_cents IS NOT NULL")
      .all().filter(r => wordsMatch(r.t.replace(/[^a-z0-9 -]+/g, ' '), type)).map(r => r.c).sort((a, b) => a - b);
    if (costs.length) { base = costs[Math.floor((costs.length - 1) / 2)]; from = 'catalogue'; }
  }
  if (base === null) return null;
  try {
    const floor = settings.getInt('margin_floor_cents', 200);
    return { cents: minListPrice({ podBaseCostCents: base, marginCents: floor }, loadSchedule(settings)).listPriceCents, baseCents: base, from };
  } catch { return null; }
}

function makeScorer({ db, settings, season, manual, now = () => new Date(), weights = WEIGHTS }) {
  function themes() { return db.prepare("SELECT term FROM watchlist WHERE active = 1 AND kind = 'theme' ORDER BY term").all().map(r => r.term); }

  /** Gather the raw inputs for one (theme, type); no normalisation yet. */
  function gather(theme, type, today, minWeek) {
    const L = (term, metric, source) => latest(db, term, metric, { source, minWeek });
    const phrase = phraseFor(theme, type);
    const inp = { theme, type, phrase, today, notes: [] };
    // D: a tool's volume estimate replaces the Wikipedia level when present (spec 5.1), and is flagged as an estimate.
    const csvRows = db.prepare("SELECT term, label, value, week FROM trend_metrics WHERE source = 'csv' AND metric = 'csv_volume_est' AND week >= ? ORDER BY week DESC").all(minWeek)
      .filter(r => r.term === theme || (r.term.includes(theme) && !hasAnyTypeWord(r.term)));
    const wpLevel = L(theme, 'wp_level', 'wikipedia'); const wpLow = L(theme, 'wp_low_volume', 'wikipedia'); const wpRise = L(theme, 'wp_rise', 'wikipedia');
    if (csvRows.length) { const best = csvRows.sort((a, b) => b.value - a.value)[0]; inp.d = { kind: 'csv', value: best.value, label: best.label, week: best.week }; }
    else if (wpLevel) inp.d = { kind: 'wp', value: wpLevel.value, week: wpLevel.week };
    // R
    inp.wp = { level: wpLevel ? wpLevel.value : null, low: wpLow ? wpLow.value === 1 : false, rise: wpRise ? wpRise.value : null, seasonRatio: (L(theme, 'wp_season_ratio', 'wikipedia') || {}).value ?? null };
    inp.manual = manual ? manual.recentFor(theme, today, MANUAL_DAYS) : [];
    // S
    inp.season = season.fitFor(theme, type, today);
    // C and P
    const count = L(phrase, 'etm_count', 'etsy-market');
    if (count) inp.c = { kind: 'etsy', count: count.value, week: count.week };
    else {
      const rows = db.prepare("SELECT term, label, value, week FROM trend_metrics WHERE source = 'csv' AND metric = 'csv_competition_est' AND week >= ? ORDER BY week DESC").all(minWeek)
        .filter(r => r.term === phrase || (r.term.includes(theme) && wordsMatch(r.term, type)));
      if (rows.length) { const b = rows.sort((x, y) => y.value - x.value)[0]; inp.c = { kind: 'csv', count: b.value, label: b.label, week: b.week }; }
    }
    const p50 = L(phrase, 'etm_price_p50', 'etsy-market');
    inp.price = p50 ? { p50Cents: p50.value, week: p50.week, floor: priceFloor({ db, settings, type }) } : null;
    inp.market = count ? { count: count.value, velocity: (L(phrase, 'etm_velocity', 'etsy-market') || {}).value ?? null, countWow: (L(phrase, 'etm_count_wow', 'etsy-market') || {}).value ?? null, favPerWeek: (L(phrase, 'etm_fav_per_week', 'etsy-market') || {}).value ?? null } : null;
    return inp;
  }

  const satOf = (count) => clip((Math.log10(Math.max(count, 1)) - 3) / 3, 0, 1);
  /** value among peers -> fraction of peers it beats or ties, in [FLOOR, 1]. */
  const pct = (v, peers) => clip(peers.filter(x => x <= v).length / peers.length, FLOOR, 1);

  function score({ weekOverride } = {}) {
    const t = now(); const today = D.etDay(t); const week = weekOverride || D.isoWeek(today);
    const minWeek = D.isoWeek(D.addDays(today, -FRESH_DAYS));
    const list = themes();
    const items = [];
    for (const theme of list) for (const type of PRODUCT_TYPES) items.push(gather(theme, type, today, minWeek));
    // Peer sets for percentile normalisation (only used with >= PERCENTILE_MIN themes carrying that input).
    const peersD = { wp: [], csv: [] }; const seenD = new Set();
    for (const it of items) if (it.d && !seenD.has(`${it.theme}|${it.d.kind}`)) { seenD.add(`${it.theme}|${it.d.kind}`); peersD[it.d.kind].push(it.d.value); }
    const peersC = items.filter(i => i.c && i.c.kind === 'etsy').map(i => -i.c.count);
    const out = [];
    for (const it of items) {
      const parts = {}; const detail = {}; let real = 0;
      // D
      if (it.d) {
        const peers = peersD[it.d.kind]; const usePct = peers.length >= PERCENTILE_MIN;
        parts.D = usePct ? pct(it.d.value, peers) : clip(Math.log10(it.d.value + 1) / Math.log10((it.d.kind === 'csv' ? ANCHORS.csvVolumePerMonthFull : ANCHORS.wpViewsPerDayFull) + 1), FLOOR, 1);
        detail.D = { source: it.d.kind === 'csv' ? `estimate from ${it.d.label}` : 'wikipedia', value: it.d.value, unit: it.d.kind === 'csv' ? 'est. searches/month' : 'views/day', normalised: usePct ? 'percentile' : 'anchor' };
        real++;
      } else { parts.D = NEUTRAL.D; detail.D = { source: 'none', neutral: true }; }
      // R: Wikipedia week-on-week and/or a person's manual direction
      const wpUsable = it.wp.rise !== null && it.wp.level !== null && !it.wp.low;
      const man = it.manual.length ? it.manual[0] : null;
      const rVals = [];
      if (wpUsable) rVals.push(clip((it.wp.rise + 1) / 3, FLOOR, 1));
      if (man) rVals.push(MANUAL_R[man.direction]);
      if (rVals.length) {
        parts.R = rVals.reduce((a, b) => a + b, 0) / rVals.length; real++;
        detail.R = { source: [wpUsable ? 'wikipedia' : null, man ? `manual (${man.source}, ${man.observedOn})` : null].filter(Boolean).join(' + '), rise: wpUsable ? it.wp.rise : null, manual: man ? man.direction : null };
      } else { parts.R = NEUTRAL.R; detail.R = { source: it.wp.low ? 'wikipedia (low volume, ignored)' : 'none', neutral: true }; }
      // S: the calendar always answers (an evergreen theme is fixed at 0.6 by rule), so it counts as real data
      parts.S = it.season.fit; real++;
      detail.S = it.season.evergreen ? { source: 'evergreen rule', evergreen: true } : { source: 'calendar', event: it.season.event.name, peak: it.season.event.peak, weeksToPeak: it.season.event.weeksToPeak, open: it.season.event.open, closingSoon: it.season.event.closingSoon, lastOrderBy: it.season.event.lastOrderBy };
      // C
      if (it.c) {
        const usePct = it.c.kind === 'etsy' && peersC.length >= PERCENTILE_MIN;
        parts.C = usePct ? pct(-it.c.count, peersC) : clip(1 - satOf(it.c.count), FLOOR, 1);
        detail.C = { source: it.c.kind === 'etsy' ? 'etsy market (aggregate)' : `estimate from ${it.c.label}`, listings: it.c.count, normalised: usePct ? 'percentile' : 'anchor' };
        real++;
      } else { parts.C = NEUTRAL.C; detail.C = { source: 'none', neutral: true, badge: 'no competition data' }; }
      // P
      if (it.price && it.price.floor) {
        const gap = it.price.p50Cents / it.price.floor.cents - 1;
        parts.P = clip(gap / 0.5, 0.2, 1); real++;
        detail.P = { source: 'etsy market (aggregate)', medianCents: it.price.p50Cents, floorCents: it.price.floor.cents, floorFrom: it.price.floor.from, gap: r3(gap) };
      } else { parts.P = NEUTRAL.P; detail.P = { source: 'none', neutral: true, medianCents: it.price ? it.price.p50Cents : null }; }
      const k = confidenceOf(real);
      const blockedTerms = checkBlocklist(db, [it.theme]);
      const { raw, score: s } = combine(parts, k, { blocked: blockedTerms.length > 0, weights });
      out.push({
        theme: it.theme, productType: it.type, week, score: r3(s), raw: r3(raw), confidence: r3(k), realParts: real,
        blocked: blockedTerms, parts: Object.fromEntries(Object.entries(parts).map(([a, b]) => [a, r3(b)])), detail,
        market: it.market, seasonRatio: it.wp.seasonRatio,
      });
    }
    const stamp = t.toISOString();
    const up = db.prepare(`INSERT INTO trend_scores(theme, product_type, week, score, confidence, blocked, parts_json, computed_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(theme, product_type, week) DO UPDATE SET score=excluded.score, confidence=excluded.confidence, blocked=excluded.blocked, parts_json=excluded.parts_json, computed_at=excluded.computed_at`);
    db.exec('BEGIN');
    try { for (const o of out) up.run(o.theme, o.productType, week, o.score, o.confidence, o.blocked.length ? 1 : 0, JSON.stringify({ parts: o.parts, detail: o.detail, market: o.market, blocked: o.blocked, seasonRatio: o.seasonRatio, realParts: o.realParts }), stamp); db.exec('COMMIT'); }
    catch (e) { try { db.exec('ROLLBACK'); } catch { /* gone */ } throw e; }
    return { week, computedAt: stamp, items: out.sort((a, b) => b.score - a.score) };
  }

  return { score, themes, gather };
}

module.exports = { makeScorer, combine, confidenceOf, priceFloor, phraseFor, WEIGHTS, NEUTRAL, ANCHORS, MIN_CONFIDENCE, PERCENTILE_MIN, MANUAL_R };
