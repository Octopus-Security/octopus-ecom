'use strict';
// Trend sources: Wikipedia, Etsy market (aggregate-only), CSV, manual, metrics validator, score, report, routes, scheduler.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { makeDeps, tmpDir, fakeFetch, fakeHttp } = require('./helpers');
const { makeHttp } = require('../server/adapters/http');
const { buildApp } = require('../server/app');
const { openDb } = require('../server/db');
const D = require('../server/trends/dates');
const M = require('../server/trends/metrics');
const { ensureTrendSchema } = require('../server/trends/schema');
const { validateSignals, FORBIDDEN_KEYS } = require('../server/watch/trend');
const { computeMetrics, guessArticle } = require('../server/adapters/trend/wikipedia');
const { aggregate, CONFIRM_SUMMARY } = require('../server/adapters/trend/etsy-market');
const { parseNum } = require('../server/adapters/trend/csv-import');
const { combine, WEIGHTS } = require('../server/trends/score');
const { due, startTrendSchedule } = require('../server/trends/scheduler');

const EPOCH = new Date('2026-10-06T16:00:00Z');          // Tuesday, 2026-W41
const WEEK = '2026-W41';
const ETSY_ENV = { ETSY_API_KEY: 'kstr0123456789', ETSY_SHARED_SECRET: 'shsec0123456789' };

function setup({ env = {}, fetch, http, now = EPOCH } = {}) {
  const clock = { t: now };
  const f = fetch || fakeFetch(() => ({ status: 404, body: 'none' }));
  const d = makeDeps(env, { http: http || fakeHttp(f), trendNow: () => clock.t });
  d.clock = clock; d.f = f;
  d.addTheme = (term, kind = 'theme') => d.db.prepare('INSERT INTO watchlist(kind, term, notes, active, created_at, updated_at) VALUES(?,?,?,?,?,?)').run(kind, term, '', 1, EPOCH.toISOString(), EPOCH.toISOString());
  d.metric = (term, source, metric, value, n, label) => M.storeMetrics(d.db, [{ term, source, metric, value, n, week: WEEK, label }], { allowedTerms: new Set([term]) });
  return d;
}
async function serve(d) {
  const server = await new Promise((r) => { const s = buildApp(d).listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const j = async (method, url, body, headers = {}) => {
    const r = await fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { j, close: () => server.close(), base };
}

// ---- metrics validator -----------------------------------------------------------------------------------------------
test('numeric validator: closed whitelist, numbers only, terms we supplied, aggregates need n>=20; the text-signal rule is unchanged', () => {
  const ok = { term: 'frog', source: 'wikipedia', metric: 'wp_level', value: 12.5, week: WEEK };
  const terms = new Set(['frog']);
  assert.equal(M.validateMetrics([ok], { allowedTerms: terms }).length, 1);
  const rej = (row, re) => assert.throws(() => M.validateMetrics([ok, row], { allowedTerms: terms }), re);
  rej({ ...ok, title: 'x' }, /competitor-data shaped/);
  rej({ ...ok, price: 5 }, /competitor-data shaped/);
  rej({ ...ok, shop_id: 5 }, /unexpected field/);
  rej({ ...ok, metric: 'etm_title' }, /not whitelisted/);
  rej({ ...ok, value: '12' }, /finite number/);
  rej({ ...ok, value: NaN }, /finite number/);
  rej({ ...ok, term: 'SELLER SHOP NAME' }, /not supplied by us/);
  rej({ ...ok, source: 'etsy-market' }, /does not belong/);
  rej({ term: 'frog', source: 'etsy-market', metric: 'etm_price_p50', value: 1000, n: 19, week: WEEK }, /n >= 20/);
  assert.equal(M.validateMetrics([{ term: 'frog', source: 'etsy-market', metric: 'etm_price_p50', value: 1000, n: 20, week: WEEK }], { allowedTerms: terms }).length, 1);
  assert.throws(() => M.validateMetrics([ok], {}), /allowedTerms/);
  // nothing is stored when any row fails
  const db = openDb(':memory:'); ensureTrendSchema(db);
  assert.throws(() => M.storeMetrics(db, [ok, { ...ok, metric: 'nope' }], { allowedTerms: terms }));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM trend_metrics').get().n, 0);
  // the strict text-signal path is untouched
  assert.throws(() => validateSignals([{ message: 'm', price: 3 }]), /competitor-data shaped/);
  assert.deepEqual(validateSignals([{ message: 'ok', severity: 'warn' }]), [{ message: 'ok', severity: 'warn' }]);
  for (const k of ['title', 'image', 'url', 'shop', 'listing', 'price', 'seller', 'thumbnail']) assert.ok(FORBIDDEN_KEYS.includes(k), k);
});

// ---- wikipedia -------------------------------------------------------------------------------------------------------
const wikiFetch = (viewsOf, calls) => fakeFetch((url) => {
  const m = /daily\/(\d{8})00\/(\d{8})00$/.exec(url);
  if (!m) return { status: 404, body: 'x' };
  if (/Missing_article/.test(url)) return { status: 404, body: '{}' };
  const day = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const items = []; for (let d = day(m[1]); d <= day(m[2]); d = D.addDays(d, 1)) items.push({ timestamp: `${d.replace(/-/g, '')}00`, views: viewsOf(d) });
  return { body: { items } };
});

test('wikipedia metrics: level, week-on-week rise and year-on-year ratio (hand-computed)', () => {
  const end = '2026-10-05';
  const series = []; for (let d = D.addDays(end, -392); d <= end; d = D.addDays(d, 1)) series.push({ day: d, views: D.daysBetween(d, end) < 7 ? 2000 : 1000 });
  const m = computeMetrics(series, end);
  assert.equal(m.wp_level, 1250);                                   // (21*1000 + 7*2000) / 28
  assert.ok(Math.abs(m.wp_rise - Math.log2(2001 / 1001)) < 1e-9);
  assert.equal(m.wp_season_ratio, 1.25); assert.equal(m.wp_low_volume, 0);
  const low = computeMetrics(series.map(s => ({ ...s, views: 50 })), end);
  assert.equal(low.wp_low_volume, 1); assert.equal(low.wp_rise, 0);   // below 200/day: rise is noise
});

test('wikipedia adapter: contact from config in the User-Agent, disabled without it, guess vs owner article, daily cache, 404', async () => {
  const f = wikiFetch(() => 1000);
  const d = setup({ fetch: f });
  d.addTheme('frog'); d.addTheme('missing article');
  const off = await d.trends.wikipedia.collect({ themes: ['frog'], week: WEEK });
  assert.equal(off.status, 'disabled'); assert.match(off.detail, /TREND_CONTACT/); assert.equal(f.calls.length, 0);
  d.settings.set('trend_contact', 'ops@example.test');
  const r = await d.trends.collect({ only: ['wikipedia'] });
  assert.equal(r.results.wikipedia.status, 'ok');
  const call = f.calls[0];
  assert.match(call.url, /per-article\/en\.wikipedia\/all-access\/user\/Frog\/daily\//);
  assert.match(call.headers['User-Agent'], /ops@example\.test/);
  const per = r.results.wikipedia.perTheme;
  assert.equal(per.find(p => p.theme === 'frog').guess, true, 'an automatic guess is marked as one');
  assert.equal(per.find(p => p.theme === 'missing article').state, 'no_article', 'a guess that is not an article is reported, not scored');
  assert.ok(M.latest(d.db, 'frog', 'wp_level').value === 1000);
  const frogCalls = () => f.calls.filter(c => /\/user\/Frog\//.test(c.url)).length;
  const n = frogCalls();
  await d.trends.collect({ only: ['wikipedia'] });
  assert.equal(frogCalls(), n, 'same ET day: served from the daily cache');
  d.clock.t = new Date('2026-10-07T16:00:00Z');
  await d.trends.collect({ only: ['wikipedia'] });
  assert.ok(frogCalls() > n, 'next ET day: fetched again');
  // owner mapping replaces the guess
  const s = await serve(d);
  assert.equal((await s.j('PUT', '/api/trends/articles', { theme: 'frog', article: 'Tree_frog' })).body.guess, false);
  const arts = (await s.j('GET', '/api/trends/articles')).body.articles;
  assert.equal(arts.find(a => a.theme === 'frog').guess, false); assert.equal(arts.find(a => a.theme === 'frog').article, 'Tree_frog');
  assert.equal(arts.find(a => a.theme === 'missing article').guess, true);
  assert.equal((await s.j('PUT', '/api/trends/articles', { theme: 'frog', article: 'https://en.wikipedia.org/x' })).status, 400);
  s.close();
  d.clock.t = new Date('2026-10-08T16:00:00Z'); d.addTheme('ghost');
  const r2 = await d.trends.wikipedia.collect({ themes: ['ghost'], week: WEEK });
  assert.equal(r2.perTheme[0].article, 'Ghost');
  assert.equal(guessArticle('cottage core'), 'Cottage_core');
  const only404 = setup({ fetch: wikiFetch(() => 1) }); only404.settings.set('trend_contact', 'c@example.test');
  only404.db.prepare("INSERT INTO trend_theme_articles(theme, article, updated_at) VALUES('x','Missing_article','t')").run();
  assert.equal((await only404.trends.wikipedia.collect({ themes: ['x'], week: WEEK })).status, 'no_data');
});

test('no personal address is hardcoded in the trend sources', () => {
  for (const dir of ['server/trends', 'server/adapters/trend']) for (const f of fs.readdirSync(path.join(__dirname, '..', dir))) {
    const text = fs.readFileSync(path.join(__dirname, '..', dir, f), 'utf8');
    assert.doesNotMatch(text, /[A-Za-z0-9._-]+@[A-Za-z0-9-]+\.[a-z]{2,}/, `${dir}/${f}`);
  }
});

// ---- etsy market -----------------------------------------------------------------------------------------------------
const NOW_S = Math.floor(EPOCH.getTime() / 1000);
const listing = (i) => ({
  listing_id: 900000 + i, shop_id: 777000 + i, title: `SECRETTITLE ${i}`, description: 'SECRETDESC', tags: ['secrettag'], url: `https://www.etsy.com/listing/${900000 + i}`, state: 'active',
  created_timestamp: NOW_S - i * 6 * 3600, num_favorers: i % 7, price: { amount: 1500 + i * 10, divisor: 100, currency_code: 'USD' }, taxonomy_id: i % 4 === 0 ? 1 : 2,
  images: [{ url_fullxfull: 'https://i.etsystatic.com/SECRETIMG' }], shop: { shop_name: 'SECRETSHOP' },
});
const etsyBody = (count = 5000, n = 100) => ({ count, results: Array.from({ length: n }, (_, i) => listing(i)) });
const etsyFetch = (over = {}) => fakeFetch(() => ({ body: etsyBody(), ...over }));

test('etsy market aggregate(): hand-computed numbers from a known sample', () => {
  const m = aggregate(etsyBody(5000, 100), NOW_S);
  assert.equal(m.etm_count, 5000); assert.equal(m.n, 100);
  assert.equal(m.etm_price_p50, 1995); assert.equal(m.etm_price_p25, 1748); assert.equal(m.etm_price_p75, 2243);
  assert.ok(Math.abs(m.etm_velocity - 100 / 24.75) < 1e-9);
  assert.ok(Math.abs(m.etm_sat - (Math.log10(5000) - 3) / 3) < 1e-9);
  assert.equal(m.etm_fav_p50, 3); assert.equal(m.etm_top_taxonomy_share, 0.75);
  const small = aggregate(etsyBody(300, 100), NOW_S); assert.equal(small.etm_velocity, undefined, 'velocity needs count >= 500');
  const tiny = aggregate(etsyBody(12, 12), NOW_S); assert.deepEqual(Object.keys(tiny).sort(), ['etm_count', 'etm_sat', 'n']);
  assert.throws(() => aggregate({ results: [] }, NOW_S), /count/);
});

test('etsy market is DISABLED by default: nothing is requested even with credentials', async () => {
  const f = etsyFetch(); const d = setup({ env: ETSY_ENV, fetch: f });
  d.addTheme('frog');
  assert.equal(d.trends.etsyMarket.enabled().enabled, false);
  const r = await d.trends.collect({ only: ['etsy-market'] });
  assert.equal(r.results['etsy-market'].status, 'disabled'); assert.equal(f.calls.length, 0);
  const rep = d.trends.report();
  assert.equal(rep.sources.find(s => s.name === 'etsy-market').status, 'disabled');
});

test('turning it on is confirm-gated with the terms warning; credentials missing or a refused key keep it off', async () => {
  const f = etsyFetch({ status: 403, body: { error: 'forbidden' } });
  const d = setup({ env: ETSY_ENV, fetch: f }); d.addTheme('frog');
  const s = await serve(d);
  const gate = (await s.j('POST', '/api/trends/etsy-market/enable', {})).body;
  assert.equal(gate.needsConfirm, true);
  assert.equal(gate.summary, "Read Etsy's current API Terms first; search summaries suggest analytics use may need Etsy's authorisation.");
  assert.equal(gate.summary, CONFIRM_SUMMARY);
  assert.equal(d.settings.get('trend_etsy_market_enabled'), null, 'asking does not enable');
  assert.equal((await s.j('POST', '/api/trends/etsy-market/enable', { token: 'forged' })).status, 409);
  assert.equal((await s.j('POST', '/api/trends/etsy-market/enable', { token: gate.token })).body.ok, true);
  assert.equal((await s.j('POST', '/api/trends/etsy-market/enable', { token: gate.token })).status, 409, 'single use');
  assert.equal(d.settings.get('trend_etsy_market_enabled'), 'true');
  // Etsy says no: switched off again, with the reason
  const r = await d.trends.collect({ only: ['etsy-market'] });
  assert.equal(r.results['etsy-market'].status, 'disabled'); assert.match(r.results['etsy-market'].detail, /403/);
  assert.equal(d.trends.etsyMarket.enabled().enabled, false); assert.match(d.trends.etsyMarket.enabled().reason, /refused/);
  assert.equal(f.calls.length, 1, 'stops at the first refusal');
  s.close();
  // no credentials: on in settings but still off
  const g = etsyFetch(); const d2 = setup({ fetch: g }); d2.settings.set('trend_etsy_market_enabled', true); d2.addTheme('frog');
  assert.match(d2.trends.etsyMarket.enabled().reason, /credentials are missing/);
  assert.equal((await d2.trends.collect({ only: ['etsy-market'] })).results['etsy-market'].status, 'disabled'); assert.equal(g.calls.length, 0);
});

test('etsy market stores numbers only: no competitor title, tag, image, shop, shop id or listing id, and no shop endpoint', async () => {
  const f = etsyFetch(); const d = setup({ env: ETSY_ENV, fetch: f });
  d.settings.set('trend_etsy_market_enabled', true); d.addTheme('frog');
  const r = await d.trends.collect({ only: ['etsy-market'] });
  assert.equal(r.results['etsy-market'].status, 'ok');
  assert.equal(f.calls.length, 4, 'one search per product-type phrase');
  for (const c of f.calls) {
    const u = new URL(c.url);
    assert.equal(u.host, 'api.etsy.com'); assert.equal(u.pathname, '/v3/application/listings/active');
    assert.doesNotMatch(c.url, /\/shops?\//); assert.equal(c.headers['x-api-key'], 'kstr0123456789:shsec0123456789');
  }
  assert.deepEqual(f.calls.map(c => new URL(c.url).searchParams.get('keywords')).sort(), ['frog mug', 'frog shirt', 'frog sticker', 'frog wall art']);
  const rows = d.db.prepare('SELECT * FROM trend_metrics').all();
  assert.ok(rows.length >= 4 * 8);
  const dump = JSON.stringify(rows);
  for (const bad of [/secrettitle/i, /secretdesc/i, /secrettag/i, /secretimg/i, /secretshop/i, /\b777\d{3}\b/, /\b9000\d\d\b/, /etsystatic/i, /etsy\.com\/listing/i]) assert.doesNotMatch(dump, bad);
  for (const row of rows) { assert.ok(M.METRICS.includes(row.metric)); assert.equal(typeof row.value, 'number'); assert.ok(['frog shirt', 'frog mug', 'frog sticker', 'frog wall art'].includes(row.term)); }
  const cols = Object.keys(d.db.prepare('SELECT * FROM trend_metrics LIMIT 1').get()).sort();
  assert.deepEqual(cols, ['created_at', 'id', 'label', 'metric', 'n', 'source', 'term', 'value', 'week']);
  // a second week gets a week-on-week supply change
  d.clock.t = new Date('2026-10-13T16:00:00Z');
  const f2 = fakeFetch(() => ({ body: etsyBody(6000) })); d.trends.etsyMarket.collect = d.trends.etsyMarket.collect; // same adapter, new fake below
  void f2;
});

test('etsy market goes through the shared rate limiter and respects the daily reserve', async () => {
  const f = etsyFetch();
  const http = makeHttp({ fetchImpl: f, sleep: async () => {}, random: () => 0.5, hostLimits: { 'api.etsy.com': { ratePerSec: 100, perDay: 30 } } });
  const d = setup({ env: { ...ETSY_ENV, ETSY_QPD_RESERVE: '25' }, http });
  d.settings.set('trend_etsy_market_enabled', true); ['a', 'b', 'c'].forEach(t => d.addTheme(t));
  const spy = []; const orig = http.request; http.request = (u, o) => { spy.push(u); return orig(u, o); };
  const r = await d.trends.collect({ only: ['etsy-market'] });
  assert.equal(f.calls.length, 5, '30 per day minus a reserve of 25 leaves 5 calls');
  assert.equal(spy.length, 5, 'every request went through http.request');
  assert.match(r.results['etsy-market'].detail, /reserve/);
  assert.equal(http.budget('api.etsy.com').used, 5);
  // Etsy's own header
  const g = fakeFetch(() => ({ body: etsyBody(), headers: { 'x-remaining-today': '10' } }));
  const d2 = setup({ env: ETSY_ENV, fetch: g }); d2.settings.set('trend_etsy_market_enabled', true); d2.addTheme('frog');
  const r2 = await d2.trends.collect({ only: ['etsy-market'] });
  assert.equal(g.calls.length, 1); assert.match(r2.results['etsy-market'].detail, /10 requests left/);
  // the per-run cap
  const h = etsyFetch(); const d3 = setup({ env: { ...ETSY_ENV, TREND_ETSY_MAX_CALLS: '2' }, fetch: h });
  d3.settings.set('trend_etsy_market_enabled', true); d3.addTheme('frog');
  await d3.trends.collect({ only: ['etsy-market'] }); assert.equal(h.calls.length, 2);
});

test('etsy market: supply change week on week comes from our own stored snapshots', async () => {
  const f = etsyFetch(); const d = setup({ env: ETSY_ENV, fetch: f });
  d.settings.set('trend_etsy_market_enabled', true); d.addTheme('frog');
  await d.trends.collect({ only: ['etsy-market'] });
  assert.equal(M.latest(d.db, 'frog shirt', 'etm_count_wow'), null, 'the first week has no growth number');
  d.clock.t = new Date('2026-10-13T16:00:00Z');
  const adapter = require('../server/adapters/trend/etsy-market').createEtsyMarket({ http: fakeHttp(fakeFetch(() => ({ body: etsyBody(6000) }))), etsyAuth: d.etsyAuth, settings: d.settings, db: d.db, env: ETSY_ENV, now: () => d.clock.t });
  const out = await adapter.collect({ queries: [{ phrase: 'frog shirt' }], week: '2026-W42' });
  assert.ok(Math.abs(out.rows.find(x => x.metric === 'etm_count_wow').value - 0.2) < 1e-9);
});

// ---- csv -------------------------------------------------------------------------------------------------------------
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'trend-keywords-ASSUMED-HEADERS.csv'), 'utf8');

test('csv parseNum', () => {
  assert.equal(parseNum('12,400'), 12400); assert.equal(parseNum('1.2K'), 1200); assert.equal(parseNum('+35%'), 35); assert.equal(parseNum('2M'), 2000000);
  assert.equal(parseNum('N/A'), null); assert.equal(parseNum('High'), null); assert.equal(parseNum('-'), null);
});

test('csv preview reads by alias, shows the mapping, saves nothing; import needs the preview hash and keeps keyword metrics only', () => {
  const d = setup(); d.addTheme('frog');
  const p = d.trends.csv.preview(FIXTURE, 'erank');
  assert.equal(p.assumedHeaders, true); assert.equal(p.rows, 3); assert.equal(p.skippedCount, 2);
  assert.deepEqual(p.headerMap, { keyword: 'Keyword', volume: 'Avg Monthly Searches', competition: 'Competition', trend: 'Trend' });
  assert.deepEqual(p.ignoredHeaders, ['Listing Title', 'Shop Name']);
  assert.equal(p.matchedToWatchlistThemes, 2);
  assert.deepEqual(p.sample[0], { line: 2, term: 'frog shirt', csv_volume_est: 12400, csv_competition_est: 52000, csv_trend_pct: 35 });
  assert.ok(p.skipped.some(s => /link/.test(s.reason)) && p.skipped.some(s => /duplicate/.test(s.reason)));
  assert.equal(d.db.prepare('SELECT COUNT(*) n FROM trend_metrics').get().n, 0, 'preview saves nothing');
  assert.throws(() => d.trends.csv.importCsv(FIXTURE, 'erank'), (e) => e.status === 409);
  assert.throws(() => d.trends.csv.importCsv(FIXTURE + 'x,1,1,1,,\n', 'erank', p.previewHash), (e) => e.status === 409, 'a changed file needs a new preview');
  assert.throws(() => d.trends.csv.importCsv(FIXTURE, 'alura', p.previewHash), (e) => e.status === 409, 'a different tool too');
  const r = d.trends.csv.importCsv(FIXTURE, 'erank', p.previewHash);
  assert.equal(r.keywords, 3); assert.equal(r.numbersSaved, 8);
  d.trends.csv.importCsv(FIXTURE, 'erank', p.previewHash);
  const rows = d.db.prepare('SELECT * FROM trend_metrics').all();
  assert.equal(rows.length, 8, 'rerun is idempotent');
  assert.ok(rows.every(x => x.source === 'csv' && x.label === 'erank'));
  assert.doesNotMatch(JSON.stringify(rows), /ExampleShop|OtherShop|Cute Frog|etsy\.com/);
  assert.equal(d.trends.csv.preview('Name,Foo\na,b\n', 'erank').fatal !== null, true);
  assert.throws(() => d.trends.csv.preview(FIXTURE, 'nope'), (e) => e.status === 400);
});

test('csv estimates replace C (and D) when present and are labelled as the tool\'s estimate', () => {
  const d = setup(); d.addTheme('frog');
  const p = d.trends.csv.preview(FIXTURE, 'erank'); d.trends.csv.importCsv(FIXTURE, 'erank', p.previewHash);
  const tee = d.trends.scorer.score().items.find(i => i.theme === 'frog' && i.productType === 'tee');
  assert.match(tee.detail.C.source, /estimate from erank/); assert.equal(tee.detail.C.listings, 52000);
  assert.ok(Math.abs(tee.parts.C - (1 - (Math.log10(52000) - 3) / 3)) < 0.001);
  assert.equal(tee.detail.D.neutral, true, 'a typed phrase is not theme-level demand');
});

// ---- manual ----------------------------------------------------------------------------------------------------------
test('manual entries: dated in ET, labelled manual, validated', () => {
  const d = setup({ now: new Date('2026-10-07T02:30:00Z') });   // 22:30 ET on Oct 6
  const e = d.trends.manual.add({ source: 'pinterest-trends', term: ' Frog  Core ', direction: 'rising', growthPct: 120, note: 'top growing in home decor' });
  assert.equal(e.observedOn, '2026-10-06'); assert.equal(e.label, 'manual'); assert.equal(e.term, 'frog core');
  assert.equal(d.trends.manual.add({ source: 'redbubble', term: 'x', observedOn: '2026-10-01' }).observedOn, '2026-10-01');
  for (const bad of [{ term: 'x', observedOn: '2026-10-07' }, { term: 'x', note: 'see https://etsy.com/listing/1' }, { term: '' }, { term: 'x', source: 'tiktok' }, { term: 'x', direction: 'sideways' }, { term: 'x', observedOn: 'yesterday' }, { term: 'x', growthPct: 'lots' }]) {
    assert.throws(() => d.trends.manual.add(bad), (er) => er.status === 400, JSON.stringify(bad));
  }
  assert.equal(d.trends.manual.list().length, 2);
  assert.equal(d.trends.manual.recentFor('frog', '2026-10-06').length, 1);
});

// ---- score -----------------------------------------------------------------------------------------------------------
test('score formula: hand-computed cases, K and the blocklist veto', () => {
  assert.equal(Object.values(WEIGHTS).reduce((a, b) => a + b, 0).toFixed(10), '1.0000000000');
  const all = (x) => ({ D: x, R: x, S: x, C: x, P: x });
  assert.ok(Math.abs(combine(all(1), 1).score - 100) < 1e-9);
  assert.ok(Math.abs(combine(all(0.5), 1).score - 50) < 1e-9);         // weights sum to 1, so 0.5^1
  assert.ok(Math.abs(combine(all(0.5), 0.4).score - 35) < 1e-9);       // x (0.5 + 0.2)
  assert.ok(Math.abs(combine({ D: 1, R: 1, S: 1, C: 1, P: 0.2 }, 1).score - 100 * Math.pow(0.2, 0.1)) < 1e-9);
  assert.ok(Math.abs(combine({ D: 1, R: 1, S: 1, C: 1, P: 0.2 }, 1).score - 85.134) < 0.001);
  assert.equal(combine(all(1), 1, { blocked: true }).score, 0);
});

test('score end to end: parts from stored sources, neutral defaults, K, blocklist, percentile past 20 themes', () => {
  const d = setup(); d.addTheme('frog');
  d.settings.set('trend_base_cost_cents', JSON.stringify({ tee: 1000 }));
  d.metric('frog', 'wikipedia', 'wp_level', 5000); d.metric('frog', 'wikipedia', 'wp_rise', 2); d.metric('frog', 'wikipedia', 'wp_low_volume', 0);
  d.metric('frog shirt', 'etsy-market', 'etm_count', 1000, 100); d.metric('frog shirt', 'etsy-market', 'etm_price_p50', 100000, 100);
  const r = d.trends.scorer.score();
  const tee = r.items.find(i => i.productType === 'tee'); const mug = r.items.find(i => i.productType === 'mug');
  assert.deepEqual(tee.parts, { D: 1, R: 1, S: 0.6, C: 1, P: 1 }); assert.equal(tee.confidence, 1);
  assert.ok(Math.abs(tee.score - 100 * Math.pow(0.6, 0.2)) < 0.01);
  assert.deepEqual(mug.parts, { D: 1, R: 1, S: 0.6, C: 0.5, P: 0.5 }); assert.equal(mug.confidence, 0.6);   // 3 of 5 parts are real data
  assert.ok(Math.abs(mug.score - 100 * Math.pow(0.6, 0.2) * Math.pow(0.5, 0.35) * 0.8) < 0.01);
  assert.equal(mug.detail.C.neutral, true); assert.equal(mug.detail.C.badge, 'no competition data');
  const bare = setup(); bare.addTheme('quiet');
  const q = bare.trends.scorer.score().items.find(i => i.productType === 'tee');
  assert.deepEqual(q.parts, { D: 0.3, R: 0.35, S: 0.6, C: 0.5, P: 0.5 }); assert.equal(q.confidence, 0.4);   // only the calendar: 1/5 floors at 0.4
  // blocklist veto
  const b = setup(); b.addTheme('nike frog'); b.metric('nike frog', 'wikipedia', 'wp_level', 5000);
  const bi = b.trends.scorer.score().items.find(i => i.productType === 'tee');
  assert.equal(bi.score, 0); assert.ok(bi.blocked.includes('nike')); assert.ok(bi.parts.D > 0.9, 'parts are still shown');
  assert.equal(b.trends.opportunities().items.at(-1).theme, 'nike frog');
  // percentile once 20 themes carry the input
  const p = setup(); for (let i = 1; i <= 20; i++) { p.addTheme(`theme${i}`); p.metric(`theme${i}`, 'wikipedia', 'wp_level', i * 100); }
  const items = p.trends.scorer.score().items.filter(i => i.productType === 'tee');
  assert.equal(items.find(i => i.theme === 'theme20').parts.D, 1); assert.equal(items.find(i => i.theme === 'theme1').parts.D, 0.05);
  assert.equal(items.find(i => i.theme === 'theme10').detail.D.normalised, 'percentile');
});

test('manual direction feeds R and lifts K; a low-volume wikipedia rise is ignored', () => {
  const d = setup(); d.addTheme('frog');
  d.metric('frog', 'wikipedia', 'wp_level', 100); d.metric('frog', 'wikipedia', 'wp_rise', 3); d.metric('frog', 'wikipedia', 'wp_low_volume', 1);
  assert.equal(d.trends.scorer.score().items[0].detail.R.neutral, true);
  d.trends.manual.add({ source: 'pinterest-trends', term: 'frog', direction: 'rising' });
  const t = d.trends.scorer.score().items.find(i => i.productType === 'tee');
  assert.equal(t.parts.R, 0.8); assert.match(t.detail.R.source, /manual/);
});

test('rebuild raises concise trend_signal alerts (the proposals feature reads alerts)', async () => {
  const d = setup({ now: new Date('2026-03-20T16:00:00Z') }); d.addTheme('mom funny');
  d.metric('mom funny', 'wikipedia', 'wp_level', 5000);
  await d.trends.rebuild({ collect: false });
  const a = d.watch.alerts.list().filter(x => x.kind === 'trend_signal');
  assert.ok(a.length >= 1);
  const tee = a.find(x => /tee score/.test(x.message));
  assert.match(tee.message, /^mom funny: tee score \d+ \(D \.?\d+ R [.\d]+ S 1 C [.\d]+ P [.\d]+, conf [.\d]+\); season window open \(closing soon\), last order 04-26$/);
  const n = a.length; await d.trends.rebuild({ collect: false });
  assert.equal(d.watch.alerts.list().filter(x => x.kind === 'trend_signal').length, n, 'deduplicated per week');
  // and the watcher interface still works end to end, with only {message, severity}
  const sig = await d.watch.trendSource.check({ kind: 'theme', term: 'mom funny', notes: '' });
  assert.ok(sig.length >= 1); assert.doesNotThrow(() => validateSignals(sig));
});

// ---- report ----------------------------------------------------------------------------------------------------------
test('weekly report: sections, season windows with last-order dates, gaps, launches, sources, caveat', async () => {
  const d = setup({ now: new Date('2026-03-20T16:00:00Z') });
  d.addTheme('mom funny'); d.addTheme('frog');
  d.settings.set('trend_base_cost_cents', JSON.stringify({ tee: 1000 }));
  for (const t of ['mom funny', 'frog']) { d.metric(t, 'wikipedia', 'wp_level', 5000); d.metric(t, 'wikipedia', 'wp_rise', 1); d.metric(t, 'wikipedia', 'wp_low_volume', 0); d.metric(`${t} shirt`, 'etsy-market', 'etm_count', 1000, 100); d.metric(`${t} shirt`, 'etsy-market', 'etm_price_p50', 100000, 100); }
  const NOWI = '2026-03-20T16:00:00.000Z';
  const pid = Number(d.db.prepare("INSERT INTO products(stage, niche, title, keywords, brief, created_at, updated_at) VALUES('published','frog','Frog tee','[]','',?,?)").run(NOWI, NOWI).lastInsertRowid);
  const lid = Number(d.db.prepare("INSERT INTO listings(product_id, platform, external_id, created_at) VALUES(?,?,?,?)").run(pid, 'etsy', '123456', '2026-03-25T00:00:00.000Z').lastInsertRowid);
  d.db.prepare("INSERT INTO sales(listing_id, product_id, external_order_id, gross_cents, net_cents, quantity, source, ts) VALUES(?,?,?,?,?,?,?,?)").run(lid, pid, 'o1', 2500, 1500, 2, 'etsy', '2026-03-26T00:00:00.000Z');
  d.db.prepare("INSERT INTO watch_state(key, value, updated_at) VALUES(?,?,?)").run(`perf.listing.${lid}`, JSON.stringify({ views: 42 }), NOWI);
  const out = await d.trends.rebuild({ collect: false });
  const rep = out.report;
  assert.match(rep.caveat, /No source shows what other sellers sell\. Every number here is a proxy/);
  assert.equal(rep.week, '2026-W12'); assert.ok(rep.top.length >= 2); assert.ok(rep.top.length <= 10);
  assert.ok(rep.top.every((t, i, a) => i === 0 || a[i - 1].score >= t.score));
  assert.deepEqual(Object.keys(rep.top[0].parts), ['D', 'R', 'S', 'C', 'P']); assert.ok(['high', 'medium', 'low'].includes(rep.top[0].confidenceLevel));
  assert.ok(rep.risers.length >= 1 && rep.risers[0].rise === 1);
  const w = rep.seasonal.open.find(x => x.eventId === 'mothers-day' && x.productType === 'tee');
  assert.equal(w.lastOrderBy, '2026-04-26'); assert.equal(w.state, 'closing_soon'); assert.equal(w.listUntil, '2026-03-29');
  assert.ok(rep.seasonal.closingSoon.some(x => x.eventId === 'mothers-day'));
  assert.ok(rep.gaps.some(g => g.theme === 'mom funny') && !rep.gaps.some(g => g.theme === 'frog'), 'frog has a product, mom funny has none');
  assert.equal(rep.launches.length, 1);
  assert.deepEqual({ sales: rep.launches[0].sales, net: rep.launches[0].netCents, views: rep.launches[0].views, theme: rep.launches[0].theme }, { sales: 2, net: 1500, views: 42, theme: 'frog' });
  assert.ok(rep.launches[0].scoreAtLaunch > 0);
  const st = Object.fromEntries(rep.sources.map(s => [s.name, s.status]));
  assert.deepEqual(st, { season: 'ok', wikipedia: 'disabled', 'etsy-market': 'disabled', csv: 'no_data', manual: 'no_data' });
  assert.ok(rep.sources.every(s => 'lastRunAt' in s && 'detail' in s));
  d.trends.manual.add({ source: 'redbubble', term: 'frog' });
  assert.equal(d.trends.report().sources.find(s => s.name === 'manual').status, 'ok');
  assert.equal(d.trends.report().launchesNote, '');
  const empty = setup(); assert.match(empty.trends.report().empty, /No scores yet/); assert.match(empty.trends.report().launchesNote, /No launched product/);
  d.db.prepare("INSERT INTO trend_runs(source, status, detail, week, trigger, started_at, finished_at) VALUES('csv','error','boom','2026-W12','import',?,?)").run(NOWI, NOWI);
  assert.equal(d.trends.report().sources.find(s => s.name === 'csv').status, 'error');
});

test('collect runs the enabled sources, records a run row per source, and survives a source failure', async () => {
  const f = fakeFetch((url) => { if (/nager/.test(url)) return { status: 404, body: 'down' }; return { status: 404, body: '' }; });
  const d = setup({ fetch: f }); d.addTheme('frog');
  const out = await d.trends.rebuild({ collect: true });
  assert.equal(out.run.results.season.degraded, true);
  assert.equal(out.run.results.wikipedia.status, 'disabled'); assert.equal(out.run.results['etsy-market'].status, 'disabled');
  const runs = d.db.prepare('SELECT source FROM trend_runs ORDER BY id').all().map(r => r.source);
  assert.deepEqual(runs, ['season', 'wikipedia', 'etsy-market', 'score']);
  assert.ok(out.report.sources.find(s => s.name === 'season').detail.includes('table only'));
});

// ---- routes: owner-only, cross-origin, rebuild ------------------------------------------------------------------------
test('every trends route is owner-only (401 / 403 / owner passes) and mutating routes refuse cross-origin', async () => {
  const { buildAuth } = require('../server/auth');
  const d = setup();
  const cfgSso = { ...d.cfg, authMode: 'sso', owners: ['boss'] };
  const mk = (user) => buildAuth(cfgSso, { ssoFactory: () => (req, _res, next) => { if (user) req.user = user; next(); }, log: { warn() {} } });
  const routes = [
    ['GET', '/api/trends/report'], ['GET', '/api/trends/status'], ['GET', '/api/trends/opportunities'], ['GET', '/api/trends/articles'], ['GET', '/api/trends/manual'],
    ['POST', '/api/trends/report/rebuild', { collect: false }], ['POST', '/api/trends/settings', { weeklyEnabled: false }],
    ['POST', '/api/trends/etsy-market/enable', {}], ['POST', '/api/trends/etsy-market/disable', {}],
    ['PUT', '/api/trends/articles', { theme: 'frog', article: 'Frog' }],
    ['POST', '/api/trends/csv/preview', { csv: FIXTURE, tool: 'erank' }], ['POST', '/api/trends/manual', { term: 'frog' }],
  ];
  for (const [user, want] of [[null, 401], [{ username: 'rando' }, 403], [{ username: 'boss' }, 200]]) {
    const app = buildApp({ ...d, auth: mk(user) });
    const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
    for (const [method, url, body] of routes) {
      const res = await fetch(`http://127.0.0.1:${s.address().port}${url}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
      if (want === 200) assert.ok(res.status === 200 || res.status === 201, `${method} ${url} as owner -> ${res.status}`);
      else assert.equal(res.status, want, `${method} ${url} as ${JSON.stringify(user)}`);
    }
    s.close();
  }
  assert.equal(d.db.prepare('SELECT COUNT(*) n FROM trend_manual').get().n, 1, 'only the owner run wrote');
  // cross-origin
  const s = await serve(d);
  for (const [method, url, body] of routes.filter(r => r[0] !== 'GET')) {
    const before = d.db.prepare('SELECT COUNT(*) n FROM trend_manual').get().n;
    const res = await fetch(s.base + url, { method, headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify(body) });
    assert.equal(res.status, 403, `${method} ${url}`);
    assert.equal(d.db.prepare('SELECT COUNT(*) n FROM trend_manual').get().n, before);
  }
  const del = await fetch(`${s.base}/api/trends/manual/1`, { method: 'DELETE', headers: { Origin: 'https://evil.example' } });
  assert.equal(del.status, 403);
  assert.notEqual(d.settings.get('trend_etsy_market_enabled'), 'true');
  s.close();
});

test('rebuild route validates, rebuilds on demand, and csv/manual/settings work over HTTP', async () => {
  const d = setup(); d.addTheme('frog'); const s = await serve(d);
  assert.equal((await s.j('POST', '/api/trends/report/rebuild', { collect: 'yes' })).status, 400);
  const r = (await s.j('POST', '/api/trends/report/rebuild', { collect: false })).body;
  assert.equal(r.report.week, WEEK); assert.ok(r.report.top.length >= 1);
  const prev = (await s.j('POST', '/api/trends/csv/preview', { csv: FIXTURE, tool: 'erank' })).body;
  assert.equal((await s.j('POST', '/api/trends/csv/import', { csv: FIXTURE, tool: 'erank' })).status, 409);
  assert.equal((await s.j('POST', '/api/trends/csv/import', { csv: FIXTURE, tool: 'erank', previewHash: prev.previewHash })).body.numbersSaved, 8);
  assert.equal((await s.j('POST', '/api/trends/manual', { term: 'frog', source: 'pinterest-trends' })).status, 201);
  assert.equal((await s.j('POST', '/api/trends/manual', { term: 'frog', observedOn: '2099-01-01' })).status, 400);
  assert.equal((await s.j('POST', '/api/trends/settings', { weeklyEnabled: true, contact: 'me@example.test' })).body.settings.weeklyEnabled, true);
  assert.equal((await s.j('POST', '/api/trends/settings', { country: 'USA' })).status, 400);
  assert.equal((await s.j('GET', '/api/trends/status')).body.settings.contactSet, true);
  assert.equal((await s.j('DELETE', '/api/trends/manual/9999')).status, 404);
  assert.equal((await s.j('GET', '/api/trends/nope')).status, 404);
  s.close();
});

// ---- scheduler (off by default) --------------------------------------------------------------------------------------
test('weekly schedule: pure decision in ET, and OFF unless the owner turns it on', async () => {
  const mon = (iso) => new Date(iso);
  assert.equal(due({ now: mon('2026-10-05T10:59:00Z'), enabled: true, lastScheduledWeek: null }), false);   // 06:59 ET
  assert.equal(due({ now: mon('2026-10-05T11:00:00Z'), enabled: true, lastScheduledWeek: null }), true);    // 07:00 ET
  assert.equal(due({ now: mon('2026-10-05T11:00:00Z'), enabled: true, lastScheduledWeek: '2026-W41' }), false);
  assert.equal(due({ now: mon('2026-10-05T11:00:00Z'), enabled: false, lastScheduledWeek: null }), false);
  assert.equal(due({ now: mon('2026-10-06T16:00:00Z'), enabled: true, lastScheduledWeek: null }), false);   // Tuesday
  assert.equal(due({ now: mon('2026-10-12T03:00:00Z'), enabled: true, lastScheduledWeek: null }), false);   // still Sunday night ET
  const f = fakeFetch(() => ({ status: 404, body: '' }));
  const d = setup({ fetch: f, now: new Date('2026-10-05T12:00:00Z') });
  assert.equal(d.settings.get('trend_weekly_enabled'), null, 'off by default');
  assert.equal(typeof startTrendSchedule({ ...d, env: { NODE_ENV: 'test' } }), 'function');
  const timers = []; const stop = startTrendSchedule({ ...d, env: {} }, { setTimeoutFn: (fn) => { timers.push(fn); return {}; }, clearTimeoutFn() {}, now: () => d.clock.t, force: true });
  await timers.shift()();
  assert.equal(d.db.prepare('SELECT COUNT(*) n FROM trend_runs').get().n, 0, 'disabled: nothing ran');
  d.settings.set('trend_weekly_enabled', true);
  await timers.shift()();
  assert.equal(d.db.prepare("SELECT COUNT(*) n FROM trend_runs WHERE trigger = 'schedule'").get().n > 0, true);
  const n = d.db.prepare('SELECT COUNT(*) n FROM trend_runs').get().n;
  await timers.shift()();
  assert.equal(d.db.prepare('SELECT COUNT(*) n FROM trend_runs').get().n, n, 'at most once per week');
  stop();
});

// ---- migration and entrypoint ----------------------------------------------------------------------------------------
test('migration is additive and safe to rerun: existing rows survive, tables appear once', () => {
  const file = path.join(tmpDir(), 'old.db');
  let db = openDb(file); ensureTrendSchema(db);
  db.prepare("INSERT INTO trend_manual(source, term, observed_on, created_at) VALUES('other','frog','2026-10-01','t')").run();
  db.prepare("INSERT INTO products(stage, created_at, updated_at) VALUES('idea','t','t')").run();
  ensureTrendSchema(db); ensureTrendSchema(db); db.close();
  db = openDb(file); ensureTrendSchema(db);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM trend_manual').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM products').get().n, 1);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'trend_%'").all().map(r => r.name).sort();
  assert.deepEqual(names, ['trend_cache', 'trend_manual', 'trend_metrics', 'trend_runs', 'trend_scores', 'trend_theme_articles']);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'server', 'trends', 'schema.js'), 'utf8'), /DROP |ALTER |DELETE FROM/i);
});

test('the real entrypoint loads with the trends router and the schedule wired', async () => {
  const { assemble } = require('../server/index.js');
  const { app, deps } = assemble({ DATA_DIR: tmpDir() }, { dbFile: ':memory:', warn() {}, out: { log() {}, info() {}, warn() {}, error() {} } });
  assert.equal(typeof deps.trends.report, 'function');
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/trends/report`);
  assert.equal(res.status, 200); assert.match((await res.json()).caveat, /proxy/);
  srv.close();
});

test('a real server process boots, serves /api/trends/status, and starts no weekly run', async () => {
  const dataDir = tmpDir('ecom-trend-boot-');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { env: { PATH: process.env.PATH, DATA_DIR: dataDir, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server did not start')), 15000); let buf = '';
      child.stdout.on('data', (b) => { buf += b; const m = /listening on http:\/\/[\d.]+:(\d+)/.exec(buf); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
      child.on('exit', (c) => { clearTimeout(t); reject(new Error(`exited ${c}`)); });
    });
    const res = await fetch(`http://127.0.0.1:${port}/api/trends/status`);
    assert.equal(res.status, 200);
    const b = await res.json();
    assert.equal(b.settings.weeklyEnabled, false); assert.equal(b.settings.etsyMarketEnabled, false);
  } finally { child.kill('SIGKILL'); }
});
