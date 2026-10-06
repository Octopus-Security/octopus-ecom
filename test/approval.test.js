'use strict';
// M2: POD step, margin, submit/approve/reject/archive and the publish guard, over real HTTP with stubs.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { makeDeps } = require('./helpers');
const { buildApp } = require('../server/app');

let server; let base; let d;
before(async () => {
  d = makeDeps();
  server = await new Promise((r) => { const s = buildApp(d).listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
const j = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null), res: r };
};
/** Create through to listing_drafted. price in dollars; stub tee base cost is 1250. */
async function drafted(price = 30, extra = {}) {
  const v = (await j('GET', '/api/pod/blueprints/stub-tee/providers/stub-pp/variants')).body.variants;
  const c = await j('POST', '/api/products', { brief: 'a fox in a scarf', niche: 'cozy', listPrice: price, blueprint: 'stub-tee', printProviderId: 'stub-pp', variantIds: [v[0].id], ...extra });
  assert.equal(c.status, 201, JSON.stringify(c.body)); const id = c.body.product.id;
  assert.equal((await j('POST', `/api/products/${id}/generate-design`, {})).status, 200);
  assert.equal((await j('POST', `/api/products/${id}/create-pod`, {})).body.product.stage, 'mockup_ready');
  assert.equal((await j('POST', `/api/products/${id}/draft-listing`, {})).body.product.stage, 'listing_drafted');
  return id;
}
const get = async (id) => (await j('GET', `/api/products/${id}`)).body;
const approveFlow = async (id) => { const a = await j('POST', `/api/products/${id}/approve`, {}); return { a, b: a.body.needsConfirm ? await j('POST', `/api/products/${id}/approve`, { token: a.body.token }) : null }; };

test('catalog: stub blueprints carry print-area pixels; the product records them for M4', async () => {
  const bps = (await j('GET', '/api/pod/blueprints')).body;
  assert.deepEqual(bps.blueprints.map(b => b.id), ['stub-tee', 'stub-mug', 'stub-poster']);
  const id = await drafted();
  const det = await get(id);
  assert.deepEqual(det.product.print_spec.positions, [{ position: 'front', width: 4500, height: 5400 }]);
  assert.equal(det.designs[0].width, 4500, 'the design is generated for the blueprint print area');
  const mug = await j('POST', '/api/products', { brief: 'mug', listPrice: 20, blueprint: 'stub-mug', printProviderId: 'stub-pp' });
  assert.deepEqual((await get(mug.body.product.id)).product.print_spec.positions, [{ position: 'front', width: 2475, height: 1155 }]);
});

test('draft: mockups exist (thumbnail is the first mockup), base cost + projected margin, no pod cost row, estimate flag', async () => {
  const id = await drafted(30);
  const det = await get(id);
  assert.equal(det.mockups.length, 2); assert.equal(det.mockups[0].isDefault, true);
  const png = await fetch(base + det.mockups[0].url); assert.equal(png.status, 200); assert.equal(png.headers.get('content-type'), 'image/png');
  assert.equal(det.product.pod_base_cost_cents, 1250); assert.equal(det.product.pod_cost_source, 'estimate');
  // 3000 - 1250 - 20 listing - 195 txn (6.5%, no tax) - 121 processing (3% of 3210 incl. est. 7% tax, + 25) = 1414
  assert.equal(det.product.projected_margin_cents, 1414); assert.equal(det.economics.marginCents, 1414);
  assert.deepEqual(det.product.flags.map(f => f.code), ['pod_cost_estimated']);
  assert.equal(det.costs.length, 0); assert.equal(det.costTotalCents, 0);
  const card = (await j('GET', '/api/products')).body.columns.listing_drafted.find(c => c.id === id);
  assert.equal(card.thumbnailKind, 'mockup'); assert.match(card.thumbnail, /^\/api\/mockups\/\d+\/file$/); assert.equal(card.projectedMarginCents, 1414);
  assert.equal((await j('GET', '/api/mockups/99999/file')).status, 404);
});

test('margin preview is the same math; margin <= 0 and below floor are flagged, a healthy margin is not', async () => {
  const pv = (await j('GET', '/api/margin-preview?listPrice=3000&baseCost=1250')).body;
  assert.equal(pv.marginCents, 1414); assert.deepEqual(pv.flags, []);
  assert.equal((await j('GET', '/api/margin-preview?listPrice=abc&baseCost=1')).status, 400);
  const id = await drafted(30);
  let p = (await j('PATCH', `/api/products/${id}/price`, { listPrice: 14 })).body.product; // 1400-1250-20-91-67 = -28
  assert.ok(p.projected_margin_cents <= 0); assert.ok(JSON.parse(p.flags).some(f => f.code === 'margin_non_positive'));
  p = (await j('PATCH', `/api/products/${id}/price`, { listPrice: 16.5 })).body.product; // positive but under the $2 floor
  assert.ok(p.projected_margin_cents > 0 && p.projected_margin_cents < 200); assert.ok(JSON.parse(p.flags).some(f => f.code === 'margin_below_floor'));
  p = (await j('PATCH', `/api/products/${id}/price`, { listPrice: 30 })).body.product;
  assert.deepEqual(JSON.parse(p.flags).map(f => f.code), ['pod_cost_estimated'], 'margin flags cleared, the estimate flag stays');
  assert.equal((await j('PATCH', `/api/products/${id}/price`, { listPrice: -2 })).status, 400);
});

test('approval is two-step and human-only: summary lists price, base cost, margin and flags; token is single use; edits void it', async () => {
  const id = await drafted(14); // flagged
  assert.equal((await j('POST', `/api/products/${id}/approve`, {})).status, 409, 'not PENDING yet');
  assert.equal((await j('POST', `/api/products/${id}/submit`, {})).body.product.stage, 'PENDING_APPROVAL');
  const a = await j('POST', `/api/products/${id}/approve`, {});
  assert.equal(a.body.needsConfirm, true); assert.equal((await get(id)).product.stage, 'PENDING_APPROVAL', 'first call executes nothing');
  assert.match(a.body.summary, /List price 14\.00/); assert.match(a.body.summary, /base cost 12\.50.*ESTIMATE/); assert.match(a.body.summary, /Projected unit margin/); assert.match(a.body.summary, /FLAGGED: .*margin_non_positive/); assert.match(a.body.summary, /DRY_RUN is on/);
  const ok = await j('POST', `/api/products/${id}/approve`, { token: a.body.token });
  assert.equal(ok.status, 200); assert.equal(ok.body.product.stage, 'approved', 'a human may approve a flagged product');
  assert.equal((await j('POST', `/api/products/${id}/approve`, { token: a.body.token })).status, 409, 'single use');
  // a price edit after the summary was shown voids the token and steps back to listing_drafted
  const id2 = await drafted(30); await j('POST', `/api/products/${id2}/submit`, {});
  const t = (await j('POST', `/api/products/${id2}/approve`, {})).body.token;
  await j('PATCH', `/api/products/${id2}/price`, { listPrice: 31 });
  assert.equal((await get(id2)).product.stage, 'listing_drafted');
  await j('POST', `/api/products/${id2}/submit`, {});
  assert.equal((await j('POST', `/api/products/${id2}/approve`, { token: t })).status, 409, 'token was bound to the earlier state');
});

test('the agent can never approve: DRY_RUN on, autopublish off, or any flag each refuse; all three clear is the one allowed path', async () => {
  const live = makeDeps({ DRY_RUN: 'false' });
  const mkPending = async (dep) => {
    const p = dep.pipeline.create({ brief: 'a fox', listPrice: 30, blueprint: 'stub-tee', printProviderId: 'stub-pp' });
    await dep.pipeline.selectPod(p.id, { blueprint: 'stub-tee', providerId: 'stub-pp' });
    await dep.pipeline.generateDesign(p.id); await dep.pipeline.createPodProduct(p.id); await dep.pipeline.draftListing(p.id); await dep.pipeline.submit(p.id);
    dep.db.prepare("UPDATE products SET flags = '[]' WHERE id = ?").run(p.id); // clear the estimate flag so only the condition under test remains
    return p.id;
  };
  const store = (dep, auto) => Number(dep.db.prepare("INSERT INTO stores(platform,name,autopublish,created_at) VALUES('etsy','s',?,?)").run(auto, new Date().toISOString()).lastInsertRowid);
  // DRY_RUN on
  const id0 = await mkPending(d); d.db.prepare('UPDATE products SET store_id = ? WHERE id = ?').run(store(d, 1), id0);
  await assert.rejects(d.pipeline.approve(id0, { actor: 'agent' }), /DRY_RUN is on/);
  // live: autopublish off, then flagged, then everything clear
  const id = await mkPending(live);
  const off = store(live, 0), on = store(live, 1);
  live.db.prepare('UPDATE products SET store_id = ? WHERE id = ?').run(off, id);
  await assert.rejects(live.pipeline.approve(id, { actor: 'agent' }), /autopublish is off/);
  live.db.prepare('UPDATE products SET store_id = ?, flags = ? WHERE id = ?').run(on, JSON.stringify([{ code: 'margin_below_floor', detail: 'x' }]), id);
  await assert.rejects(live.pipeline.approve(id, { actor: 'agent' }), /flagged \(margin_below_floor\)/);
  live.db.prepare("UPDATE products SET flags = '[]' WHERE id = ?").run(id);
  assert.equal((await live.pipeline.approve(id, { actor: 'agent' })).stage, 'approved');
  // and the HTTP route is human-only: it never takes an actor from the request
  const id2 = await drafted(30); await j('POST', `/api/products/${id2}/submit`, {});
  const r = await j('POST', `/api/products/${id2}/approve`, { actor: 'agent' });
  assert.equal(r.body.needsConfirm, true, 'a body cannot claim to be the agent; the confirm gate still applies');
});

test('reject and archive; archived products cannot move again', async () => {
  const id = await drafted(30);
  assert.equal((await j('POST', `/api/products/${id}/reject`, { note: 'meh' })).body.product.stage, 'rejected');
  assert.equal((await j('POST', `/api/products/${id}/archive`, {})).body.product.stage, 'archived');
  assert.equal((await j('POST', `/api/products/${id}/archive`, {})).status, 409);
  assert.equal((await j('POST', `/api/products/${id}/submit`, {})).status, 409);
});

test('cannot publish while PENDING_APPROVAL (or any stage but approved), and no confirm token is even issued', async () => {
  const id = await drafted(30); await j('POST', `/api/products/${id}/submit`, {});
  const r = await j('POST', `/api/products/${id}/publish`, {});
  assert.equal(r.status, 409); assert.equal(r.body.code, 'not_approved'); assert.equal(r.body.needsConfirm, undefined);
  assert.equal((await j('POST', `/api/products/${id}/publish`, { token: 'x' })).status, 409);
  assert.equal((await get(id)).product.stage, 'PENDING_APPROVAL');
});

test('cannot publish while DRY_RUN is on: an approved product only gets a SIMULATED publish after confirm; stage unchanged; DRY_RUN off refuses a stub-only product', async () => {
  const id = await drafted(30); await j('POST', `/api/products/${id}/submit`, {});
  await approveFlow(id);
  assert.equal((await get(id)).product.stage, 'approved');
  const a = await j('POST', `/api/products/${id}/publish`, {});
  assert.equal(a.body.needsConfirm, true); assert.match(a.body.summary, /SIMULATED/);
  const b = await j('POST', `/api/products/${id}/publish`, { token: a.body.token });
  assert.equal(b.status, 200); assert.equal(b.body.faked, true); assert.equal(b.body.published, false);
  assert.equal((await get(id)).product.stage, 'approved', 'nothing was published, so the stage did not move');
  assert.ok((await get(id)).events.some(e => /publish simulated/.test(e.note)));
  d.dryRun.isOn = () => false;
  try {
    const c = await j('POST', `/api/products/${id}/publish`, {});
    // M3: live, this product (a DRY_RUN stub with an estimated cost and no Etsy store) is refused BEFORE any token is issued.
    assert.equal(c.status, 409); assert.equal(c.body.needsConfirm, undefined);
    assert.ok(['no_pod_product', 'estimated_cost'].every(k => c.body.blockers.some(b => b.code === k)), JSON.stringify(c.body));
    assert.equal((await get(id)).product.stage, 'approved');
  } finally { d.dryRun.isOn = () => true; }
});

test('guards: POD step needs blueprint, price and a design; flagging a blocklist hit survives margin recompute', async () => {
  const c = await j('POST', '/api/products', { brief: 'plain', listPrice: 20 });
  const id = c.body.product.id;
  await j('POST', `/api/products/${id}/generate-design`, {});
  assert.equal((await j('POST', `/api/products/${id}/create-pod`, {})).body.code, 'no_blueprint');
  assert.equal((await j('POST', `/api/products/${id}/pod`, { blueprint: 'stub-tee', printProviderId: 'stub-pp', variantIds: ['nope'] })).status, 422);
  const bad = await j('POST', '/api/products', { brief: 'a pikachu portrait', listPrice: 20, blueprint: 'stub-tee', printProviderId: 'stub-pp' });
  const bid = bad.body.product.id;
  await j('POST', `/api/products/${bid}/generate-design`, { brief: 'a pikachu portrait' });
  await j('POST', `/api/products/${bid}/create-pod`, {});
  await j('POST', `/api/products/${bid}/draft-listing`, {});
  const codes = (await get(bid)).product.flags.map(f => f.code);
  assert.ok(codes.includes('blocklist') && codes.includes('pod_cost_estimated'));
});

test('fee + price-calc API: edit validates, applies to the preview, resets; solver route meets its target', async () => {
  const g = (await j('GET', '/api/fees')).body;
  assert.equal(g.schedule.version, 0); assert.equal(g.verifiedOn, '2026-10-06'); assert.equal(g.defaults.transactionBps, 650);
  assert.equal((await j('POST', '/api/fees', { schedule: { transactionBps: -1 } })).status, 400);
  assert.equal((await j('POST', '/api/fees', { schedule: { bogus: 1 } })).status, 400);
  const saved = (await j('POST', '/api/fees', { schedule: { transactionBps: 1000 } })).body;
  assert.equal(saved.schedule.version, 1);
  const pv = (await j('GET', '/api/margin-preview?listPrice=3000&baseCost=1250')).body;
  assert.equal(pv.transactionFeeCents, 300); assert.equal(pv.scheduleVersion, 1);
  const calc = (await j('POST', '/api/price-calc', { podBaseCostCents: 1250, podShippingCostCents: 450, shippingCents: 499, marginCents: 500, listPriceCents: 2000 })).body;
  assert.ok(calc.suggested.projection.marginCents >= 500); assert.equal(calc.atPrice.listPriceCents, 2000); assert.equal(calc.setupFeeCents, 2900);
  assert.equal((await j('POST', '/api/price-calc', { podBaseCostCents: 100, marginPct: 99 })).status, 400);
  const reset = (await j('POST', '/api/fees/reset')).body;
  assert.equal(reset.schedule.transactionBps, 650); assert.equal(reset.schedule.version, 2);
});
