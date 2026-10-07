'use strict';
/**
 * routes/channels.js — sales channels. Mounted by routes/api.js, so every route here sits behind the same owner auth and
 * sameOrigin check as the rest (401 signed out, 403 for a non-owner, enforced in app.js) and before the catch-all 404.
 * Nothing here talks to a marketplace: Redbubble is a MANUAL channel (see server/channels/contract.js).
 * Status codes follow the other routes: 404 unknown product/channel, 400 bad input, 409 an illegal state change.
 */
const { wrap } = require('../auth');
const { ChannelError } = require('../channels/state');

function mount(r, deps) {
  const { db, channels } = deps;
  const known = c => Object.prototype.hasOwnProperty.call(channels.registry, c);
  const needProduct = (req, res) => {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id));
    if (!p) { res.status(404).json({ error: 'Not found' }); return null; }
    return p;
  };
  const dollarsToCents = (v, name) => {
    const n = typeof v === 'string' ? Number(v.replace(/[$,\s]/g, '')) : Number(v);
    if (v === '' || v === null || v === undefined || !Number.isFinite(n)) throw Object.assign(new Error(`${name} must be a dollar amount`), { status: 400 });
    return Math.round(n * 100);
  };

  // GET /api/channels — the channel registry: capability, what is automated, what is manual, linked playbooks, and per-channel revenue.
  r.get('/channels', wrap(async (_req, res) => { res.json({ ok: true, channels: channels.describe(), sales: channels.salesByChannel() }); }));

  // GET /api/products/:id/channels — this product's state on every channel, and its revenue per channel.
  r.get('/products/:id/channels', wrap(async (req, res) => {
    const p = needProduct(req, res); if (!p) return;
    res.json({ ok: true, states: channels.statesFor(p), sales: channels.salesByChannel(p.id) });
  }));

  // POST /api/products/:id/channels/:channel/state {state, url?, title?} — manual channels only; Etsy's state follows the product stage.
  r.post('/products/:id/channels/:channel/state', wrap(async (req, res) => {
    const p = needProduct(req, res); if (!p) return;
    if (!known(req.params.channel)) return res.status(404).json({ error: 'Not found' });
    if (channels.registry[req.params.channel].capability !== 'manual') return res.status(400).json({ error: `${channels.registry[req.params.channel].label} is an api channel: its state follows the product stage, it is not set by hand`, code: 'not_manual' });
    const b = req.body || {};
    const out = channels.state.set({ productId: p.id, channel: req.params.channel, to: b.state, url: b.url, title: b.title, actor: 'human', hostSuffix: 'redbubble.com' });
    res.json({ ok: true, listing: out, states: channels.statesFor(p) });
  }));

  // GET /api/products/:id/redbubble/pack — the pack as JSON (copy, lint, sizes, product types, checklist); no heavy image work.
  r.get('/products/:id/redbubble/pack', wrap(async (req, res) => {
    const p = needProduct(req, res); if (!p) return;
    const m = req.query.markup === undefined ? undefined : Number(req.query.markup);
    res.json(channels.redbubble.pack(p.id, { markupPct: m }));
  }));
  // GET /api/products/:id/redbubble/pack.zip — the same, with the PNG, as one download.
  r.get('/products/:id/redbubble/pack.zip', wrap(async (req, res) => {
    const p = needProduct(req, res); if (!p) return;
    const z = await channels.redbubble.zip(p.id);
    res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${z.filename}"`, 'Cache-Control': 'no-store' }).send(z.buffer);
  }));
  // GET /api/products/:id/redbubble/design.png — just the sized image (for the folder view's download link).
  r.get('/products/:id/redbubble/design.png', wrap(async (req, res) => {
    const p = needProduct(req, res); if (!p) return;
    const img = await channels.redbubble.image(p.id);
    res.set({ 'Content-Type': 'image/png', 'Content-Disposition': `attachment; filename="redbubble-${p.id}-${img.width}x${img.height}.png"`, 'Cache-Control': 'no-store', 'X-Image-Size': `${img.width}x${img.height}` }).send(img.png);
  }));

  // POST /api/sales/redbubble/import {csv, preview?} — the sales-history CSV. Header names are ASSUMED; preview=true reads without saving.
  r.post('/sales/redbubble/import', wrap(async (req, res) => {
    const b = req.body || {};
    try { res.json(channels.redbubbleSales.importCsv(b.csv, { preview: b.preview === true, actor: 'human' })); }
    catch (e) { if (e.parsed) return res.status(400).json({ error: e.message, code: 'unreadable_csv', headerMap: e.parsed.headerMap, unmatchedHeaders: e.parsed.unmatchedHeaders }); throw e; }
  }));
  // POST /api/sales/redbubble/entry {productId?|title?, date, margin (dollars), quantity?, orderId?}
  r.post('/sales/redbubble/entry', wrap(async (req, res) => {
    const b = req.body || {};
    const marginCents = dollarsToCents(b.margin, 'margin');
    const out = channels.redbubbleSales.addManual({ productId: b.productId, title: typeof b.title === 'string' ? b.title.slice(0, 300) : null, date: b.date, marginCents, quantity: b.quantity === undefined ? 1 : Number(b.quantity), orderId: b.orderId }, { actor: 'human' });
    res.status(201).json(out);
  }));
}

module.exports = { mount, ChannelError };
