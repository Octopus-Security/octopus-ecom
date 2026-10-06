'use strict';
/**
 * routes/etsy.js — Etsy connection, publish, listing edits, sales. Mounted by routes/api.js (so it sits behind the
 * same owner auth and sameOrigin check as everything else, and before the catch-all 404).
 * Nothing here returns a token; confirm-gated actions use server/confirm.js like the rest.
 */
const { wrap } = require('../auth');
const { S } = require('../domain/stages');
const { productEvent } = require('../events');
const { PipelineError } = require('../pipeline');

function mount(r, deps) {
  const { db, confirm, dryRun, etsy, publisher, sales, pipeline } = deps;
  const actorOf = () => 'human';
  const getP = id => db.prepare('SELECT * FROM products WHERE id = ?').get(Number(id));
  const need = (req, res) => { const p = getP(req.params.id); if (!p) { res.status(404).json({ error: 'Not found' }); return null; } return p; };
  const home = (q) => `/?${new URLSearchParams(q)}`;

  // GET /api/etsy/status — connection state, credentials presence, no secrets.
  r.get('/etsy/status', wrap(async (_req, res) => { res.json({ ok: true, ...etsy.status() }); }));

  // GET /api/etsy/connect — JSON {url} by default (the panel navigates to it); ?redirect=1 answers with a 302.
  // With no app credentials it answers 400 with a plain explanation instead of failing silently.
  r.get('/etsy/connect', wrap(async (req, res) => {
    const c = etsy.connect();
    if (req.query.redirect === '1') return res.redirect(c.url);
    res.json({ ok: true, url: c.url, expiresAt: c.expiresAt, scopes: c.scopes });
  }));

  // GET /api/etsy/callback?code&state — Etsy sends the browser here. Always ends in a redirect to the panel with the outcome.
  r.get('/etsy/callback', async (req, res) => {
    try {
      const s = await etsy.callback(req.query || {});
      res.redirect(home({ etsy: s.needsShop ? 'no_shop' : 'connected' }));
    } catch (e) {
      deps.log.warn(`[etsy] callback failed: ${e.code || ''} ${e.message}`);
      res.redirect(home({ etsy: 'error', msg: String(e.message).slice(0, 300) }));
    }
  });

  r.post('/etsy/stores/:id/recheck', wrap(async (req, res) => { res.json({ ok: true, store: await etsy.recheck(req.params.id) }); }));

  // Disconnect: confirm-gated; deletes the sealed tokens.
  r.post('/etsy/stores/:id/disconnect', wrap(async (req, res) => {
    const s = etsy.row(req.params.id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    const gate = confirm.check({ action: 'store.disconnect', subject: String(s.id), summary: `Disconnect the Etsy store "${s.name}". Its saved Etsy tokens are deleted here and autopublish is switched off. Published listings stay on Etsy and keep their history; publishing and sales sync stop until you connect again. To revoke access on Etsy's side, remove the app under Etsy account settings.` }, (req.body || {}).token);
    if (gate.needsConfirm) return res.json(gate);
    res.json({ ok: true, store: etsy.disconnect(s.id) });
  }));

  // Autopublish: turning it ON is confirm-gated (decision 6); OFF is immediate.
  r.post('/etsy/stores/:id/autopublish', wrap(async (req, res) => {
    const s = etsy.row(req.params.id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    const on = (req.body || {}).enabled;
    if (typeof on !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
    if (!on) return res.json({ ok: true, store: etsy.setAutopublish(s.id, false) });
    const gate = confirm.check({ action: 'store.autopublish', subject: String(s.id), summary: `Enable AUTOPUBLISH for "${s.name}". With DRY_RUN off, an automated run may approve and publish products to the real Etsy marketplace without you, as long as the product has no flags. Each publish costs a ${'$0.20'} listing fee and is irreversible by this app. While DRY_RUN is on nothing is published.` }, (req.body || {}).token);
    if (gate.needsConfirm) return res.json(gate);
    res.json({ ok: true, store: etsy.setAutopublish(s.id, true) });
  }));

  // POST /api/products/:id/publish — the whole gate, in order:
  //   not approved -> 409 (no token issued) · live blockers -> 409 with the reason (no token issued) · confirm ·
  //   DRY_RUN on -> simulated, stage unchanged · DRY_RUN off -> real publish.
  r.post('/products/:id/publish', wrap(async (req, res) => {
    const p = need(req, res); if (!p) return;
    if (p.stage !== S.APPROVED) return res.status(409).json({ error: `Only an approved product can be published; this one is ${p.stage}`, code: 'not_approved' });
    const prep = await publisher.prepare(p);
    if (!dryRun.isOn() && prep.blockers.length) return res.status(409).json({ error: prep.blockers[0].message, code: prep.blockers[0].code, blockers: prep.blockers });
    const gate = confirm.check({ action: 'product.publish', subject: `${p.id}:${p.updated_at}`, summary: prep.summary }, (req.body || {}).token);
    if (gate.needsConfirm) return res.json({ ...gate, blockers: prep.blockers });
    if (dryRun.isOn()) {
      const sim = await publisher.simulate(p, { actor: actorOf(req) });
      return res.json({ ok: true, faked: true, published: false, stage: p.stage, result: sim.result, liveBlockers: sim.liveBlockers });
    }
    const out = await publisher.publish(p.id, { actor: actorOf(req) });
    res.json({ ok: true, faked: false, published: true, stage: out.product.stage, readBack: out.readBack, product: out.product });
  }));

  // POST /api/products/:id/refresh-status — reconcile with Printify/Etsy (published -> live when Etsy shows it active).
  r.post('/products/:id/refresh-status', wrap(async (req, res) => {
    const p = need(req, res); if (!p) return;
    const out = await publisher.reconcile(p.id, { actor: actorOf(req) });
    res.json({ ok: true, ...out, product: getP(p.id) });
  }));

  // PATCH /api/products/:id/listing {title?, tags?, price?} — edit the published Etsy listing. A price change is confirm-gated.
  r.patch('/products/:id/listing', wrap(async (req, res) => {
    const p = need(req, res); if (!p) return;
    const body = req.body || {};
    const plan = publisher.planEdit(p, body);
    if (plan.priceChange) {
      const gate = confirm.check({ action: 'listing.price', subject: `${p.id}:${p.updated_at}:${plan.changes.priceCents}`, summary: plan.summary }, body.token);
      if (gate.needsConfirm) return res.json(gate);
    }
    const out = await publisher.applyEdit(p, plan, { actor: actorOf(req) });
    res.json({ ok: true, ...out, repairs: plan.repairs });
  }));

  // Sales
  r.post('/sales/sync', wrap(async (req, res) => {
    const out = await sales.sync({ actor: actorOf(req) });
    res.status(out.ok === false ? 409 : 200).json(out.ok === false ? { error: out.reason, ...out } : out);
  }));
  r.get('/sales', wrap(async (req, res) => { res.json({ ok: true, ...sales.list({ limit: Number(req.query.limit) || 100 }), summary: deps.spend.summary() }); }));
}

module.exports = { mount };
