'use strict';
/** watch/routes.js — createWatchRouter(deps): mount at /api/watch (behind the app's owner auth). */
const express = require('express');
const { makeWatchService } = require('./service');

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

function createWatchRouter(deps, { service } = {}) {
  const svc = service || makeWatchService(deps);
  const { db } = deps;
  const r = express.Router();
  r.use(express.json({ limit: '100kb' }));

  r.get('/alerts', wrap(async (req, res) => {
    res.json({ alerts: svc.alerts.list({ includeAcknowledged: req.query.all === '1', limit: Number(req.query.limit) || 200 }), ...svc.alerts.counts() });
  }));
  r.get('/alerts/count', wrap(async (_req, res) => res.json(svc.alerts.counts())));
  r.post('/alerts/ack-all', wrap(async (_req, res) => res.json({ ok: true, acknowledged: svc.alerts.acknowledgeAll() })));
  r.post('/alerts/:id/ack', wrap(async (req, res) => {
    const ok = svc.alerts.acknowledge(Number(req.params.id));
    if (!ok) return res.status(404).json({ error: 'No open alert with that id' });
    res.json({ ok: true, ...svc.alerts.counts() });
  }));

  r.get('/runs', wrap(async (req, res) => res.json({ runs: svc.listRuns(Number(req.query.limit) || 50), running: svc.isRunning(), watchers: svc.WATCHERS, trendSource: svc.trendSource.describe() })));
  // POST /run {watcher?: 'supplier'|'performance'|'keywords'} — "run now". Reads only; never an external write.
  r.post('/run', wrap(async (req, res) => {
    const w = (req.body || {}).watcher;
    if (w !== undefined && !svc.WATCHERS.includes(w)) throw bad(`watcher must be one of ${svc.WATCHERS.join(', ')}`);
    res.json(await svc.runAll({ trigger: 'manual', only: w ? [w] : undefined }));
  }));

  const shape = e => ({ id: e.id, kind: e.kind, term: e.term, notes: e.notes, active: !!e.active, created: e.created_at, updated: e.updated_at });
  const clean = (b, partial) => {
    const out = {};
    if (!partial || b.term !== undefined) { const t = String(b.term || '').trim().toLowerCase(); if (!t || t.length > 120) throw bad('term is required (<=120 chars)'); out.term = t; }
    if (b.kind !== undefined || !partial) { const k = b.kind || 'keyword'; if (!['keyword', 'theme'].includes(k)) throw bad("kind must be 'keyword' or 'theme'"); out.kind = k; }
    if (b.notes !== undefined) { if (typeof b.notes !== 'string' || b.notes.length > 2000) throw bad('notes must be a string (<=2000 chars)'); out.notes = b.notes; }
    if (b.active !== undefined) out.active = b.active ? 1 : 0;
    return out;
  };
  r.get('/watchlist', wrap(async (_req, res) => res.json({ entries: db.prepare('SELECT * FROM watchlist ORDER BY id DESC').all().map(shape) })));
  r.post('/watchlist', wrap(async (req, res) => {
    const c = clean(req.body || {}, false); const t = new Date().toISOString();
    try {
      const id = Number(db.prepare('INSERT INTO watchlist(kind, term, notes, active, created_at, updated_at) VALUES(?,?,?,?,?,?)').run(c.kind, c.term, c.notes || '', c.active ?? 1, t, t).lastInsertRowid);
      res.status(201).json({ entry: shape(db.prepare('SELECT * FROM watchlist WHERE id = ?').get(id)) });
    } catch (e) { if (/UNIQUE/i.test(e.message)) throw bad('already on the watchlist', 409); throw e; }
  }));
  r.patch('/watchlist/:id', wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM watchlist WHERE id = ?').get(id)) return res.status(404).json({ error: 'Not found' });
    const c = clean(req.body || {}, true);
    const cols = Object.keys(c);
    if (cols.length) {
      try { db.prepare(`UPDATE watchlist SET ${cols.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...cols.map(k => c[k]), new Date().toISOString(), id); }
      catch (e) { if (/UNIQUE/i.test(e.message)) throw bad('already on the watchlist', 409); throw e; }
    }
    res.json({ entry: shape(db.prepare('SELECT * FROM watchlist WHERE id = ?').get(id)) });
  }));
  r.delete('/watchlist/:id', wrap(async (req, res) => {
    const n = db.prepare('DELETE FROM watchlist WHERE id = ?').run(Number(req.params.id)).changes;
    if (!n) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  }));

  r.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  r.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
    (deps.log || console).error(`[watch] route failed: ${err.message}`);
    res.status(500).json({ error: 'Internal error' });
  });
  return r;
}
module.exports = { createWatchRouter };
