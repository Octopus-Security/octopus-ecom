'use strict';
// Trend sources: dates, season table, Nager.Date adapter, ET midnight.
const { test } = require('node:test');
const assert = require('node:assert');
const D = require('../server/trends/dates');
const T = require('../server/trends/season-table');
const { openDb } = require('../server/db');
const { ensureTrendSchema } = require('../server/trends/schema');
const { makeCache } = require('../server/trends/cache');
const { createSeason, seasonFit } = require('../server/adapters/trend/season');
const { fakeFetch, fakeHttp } = require('./helpers');

function mk({ now, fetch } = {}) {
  const db = openDb(':memory:'); ensureTrendSchema(db);
  const clock = { t: new Date(now || '2026-10-06T16:00:00Z') };
  const cache = makeCache(db, () => clock.t);
  const f = fetch || fakeFetch(() => ({ status: 200, body: [] }));
  const season = createSeason({ http: fakeHttp(f), cache, settings: { get: () => null }, env: {}, now: () => clock.t });
  return { db, season, clock, f };
}

test('ET day: the calendar date in New York, not UTC', () => {
  assert.equal(D.etDay(new Date('2026-03-29T03:30:00Z')), '2026-03-28');   // 23:30 EDT
  assert.equal(D.etDay(new Date('2026-03-29T04:30:00Z')), '2026-03-29');   // 00:30 EDT
  assert.equal(D.etDay(new Date('2026-01-01T04:59:00Z')), '2025-12-31');   // EST
});

test('date rules pin the 2026 dates', () => {
  assert.equal(D.nthWeekday(2026, 5, 0, 2), '2026-05-10');   // Mother's Day
  assert.equal(D.nthWeekday(2026, 6, 0, 3), '2026-06-21');   // Father's Day
  assert.equal(D.nthWeekday(2026, 11, 4, 4), '2026-11-26');  // Thanksgiving
  assert.equal(D.lastWeekday(2026, 5, 1), '2026-05-25');     // Memorial Day
  assert.equal(D.easter(2026), '2026-04-05'); assert.equal(D.easter(2027), '2027-03-28');
  assert.equal(D.isoWeek('2026-10-06'), '2026-W41'); assert.equal(D.isoWeek('2026-01-01'), '2026-W01'); assert.equal(D.isoWeek('2027-01-01'), '2026-W53');
});

test('Hanukkah table matches the ICU Hebrew calendar (25 Kislev) and a missing year yields no event, not a guess', () => {
  const f = new Intl.DateTimeFormat('en-u-ca-hebrew', { month: 'long', day: 'numeric', timeZone: 'UTC' });
  const isFirst = (day) => { const p = f.formatToParts(new Date(`${day}T12:00:00Z`)); return p.find(x => x.type === 'day').value === '25' && p.find(x => x.type === 'month').value === 'Kislev'; };
  for (const [y, day] of Object.entries(T.HANUKKAH_FIRST_DAY)) assert.ok(isFirst(day), `${y} ${day}`);
  const hk = T.EVENTS.find(e => e.id === 'hanukkah');
  assert.equal(hk.peak(2026), '2026-12-05'); assert.equal(hk.peak(2099), null);
});

test('every event has dates and every product type has a window and a lead time', () => {
  for (const e of T.EVENTS) assert.ok(e.peak(2026), e.id);
  for (const t of T.PRODUCT_TYPES) { assert.ok(T.WINDOWS[t]); assert.ok(T.LEAD_DAYS[t] > 0); }
  for (const id of ['mothers-day', 'fathers-day', 'valentines-day', 'graduation', 'back-to-school', 'halloween', 'thanksgiving', 'hanukkah', 'christmas']) assert.ok(T.EVENTS.find(e => e.id === id), id);
});

test('seasonFit: spec shape (1 inside the window, linear to 0.2 over 6 weeks either side, 0.1 just after the peak)', () => {
  assert.equal(seasonFit(10, [6, 14]), 1); assert.equal(seasonFit(6, [6, 14]), 1); assert.equal(seasonFit(14, [6, 14]), 1);
  assert.equal(seasonFit(3, [6, 14]), 0.6);     // 1 - 0.8*3/6
  assert.equal(seasonFit(0, [6, 14]), 0.2);
  assert.equal(seasonFit(17, [6, 14]), 0.6);    // 1 - 0.8*3/6
  assert.equal(seasonFit(30, [6, 14]), 0.2);
  assert.equal(seasonFit(-1, [6, 14]), 0.1); assert.equal(seasonFit(-3, [6, 14]), 0.2);
});

test("events for 2026-03-20: Mother's Day tee window open, closing soon, last order by peak - 14 days", () => {
  const { season } = mk({ now: '2026-03-20T16:00:00Z' });
  const m = season.events('2026-03-20').find(e => e.id === 'mothers-day');
  assert.equal(m.peak, '2026-05-10'); assert.equal(m.peakSource, 'table');
  const tee = m.perType.tee;
  assert.equal(tee.listFrom, '2026-02-01'); assert.equal(tee.listUntil, '2026-03-29'); assert.equal(tee.lastOrderBy, '2026-04-26');
  assert.ok(tee.open && tee.closingSoon && tee.daysToClose === 9);
  assert.equal(m.perType.wall_art.listUntil, '2026-03-15'); assert.equal(m.perType.wall_art.open, false);
});

test('ET midnight: the window boundary follows the New York date, not UTC', () => {
  const at = (iso) => { const { season } = mk({ now: iso }); const today = D.etDay(new Date(iso)); const m = season.events(today).find(e => e.id === 'mothers-day'); return { today, tee: m.perType.tee }; };
  const a = at('2026-03-30T03:30:00Z');   // UTC says Mar 30, ET still Mar 29 (last open day)
  assert.equal(a.today, '2026-03-29'); assert.equal(a.tee.open, true); assert.equal(a.tee.daysToClose, 0);
  const b = at('2026-03-30T04:30:00Z');   // ET Mar 30 00:30: closed
  assert.equal(b.today, '2026-03-30'); assert.equal(b.tee.open, false); assert.equal(b.tee.late, true);
  const h1 = mk().season.events('2026-10-30').find(e => e.id === 'halloween'); const h2 = mk().season.events('2026-10-31').find(e => e.id === 'halloween');
  assert.equal(h1.daysToPeak, 1); assert.equal(h2.daysToPeak, 0);
});

test('a peak that passed under 2 weeks ago is still listed; older ones roll to next year', () => {
  const { season } = mk();
  assert.equal(season.events('2026-11-30').find(e => e.id === 'thanksgiving').peak, '2026-11-26');
  assert.equal(season.events('2026-12-20').find(e => e.id === 'thanksgiving').peak, '2027-11-25');
  assert.equal(season.events('2027-01-03').find(e => e.id === 'christmas').peak, '2026-12-25');
});

test('fitFor: themed words map to events; an evergreen theme is fixed at 0.6', () => {
  const { season } = mk();
  const e = season.fitFor('mom funny', 'tee', '2026-03-20'); assert.equal(e.fit, 1); assert.equal(e.event.id, 'mothers-day');
  const g = season.fitFor('frog', 'tee', '2026-03-20'); assert.equal(g.fit, 0.6); assert.equal(g.evergreen, true);
  assert.equal(season.fitFor('moment', 'tee', '2026-03-20').evergreen, true);   // "mom" must not match "moment"
});

test('Nager.Date: fetched once per country-year, cached, supplies the date, failure falls back to the table', async () => {
  const seen = [];
  const f = fakeFetch((url) => { seen.push(url); if (/\/2026\//.test(url)) return { body: [{ date: '2026-11-27', name: 'Thanksgiving Day' }, { date: '2026-06-19', name: 'Juneteenth National Independence Day' }, { date: '2026-10-12', name: 'Columbus Day' }] }; return { status: 404, body: 'no' }; });
  const { season } = mk({ fetch: f });
  const r = await season.collect();
  assert.equal(r.fetched, 1); assert.equal(r.degraded, true); assert.match(r.detail, /table only/);
  assert.ok(seen[0].startsWith('https://date.nager.at/api/v3/PublicHolidays/2026/US'));
  const th = season.events('2026-10-06').find(e => e.id === 'thanksgiving');
  assert.equal(th.peak, '2026-11-27'); assert.equal(th.peakSource, 'nager');   // Nager wins when it has the holiday
  assert.ok(season.events('2026-10-06').find(e => e.generic && e.name === 'Columbus Day'));
  const before = f.calls.length; await season.collect();
  assert.equal(f.calls.slice(before).filter(c => /\/2026\//.test(c.url)).length, 0, 'the 2026 list is cached, not refetched');
});

test('season check() is network-free and speaks only when a window is open', async () => {
  const { season, f } = mk({ now: '2026-03-20T16:00:00Z' });
  const s = await season.check({ term: 'funny mom shirt' });
  assert.equal(s.length, 1); assert.match(s[0].message, /Mother's Day.*last order by 2026-04-26/); assert.equal(s[0].severity, 'warn');
  assert.deepEqual(await season.check({ term: 'frog' }), []);
  assert.equal(f.calls.length, 0);
});
