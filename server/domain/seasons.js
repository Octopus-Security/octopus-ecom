'use strict';
/**
 * seasons.js — holiday dates and print-on-demand lead times, so a proposal can say "list it by X, last realistic order Y"
 * and be flagged TOO LATE when that date has gone. Pure functions, no I/O. Every date is an ET calendar date string
 * (YYYY-MM-DD, see spend.etDay); arithmetic is done on UTC midnights so the machine's time zone never shifts a day.
 *
 * PROVENANCE (2026-10-06). The HOLIDAY DATES are computed from their calendar rules (fixed dates; nth weekday of a month;
 * Easter by the anonymous Gregorian algorithm) and are US dates. They were not looked up anywhere: they are calendar facts,
 * checked by tests against known years. "Graduation season" and "Back to school" are conventions (a representative date),
 * flagged `approx`. The LEAD TIMES are ASSUMED, UNVERIFIED planning defaults: no Printify or carrier schedule was read for
 * this file. They are the same kind of figure as the "weeks, not days" rule of thumb in the seasonal-prep playbook, and are
 * editable in the proposals settings (`proposals_lead_time`); replace them with the print provider's and the carrier's
 * published schedule for the year before relying on a last-order date.
 *   productionDays  5   calendar days from order to the item leaving the print provider (assumed)
 *   shippingDays   10   calendar days of standard US transit (assumed)
 *   bufferDays      3   slack for delays (assumed)
 *   rampDays       21   how long a new listing needs to be live before the season to be found (assumed)
 */
const DAY = 86400000;

const DEFAULT_LEAD = Object.freeze({ productionDays: 5, shippingDays: 10, bufferDays: 3, rampDays: 21 });
const LEAD_STATUS = 'assumed, unverified: planning defaults, not a Printify or carrier schedule';
const LEAD_BOUNDS = { productionDays: [0, 60], shippingDays: [0, 60], bufferDays: [0, 60], rampDays: [0, 180] };

const parseDay = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
  if (!m) throw new Error(`bad date "${iso}" (want YYYY-MM-DD)`);
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  if (new Date(t).toISOString().slice(0, 10) !== iso) throw new Error(`bad date "${iso}"`);
  return t;
};
const fmtDay = (t) => new Date(t).toISOString().slice(0, 10);
const addDays = (iso, n) => fmtDay(parseDay(iso) + n * DAY);
const diffDays = (a, b) => Math.round((parseDay(a) - parseDay(b)) / DAY); // a - b
const isDay = (s) => { try { parseDay(s); return true; } catch { return false; } };

/** ET calendar date. ET is the only clock. */
const etToday = (now = new Date()) => now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

const iso = (y, m, d) => fmtDay(Date.UTC(y, m - 1, d));
/** nth (1-based) given weekday (0 = Sunday) of a month (1-12). */
function nthWeekday(y, m, wd, n) {
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  return iso(y, m, 1 + ((wd - first + 7) % 7) + (n - 1) * 7);
}
/** Easter Sunday (anonymous Gregorian algorithm). */
function easter(y) {
  const a = y % 19; const b = Math.floor(y / 100); const c = y % 100; const d = Math.floor(b / 4); const e = b % 4; const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3); const h = (19 * a + b - d - g + 15) % 30; const i = Math.floor(c / 4); const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7; const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); const day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(y, month, day);
}

// `rule` maps a year to that year's date. `approx` marks a convention rather than a fixed day.
const HOLIDAYS = Object.freeze([
  { id: 'new-year', name: "New Year's Day", aliases: ['new year', 'new years'], rule: (y) => iso(y, 1, 1) },
  { id: 'valentines', name: "Valentine's Day", aliases: ['valentine', 'valentines'], rule: (y) => iso(y, 2, 14) },
  { id: 'st-patricks', name: "St. Patrick's Day", aliases: ['st patrick', 'st patricks', 'saint patrick', 'st paddys'], rule: (y) => iso(y, 3, 17) },
  { id: 'easter', name: 'Easter', aliases: ['easter'], rule: easter },
  { id: 'mothers-day', name: "Mother's Day", aliases: ['mother', 'mothers', 'mom', 'mama'], rule: (y) => nthWeekday(y, 5, 0, 2) },
  { id: 'graduation', name: 'Graduation season', aliases: ['graduation', 'graduate', 'grad'], rule: (y) => iso(y, 5, 20), approx: true },
  { id: 'fathers-day', name: "Father's Day", aliases: ['father', 'fathers', 'dad', 'papa'], rule: (y) => nthWeekday(y, 6, 0, 3) },
  { id: 'independence-day', name: 'Independence Day (July 4)', aliases: ['july 4', 'fourth of july', '4th of july', 'independence day'], rule: (y) => iso(y, 7, 4) },
  { id: 'back-to-school', name: 'Back to school', aliases: ['back to school'], rule: (y) => iso(y, 8, 20), approx: true },
  { id: 'halloween', name: 'Halloween', aliases: ['halloween', 'spooky season'], rule: (y) => iso(y, 10, 31) },
  { id: 'thanksgiving', name: 'Thanksgiving', aliases: ['thanksgiving', 'friendsgiving'], rule: (y) => nthWeekday(y, 11, 4, 4) },
  { id: 'christmas', name: 'Christmas', aliases: ['christmas', 'xmas', 'holiday', 'holidays', 'festive'], rule: (y) => iso(y, 12, 25) },
]);
const byHoliday = (id) => HOLIDAYS.find(h => h.id === id) || null;

/** Merge an override over the defaults; every figure must be a whole number within its bounds. Throws a plain Error naming the field. */
function resolveLead(input) {
  const out = { ...DEFAULT_LEAD };
  for (const [k, v] of Object.entries(input || {})) {
    if (!(k in LEAD_BOUNDS)) throw new Error(`unknown lead-time field: ${k}`);
    const [lo, hi] = LEAD_BOUNDS[k];
    if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${k} must be a whole number of days from ${lo} to ${hi}`);
    out[k] = v;
  }
  return out;
}

/** The next occurrence of a holiday on or after `today` (an ET date). */
function nextOccurrence(holiday, today) {
  const y = Number(today.slice(0, 4));
  const thisYear = holiday.rule(y);
  return diffDays(thisYear, today) >= 0 ? thisYear : holiday.rule(y + 1);
}

/**
 * The window for one holiday, from `today` (ET) and the lead times.
 *   lastOrder = date - production - shipping - buffer;  listBy = lastOrder - ramp.
 *   status: 'too_late' (today is past the last realistic order date for THIS occurrence), 'tight' (orders can still arrive
 *   in time but a new listing has less than the ramp to be found), 'open' (listBy is still ahead).
 * When too late, `next` holds the same figures for the following year, so "too late" points at next year rather than a dead end.
 */
function windowFor(holidayId, today, lead = DEFAULT_LEAD) {
  const h = byHoliday(holidayId);
  if (!h) return null;
  const L = { ...DEFAULT_LEAD, ...lead };
  const build = (date) => {
    const lastOrder = addDays(date, -(L.productionDays + L.shippingDays + L.bufferDays));
    const listBy = addDays(lastOrder, -L.rampDays);
    const toLast = diffDays(lastOrder, today); const toList = diffDays(listBy, today);
    return {
      holiday: h.id, name: h.name, date, lastOrder, listBy, daysToHoliday: diffDays(date, today), daysToLastOrder: toLast, daysToListBy: toList,
      status: toLast < 0 ? 'too_late' : toList < 0 ? 'tight' : 'open', approx: !!h.approx,
    };
  };
  const w = build(nextOccurrence(h, today));
  const out = { ...w, tooLate: w.status === 'too_late', lead: L, leadStatus: LEAD_STATUS };
  if (out.tooLate) {
    const n = build(h.rule(Number(w.date.slice(0, 4)) + 1));
    out.next = { date: n.date, lastOrder: n.lastOrder, listBy: n.listBy, status: n.status };
  }
  out.summary = out.tooLate
    ? `${h.name} ${w.date}: TOO LATE this year (last realistic order date ${w.lastOrder} has passed); next chance ${out.next.date}, list by ${out.next.listBy}`
    : `${h.name} ${w.date}: ${w.status === 'tight' ? 'TIGHT, list now' : `list by ${w.listBy}`}; last realistic order date ${w.lastOrder} (${w.daysToLastOrder} days)`;
  return out;
}

/** Every holiday within `horizonDays` of today, nearest first, each with its window (including ones already too late this year). */
function upcoming(today, lead = DEFAULT_LEAD, horizonDays = 200) {
  return HOLIDAYS.map(h => windowFor(h.id, today, lead)).filter(w => w.daysToHoliday <= horizonDays).sort((a, b) => a.daysToHoliday - b.daysToHoliday);
}

const plain = (s) => String(s || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
/** Holiday ids an owner's free-text occasion refers to ("father's day", "xmas"). Whole-word, alias-based; unknown text matches nothing. */
function matchOccasion(text) {
  const t = ` ${plain(text)} `;
  return HOLIDAYS.filter(h => [h.name, ...h.aliases].some(a => t.includes(` ${plain(a)} `))).map(h => h.id);
}

module.exports = { HOLIDAYS, DEFAULT_LEAD, LEAD_STATUS, LEAD_BOUNDS, resolveLead, windowFor, upcoming, matchOccasion, nextOccurrence, etToday, addDays, diffDays, isDay, byHoliday, easter, nthWeekday };
