'use strict';
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { wrap } = require('../auth');
const { STAGES, parseFlags } = require('../domain/stages');
const { ConfirmError } = require('../confirm');
const { KEY_NAMES } = require('../keystore');

function actorOf() { return 'human'; } // every request here is an authenticated owner

function router(deps) {
  const { db, credentials, keystore, settings, confirm, dryRun, spend, adapters, llm } = deps;
  const r = express.Router();

  // GET /api/products — the board. Empty list is a normal answer.
  r.get('/products', wrap(async (_req, res) => {
    const rows = db.prepare(`
      SELECT p.*, s.name AS store_name,
             (SELECT id FROM designs d WHERE d.product_id = p.id ORDER BY d.id DESC LIMIT 1) AS design_id
      FROM products p LEFT JOIN stores s ON s.id = p.store_id ORDER BY p.updated_at DESC`).all();
    const columns = Object.fromEntries(STAGES.map(s => [s, []]));
    for (const p of rows) {
      (columns[p.stage] || (columns[p.stage] = [])).push({
        id: p.id, stage: p.stage, title: p.title || p.brief.slice(0, 60) || `Product ${p.id}`, brief: p.brief, store: p.store_name || null,
        modelUsed: p.model_used, projectedMarginCents: p.projected_margin_cents, listPriceCents: p.list_price_cents,
        flags: parseFlags(p), failedReason: p.failed_reason,
        thumbnail: p.design_id ? `/api/images/${p.design_id}` : null, updatedAt: p.updated_at,
      });
    }
    res.json({ stages: STAGES, columns, count: rows.length });
  }));

  // GET /api/summary — spend, revenue, NET, daily cap, and what is stubbed.
  r.get('/summary', wrap(async (_req, res) => {
    res.json({ ok: true, dryRun: dryRun.isOn(), ...spend.summary(), adapters: adapters.describe(), llm: llm.describe() });
  }));

  // Authenticated image route: files live under DATA_DIR/images.
  r.get('/images/:id', wrap(async (req, res) => {
    const d = db.prepare('SELECT image_path FROM designs WHERE id = ?').get(Number(req.params.id));
    const root = path.resolve(deps.cfg.dataDir, 'images');
    const file = d && d.image_path ? path.resolve(root, d.image_path) : null;
    if (!file || !file.startsWith(root + path.sep) || !fs.existsSync(file)) return res.status(404).json({ error: 'Not found' });
    res.type('png').sendFile(file);
  }));

  // GET /api/settings — presence only, never values.
  r.get('/settings', wrap(async (_req, res) => {
    res.json({
      dryRun: dryRun.isOn(), disarmPhrase: dryRun.PHRASE,
      dailySpendCapCents: spend.capCents(), marginFloorCents: settings.getInt('margin_floor_cents', 200),
      credentials: credentials.status(),
    });
  }));

  // POST /api/settings — caps, in dollars.
  r.post('/settings', wrap(async (req, res) => {
    const b = req.body || {};
    const cents = (v, name) => { const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > 100000) throw Object.assign(new Error(`${name} must be dollars between 0 and 100000`), { status: 400 }); return Math.round(n * 100); };
    if (b.dailySpendCap !== undefined) settings.set('daily_spend_cap_cents', cents(b.dailySpendCap, 'dailySpendCap'));
    if (b.marginFloor !== undefined) settings.set('margin_floor_cents', cents(b.marginFloor, 'marginFloor'));
    res.json({ ok: true, dailySpendCapCents: spend.capCents(), marginFloorCents: settings.getInt('margin_floor_cents', 200) });
  }));

  // POST /api/settings/credentials {name, value} — sealed; the response carries no value.
  r.post('/settings/credentials', wrap(async (req, res) => {
    const { name, value } = req.body || {};
    if (!KEY_NAMES.includes(name)) return res.status(400).json({ error: `name must be one of ${KEY_NAMES.join(', ')}` });
    if (typeof value !== 'string' || !value.trim() || value.length > 4096) return res.status(400).json({ error: 'value must be a non-empty string (<=4096 chars)' });
    const { fp, tail } = keystore.set(name, value);
    res.json({ ok: true, name, present: true, fp, tail, source: 'keystore' });
  }));

  // DELETE /api/settings/credentials/:name — confirm-gated (irreversible).
  r.delete('/settings/credentials/:name', wrap(async (req, res) => {
    const name = req.params.name;
    if (!KEY_NAMES.includes(name)) return res.status(404).json({ error: 'Unknown credential' });
    if (!credentials.status().find(c => c.name === name && c.source === 'keystore')) return res.status(404).json({ error: 'No stored credential by that name (env credentials are removed from the environment, not here).' });
    const gate = confirm.check({
      action: 'credential.delete', subject: name,
      summary: `Delete the stored ${name} credential. It cannot be recovered; you would have to enter it again. Anything using it falls back to stubs (or to the env var, if one is set).`,
    }, (req.body || {}).token);
    if (gate.needsConfirm) return res.json(gate);
    keystore.remove(name);
    res.json({ ok: true, name, deleted: true });
  }));

  // POST /api/settings/dry-run {dryRun:true} | {dryRun:false} then {dryRun:false, token, confirm:"ARM LIVE WRITES"}
  r.post('/settings/dry-run', wrap(async (req, res) => {
    const b = req.body || {};
    if (typeof b.dryRun !== 'boolean') return res.status(400).json({ error: 'dryRun must be a boolean' });
    if (b.dryRun) return res.json({ ok: true, ...dryRun.enable({ actor: actorOf(req) }) });
    const out = dryRun.disarm({ actor: actorOf(req), token: b.token, phrase: b.confirm });
    res.json(out.needsConfirm ? out : { ok: true, ...out });
  }));

  r.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  return r;
}

function errorHandler(deps) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, _next) => {
    if (err instanceof ConfirmError) return res.status(409).json({ error: err.message, code: err.code });
    if (err.name === 'DryRunError') return res.status(400).json({ error: err.message });
    if (err.name === 'StageError') return res.status(err.code === 'not_found' ? 404 : 409).json({ error: err.message, code: err.code });
    if (err.name === 'SpendCapError') return res.status(429).json({ error: err.message, code: 'spend_cap' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
    deps.log.error(`[api] ${req.method} ${req.path} failed:`, err);
    return res.status(500).json({ error: 'Internal error' });
  };
}

module.exports = { router, errorHandler };
