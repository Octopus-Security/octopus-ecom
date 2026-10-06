'use strict';
/**
 * watch/service.js — runs watchers and records every run. A watcher failure is recorded
 * (watch_runs.status='error') and swallowed: it never crashes the process, never blocks others.
 * Watchers only read adapters and write our own tables; there are no external writes here.
 */
const { ensureWatchSchema } = require('./schema');
const { makeAlerts } = require('./alerts');
const { makeState } = require('./state');
const { makeReaders } = require('./readers');
const { createManualTrendSource } = require('./trend');
const { runSupplierWatch } = require('./supplier');
const { runPerformanceWatch } = require('./performance');
const { runKeywordWatch } = require('./keywords');

const WATCHERS = ['supplier', 'performance', 'keywords'];
const quiet = { info() {}, warn() {}, error() {} };

function makeWatchService(deps) {
  const { db, settings, adapters, env = process.env, trendSource = createManualTrendSource() } = deps;
  const log = deps.log || quiet;
  ensureWatchSchema(db);
  const alerts = makeAlerts(db);
  const state = makeState(db);
  const readers = deps.readers || makeReaders(adapters);
  const impl = {
    supplier: () => runSupplierWatch({ db, readers, alerts, state, settings, log }),
    performance: () => runPerformanceWatch({ db, readers, alerts, state, log, env, hooks: deps.hooks }),
    keywords: () => runKeywordWatch({ db, alerts, trendSource, log }),
  };
  let running = false;

  async function runOne(name, trigger) {
    const started = new Date().toISOString();
    const id = Number(db.prepare('INSERT INTO watch_runs(watcher, trigger, status, started_at) VALUES(?,?,?,?)').run(name, trigger, 'running', started).lastInsertRowid);
    try {
      const summary = await impl[name]();
      db.prepare("UPDATE watch_runs SET status='ok', finished_at=?, summary=? WHERE id=?").run(new Date().toISOString(), summary, id);
      return { id, watcher: name, status: 'ok', summary };
    } catch (e) {
      log.error(`[watch] ${name} failed: ${e && e.message}`);
      try { db.prepare("UPDATE watch_runs SET status='error', finished_at=?, error=? WHERE id=?").run(new Date().toISOString(), String((e && e.message) || e).slice(0, 500), id); } catch { /* db gone */ }
      return { id, watcher: name, status: 'error', error: String((e && e.message) || e) };
    }
  }

  /** Never throws. A run already in flight is not doubled. */
  async function runAll({ trigger = 'schedule', only } = {}) {
    if (running) return { skipped: true, reason: 'a watch run is already in progress', runs: [] };
    running = true;
    try {
      const names = only ? WATCHERS.filter(w => only.includes(w)) : WATCHERS;
      const runs = [];
      for (const n of names) runs.push(await runOne(n, trigger));
      return { skipped: false, runs };
    } catch (e) {
      log.error(`[watch] run failed: ${e && e.message}`);
      return { skipped: false, runs: [], error: String(e && e.message) };
    } finally { running = false; }
  }

  function listRuns(limit = 50) {
    return db.prepare('SELECT * FROM watch_runs ORDER BY id DESC LIMIT ?').all(Math.min(Math.max(limit | 0, 1), 500))
      .map(r => ({ id: r.id, watcher: r.watcher, trigger: r.trigger, status: r.status, startedAt: r.started_at, finishedAt: r.finished_at, summary: r.summary, error: r.error }));
  }

  return { alerts, state, readers, trendSource, runAll, runOne, listRuns, isRunning: () => running, WATCHERS };
}
module.exports = { makeWatchService, WATCHERS };
