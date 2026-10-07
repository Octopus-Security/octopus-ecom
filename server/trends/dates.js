'use strict';
/**
 * trends/dates.js — calendar maths for the trend features. ET is the only clock: every "today" is the
 * America/New_York calendar date (estate rule), and everything after that is plain YYYY-MM-DD arithmetic in UTC,
 * so a DST change or a server in another zone cannot move a date by a day.
 */
const TZ = 'America/New_York';

/** ET calendar date, YYYY-MM-DD, of a Date (or epoch ms). */
function etDay(date = new Date()) {
  return new Date(date).toLocaleDateString('en-CA', { timeZone: TZ });
}
const parse = (ymd) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd)); if (!m) throw new Error(`not a YYYY-MM-DD date: ${ymd}`); return Date.UTC(+m[1], +m[2] - 1, +m[3]); };
const fmt = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (ymd, n) => fmt(parse(ymd) + n * 86400000);
const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);   // b - a
const weeksBetween = (a, b) => daysBetween(a, b) / 7;
const ymd = (y, m, d) => fmt(Date.UTC(y, m - 1, d));
const yearOf = (day) => Number(String(day).slice(0, 4));
/** 0 = Sunday ... 6 = Saturday. */
const weekday = (day) => new Date(parse(day)).getUTCDay();

/** The n-th (1-based) given weekday of a month. */
function nthWeekday(year, month, wd, n) {
  const first = weekday(ymd(year, month, 1));
  return ymd(year, month, 1 + ((wd - first + 7) % 7) + (n - 1) * 7);
}
function lastWeekday(year, month, wd) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = weekday(ymd(year, month, lastDay));
  return ymd(year, month, lastDay - ((last - wd + 7) % 7));
}
/** Gregorian Easter Sunday (Meeus/Jones/Butcher algorithm). */
function easter(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return ymd(year, month, day);
}

/** ISO-8601 week id of an ET calendar date, e.g. "2026-W41" (weeks start Monday; the ISO year can differ from the calendar year). */
function isoWeek(day) {
  const t = new Date(parse(day));
  const wd = (t.getUTCDay() + 6) % 7;                   // Monday = 0
  t.setUTCDate(t.getUTCDate() - wd + 3);                // the Thursday of this week decides the ISO year
  const year = t.getUTCFullYear();
  const firstThu = new Date(Date.UTC(year, 0, 4));
  firstThu.setUTCDate(firstThu.getUTCDate() - ((firstThu.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((t.getTime() - firstThu.getTime()) / (7 * 86400000));
  return `${year}-W${String(week).padStart(2, '0')}`;
}

module.exports = { TZ, etDay, parse, fmt, addDays, daysBetween, weeksBetween, ymd, yearOf, weekday, nthWeekday, lastWeekday, easter, isoWeek };
