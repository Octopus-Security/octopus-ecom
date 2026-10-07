'use strict';
/**
 * trends/season-table.js — the checked-in observance and season table (spec: octopus-vault/memory/ecom-trend-sources.md 2.8).
 *
 * WHAT IS CHECKED IN, AND HOW SURE WE ARE (2026-10-06):
 *  - Dates by RULE (2nd Sunday of May, 4th Thursday of November, Easter by the Gregorian computus, fixed month/day): arithmetic,
 *    not guesses. The unit tests pin the 2026 dates and cross-check them against Nager.Date's shape where Nager has the holiday.
 *    The rules themselves are the common US conventions: assumed, unverified against any published calendar in this session.
 *  - HANUKKAH is not a Gregorian rule, so it is a TABLE of the first day (25 Kislev), never extrapolated: a year not in the
 *    table yields NO Hanukkah event rather than a guess. The table was produced 2026-10-06 with the ICU Hebrew calendar in
 *    Node's Intl (2025-2034) and a test re-derives it, but it has not been checked against a published calendar:
 *    assumed, unverified - confirm against hebcal.com before relying on a year.
 *  - Graduation (15 May) and back-to-school (15 August) have no single date: the peak is a stated midpoint. assumed, unverified.
 *  - LISTING WINDOWS (weeks before the peak in which to have the listing live) per product type: tee/mug 6-14, wall art 8-16,
 *    stickers 4-10, from the spec (secondary guidance, 8-12 weeks typical). assumed, unverified; measure our own time to first sale.
 *  - LAST-ORDER LEAD TIME (days before the peak by which an order must be placed to arrive): production + shipping estimates,
 *    NOT provider quotes. assumed, unverified. The seasonal-prep playbook says to replace them with this year's provider cut-offs.
 */
const D = require('./dates');

const PRODUCT_TYPES = ['tee', 'mug', 'sticker', 'wall_art'];
const PRODUCT_LABELS = { tee: 'T-shirt', mug: 'Mug', sticker: 'Sticker', wall_art: 'Wall art' };
/** Words that put a search phrase in a product type, and the suffix we append to a theme to build "<theme> <suffix>". */
const PRODUCT_WORDS = {
  tee: { suffix: 'shirt', words: ['shirt', 'tee', 'tshirt', 't-shirt', 'sweatshirt', 'hoodie'] },
  mug: { suffix: 'mug', words: ['mug', 'cup'] },
  sticker: { suffix: 'sticker', words: ['sticker', 'decal'] },
  wall_art: { suffix: 'wall art', words: ['poster', 'print', 'wall art', 'canvas'] },
};
const WINDOWS = { tee: [6, 14], mug: [6, 14], sticker: [4, 10], wall_art: [8, 16] };
const LEAD_DAYS = { tee: 14, mug: 14, sticker: 10, wall_art: 16 };

/** First day (25 Kislev) of Hanukkah. The evening BEFORE is the first candle. See the header: assumed, unverified. */
const HANUKKAH_FIRST_DAY = {
  2025: '2025-12-15', 2026: '2026-12-05', 2027: '2027-12-25', 2028: '2028-12-13', 2029: '2029-12-02',
  2030: '2030-12-21', 2031: '2031-12-10', 2032: '2032-11-28', 2033: '2033-12-17', 2034: '2034-12-07',
};

const fixed = (m, d) => (y) => D.ymd(y, m, d);
/**
 * id, name, peak(year) -> date|null, keywords (a theme containing one is "about" this event), nager (Nager.Date names that
 * supply the date when it is a public holiday). Windows and lead times come from WINDOWS / LEAD_DAYS.
 */
const EVENTS = [
  { id: 'valentines-day', name: "Valentine's Day", peak: fixed(2, 14), keywords: ['valentine', 'valentines', 'galentine', 'galentines'] },
  { id: 'st-patricks-day', name: "St. Patrick's Day", peak: fixed(3, 17), keywords: ['patrick', 'patricks', 'shamrock', 'irish', 'clover'] },
  { id: 'easter', name: 'Easter', peak: D.easter, keywords: ['easter'] },
  { id: 'earth-day', name: 'Earth Day', peak: fixed(4, 22), keywords: ['earth day'] },
  { id: 'cinco-de-mayo', name: 'Cinco de Mayo', peak: fixed(5, 5), keywords: ['cinco'] },
  { id: 'mothers-day', name: "Mother's Day", peak: (y) => D.nthWeekday(y, 5, 0, 2), keywords: ['mother', 'mothers', 'mom', 'mama', 'mum', 'mommy'] },
  { id: 'graduation', name: 'Graduation season', peak: fixed(5, 15), keywords: ['graduation', 'graduate', 'graduating', 'grad', 'class of'] },
  { id: 'memorial-day', name: 'Memorial Day', peak: (y) => D.lastWeekday(y, 5, 1), nager: ['Memorial Day'], keywords: ['memorial'] },
  { id: 'pride', name: 'Pride month', peak: fixed(6, 1), keywords: ['pride', 'lgbt', 'lgbtq', 'rainbow'] },
  { id: 'fathers-day', name: "Father's Day", peak: (y) => D.nthWeekday(y, 6, 0, 3), keywords: ['father', 'fathers', 'dad', 'papa', 'daddy'] },
  { id: 'juneteenth', name: 'Juneteenth', peak: fixed(6, 19), nager: ['Juneteenth National Independence Day'], keywords: ['juneteenth'] },
  { id: 'independence-day', name: 'Independence Day (4th of July)', peak: fixed(7, 4), nager: ['Independence Day'], keywords: ['4th of july', 'fourth of july', 'independence day', 'patriotic', 'usa'] },
  { id: 'back-to-school', name: 'Back to school', peak: fixed(8, 15), keywords: ['back to school', 'teacher', 'teachers', 'student', 'school'] },
  { id: 'labor-day', name: 'Labor Day', peak: (y) => D.nthWeekday(y, 9, 1, 1), nager: ['Labour Day', 'Labor Day'], keywords: ['labor day'] },
  { id: 'halloween', name: 'Halloween', peak: fixed(10, 31), keywords: ['halloween', 'spooky', 'witch', 'witchy', 'ghost', 'pumpkin', 'skeleton', 'haunted'] },
  { id: 'thanksgiving', name: 'Thanksgiving', peak: (y) => D.nthWeekday(y, 11, 4, 4), nager: ['Thanksgiving Day'], keywords: ['thanksgiving', 'turkey', 'friendsgiving'] },
  { id: 'hanukkah', name: 'Hanukkah', peak: (y) => HANUKKAH_FIRST_DAY[y] || null, keywords: ['hanukkah', 'chanukah', 'menorah', 'dreidel'] },
  { id: 'christmas', name: 'Christmas', peak: fixed(12, 25), nager: ['Christmas Day'], keywords: ['christmas', 'xmas', 'santa', 'reindeer', 'holiday', 'festive'] },
  { id: 'new-years', name: "New Year's", peak: fixed(12, 31), keywords: ['new year', 'new years', 'nye'] },
];

module.exports = { PRODUCT_TYPES, PRODUCT_LABELS, PRODUCT_WORDS, WINDOWS, LEAD_DAYS, HANUKKAH_FIRST_DAY, EVENTS };
