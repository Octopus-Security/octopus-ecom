'use strict';
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { wrap } = require('../auth');
const { STAGES, S, parseFlags, approvalSummary } = require('../domain/stages');
const { productEvent } = require('../events');
const { ConfirmError } = require('../confirm');
const { KEY_NAMES } = require('../keystore');
const feeSchedule = require('../domain/fee-schedule');
const fees = require('../domain/fees');

/** Image type from magic bytes only. */
function sniffImage(b) {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  return null;
}

function actorOf() { return 'human'; } // every request here is an authenticated owner

function router(deps) {
  const { db, credentials, keystore, settings, confirm, dryRun, spend, adapters, llm } = deps;
  void productEvent;
  const r = express.Router();

  // GET /api/products — the board. Empty list is a normal answer.
  r.get('/products', wrap(async (_req, res) => {
    const rows = db.prepare(`
      SELECT p.*, s.name AS store_name,
             (SELECT id FROM designs d WHERE d.product_id = p.id ORDER BY d.id DESC LIMIT 1) AS design_id,
             (SELECT width FROM designs d WHERE d.product_id = p.id ORDER BY d.id DESC LIMIT 1) AS design_w,
             (SELECT height FROM designs d WHERE d.product_id = p.id ORDER BY d.id DESC LIMIT 1) AS design_h,
             (SELECT id FROM mockups m WHERE m.product_id = p.id ORDER BY m.is_default DESC, m.id LIMIT 1) AS mockup_id,
             (SELECT CASE WHEN file IS NOT NULL THEN NULL ELSE url END FROM mockups m WHERE m.product_id = p.id ORDER BY m.is_default DESC, m.id LIMIT 1) AS mockup_url,
             (SELECT COALESCE(SUM(amount_cents),0) FROM costs c WHERE c.product_id = p.id) AS cost_cents
      FROM products p LEFT JOIN stores s ON s.id = p.store_id ORDER BY p.updated_at DESC`).all();
    const floor = settings.getInt('margin_floor_cents', 200);
    const chan = deps.channels.state.boardMap();
    const columns = Object.fromEntries(STAGES.map(s => [s, []]));
    for (const p of rows) {
      (columns[p.stage] || (columns[p.stage] = [])).push({
        id: p.id, stage: p.stage, title: p.title || p.brief.slice(0, 60) || `Product ${p.id}`, brief: p.brief, store: p.store_name || null,
        modelUsed: p.model_used, projectedMarginCents: p.projected_margin_cents, listPriceCents: p.list_price_cents,
        flags: parseFlags(p), failedReason: p.failed_reason,
        costCents: p.cost_cents, designSize: p.design_id ? `${p.design_w}x${p.design_h}` : null,
        thumbnail: p.mockup_id ? (p.mockup_url || `/api/mockups/${p.mockup_id}/file`) : p.design_id ? `/api/images/${p.design_id}` : null,
        thumbnailKind: p.mockup_id ? 'mockup' : p.design_id ? 'design' : null,
        podBaseCostCents: p.pod_base_cost_cents, podCostSource: p.pod_cost_source, marginFloorCents: floor, updatedAt: p.updated_at,
        channels: { etsy: p.stage === 'live' ? 'live' : p.stage === 'published' ? 'uploaded' : 'not_listed', redbubble: (chan.get(p.id) || {}).redbubble || 'not_listed' },
      });
    }
    res.json({ stages: STAGES, columns, count: rows.length });
  }));

  // ---- M1: products -------------------------------------------------------------------------
  const pipe = deps.pipeline;
  const out = (res, status, o) => res.status(status).json(o);

  // POST /api/products {brief, niche, keywords[], listPrice (dollars), blueprint, printProviderId} -> the new idea
  r.post('/products', wrap(async (req, res) => {
    const b = req.body || {};
    let p = pipe.create(b, { actor: actorOf(req) });
    let podError = null;
    if (b.blueprint && b.printProviderId) {
      try { p = await pipe.selectPod(p.id, { blueprint: b.blueprint, providerId: b.printProviderId, variantIds: b.variantIds }); }
      catch (e) { podError = e.message; } // the idea exists; the operator can pick again
    }
    res.status(201).json({ ok: true, product: p, ...(podError ? { podError } : {}) });
  }));
  // POST /api/products/:id/generate-design {brief?}   (a brief = the operator edited it = regenerate)
  r.post('/products/:id/generate-design', wrap(async (req, res) => {
    const p = await pipe.generateDesign(req.params.id, { brief: (req.body || {}).brief, actor: actorOf(req) });
    res.json({ ok: true, product: p });
  }));
  // GET /api/products/:id/design-prompt — what to paste into an external image tool (Nano Banana, Grok, Claude...).
  r.get('/products/:id/design-prompt', wrap(async (req, res) => { res.json({ ok: true, ...pipe.manualDesignPrompt(req.params.id) }); }));
  // POST /api/products/:id/upload-design — raw image bytes (Content-Type image/png). Owner-only like every route here
  // (app-level requireOwner + sameOrigin). The type is decided by magic bytes, not the header or any filename.
  const MAX_UPLOAD = 25 * 1024 * 1024;
  r.post('/products/:id/upload-design', express.raw({ type: () => true, limit: MAX_UPLOAD }), wrap(async (req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) return res.status(400).json({ error: 'Send the image as the raw request body', code: 'no_body' });
    const kind = sniffImage(buf);
    if (kind === 'jpeg') return res.status(415).json({ error: 'JPEG is not supported: designs are measured and upscaled as PNG. Export the image as PNG and upload that.', code: 'jpeg_unsupported' });
    if (kind !== 'png') return res.status(415).json({ error: 'That is not a PNG image', code: 'not_image' });
    const p = await pipe.attachDesign(req.params.id, buf, { actor: actorOf(req) });
    res.json({ ok: true, product: p });
  }));
  r.post('/products/:id/draft-copy', wrap(async (req, res) => {
    res.json({ ok: true, ...(await pipe.draftCopy(req.params.id, { actor: actorOf(req) })) });
  }));
  // PATCH /api/products/:id/copy {title?, tags?, description?} - Etsy rules re-enforced server-side.
  r.patch('/products/:id/copy', wrap(async (req, res) => {
    res.json({ ok: true, ...(await pipe.editCopy(req.params.id, req.body || {}, { actor: actorOf(req) })) });
  }));
  r.get('/products/:id', wrap(async (req, res) => {
    const d = pipe.detail(req.params.id);
    const l = deps.publisher.listingOf(d.product.id);
    const published = l && l.status !== 'draft' ? { externalId: l.external_id, url: l.url, status: l.status, views: l.views, checkedAt: l.checked_at } : null;
    const readiness = d.product.stage === S.APPROVED ? (await deps.publisher.prepare(d.product)) : null;
    out(res, 200, { ok: true, ...d, channels: deps.channels.statesFor(d.product), salesByChannel: deps.channels.salesByChannel(d.product.id), published, publish: readiness && { blockers: readiness.blockers, dryRun: dryRun.isOn() } });
  }));


  // ---- M2: POD catalog (reads: real when a Printify credential exists, even under DRY_RUN) ----------------
  const slim = (a, n) => (Array.isArray(a) ? a.slice(0, n) : a);
  r.get('/pod/blueprints', wrap(async (_req, res) => {
    const list = await adapters.pod.listBlueprints();
    res.json({ ok: true, source: adapters.pod.describe().methods.listBlueprints, total: list.length, blueprints: slim(list, 2000) });
  }));
  r.get('/pod/blueprints/:bp/providers', wrap(async (req, res) => {
    res.json({ ok: true, providers: await adapters.pod.listPrintProviders(req.params.bp) });
  }));
  r.get('/pod/blueprints/:bp/providers/:pp/variants', wrap(async (req, res) => {
    const v = await adapters.pod.listVariants(req.params.bp, req.params.pp);
    res.json({ ok: true, source: v.source, note: v.source === 'printify' ? 'Printify does not expose base costs in the catalog; the real cost is read from the product after it is created.' : undefined, variants: v.variants });
  }));
  // GET /api/margin-preview?listPrice=<cents>&baseCost=<cents>&shipping=<cents> — the composer's live margin.
  r.get('/margin-preview', wrap(async (req, res) => {
    const n = k => (req.query[k] === undefined ? undefined : Number(req.query[k]));
    res.json({ ok: true, ...pipe.marginPreview({ listPriceCents: n('listPrice'), shippingCents: n('shipping') ?? 0, podBaseCostCents: n('baseCost') }) });
  }));

  r.post('/products/:id/pod', wrap(async (req, res) => {
    const b = req.body || {};
    res.json({ ok: true, product: await pipe.selectPod(req.params.id, { blueprint: b.blueprint, providerId: b.printProviderId, variantIds: b.variantIds }) });
  }));
  r.post('/products/:id/create-pod', wrap(async (req, res) => { res.json({ ok: true, product: await pipe.createPodProduct(req.params.id, { actor: actorOf(req) }) }); }));
  r.post('/products/:id/refresh-mockups', wrap(async (req, res) => { res.json({ ok: true, product: await pipe.refreshMockups(req.params.id, { actor: actorOf(req) }) }); }));
  r.post('/products/:id/draft-listing', wrap(async (req, res) => { res.json({ ok: true, product: await pipe.draftListing(req.params.id, { actor: actorOf(req) }) }); }));
  r.patch('/products/:id/price', wrap(async (req, res) => { res.json({ ok: true, product: await pipe.setPrice(req.params.id, req.body || {}, { actor: actorOf(req) }) }); }));
  r.post('/products/:id/submit', wrap(async (req, res) => { res.json({ ok: true, product: await pipe.submit(req.params.id, { actor: actorOf(req) }) }); }));
  r.post('/products/:id/reject', wrap(async (req, res) => { res.json({ ok: true, product: await pipe.reject(req.params.id, { actor: actorOf(req), note: String((req.body || {}).note || '').slice(0, 500) }) }); }));
  r.post('/products/:id/archive', wrap(async (req, res) => { res.json({ ok: true, product: await pipe.archive(req.params.id, { actor: actorOf(req), note: String((req.body || {}).note || '').slice(0, 500) }) }); }));

  // POST /api/products/:id/approve — two-step confirm. Only a human reaches this route (actorOf is always 'human');
  // the agent rule (autopublish on, DRY_RUN off, no flags) is enforced in stages.transition() for any other caller.
  // The confirm token is bound to the product AND its updated_at, so an edit after the summary was shown voids it.
  r.post('/products/:id/approve', wrap(async (req, res) => {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id));
    if (!p) return res.status(404).json({ error: 'Not found' });
    if (p.stage !== S.PENDING) return res.status(409).json({ error: `Only a PENDING_APPROVAL product can be approved; this one is ${p.stage}`, code: 'illegal_stage' });
    const gate = confirm.check({ action: 'product.approve', subject: `${p.id}:${p.updated_at}`, summary: approvalSummary(p, { dryRun: dryRun.isOn() }) }, (req.body || {}).token);
    if (gate.needsConfirm) return res.json(gate);
    res.json({ ok: true, product: await pipe.approve(p.id, { actor: actorOf(req) }) });
  }));

  // Publish, listing edits, Etsy connection and sales live in routes/etsy.js.
  require('./etsy').mount(r, deps);
  // Channels: Redbubble upload pack, per-channel listing state, Redbubble sales import/entry.
  require('./channels').mount(r, deps);
  // M4: blocklist editor, batch orchestrator.
  require('./m4').mount(r, deps);
  // Proposals queue: generated original product ideas awaiting the owner.
  require('./proposals').mount(r, deps);

  r.get('/mockups/:id/file', wrap(async (req, res) => {
    const m = db.prepare('SELECT file FROM mockups WHERE id = ?').get(Number(req.params.id));
    const root = path.resolve(deps.cfg.dataDir, 'mockups');
    const file = m && m.file ? path.resolve(root, m.file) : null;
    if (!file || !file.startsWith(root + path.sep) || !fs.existsSync(file)) return res.status(404).json({ error: 'Not found' });
    res.set('Cache-Control', 'private, max-age=3600').type('png').sendFile(file);
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
    res.set('Cache-Control', 'private, max-age=3600').type('png').sendFile(file);
  }));

  // ---- Etsy fee schedule: editable rates (cents / basis points), verified defaults, and the pricing helper ----
  const feePayload = () => ({ ok: true, schedule: feeSchedule.loadSchedule(settings), defaults: feeSchedule.DEFAULTS, fields: feeSchedule.FIELDS, verifiedOn: feeSchedule.VERIFIED_ON, verifiedSource: feeSchedule.VERIFIED_SOURCE });
  r.get('/fees', wrap(async (_req, res) => { res.json(feePayload()); }));
  // POST /api/fees {schedule:{...partial}} — validated; applies to FUTURE projections only (each projection records the version it used).
  r.post('/fees', wrap(async (req, res) => {
    feeSchedule.saveSchedule(settings, (req.body || {}).schedule);
    res.json(feePayload());
  }));
  r.post('/fees/reset', wrap(async (_req, res) => { feeSchedule.resetSchedule(settings); res.json(feePayload()); }));
  // POST /api/price-calc {podBaseCostCents, podShippingCostCents, shippingCents, marginCents|marginPct, listPriceCents?}
  r.post('/price-calc', wrap(async (req, res) => {
    const b = req.body || {}; const sched = feeSchedule.loadSchedule(settings);
    try {
      const suggested = fees.minListPrice({ podBaseCostCents: b.podBaseCostCents, podShippingCostCents: b.podShippingCostCents ?? 0, shippingCents: b.shippingCents ?? 0, marginCents: b.marginCents, marginPct: b.marginPct }, sched);
      const atPrice = b.listPriceCents === undefined ? null : fees.projectMargin({ listPriceCents: b.listPriceCents, shippingCents: b.shippingCents ?? 0, podBaseCostCents: b.podBaseCostCents, podShippingCostCents: b.podShippingCostCents ?? 0 }, sched);
      res.json({ ok: true, suggested, atPrice, breakEvenAtPrice: atPrice ? fees.breakEvenUnits(atPrice.marginCents, sched.setupFeeCents) : null, setupFeeCents: sched.setupFeeCents });
    } catch (e) { res.status(400).json({ error: e.message }); }
  }));

  // GET /api/settings — presence only, never values.
  r.get('/settings', wrap(async (_req, res) => {
    res.json({
      dryRun: dryRun.isOn(), disarmPhrase: dryRun.PHRASE,
      dailySpendCapCents: spend.capCents(), marginFloorCents: settings.getInt('margin_floor_cents', 200),
      print: pipe.printRule(),
      credentials: credentials.status(),
    });
  }));

  // POST /api/settings — caps, in dollars.
  r.post('/settings', wrap(async (req, res) => {
    const b = req.body || {};
    const cents = (v, name) => { const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > 100000) throw Object.assign(new Error(`${name} must be dollars between 0 and 100000`), { status: 400 }); return Math.round(n * 100); };
    if (b.dailySpendCap !== undefined) settings.set('daily_spend_cap_cents', cents(b.dailySpendCap, 'dailySpendCap'));
    if (b.marginFloor !== undefined) settings.set('margin_floor_cents', cents(b.marginFloor, 'marginFloor'));
    if (b.printMinCoverage !== undefined) {
      const n = Number(b.printMinCoverage);
      if (!(n >= 0.1 && n <= 1)) return res.status(400).json({ error: 'printMinCoverage must be from 0.1 to 1' });
      settings.set('print_min_coverage', n);
    }
    if (b.printFit !== undefined) {
      if (!['cover', 'contain'].includes(b.printFit)) return res.status(400).json({ error: 'printFit must be "cover" or "contain"' });
      settings.set('print_fit', b.printFit);
    }
    res.json({ ok: true, dailySpendCapCents: spend.capCents(), marginFloorCents: settings.getInt('margin_floor_cents', 200), print: pipe.printRule() });
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
    if (err.name === 'PipelineError') return res.status(err.status).json({ error: err.message, code: err.code, ...(err.failed ? { failed: true } : {}), ...(err.readiness ? { readiness: err.readiness } : {}) });
    if (err.name === 'ChannelError') return res.status(err.status || 400).json({ error: err.message, code: err.code });
    if (err.name === 'BatchError') return res.status(err.status).json({ error: err.message, code: err.code });
    if (err.name === 'SpendCapError') return res.status(429).json({ error: err.message, code: 'spend_cap' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
    deps.log.error(`[api] ${req.method} ${req.path} failed:`, err);
    return res.status(500).json({ error: 'Internal error' });
  };
}

module.exports = { router, errorHandler };
