'use strict';
/**
 * trends/scheduler.js — the weekly trend run. OFF BY DEFAULT: nothing runs unless the owner sets trend_weekly_enabled=true
 * (POST /api/trends/settings). Disabled under NODE_ENV=test. Checks hourly (the setting is read on every tick, so no restart is
 * needed); runs at most once per ISO week, on Monday from 07:00 ET (spec 6), and then collects from the ENABLED sources
 * and rebuilds the report. Timers are unref'd. Returns a stop function.
 */
const D = require('./dates');

const HOUR = 3600 * 1000;

function etHour(date) { return Number(new Date(date).toLocaleString('en-US', { timeZone: D.TZ, hour: 'numeric', hour12: false }).replace(/\D/g, '')) % 24; }

/** Pure decision: should a scheduled run happen now? */
function due({ now, enabled, lastScheduledWeek }) {
  if (!enabled) return false;
  const day = D.etDay(now);
  if (D.weekday(day) !== 1 || etHour(now) < 7) return false;
  return lastScheduledWeek !== D.isoWeek(day);
}

function startTrendSchedule(deps, { setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, now = () => new Date(), force = false } = {}) {
  const env = deps.env || process.env;
  const log = deps.log || { info() {}, warn() {}, error() {} };
  if (!force && env.NODE_ENV === 'test') return () => {};
  const { trends, settings, db } = deps;
  let timer = null; let stopped = false;
  const tick = async () => {
    try {
      const last = db.prepare("SELECT week FROM trend_runs WHERE trigger = 'schedule' ORDER BY id DESC LIMIT 1").get();
      if (due({ now: now(), enabled: settings.get('trend_weekly_enabled') === 'true', lastScheduledWeek: last && last.week })) {
        log.info('[trend] weekly run starting');
        await trends.rebuild({ collect: true, trigger: 'schedule' });
      }
    } catch (e) { log.error(`[trend] weekly run failed: ${e && e.message}`); }
    next();
  };
  const next = () => { if (stopped) return; timer = setTimeoutFn(tick, HOUR); if (timer && typeof timer.unref === 'function') timer.unref(); };
  next();
  return () => { stopped = true; if (timer) clearTimeoutFn(timer); };
}

module.exports = { startTrendSchedule, due, etHour };
