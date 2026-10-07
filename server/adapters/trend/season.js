'use strict';
/**
 * adapters/trend/season.js — the SEASON source: Nager.Date public holidays + the checked-in observance table.
 *
 * Nager.Date: GET https://date.nager.at/api/v3/PublicHolidays/{year}/{countryCode} — no key. verified 2026-10-06 - the spec
 * (octopus-vault/memory/ecom-trend-sources.md 2.8) called it live that day: HTTP 200, JSON with date, name, localName, global,
 * types. It lists PUBLIC holidays only, not the observances print-on-demand sells around, which is why the checked-in table
 * (trends/season-table.js) is the core and Nager only supplies/cross-checks dates when it has the holiday. No rate limit is
 * stated (corroborated); we make at most two calls per country per 30 days.
 *
 * Failure of Nager is never a failure of the source: the table alone still answers every question, and the status line says
 * so ("table only"). Dates are ET calendar dates (trends/dates.js). Network is touched ONLY by collect(); events(),
 * seasonFit() and check() read the cache and the table, so a watcher run is network-free.
 *
 * Read-only: nothing here writes to any marketplace, so DRY_RUN does not change its behaviour.
 */
const D = require('../../trends/dates');
const T = require('../../trends/season-table');
const { PRODUCT_TYPES } = T;

const NAGER = 'https://date.nager.at/api/v3/PublicHolidays';
const TTL_MS = 30 * 86400000;
const CLOSING_SOON_DAYS = 14;

/** season_fit in [0,1] from weeks to the peak and the product type's listing window (spec 5.1). */
function seasonFit(weeksToPeak, [min, max]) {
  const w = weeksToPeak;
  if (w < 0) return w >= -2 ? 0.1 : 0.2;           // peak passed less than 2 weeks ago: only evergreens still sell
  if (w >= min && w <= max) return 1;
  if (w < min) return w >= min - 6 ? round(1 - 0.8 * (min - w) / 6) : 0.2;
  return w <= max + 6 ? round(1 - 0.8 * (w - max) / 6) : 0.2;
}
const round = (x) => Math.round(x * 1000) / 1000;

function matchesTerm(term, keywords) {
  const text = ` ${String(term || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/'/g, '')} `;
  const tokens = text.trim().split(/\s+/);
  return keywords.some(k => {
    const kw = k.toLowerCase().replace(/'/g, '');
    if (kw.includes(' ')) return text.includes(` ${kw} `);
    return tokens.some(t => t === kw || (kw.length >= 5 && t.startsWith(kw)));
  });
}

function createSeason({ http, cache, settings, env = {}, now = () => new Date(), log = { info() {}, warn() {} } } = {}) {
  const country = () => String((settings && settings.get('trend_country')) || env.TREND_COUNTRY || 'US').trim().toUpperCase().slice(0, 2) || 'US';
  const cacheKey = (year, cc) => `nager:${cc}:${year}`;

  /** The cached Nager list for a year ({date,name}[]) or null. Stale rows are still served: a calendar does not rot in a week. */
  const nagerYear = (year) => { const c = cache.get(cacheKey(year, country()), { allowStale: true }); return c ? c.value : null; };

  async function collect({ force = false } = {}) {
    const today = D.etDay(now()); const y = D.yearOf(today); const cc = country();
    const out = { source: 'season', status: 'ok', country: cc, years: [], fetched: 0, detail: '' };
    const problems = [];
    for (const year of [y, y + 1]) {
      const have = cache.get(cacheKey(year, cc));
      if (have && !force) { out.years.push(year); continue; }
      try {
        const res = await http.request(`${NAGER}/${year}/${cc}`, { headers: { Accept: 'application/json', 'User-Agent': 'octopus-ecom trend calendar (read-only)' }, ratePerSec: 1 });
        const list = res.json();
        if (!Array.isArray(list)) throw new Error('Nager.Date returned something other than a list');
        cache.set(cacheKey(year, cc), list.filter(h => h && typeof h.date === 'string' && typeof h.name === 'string').map(h => ({ date: h.date.slice(0, 10), name: h.name })), TTL_MS);
        out.fetched++; out.years.push(year);
      } catch (e) { problems.push(`${year}: ${e.message}`); log.warn(`[trend] Nager.Date ${year}/${cc} failed: ${e.message}`); }
    }
    out.detail = problems.length ? `Nager.Date unavailable (${problems.join('; ')}); dates come from the checked-in table only` : `Nager.Date ${cc} cached for ${out.years.join(', ')}`;
    out.degraded = problems.length > 0;
    return out;
  }

  /** All event occurrences relevant to `today`: the next peak of each event (or one that passed under 14 days ago). */
  function events(today = D.etDay(now())) {
    const y = D.yearOf(today); const out = [];
    const nager = new Map();
    for (const year of [y - 1, y, y + 1]) for (const h of nagerYear(year) || []) nager.set(`${h.name}|${year}`, h.date);
    const claimed = new Set();
    for (const ev of T.EVENTS) {
      let pick = null;
      for (const year of [y - 1, y, y + 1]) {
        let peak = ev.peak(year); let src = 'table';
        for (const nm of ev.nager || []) { const d = nager.get(`${nm}|${year}`); if (d) { peak = d; src = 'nager'; claimed.add(`${nm}|${year}`); break; } }
        if (!peak) continue;
        if (D.daysBetween(today, peak) >= -14) { pick = { peak, src }; break; }
      }
      if (pick) out.push(occurrence(ev, pick.peak, pick.src, today, false));
    }
    // Public holidays Nager has that the table does not: kept, marked generic, never invented windows beyond the defaults.
    const tableNames = new Set(T.EVENTS.flatMap(e => e.nager || []));
    const seen = new Set();
    for (const [k, date] of nager) {
      const [name] = k.split('|');
      if (tableNames.has(name) || seen.has(name) || D.daysBetween(today, date) < -14) continue;
      const next = [...nager].filter(([kk]) => kk.startsWith(`${name}|`)).map(([, d]) => d).filter(d => D.daysBetween(today, d) >= -14).sort()[0];
      seen.add(name);
      out.push(occurrence({ id: `nager:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, name, keywords: [name.toLowerCase()] }, next, 'nager', today, true));
    }
    return out.sort((a, b) => a.peak.localeCompare(b.peak));
  }

  function occurrence(ev, peak, peakSource, today, generic) {
    const daysToPeak = D.daysBetween(today, peak);
    const perType = {};
    for (const type of PRODUCT_TYPES) {
      const [min, max] = T.WINDOWS[type];
      const listFrom = D.addDays(peak, -max * 7); const listUntil = D.addDays(peak, -min * 7);
      const lastOrderBy = D.addDays(peak, -T.LEAD_DAYS[type]);
      const w = daysToPeak / 7;
      const open = today >= listFrom && today <= listUntil;
      const untilClose = D.daysBetween(today, listUntil);
      perType[type] = {
        fit: seasonFit(w, [min, max]), listFrom, listUntil, lastOrderBy, open,
        closingSoon: open && untilClose <= CLOSING_SOON_DAYS,
        late: !open && today > listUntil && today <= lastOrderBy,       // ranking warm-up is short, but an order can still arrive
        orderable: today <= lastOrderBy,
        daysToClose: open ? untilClose : null,
      };
    }
    return { id: ev.id, name: ev.name, keywords: ev.keywords || [], peak, peakSource, generic, daysToPeak, weeksToPeak: round(daysToPeak / 7), perType };
  }

  /** {fit, event|null, source:'calendar'|'evergreen'} for a theme and product type. An evergreen theme (no event) is fixed at 0.6. */
  function fitFor(theme, type, today = D.etDay(now())) {
    const hits = events(today).filter(e => matchesTerm(theme, e.keywords));
    if (!hits.length) return { fit: 0.6, event: null, evergreen: true };
    const best = hits.map(e => ({ e, fit: e.perType[type].fit })).sort((a, b) => b.fit - a.fit)[0];
    return { fit: best.fit, event: { id: best.e.id, name: best.e.name, peak: best.e.peak, weeksToPeak: best.e.weeksToPeak, ...best.e.perType[type] }, evergreen: false };
  }

  return {
    kind: 'trend', name: 'season',
    describe: () => `Season calendar: checked-in observance table, dates cross-checked with Nager.Date (${country()}) when it has the holiday. Read-only, no key.`,
    enabled: () => ({ enabled: true, reason: '' }),
    collect, events, fitFor, matchesTerm, country,
    /** Network-free: reads the cache and the table. */
    async check(entry) {
      const today = D.etDay(now());
      return events(today).filter(e => !e.generic && matchesTerm(entry.term, e.keywords)).flatMap(e => {
        const open = PRODUCT_TYPES.filter(t => e.perType[t].open); const closing = PRODUCT_TYPES.filter(t => e.perType[t].closingSoon);
        if (!open.length) return [];
        const t = open[0];
        return [{ severity: closing.length ? 'warn' : 'info', message: `${e.name} (${e.peak}): listing window open${closing.length ? `, closes soon for ${closing.join('/')}` : ''}; last order by ${e.perType[t].lastOrderBy} (${t}, an estimate).` }];
      });
    },
  };
}

module.exports = { createSeason, seasonFit, matchesTerm, CLOSING_SOON_DAYS };
