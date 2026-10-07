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
 *
 * ONE SOURCE OF TRUTH FOR DATES (2026-10-06). The holiday dates and the calendar helpers (ET day, add/diff days, nth weekday,
 * Easter) come from the trends feature: trends/season-table.js EVENTS[].peak(year) and trends/dates.js. This file only maps
 * its own holiday ids to those events and keeps its exported signatures. Where the two disagreed the trends table won:
 * New Year (Jan 1 -> Dec 31, the trends peak), Graduation (May 20 -> May 15), Back to school (Aug 20 -> Aug 15).
 *
 * TWO DIFFERENT "LEAD TIME" IDEAS, BOTH KEPT (they answer different questions; do not merge them):
 *   - HERE (proposals): lastOrder = date - (production + shipping + buffer) = 18 days by default, the same for every product,
 *     and listBy = lastOrder - rampDays (21) = "the latest day to START listing a NEW idea". Owner-editable (proposals_lead_time).
 *   - TRENDS (adapters/trend/season.js): per PRODUCT TYPE, a listing WINDOW in weeks before the peak (tee/mug 6-14, sticker 4-10,
 *     wall art 8-16: when a listing ranks best) and a LAST-ORDER lead in days (tee/mug 14, sticker 10, wall art 16).
 *   Both are assumed, unverified planning figures. Do not compare a proposals lastOrder with a trends lastOrderBy for the same
 *   holiday: the first is a conservative whole-shop figure, the second is per product type.
 */
const TD = require('../trends/dates');
const { EVENTS } = require('../trends/season-table');

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
const addDays = (iso, n) => { parseDay(iso); return TD.addDays(iso, n); };
const diffDays = (a, b) => { parseDay(a); parseDay(b); return TD.daysBetween(b, a); }; // a - b
const isDay = (s) => { try { parseDay(s); return true; } catch { return false; } };

/** ET calendar date. ET is the only clock. */
const etToday = (now = new Date()) => TD.etDay(now);

const nthWeekday = TD.nthWeekday; // (year, month 1-12, weekday 0 = Sunday, n 1-based)
const easter = TD.easter;
/** This file's holiday id -> the trends event whose peak(year) supplies the date. */
const EVENT_OF = Object.freeze({
  'new-year': 'new-years', valentines: 'valentines-day', 'st-patricks': 'st-patricks-day', easter: 'easter', 'mothers-day': 'mothers-day',
  graduation: 'graduation', 'fathers-day': 'fathers-day', 'independence-day': 'independence-day', 'back-to-school': 'back-to-school',
  halloween: 'halloween', thanksgiving: 'thanksgiving', christmas: 'christmas',
});
const peakOf = (id) => {
  const ev = EVENTS.find(e => e.id === EVENT_OF[id]);
  if (!ev) throw new Error(`no trends event for holiday "${id}"`);
  return ev.peak;
};

// `rule` maps a year to that year's date. `approx` marks a convention rather than a fixed day.
const HOLIDAYS = Object.freeze([
  { id: 'new-year', name: "New Year's", aliases: ['new year', 'new years'], rule: peakOf('new-year') },
  { id: 'valentines', name: "Valentine's Day", aliases: ['valentine', 'valentines'], rule: peakOf('valentines') },
  { id: 'st-patricks', name: "St. Patrick's Day", aliases: ['st patrick', 'st patricks', 'saint patrick', 'st paddys'], rule: peakOf('st-patricks') },
  { id: 'easter', name: 'Easter', aliases: ['easter'], rule: peakOf('easter') },
  { id: 'mothers-day', name: "Mother's Day", aliases: ['mother', 'mothers', 'mom', 'mama'], rule: peakOf('mothers-day') },
  { id: 'graduation', name: 'Graduation season', aliases: ['graduation', 'graduate', 'grad'], rule: peakOf('graduation'), approx: true },
  { id: 'fathers-day', name: "Father's Day", aliases: ['father', 'fathers', 'dad', 'papa'], rule: peakOf('fathers-day') },
  { id: 'independence-day', name: 'Independence Day (July 4)', aliases: ['july 4', 'fourth of july', '4th of july', 'independence day'], rule: peakOf('independence-day') },
  { id: 'back-to-school', name: 'Back to school', aliases: ['back to school'], rule: peakOf('back-to-school'), approx: true },
  { id: 'halloween', name: 'Halloween', aliases: ['halloween', 'spooky season'], rule: peakOf('halloween') },
  { id: 'thanksgiving', name: 'Thanksgiving', aliases: ['thanksgiving', 'friendsgiving'], rule: peakOf('thanksgiving') },
  { id: 'christmas', name: 'Christmas', aliases: ['christmas', 'xmas', 'holiday', 'holidays', 'festive'], rule: peakOf('christmas') },
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
