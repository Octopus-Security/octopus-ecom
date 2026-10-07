'use strict';
/**
 * routes/proposals.js — the Proposals queue. Mounted by routes/api.js, so it sits behind the app's owner gate (401 signed out, 403
 * for a non-owner) and the sameOrigin check (403 cross-origin) like every other route, and before the catch-all 404. The codes
 * match the existing routes: 400 bad input, 404 unknown id, 409 wrong state or a bad confirm token, 422 refused by a rule,
 * 429 daily spend cap (SpendCapError, through the shared handler), 402/502 a model failure.
 */
const { wrap } = require('../auth');

function mount(r, deps) {
  const svc = deps.proposals;
  // A ProposalError carries its own status and a message the owner can act on (502 included, which the shared handler would hide).
  const w = (fn) => wrap(async (req, res, next) => {
    try { await fn(req, res, next); }
    catch (e) {
      if (e && e.name === 'ProposalError') return res.status(e.status).json({ error: e.message, code: e.code, ...(e.reasons ? { reasons: e.reasons } : {}), ...(e.hits ? { hits: e.hits } : {}) });
      throw e;
    }
  });
  const body = (req) => (req.body && typeof req.body === 'object' ? req.body : {});

  r.get('/proposals', w(async (req, res) => { res.json({ ok: true, ...svc.list({ status: req.query.status ? String(req.query.status) : undefined }) }); }));
  r.get('/proposals/config', w(async (_req, res) => { res.json({ ok: true, ...svc.config() }); }));
  r.get('/proposals/runs', w(async (req, res) => { res.json({ ok: true, runs: svc.listRuns(Number(req.query.limit) || 20) }); }));
  r.get('/proposals/settings', w(async (_req, res) => { res.json({ ok: true, settings: svc.getSettings() }); }));
  r.post('/proposals/settings', w(async (req, res) => { res.json({ ok: true, settings: svc.setSettings(body(req)) }); }));
  r.get('/proposals/digest', w(async (_req, res) => { res.json({ ok: true, ...svc.digestInfo() }); }));
  // Generate a fresh batch now from the saved digest settings (the weekly job runs the same function).
  r.post('/proposals/digest', w(async (req, res) => { res.status(201).json({ ok: true, ...(await svc.digest(body(req))) }); }));
  // {count, productTypes[], seeds:{themes,occasions,audiences}, liveSignals?, tier?}
  r.post('/proposals/generate', w(async (req, res) => { res.status(201).json({ ok: true, ...(await svc.generate(body(req))) }); }));

  r.get('/proposals/:id', w(async (req, res) => { res.json({ ok: true, proposal: svc.get(req.params.id) }); }));
  r.patch('/proposals/:id', w(async (req, res) => { res.json({ ok: true, proposal: await svc.update(req.params.id, body(req)) }); }));
  // Two-step when the proposal needs a look (lint errors, a too-late season): the first call answers {needsConfirm, token, summary}.
  r.post('/proposals/:id/approve', w(async (req, res) => {
    const out = await svc.approve(req.params.id, { edits: body(req).edits, token: body(req).token });
    if (out.needsConfirm) return res.json(out);
    res.status(201).json({ ok: true, ...out });
  }));
  r.post('/proposals/:id/reject', w(async (req, res) => { res.json({ ok: true, proposal: svc.reject(req.params.id, { reason: body(req).reason }) }); }));
  r.post('/proposals/:id/snooze', w(async (req, res) => { res.json({ ok: true, proposal: svc.snooze(req.params.id, { until: body(req).until }) }); }));
  r.post('/proposals/:id/unsnooze', w(async (req, res) => { res.json({ ok: true, proposal: svc.unsnooze(req.params.id) }); }));
  r.post('/proposals/:id/regenerate', w(async (req, res) => { res.json({ ok: true, proposal: await svc.regenerate(req.params.id, { tier: body(req).tier }) }); }));
}

module.exports = { mount };
