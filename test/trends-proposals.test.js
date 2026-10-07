'use strict';
// Trends x Proposals: the Trends tab's "Generate proposals" request is one the real route accepts; proposals read the stored
// trend opportunities as signals without duplicating the trend_signal alerts; and proposals' season dates come from the trends table.
const { test } = require('node:test');
const assert = require('node:assert');
const { makeDeps } = require('./helpers');
const { buildApp } = require('../server/app');
const { makeProposals } = require('../server/proposals/service');
const M = require('../server/trends/metrics');
const seasons = require('../server/domain/seasons');
const { EVENTS } = require('../server/trends/season-table');
const D = require('../server/trends/dates');

const EPOCH = new Date('2026-10-06T16:00:00Z'); const WEEK = '2026-W41';
const quiet = { log() {}, info() {}, warn() {}, error() {} };
const setup = () => {
  const d = makeDeps({}, { nowDate: () => EPOCH, trendNow: () => EPOCH });
  const theme = (term, value) => {
    d.db.prepare('INSERT INTO watchlist(kind, term, notes, active, created_at, updated_at) VALUES(?,?,?,?,?,?)').run('theme', term, '', 1, EPOCH.toISOString(), EPOCH.toISOString());
    M.storeMetrics(d.db, [{ term, source: 'wikipedia', metric: 'wp_level', value, n: 100, week: WEEK }], { allowedTerms: new Set([term]) });
  };
  return { d, theme };
};
const svcWith = (d, llm) => makeProposals({ db: d.db, settings: d.settings, spend: d.spend, llm, adapters: d.adapters, pipeline: d.pipeline, confirm: d.confirm, watch: d.watch, trends: d.trends, cfg: d.cfg, log: quiet, now: () => EPOCH });
const fakeLlm = () => { const calls = []; return { calls, describe: () => ({ provider: 'openai', routing: {} }), async complete(a) { calls.push(a); return { model: 'fake', costCents: 0, text: JSON.stringify({ proposals: [] }) }; } }; };

test('proposals read stored trend opportunities as signals; blocked themes are left out', async () => {
  const { d, theme } = setup();
  theme('heron at dawn', 9000); theme('nike frog', 9000);
  d.trends.scorer.score(); // stores scores, raises no alerts
  assert.equal(d.db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE kind = 'trend_signal'").get().n, 0);
  const llm = fakeLlm(); const svc = svcWith(d, llm);
  await svc.generate({ count: 2, seeds: { themes: 'kites' } }).catch(() => {});
  const prompt = llm.calls[0].prompt;
  assert.match(prompt, /heron at dawn: tee opportunity score \d+/);
  assert.ok(!/nike frog/i.test(prompt), 'a blocklisted theme never reaches a prompt');
});

test('opportunity signals are deduplicated against the trend_signal alerts trends already raised', async () => {
  const { d, theme } = setup();
  theme('heron at dawn', 9000);
  d.trends.score(); // raises trend_signal alerts for the top scores
  assert.ok(d.db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE kind = 'trend_signal'").get().n > 0);
  const llm = fakeLlm(); const svc = svcWith(d, llm);
  await svc.generate({ count: 2, seeds: { themes: 'kites' } }).catch(() => {});
  const prompt = llm.calls[0].prompt;
  assert.match(prompt, /heron at dawn: tee score \d+/, 'the alert is there');
  assert.ok(!/opportunity score/.test(prompt), 'and the same pair is not listed a second time');
  // and when the trends feature is absent nothing changes
  const bare = svcWith(d, fakeLlm()); assert.ok(bare);
});

test('the Trends tab request is accepted by the real /api/proposals/generate route', async () => {
  // the client module is ESM in a CommonJS package: load its source as a module without touching package.json
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'client', 'src', 'components', 'trends', 'trendsApi.js'), 'utf8');
  const { proposalRequest } = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
  const { d, theme } = setup(); theme('heron at dawn', 9000); theme('tide pools', 8000);
  const { report } = await d.trends.rebuild({});
  const body = proposalRequest(report);
  assert.deepEqual(body.seeds.themes.sort(), ['heron at dawn', 'tide pools']);
  assert.deepEqual(body.productTypes.sort(), ['mug', 'poster', 'sticker', 'tshirt']);
  assert.ok(Number.isInteger(body.count) && body.count >= 1 && body.count <= 20);
  const server = await new Promise((r) => { const s = buildApp(d).listen(0, '127.0.0.1', () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/proposals/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const out = await res.json();
    assert.equal(res.status, 201, JSON.stringify(out)); assert.ok(out.proposals.length > 0);
    assert.ok(out.proposals.every(p => ['tshirt', 'mug', 'sticker', 'poster'].includes(p.productType)));
  } finally { await new Promise(r => server.close(r)); }
  // blocked and unmapped items are skipped; an empty report still yields a valid body
  assert.deepEqual(proposalRequest({ top: [{ theme: 'x', productType: 'tee', blocked: true }] }).seeds.themes, []);
  assert.equal(proposalRequest({}).count, 1);
});

test('proposals seasons take their dates from the trends table (one source of truth)', () => {
  const map = { 'new-year': 'new-years', valentines: 'valentines-day', 'st-patricks': 'st-patricks-day' };
  for (const h of seasons.HOLIDAYS) {
    const ev = EVENTS.find(e => e.id === (map[h.id] || h.id)); assert.ok(ev, `${h.id} has a trends event`);
    for (const y of [2026, 2027, 2028]) assert.equal(h.rule(y), ev.peak(y), `${h.id} ${y}`);
  }
  // where the two disagreed, the trends table wins
  const r = Object.fromEntries(seasons.HOLIDAYS.map(h => [h.id, h.rule(2026)]));
  assert.equal(r['new-year'], '2026-12-31'); assert.equal(r.graduation, '2026-05-15'); assert.equal(r['back-to-school'], '2026-08-15');
  // helpers are the trends helpers, signatures kept
  assert.equal(seasons.easter(2026), D.easter(2026)); assert.equal(seasons.nthWeekday(2026, 11, 4, 4), '2026-11-26');
  assert.equal(seasons.addDays('2026-02-27', 2), '2026-03-01'); assert.equal(seasons.diffDays('2026-03-01', '2026-02-27'), 2);
  assert.throws(() => seasons.addDays('2026-02-30', 1), /bad date/);
});

// ---- Hanukkah in proposals' season list ---------------------------------------------------------------------------------------
const { HANUKKAH_FIRST_DAY } = require('../server/trends/season-table');
const { templateProposals } = require('../server/proposals/templates');

test('Hanukkah is a proposals season; its date is the trends table value, and a year with no entry is skipped', () => {
  const h = seasons.byHoliday('hanukkah'); assert.ok(h);
  assert.equal(h.rule(2026), HANUKKAH_FIRST_DAY[2026]); assert.equal(h.rule(2027), HANUKKAH_FIRST_DAY[2027]);
  const w = seasons.windowFor('hanukkah', '2026-10-06');
  assert.equal(w.date, HANUKKAH_FIRST_DAY[2026]); assert.equal(w.lastOrder, seasons.addDays(HANUKKAH_FIRST_DAY[2026], -18)); assert.equal(w.listBy, seasons.addDays(w.lastOrder, -21)); assert.equal(w.status, 'open');
  assert.equal(h.rule(2040), null, 'the table has no 2040');
  assert.equal(seasons.windowFor('hanukkah', '2040-06-01'), null, 'no date: no window, never a null date');
  assert.ok(seasons.upcoming('2040-06-01', undefined, 400).every(x => x.date && x.holiday !== 'hanukkah'));
  assert.equal(seasons.windowFor('christmas', '2040-06-01').date, '2040-12-25');
  // too late this year, next year known
  const late = seasons.windowFor('hanukkah', '2026-12-04'); assert.equal(late.tooLate, true); assert.equal(late.next.date, HANUKKAH_FIRST_DAY[2027]);
  assert.deepEqual(seasons.matchOccasion('Chanukah gifts'), ['hanukkah']);
});

test('Hanukkah appears in /api/proposals/config seasons and a Hanukkah-seeded generation is tagged with it', async () => {
  const { d } = setup();
  const server = await new Promise((r) => { const s = buildApp(d).listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const cfg = await (await fetch(`${base}/api/proposals/config`)).json();
    const hk = cfg.seasons.find(s => s.holiday === 'hanukkah'); assert.ok(hk, 'listed');
    assert.equal(hk.date, HANUKKAH_FIRST_DAY[2026]); assert.equal(hk.status, 'open');
    const post = (b) => fetch(`${base}/api/proposals/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());
    const a = await post({ count: 3, seeds: { occasions: ['Hanukkah'] } });
    assert.ok(a.proposals.length && a.proposals.every(p => p.season === 'hanukkah'));
    assert.ok(a.proposals.every(p => !/christmas|star of david/i.test(`${p.title} ${p.brief} ${p.description} ${p.etsyTitle || ''}`)), 'simple, no Christmas framing');
    const b = await post({ count: 3, seeds: { themes: ['hanukkah menorah'] }, productTypes: ['mug'] });
    assert.ok(b.proposals.every(p => p.season === null || p.season === 'hanukkah'), 'a Hanukkah theme is never tagged with another holiday');
  } finally { await new Promise(r => server.close(r)); }
});

test('stub templates attach a pooled season only when the theme matches it (or no theme was given)', () => {
  const today = '2026-10-06';
  const windows = Object.fromEntries(seasons.HOLIDAYS.map(h => [h.id, seasons.windowFor(h.id, today)]).filter(([, w]) => w));
  const run = (subjects, pool = ['halloween', 'hanukkah']) => templateProposals({ count: 12, subjects, types: ['mug'], seasonalPool: pool, windows, today });
  const themed = run([{ term: 'hanukkah menorah', source: 'seed' }, { term: 'heron at dawn', source: 'seed' }]);
  for (const p of themed) {
    if (p.theme === 'heron at dawn') assert.equal(p.season, null, 'an unrelated theme gets no season');
    else assert.ok(p.season === null || p.season === 'hanukkah', `menorah tagged ${p.season}`);
    assert.ok(!(p.season && p.season !== 'hanukkah' && /hanukkah/i.test(p.title)), p.title);
  }
  const hkOnly = run([{ term: 'hanukkah menorah', source: 'seed' }, { term: 'heron at dawn', source: 'seed' }], ['hanukkah']);
  assert.ok(hkOnly.some(p => p.season === 'hanukkah'), 'the matching theme does get its season');
  assert.ok(hkOnly.filter(p => p.theme === 'heron at dawn').every(p => p.season === null));
  assert.ok(run([]).some(p => p.season), 'no theme given: evergreen filler may take a pooled season');
  const hk = hkOnly.find(p => p.season === 'hanukkah'); assert.match(hk.brief, /respectfully/); assert.ok(!/christmas/i.test(`${hk.title} ${hk.description}`));
});
