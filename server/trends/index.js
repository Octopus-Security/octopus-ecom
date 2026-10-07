'use strict';
/**
 * trends/index.js — makeTrends(deps): wires the trend sources, the opportunity score and the weekly report.
 *
 * INTERFACE FOR OTHER FEATURES (additive; the existing TrendSource {name, describe(), check(entry) -> Signal[]} and the
 * adapters.trend {suggest} are untouched and still work):
 *   trends.trendSource            a TrendSource (same shape as watch/trend.js) merging every source's text signals, network-free
 *   trends.opportunities({limit}) -> {week, items:[{theme, productType, score, confidence, confidenceLevel, parts, detail, blocked}]}
 *                                    the stored scores of the latest week, blocklisted themes last with score 0. Read-only.
 *   trends.report()               the stored weekly report object (see report.js)
 *   trends.rebuild({collect})     recompute (and optionally collect from the enabled sources first), returns the report
 *   trends.sources                {season, wikipedia, 'etsy-market', csv, manual}
 * HTTP: GET /api/trends/opportunities, GET /api/trends/report, POST /api/trends/report/rebuild.
 */
const D = require('./dates');
const { ensureTrendSchema } = require('./schema');
const { ensureWatchSchema } = require('../watch/schema');
const { makeAlerts } = require('../watch/alerts');
const { makeCache } = require('./cache');
const { storeMetrics } = require('./metrics');
const { makeManual } = require('./manual');
const { makeScorer, phraseFor } = require('./score');
const { buildReport, storedScores } = require('./report');
const { PRODUCT_TYPES } = require('./season-table');
const { createSeason } = require('../adapters/trend/season');
const { createWikipedia } = require('../adapters/trend/wikipedia');
const { createEtsyMarket } = require('../adapters/trend/etsy-market');
const { createCsvImport } = require('../adapters/trend/csv-import');

function makeTrends({ db, settings, http, etsyAuth, env = process.env, log = { info() {}, warn() {}, error() {} }, now = () => new Date() }) {
  ensureTrendSchema(db);
  ensureWatchSchema(db);
  const alerts = makeAlerts(db);
  const cache = makeCache(db, now);
  const manual = makeManual({ db, now });
  const season = createSeason({ http, cache, settings, env, now, log });
  const wikipedia = createWikipedia({ http, cache, db, settings, env, now, log });
  const etsyMarket = createEtsyMarket({ http, etsyAuth, settings, db, env, now, log });
  const csv = createCsvImport({ db, now });
  const sources = { season, wikipedia, 'etsy-market': etsyMarket, csv, manual: { name: 'manual', enabled: () => ({ enabled: true, reason: '' }) } };
  const scorer = makeScorer({ db, settings, season, manual, now });
  let running = false;

  const themes = () => scorer.themes();
  const runRow = (source, status, detail, week, trigger) => {
    const t = now().toISOString();
    db.prepare('INSERT INTO trend_runs(source, status, detail, week, trigger, started_at, finished_at) VALUES(?,?,?,?,?,?,?)').run(source, status, String(detail || '').slice(0, 500), week, trigger, t, t);
  };

  /** Collect from the sources that are enabled. Network happens here and nowhere else. Never throws for a source failure. */
  async function collect({ trigger = 'manual', only } = {}) {
    if (running) return { skipped: true, reason: 'a trend run is already in progress' };
    running = true;
    try {
      const week = D.isoWeek(D.etDay(now())); const list = themes(); const results = {};
      const want = (n) => !only || only.includes(n);
      if (want('season')) {
        try { const r = await season.collect(); results.season = r; runRow('season', r.status, r.detail, week, trigger); }
        catch (e) { results.season = { status: 'error', detail: e.message }; runRow('season', 'error', e.message, week, trigger); }
      }
      if (want('wikipedia')) {
        try {
          const r = await wikipedia.collect({ themes: list, week });
          if (r.rows.length) storeMetrics(db, r.rows, { allowedTerms: new Set(list), now });
          results.wikipedia = { status: r.status, detail: r.detail, perTheme: r.perTheme }; runRow('wikipedia', r.status, r.detail, week, trigger);
        } catch (e) { results.wikipedia = { status: 'error', detail: e.message }; runRow('wikipedia', 'error', e.message, week, trigger); }
      }
      if (want('etsy-market')) {
        try {
          const queries = list.flatMap(th => PRODUCT_TYPES.map(t => ({ phrase: phraseFor(th, t) })));
          const maxCalls = Number(env.TREND_ETSY_MAX_CALLS) > 0 ? Number(env.TREND_ETSY_MAX_CALLS) : 60;
          const r = await etsyMarket.collect({ queries, week, maxCalls });
          if (r.rows.length) storeMetrics(db, r.rows, { allowedTerms: new Set(queries.map(q => q.phrase)), now });
          results['etsy-market'] = { status: r.status, detail: r.detail, calls: r.calls }; runRow('etsy-market', r.status, r.detail, week, trigger);
        } catch (e) { results['etsy-market'] = { status: 'error', detail: e.message }; runRow('etsy-market', 'error', e.message, week, trigger); log.warn(`[trend] etsy-market: ${e.message}`); }
      }
      return { skipped: false, week, results };
    } finally { running = false; }
  }

  /** Concise trend_signal alerts for the top scores, so anything that reads alerts (the Proposals feature) sees them with no change. */
  function raiseSignals(r) {
    const f = (x) => String(Math.round(x * 100) / 100).replace(/^0\./, '.');
    for (const i of r.items.filter(x => !x.blocked.length).slice(0, 10)) {
      const p = i.parts; const S = i.detail.S || {};
      const win = S.event && S.open ? `; season window open${S.closingSoon ? ' (closing soon)' : ''}, last order ${String(S.lastOrderBy).slice(5)}` : '';
      alerts.raise({ kind: 'trend_signal', severity: 'info', dedupeKey: `trend.score.${i.theme}.${i.productType}.${r.week}`,
        message: `${i.theme}: ${i.productType} score ${Math.round(i.score)} (D ${f(p.D)} R ${f(p.R)} S ${f(p.S)} C ${f(p.C)} P ${f(p.P)}, conf ${f(i.confidence)})${win}` });
    }
  }
  function score() { const r = scorer.score(); runRow('score', 'ok', `${r.items.length} score(s) for week ${r.week}`, r.week, 'manual'); raiseSignals(r); return storedScores(db, r.week); }
  const report = () => buildReport({ db, sources, manual, season, now });
  async function rebuild({ collect: doCollect = false, trigger = 'manual', only } = {}) {
    const run = doCollect ? await collect({ trigger, only }) : null;
    const scores = score();
    return { run, report: buildReport({ db, sources, manual, season, now, scores }) };
  }
  function opportunities({ limit = 25 } = {}) {
    const s = storedScores(db);
    const items = [...s.items.filter(i => !i.blocked), ...s.items.filter(i => i.blocked)].slice(0, Math.min(Math.max(limit | 0, 1), 200));
    return { week: s.week, items };
  }

  const trendSource = {
    name: 'trends',
    describe: () => 'Trends: season calendar, Wikipedia attention, Etsy market aggregates (off by default), CSV imports and manual entries. Signals are read from stored numbers; a watcher run makes no network request.',
    async check(entry) {
      const out = [];
      for (const s of [season, wikipedia]) { try { out.push(...await s.check(entry)); } catch (e) { log.warn(`[trend] ${s.name} check failed: ${e.message}`); } }
      return out;
    },
  };

  return { sources, season, wikipedia, etsyMarket, csv, manual, scorer, trendSource, collect, score, report, rebuild, opportunities, themes, isRunning: () => running };
}

module.exports = { makeTrends };
