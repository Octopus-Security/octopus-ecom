'use strict';
// M3: publish Printify -> Etsy (every refusal, the happy path, DRY_RUN fake), reconcile, agent rules, direct edits.
const { test } = require('node:test');
const assert = require('node:assert');
const { makeDeps } = require('./helpers');
const { liveDeps, connectStore, approvedProduct, money } = require('./etsy-helpers');
const { buildApp } = require('../server/app');

async function serve(d) {
  const server = await new Promise(r => { const s = buildApp(d).listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const j = async (method, url, body) => { const r = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
  return { server, j };
}
const activeListing = (over = {}) => ({ listing_id: 900, state: 'active', url: 'https://etsy.test/listing/900', shop_id: 555, title: 'Fox tee', tags: ['fox'], price: money(3000), views: 4, num_favorers: 1, ...over });
const costsOf = (d, id, kind) => d.db.prepare('SELECT * FROM costs WHERE product_id=? AND kind=?').all(id, kind);
const stage = (d, id) => d.db.prepare('SELECT stage FROM products WHERE id=?').get(id).stage;
async function publishFlow(s, id) { const a = await s.j('POST', `/api/products/${id}/publish`, {}); if (!a.body.needsConfirm) return { a }; return { a, b: await s.j('POST', `/api/products/${id}/publish`, { token: a.body.token }) }; }
/** Printify reports the Etsy listing id as soon as publish.json is accepted. */
const publishesNow = st => { st.onPublish = x => { x.product = { ...x.product, external: { id: '900', handle: 'https://etsy.test/listing/900' } }; }; };

test('each precondition refuses a live publish by name, BEFORE any confirm token is issued', async () => {
  const { d, st } = liveDeps();
  const s = await serve(d);
  try {
    const codesFor = async id => { const r = await s.j('POST', `/api/products/${id}/publish`, {}); assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.needsConfirm, undefined); return r.body.blockers.map(b => b.code); };
    // not approved
    const pend = approvedProduct(d); d.db.prepare("UPDATE products SET stage='PENDING_APPROVAL' WHERE id=?").run(pend);
    const na = await s.j('POST', `/api/products/${pend}/publish`, {}); assert.equal(na.body.code, 'not_approved');
    // no store at all
    const a = approvedProduct(d);
    assert.ok((await codesFor(a)).includes('no_store'));
    // estimated cost and stub product
    const store = connectStore(d);
    const e = approvedProduct(d, { source: 'estimate' });
    assert.ok((await codesFor(e)).includes('estimated_cost'));
    const stub = approvedProduct(d, { podId: 'stub-prod-1-abc' });
    assert.ok((await codesFor(stub)).includes('no_pod_product'));
    const noprice = approvedProduct(d); d.db.prepare('UPDATE products SET list_price_cents = NULL WHERE id=?').run(noprice);
    assert.ok((await codesFor(noprice)).includes('no_price'));
    // printify not linked to Etsy
    st.printifyShops = [{ id: 7, title: 'My Shop', sales_channel: 'disconnected' }];
    assert.ok((await codesFor(approvedProduct(d))).includes('printify_not_linked'));
    // linked, but to a differently named shop
    st.printifyShops = [{ id: 7, title: 'Other Shop', sales_channel: 'etsy' }];
    assert.ok((await codesFor(approvedProduct(d))).includes('printify_shop_mismatch'));
    // store disconnected / no shop
    st.printifyShops = [{ id: 7, title: 'My Shop', sales_channel: 'etsy' }];
    d.db.prepare("UPDATE stores SET status='no_shop', shop_id=NULL, status_detail=NULL WHERE id=?").run(store);
    const ns = await s.j('POST', `/api/products/${approvedProduct(d)}/publish`, {});
    assert.ok(ns.body.blockers.some(b => b.code === 'no_shop')); assert.match(ns.body.error.concat(ns.body.blockers.map(b => b.message).join(' ')), /Open an Etsy shop first \(Shop Manager → open shop\), then reconnect/);
    d.db.prepare("UPDATE stores SET status='disconnected', oauth_sealed=NULL WHERE id=?").run(store);
    assert.ok((await codesFor(approvedProduct(d))).includes('store_disconnected'));
    assert.equal(st.publishCalls.length, 0, 'nothing reached Printify in any refusal');
  } finally { s.server.close(); }
});

test('happy path: confirm summary names shop/price/fee/flags/real marketplace; Printify is told; listing + fee + stage written; live when Etsy shows it active', async () => {
  const { d, st } = liveDeps({ listings: { 900: activeListing() } });
  publishesNow(st);
  const store = connectStore(d);
  const id = approvedProduct(d, { price: 3000 });
  d.db.prepare("UPDATE products SET flags = ? WHERE id = ?").run(JSON.stringify([{ code: 'margin_below_floor', detail: '1.00 < floor 2.00' }]), id);
  const s = await serve(d);
  try {
    const a = await s.j('POST', `/api/products/${id}/publish`, {});
    assert.equal(a.body.needsConfirm, true);
    const sum = a.body.summary;
    assert.match(sum, /My Shop/); assert.match(sum, /\$30\.00/); assert.match(sum, /listing fee \$0\.20/); assert.match(sum, /margin_below_floor/); assert.match(sum, /REAL Etsy marketplace/); assert.match(sum, /irreversible/);
    assert.equal(st.publishCalls.length, 0, 'the first call executes nothing');
    const b = await s.j('POST', `/api/products/${id}/publish`, { token: a.body.token });
    assert.equal(b.status, 200, JSON.stringify(b.body)); assert.equal(b.body.published, true); assert.equal(b.body.faked, false);
    // Printify: copy PUT first, then publish.json with the section flags
    assert.equal(st.putCalls.length, 1); assert.equal(st.putCalls[0].title, 'Fox tee'); assert.deepEqual(st.putCalls[0].tags, ['fox', 'cozy']);
    assert.deepEqual(st.publishCalls[0], { title: true, description: true, images: true, variants: true, tags: true, keyFeatures: true, shipping_template: true });
    // listing row, fee, stage
    const l = d.db.prepare("SELECT * FROM listings WHERE product_id=?").get(id);
    assert.equal(l.external_id, '900'); assert.equal(l.url, 'https://etsy.test/listing/900'); assert.equal(l.status, 'active'); assert.equal(l.store_id, store);
    const fee = costsOf(d, id, 'listing_fee'); assert.equal(fee.length, 1); assert.equal(fee[0].amount_cents, 20);
    assert.equal(stage(d, id), 'live');
    assert.deepEqual(d.db.prepare("SELECT stage_from, stage_to FROM events WHERE product_id=? AND kind='stage' ORDER BY id DESC LIMIT 2").all(id).reverse().map(e => `${e.stage_from}>${e.stage_to}`), ['approved>published', 'published>live']);
    assert.equal(d.db.prepare('SELECT store_id FROM products WHERE id=?').get(id).store_id, store);
    // the listing fee is a marketplace charge, not generation spend: it must not eat the daily cap
    assert.equal(d.spend.todayCents(), 0);
    // the detail view exposes the live listing link
    const det = await s.j('GET', `/api/products/${id}`); assert.equal(det.body.published.url, 'https://etsy.test/listing/900');
    // a second publish is refused: it is no longer approved
    assert.equal((await s.j('POST', `/api/products/${id}/publish`, {})).body.code, 'not_approved');
  } finally { s.server.close(); }
});

test('Printify has not reported an Etsy id yet: published, no fee; a later refresh finds it, records the fee ONCE and goes live', async () => {
  const { d, st } = liveDeps({ listings: { 900: activeListing() } });
  connectStore(d);
  const id = approvedProduct(d);
  const s = await serve(d);
  try {
    const { b } = await publishFlow(s, id);
    assert.equal(b.status, 200); assert.equal(b.body.readBack.status, 'publishing');
    assert.equal(stage(d, id), 'published'); assert.equal(costsOf(d, id, 'listing_fee').length, 0, 'no listing exists yet, so no fee yet');
    assert.equal(d.db.prepare('SELECT status FROM listings WHERE product_id=?').get(id).status, 'publishing');
    st.product = { ...st.product, external: [{ id: '900', handle: 'h' }] }; // array shape is read too
    const r = await s.j('POST', `/api/products/${id}/refresh-status`, {});
    assert.equal(r.body.status, 'live'); assert.equal(stage(d, id), 'live');
    await s.j('POST', `/api/products/${id}/refresh-status`, {});
    assert.equal(costsOf(d, id, 'listing_fee').length, 1);
  } finally { s.server.close(); }
});

test('Etsy shows the listing inactive/draft: stays published until it is active; a listing in the wrong shop is flagged loudly', async () => {
  const { d, st } = liveDeps({ listings: { 900: activeListing({ state: 'draft' }) } });
  publishesNow(st); connectStore(d);
  const id = approvedProduct(d);
  const s = await serve(d);
  try {
    await publishFlow(s, id);
    assert.equal(stage(d, id), 'published');
    st.listings[900] = activeListing({ shop_id: 999 });
    await s.j('POST', `/api/products/${id}/refresh-status`, {});
    assert.equal(stage(d, id), 'live');
    assert.ok(JSON.parse(d.db.prepare('SELECT flags FROM products WHERE id=?').get(id).flags).some(f => f.code === 'etsy_shop_mismatch'));
  } finally { s.server.close(); }
});

test('a Printify publish error leaves the product approved, writes no listing fee, and says so', async () => {
  const { d, st } = liveDeps();
  connectStore(d); const id = approvedProduct(d);
  st.onPublish = () => { throw new Error('boom'); };
  const s = await serve(d);
  try {
    // the fake throws inside the handler -> fetch rejects -> http error
    const { b } = await publishFlow(s, id);
    assert.equal(b.status, 502); assert.equal(b.body.code, 'publish_failed');
    assert.equal(stage(d, id), 'approved'); assert.equal(costsOf(d, id, 'listing_fee').length, 0);
    assert.ok(d.db.prepare("SELECT 1 FROM events WHERE product_id=? AND note LIKE 'publish call failed%'").get(id));
  } finally { s.server.close(); }
});

test('DRY_RUN fakes the publish: confirm, then nothing is sent anywhere, the stage does not move, live blockers are reported', async () => {
  const { d, st, calls } = liveDeps();
  d.settings.set('dry_run', 'true');
  const id = approvedProduct(d, { source: 'estimate' }); // no store, estimate: a live publish would be refused
  const s = await serve(d);
  try {
    const { a, b } = await publishFlow(s, id);
    assert.match(a.body.summary, /SIMULATED/);
    assert.equal(b.body.faked, true); assert.equal(b.body.published, false);
    assert.ok(b.body.liveBlockers.some(x => x.code === 'estimated_cost'));
    assert.equal(stage(d, id), 'approved'); assert.equal(st.publishCalls.length, 0); assert.equal(st.putCalls.length, 0);
    assert.equal(calls.filter(c => c.method === 'POST' || c.method === 'PUT').length, 0, 'no write of any kind left the process');
    assert.equal(costsOf(d, id, 'listing_fee').length, 0);
  } finally { s.server.close(); }
});

test('estimated base cost: re-running create-pod with live writes reads the real cost and VOIDS the approval', async () => {
  const { d, st } = liveDeps();
  // Printify fake extension: catalog + product create so the real createProduct path runs
  const VARIANTS = [{ id: 101, title: 'S', options: {}, placeholders: [{ position: 'front', width: 4500, height: 5400 }] }];
  const orig = st.product;
  const f = d.http; void f; void orig;
  const { makeHttp } = require('../server/adapters/http');
  const { fakeFetch } = require('./helpers');
  const base = fakeFetch((url, init) => {
    const u = new URL(url); const p = u.pathname.replace('/v1', ''); const m = init.method || 'GET';
    if (p === '/shops.json') return { body: st.printifyShops };
    if (/\/print_providers\/29\/variants\.json$/.test(p)) return { body: { variants: VARIANTS } };
    if (p === '/uploads/images.json') return { body: { id: 'img_1', width: 4500, height: 5400 } };
    if (p === '/shops/7/products.json' && m === 'POST') return { body: { id: 'pf_9', variants: [], images: [] } };
    if (p === '/shops/7/products/pf_9.json') return { body: { id: 'pf_9', variants: [{ id: 101, title: 'S', cost: 1412, is_enabled: true }], images: [{ src: 'https://i.test/m.png', position: 'front', is_default: true, variant_ids: [101] }] } };
    return { status: 404, body: {} };
  });
  const dd = makeDeps({ PRINTIFY_API_TOKEN: 'pfy-token-0123456789abcdef', DRY_RUN: 'false', PRINTIFY_SHOP_ID: '7' }, { http: makeHttp({ fetchImpl: base, sleep: async () => {}, random: () => 0.5 }) });
  const created = dd.pipeline.create({ brief: 'a fox in a scarf', listPrice: 30, blueprint: '6', printProviderId: '29' });
  await dd.pipeline.selectPod(created.id, { blueprint: '6', providerId: '29', variantIds: [101] });
  await dd.pipeline.generateDesign(created.id, {});
  // pretend an earlier DRY_RUN made it all the way to approved on an estimate
  dd.db.prepare("UPDATE products SET stage='approved', pod_cost_source='estimate', pod_base_cost_cents=1250, pod_external_id='stub-prod-1-x' WHERE id=?").run(created.id);
  const p = await dd.pipeline.createPodProduct(created.id, { actor: 'human' });
  assert.equal(p.stage, 'listing_drafted', 'approval voided: back to drafted');
  const row = dd.db.prepare('SELECT * FROM products WHERE id=?').get(created.id);
  assert.equal(row.pod_cost_source, 'printify_product'); assert.equal(row.pod_base_cost_cents, 1412); assert.equal(row.pod_external_id, 'pf_9');
  const stages = dd.db.prepare("SELECT stage_from f, stage_to t FROM events WHERE product_id=? AND kind='stage' ORDER BY id DESC LIMIT 2").all(created.id).reverse().map(e => `${e.f}>${e.t}`);
  assert.deepEqual(stages, ['approved>PENDING_APPROVAL', 'PENDING_APPROVAL>listing_drafted']);
  assert.ok(!JSON.parse(row.flags).some(f => f.code === 'pod_cost_estimated'));
});

test('agent publish: refused with autopublish off or any flag, allowed with autopublish on, DRY_RUN off and no flags (still needs every precondition)', async () => {
  const { d, st } = liveDeps({ listings: { 900: activeListing() } });
  publishesNow(st);
  const store = connectStore(d);
  const id = approvedProduct(d);
  await assert.rejects(d.publisher.publish(id, { actor: 'agent' }), /autopublish is off/);
  d.db.prepare('UPDATE stores SET autopublish=1 WHERE id=?').run(store);
  d.db.prepare("UPDATE products SET flags=? WHERE id=?").run(JSON.stringify([{ code: 'blocklist', detail: 'x' }]), id);
  await assert.rejects(d.publisher.publish(id, { actor: 'agent' }), /flagged/);
  d.db.prepare("UPDATE products SET flags='[]', pod_cost_source='estimate' WHERE id=?").run(id);
  await assert.rejects(d.publisher.publish(id, { actor: 'agent' }), e => e.code === 'estimated_cost');
  d.db.prepare("UPDATE products SET pod_cost_source='printify_product' WHERE id=?").run(id);
  const out = await d.publisher.publish(id, { actor: 'agent' });
  assert.equal(out.product.stage, 'live');
  assert.equal(d.db.prepare("SELECT actor FROM events WHERE product_id=? AND stage_to='published'").get(id).actor, 'agent');
  // an agent cannot publish at all under DRY_RUN
  const id2 = approvedProduct(d); d.settings.set('dry_run', 'true');
  await assert.rejects(d.publisher.publish(id2, { actor: 'agent' }), e => e.code === 'dry_run');
});

test('direct edits: title/tags go to Etsy with the rules enforced; a price change is confirm-gated and goes through the inventory', async () => {
  const { d, st } = liveDeps({ listings: { 900: activeListing() } });
  publishesNow(st); connectStore(d);
  const id = approvedProduct(d, { price: 3000, cost: 1337 });
  const s = await serve(d);
  try {
    await publishFlow(s, id);
    assert.equal(stage(d, id), 'live');
    const long = 'x'.repeat(200);
    const t = await s.j('PATCH', `/api/products/${id}/listing`, { title: long, tags: ['Cozy Fox', 'a'.repeat(25), 'cozy fox', 'ok'] });
    assert.equal(t.status, 200, JSON.stringify(t.body)); assert.equal(t.body.applied, true);
    const patch = st.etsyWrites.find(w => w.method === 'PATCH');
    assert.ok(patch.body.title.length <= 140); assert.deepEqual(patch.body.tags, ['cozy fox', 'ok']); assert.equal(patch.path, '/v3/application/shops/555/listings/900');
    assert.equal(d.db.prepare('SELECT title FROM listings WHERE product_id=?').get(id).title, patch.body.title);
    assert.ok(t.body.repairs.some(r => r.code === 'dropped_too_long'));
    // price: needs a confirm, nothing sent before it
    const before = st.etsyWrites.length;
    const p1 = await s.j('PATCH', `/api/products/${id}/listing`, { price: 35 });
    assert.equal(p1.body.needsConfirm, true); assert.match(p1.body.summary, /\$30\.00 to \$35\.00/); assert.match(p1.body.summary, /Projected unit margin/);
    assert.equal(st.etsyWrites.length, before);
    const p2 = await s.j('PATCH', `/api/products/${id}/listing`, { price: 35, token: p1.body.token });
    assert.equal(p2.body.applied, true);
    const put = st.etsyWrites.find(w => w.method === 'PUT');
    assert.equal(put.path, '/v3/application/listings/900/inventory'); assert.equal(put.body.products[0].offerings[0].price, 35); assert.equal(put.body.products[0].offerings[0].quantity, 5);
    assert.equal(d.db.prepare('SELECT list_price_cents FROM products WHERE id=?').get(id).list_price_cents, 3500);
    // a brand term is refused, not sent
    const n = st.etsyWrites.length;
    const bl = await s.j('PATCH', `/api/products/${id}/listing`, { title: 'Pikachu fox tee' });
    assert.equal(bl.status, 422); assert.equal(st.etsyWrites.length, n);
    // not published yet -> 409
    assert.equal((await s.j('PATCH', `/api/products/${approvedProduct(d)}/listing`, { title: 'x' })).status, 409);
  } finally { s.server.close(); }
});

test('direct edits under DRY_RUN are faked: nothing sent, nothing changed locally', async () => {
  const { d, st } = liveDeps({ listings: { 900: activeListing() } });
  publishesNow(st); connectStore(d);
  const id = approvedProduct(d);
  const s = await serve(d);
  try {
    await publishFlow(s, id);
    d.settings.set('dry_run', 'true');
    const r = await s.j('PATCH', `/api/products/${id}/listing`, { title: 'New title' });
    assert.equal(r.body.faked, true); assert.equal(st.etsyWrites.length, 0);
    assert.equal(d.db.prepare('SELECT title FROM listings WHERE product_id=?').get(id).title, 'Fox tee');
  } finally { s.server.close(); }
});

test('the listing-stats read: real views from getListing, sales null (Etsy has no per-listing sales counter)', async () => {
  const { d } = liveDeps({ listings: { 900: activeListing({ views: 77, num_favorers: 9 }) } });
  connectStore(d);
  const s = await d.adapters.storefront.getListingStats('900');
  assert.deepEqual({ v: s.views, f: s.favorites, s: s.sales }, { v: 77, f: 9, s: null });
});
