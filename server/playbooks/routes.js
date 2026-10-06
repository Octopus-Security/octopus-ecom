'use strict';
/** playbooks/routes.js — createPlaybookRouter(deps): mount at /api/playbooks (behind the app's owner auth). */
const express = require('express');
const { PLAYBOOKS, byId } = require('./definitions');
const { runCheck } = require('./checks');
const { makeTickStore } = require('./store');

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function createPlaybookRouter(deps) {
  const { db, settings } = deps;
  const ticks = makeTickStore(db);
  const r = express.Router();
  r.use(express.json({ limit: '10kb' }));

  const scopeOf = (q) => {
    if (q === undefined || q === '' || q === '0') return 0;
    const n = Number(q);
    if (!Number.isInteger(n) || n < 0) throw Object.assign(new Error('productId must be a positive integer'), { status: 400 });
    if (n && !db.prepare('SELECT 1 FROM products WHERE id = ?').get(n)) throw Object.assign(new Error('No such product'), { status: 404 });
    return n;
  };

  r.get('/', wrap(async (_req, res) => res.json({ playbooks: PLAYBOOKS.map(p => ({ id: p.id, title: p.title, whenToUse: p.whenToUse, steps: p.steps.length })) })));

  // GET /api/playbooks/:id?productId= — steps, tick state for that scope, live check results.
  r.get('/:id', wrap(async (req, res) => {
    const pb = byId(req.params.id);
    if (!pb) return res.status(404).json({ error: 'No such playbook' });
    const productId = scopeOf(req.query.productId);
    const product = productId ? db.prepare('SELECT * FROM products WHERE id = ?').get(productId) : null;
    const state = ticks.get(pb.id, productId);
    const steps = pb.steps.map(s => ({ ...s, checked: !!state[s.id], checkResult: s.check ? runCheck(s.check, { db, settings, product }) : null }));
    res.json({ id: pb.id, title: pb.title, whenToUse: pb.whenToUse, background: pb.background, productId, steps, done: steps.filter(s => s.checked).length, total: steps.length });
  }));

  r.post('/:id/steps/:stepId/tick', wrap(async (req, res) => {
    const pb = byId(req.params.id);
    if (!pb) return res.status(404).json({ error: 'No such playbook' });
    if (!pb.steps.some(s => s.id === req.params.stepId)) return res.status(404).json({ error: 'No such step' });
    const b = req.body || {};
    if (typeof b.checked !== 'boolean') return res.status(400).json({ error: 'checked must be a boolean' });
    const productId = scopeOf(b.productId === undefined ? undefined : String(b.productId));
    ticks.set(pb.id, req.params.stepId, productId, b.checked);
    res.json({ ok: true, playbookId: pb.id, stepId: req.params.stepId, productId, checked: b.checked });
  }));

  r.post('/:id/reset', wrap(async (req, res) => {
    const pb = byId(req.params.id);
    if (!pb) return res.status(404).json({ error: 'No such playbook' });
    const productId = scopeOf((req.body || {}).productId === undefined ? undefined : String(req.body.productId));
    res.json({ ok: true, cleared: ticks.reset(pb.id, productId) });
  }));

  r.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  r.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
    (deps.log || console).error(`[playbooks] route failed: ${err.message}`);
    res.status(500).json({ error: 'Internal error' });
  });
  return r;
}
module.exports = { createPlaybookRouter };
