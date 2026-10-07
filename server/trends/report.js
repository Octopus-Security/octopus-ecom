'use strict';
/**
 * trends/report.js — the weekly Trend report. Pure read of stored numbers plus the season table; it never touches the network
 * (collection is collect.js) and never writes. Sections follow the spec (6) and the build brief:
 *   caveat, per-source status line, top 10, biggest risers, seasonal windows (open now / closing soon, with last-order-by dates),
 *   gaps (high score, nothing in our catalogue), our launches against the score they had at launch, blocklist hits.
 */
const D = require('./dates');
const { PRODUCT_TYPES, PRODUCT_WORDS } = require('./season-table');
const { matchesTerm } = require('../adapters/trend/season');

const CAVEAT = 'No source shows what other sellers sell. Every number here is a proxy: attention, estimated searches, or the supply of listings. A high score is a hypothesis to test with a few designs, not a forecast.';
const GAP_MIN_SCORE = 50;     // assumed: scores are relative to the watchlist, so this is a prompt to look, not a threshold of merit
const TOP_N = 10;

const SOURCE_LABELS = {
  season: 'Season calendar', wikipedia: 'Wikipedia pageviews', 'etsy-market': 'Etsy market (aggregates)', csv: 'CSV import (paid-tool exports)', manual: 'Manual entries',
};

function sourceStatuses({ db, sources, manual, now }) {
  const lastRun = (src) => db.prepare('SELECT * FROM trend_runs WHERE source = ? ORDER BY id DESC LIMIT 1').get(src);
  const out = [];
  for (const name of ['season', 'wikipedia', 'etsy-market', 'csv', 'manual']) {
    const run = lastRun(name); let status; let detail = '';
    const src = sources[name];
    const en = src && src.enabled ? src.enabled() : { enabled: true, reason: '' };
    if (name === 'manual') {
      const n = manual.recentFor('', D.etDay(now()), 21).length;
      status = n ? 'ok' : 'no_data'; detail = n ? `${n} entr${n === 1 ? 'y' : 'ies'} in the last 3 weeks` : 'Nothing entered in the last 3 weeks.';
    } else if (!en.enabled) { status = 'disabled'; detail = en.reason; }
    else if (!run) { status = name === 'season' ? 'ok' : 'no_data'; detail = name === 'season' ? 'Checked-in table in use; Nager.Date has not been fetched yet.' : 'Has not run yet.'; }
    else { status = run.status === 'disabled' ? 'disabled' : run.status; detail = run.detail || ''; }
    out.push({ name, label: SOURCE_LABELS[name], status, detail, lastRunAt: run ? (run.finished_at || run.started_at) : null, label2: name === 'csv' || name === 'manual' ? 'by hand' : 'automatic' });
  }
  return out;
}

const dot = (k) => (k >= 0.8 ? 'high' : k >= 0.6 ? 'medium' : 'low');
const shapeScore = (r) => { const j = JSON.parse(r.parts_json); const { blocked: terms, ...rest } = j; return { theme: r.theme, productType: r.product_type, week: r.week, score: r.score, confidence: r.confidence, confidenceLevel: dot(r.confidence), blocked: Boolean(r.blocked), blockedTerms: terms || [], ...rest }; };

/** Stored scores of the latest week (or `week`). */
function storedScores(db, week) {
  const w = week || (db.prepare('SELECT week FROM trend_scores ORDER BY week DESC LIMIT 1').get() || {}).week;
  if (!w) return { week: null, items: [] };
  return { week: w, items: db.prepare('SELECT * FROM trend_scores WHERE week = ? ORDER BY score DESC, theme').all(w).map(shapeScore) };
}

function coverageOf(db) {
  const rows = db.prepare("SELECT id, stage, lower(coalesce(niche,'') || ' ' || coalesce(title,'') || ' ' || coalesce(keywords,'') || ' ' || coalesce(brief,'')) AS t FROM products WHERE stage NOT IN ('failed','rejected','archived')").all();
  return (term) => rows.filter(r => r.t.includes(term) || matchesTerm(r.t, [term])).length;
}
const coverageByWords = (db, words) => { const rows = db.prepare("SELECT lower(coalesce(niche,'') || ' ' || coalesce(title,'') || ' ' || coalesce(keywords,'')) AS t FROM products WHERE stage NOT IN ('failed','rejected','archived')").all(); return rows.filter(r => matchesTerm(r.t, words)).length; };

function launches({ db, today }) {
  const prods = db.prepare(`SELECT p.id, p.title, p.niche, p.keywords, p.blueprint, p.created_at,
      (SELECT MIN(l.created_at) FROM listings l WHERE l.product_id = p.id AND l.external_id IS NOT NULL AND l.external_id != '') AS launched_at
    FROM products p WHERE p.stage IN ('published','live')`).all().filter(p => p.launched_at);
  const out = [];
  for (const p of prods) {
    const text = `${p.niche || ''} ${p.title || ''} ${p.keywords || ''}`.toLowerCase();
    const types = PRODUCT_TYPES.filter(t => PRODUCT_WORDS[t].words.some(w => ` ${text} ${(p.blueprint || '').toLowerCase()} `.includes(` ${w} `)));
    const cand = db.prepare('SELECT theme, product_type, week, score, computed_at FROM trend_scores WHERE computed_at <= ? ORDER BY computed_at DESC').all(p.launched_at)
      .filter(r => text.includes(r.theme) && (!types.length || types.includes(r.product_type)));
    const sc = cand[0];
    if (!sc) continue;
    const sales = db.prepare("SELECT COALESCE(SUM(quantity),0) AS q, COALESCE(SUM(net_cents),0) AS net FROM sales WHERE product_id = ? AND source != 'stub'").get(p.id);
    let views = 0;
    for (const l of db.prepare("SELECT id FROM listings WHERE product_id = ? AND external_id IS NOT NULL AND external_id != ''").all(p.id)) {
      const s = db.prepare('SELECT value FROM watch_state WHERE key = ?').get(`perf.listing.${l.id}`);
      try { views += (s && JSON.parse(s.value).views) || 0; } catch { /* ignore */ }
    }
    out.push({ productId: p.id, title: p.title, theme: sc.theme, productType: sc.product_type, scoreAtLaunch: sc.score, scoreWeek: sc.week, launchedOn: D.etDay(Date.parse(p.launched_at) || Date.now()), daysLive: Math.max(0, D.daysBetween(D.etDay(Date.parse(p.launched_at) || Date.now()), today)), sales: sales.q, netCents: sales.net, views });
  }
  return out;
}

/**
 * build({db, sources, manual, season, now, scores}) -> report object.
 * `scores` is {week, items} (freshly computed or stored); omitted -> the stored latest week.
 */
function buildReport({ db, sources, manual, season, now = () => new Date(), scores }) {
  const today = D.etDay(now());
  const sc = scores || storedScores(db);
  const items = sc.items;
  const live = items.filter(i => !i.blocked);
  const top = live.slice(0, TOP_N);
  // one row per theme for risers: the highest wp_rise, never low-volume
  const riseOf = (i) => (i.detail && i.detail.R && typeof i.detail.R.rise === 'number' ? i.detail.R.rise : null);
  const seenTheme = new Set();
  const risers = live.map(i => ({ i, r: riseOf(i) })).filter(x => x.r !== null && x.r > 0).sort((a, b) => b.r - a.r)
    .filter(x => (seenTheme.has(x.i.theme) ? false : seenTheme.add(x.i.theme))).slice(0, TOP_N)
    .map(x => ({ theme: x.i.theme, rise: x.r, doublingsPerWeek: x.r, views: x.i.detail.D && x.i.detail.D.unit === 'views/day' ? x.i.detail.D.value : null, seasonRatio: x.i.seasonRatio ?? null }));
  const covered = coverageOf(db);
  // seasonal windows
  const windows = []; const events = season.events(today).filter(e => !e.generic);
  for (const e of events) {
    const cov = coverageByWords(db, e.keywords);
    for (const t of PRODUCT_TYPES) {
      const w = e.perType[t];
      if (w.open || w.late) windows.push({ event: e.name, eventId: e.id, peak: e.peak, productType: t, state: w.closingSoon ? 'closing_soon' : w.open ? 'open' : 'late', listFrom: w.listFrom, listUntil: w.listUntil, lastOrderBy: w.lastOrderBy, daysToClose: w.daysToClose, ourDesigns: cov });
    }
  }
  windows.sort((a, b) => a.lastOrderBy.localeCompare(b.lastOrderBy));
  const gaps = live.filter(i => i.score >= GAP_MIN_SCORE && covered(i.theme) === 0).slice(0, TOP_N).map(i => ({ theme: i.theme, productType: i.productType, score: i.score, confidenceLevel: i.confidenceLevel }));
  const l = launches({ db, today });
  return {
    generatedAt: now().toISOString(), today, week: sc.week, caveat: CAVEAT,
    sources: sourceStatuses({ db, sources, manual, now }),
    themeCount: new Set(items.map(i => i.theme)).size,
    top, risers,
    seasonal: { open: windows.filter(w => w.state !== 'late'), closingSoon: windows.filter(w => w.state === 'closing_soon'), late: windows.filter(w => w.state === 'late') },
    gaps, gapThreshold: GAP_MIN_SCORE,
    launches: l,
    launchesNote: l.length ? '' : 'No launched product has a stored score from before its launch yet. This fills in once a product goes live after a weekly report exists; use it to re-fit the weights after 8-12 weeks.',
    blocklisted: items.filter(i => i.blocked).map(i => ({ theme: i.theme, productType: i.productType, terms: i.blockedTerms })),
    empty: items.length === 0 ? 'No scores yet. Add themes to the Watchlist (kind: theme), then rebuild.' : '',
  };
}

module.exports = { buildReport, storedScores, sourceStatuses, launches, CAVEAT, GAP_MIN_SCORE, TOP_N };
