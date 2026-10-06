'use strict';
/**
 * watch/scheduler.js — small in-process scheduler. Disabled under NODE_ENV=test.
 * Interval from env WATCH_INTERVAL_MINUTES (default 360, floor 1). Each tick is the interval
 * +/-10% jitter so restarts and several instances do not sync up. Timers are unref'd: they never
 * keep the process alive. startWatchers returns a stop function.
 */
function intervalMs(env = process.env) {
  const m = parseFloat(env.WATCH_INTERVAL_MINUTES);
  const minutes = Number.isFinite(m) && m >= 1 ? m : 360;
  return Math.round(minutes * 60 * 1000);
}

function startWatchers(deps, { service, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, random = Math.random, force = false } = {}) {
  const env = deps.env || process.env;
  const log = deps.log || { info() {}, warn() {}, error() {} };
  if (!force && env.NODE_ENV === 'test') return () => {};
  const svc = service || require('./service').makeWatchService(deps);
  const base = intervalMs(env);
  let timer = null; let stopped = false;
  const next = () => {
    if (stopped) return;
    const delay = Math.round(base * (0.9 + random() * 0.2));
    timer = setTimeoutFn(async () => {
      try { await svc.runAll({ trigger: 'schedule' }); } catch (e) { log.error(`[watch] tick failed: ${e && e.message}`); }
      next();
    }, delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
  };
  log.info(`[watch] scheduler on, every ~${Math.round(base / 60000)} min`);
  next();
  return () => { stopped = true; if (timer) clearTimeoutFn(timer); };
}
module.exports = { startWatchers, intervalMs };
