'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { nextSale } = require('../server/domain/next-sale');
const { makeDeps } = require('./helpers');
const { buildApp } = require('../server/app');

function ctx(over = {}) {
  return {
    has: { printify: true, etsy_api_key: true, etsy_shared_secret: true },
    store: { id: 1, status: 'connected', shop_id: '99', shop_name: 'Test', oauth_sealed: true, status_detail: '' },
    dryRun: true,
    marginFloorCents: 200,
    listingFeeCents: 20,
    products: [],
    saleCount: 0,
    ...over,
  };
}

function product(over = {}) {
  return {
    id: 1, stage: 'design_generated', title: 'Cat', brief: 'a cat', flags: '[]',
    list_price_cents: 2000, projected_margin_cents: 500,
    pod_external_id: null, pod_cost_source: null,
    blueprint: 'ornament', print_provider_id: 'pp', failed_reason: null,
    designCount: 1, listingTitle: null,
    ...over,
  };
}

test('account gates come first, and a missing key is named', () => {
  assert.equal(nextSale(ctx({ has: {} })).code, 'need_printify');
  assert.equal(nextSale(ctx({ has: { printify: true } })).code, 'need_etsy_keys');
  const one = nextSale(ctx({ has: { printify: true, etsy_api_key: true } }));
  assert.match(one.detail, /etsy_shared_secret/);
  assert.doesNotMatch(one.detail, /etsy_api_key and/);
  assert.equal(nextSale(ctx({ store: null })).code, 'need_etsy_store');
  assert.equal(nextSale(ctx({ store: { status: 'no_shop', shop_id: null, oauth_sealed: true } })).code, 'need_etsy_shop');
  assert.equal(nextSale(ctx({ store: { status: 'disconnected', shop_id: '99', oauth_sealed: false, status_detail: 'token expired' } })).code, 'etsy_disconnected');
  assert.match(nextSale(ctx({ store: { status: 'disconnected', shop_id: '99', oauth_sealed: false, status_detail: 'token expired' } })).detail, /token expired/);
});

test('with no design, the step is an upload and not a generation', () => {
  const none = nextSale(ctx());
  assert.equal(none.code, 'need_design');
  assert.equal(none.open, 'composer');
  assert.match(none.detail, /Upload your PNG/);
  assert.match(none.detail, /Do not press Generate/);
  const idea = nextSale(ctx({ products: [product({ stage: 'idea', designCount: 0, blueprint: null })] }));
  assert.equal(idea.code, 'need_design');
  assert.equal(idea.open, 'product');
  assert.equal(idea.productId, 1);
});

test('a saved design follows the card buttons, and the furthest product wins', () => {
  const pod = nextSale(ctx({ products: [product()] }));
  assert.equal(pod.code, 'create_pod');
  assert.match(pod.detail, /Create POD product/);
  assert.match(pod.detail, /does not generate/);
  const blank = nextSale(ctx({ products: [product({ blueprint: null })] }));
  assert.equal(blank.code, 'need_blank');
  assert.equal(blank.open, 'composer');
  const early = product({ id: 2, stage: 'design_generated' });
  const later = product({ id: 3, stage: 'mockup_ready', listingTitle: 'Cat ornament' });
  assert.equal(nextSale(ctx({ products: [early, later] })).code, 'draft_listing');
  const drafted = product({ stage: 'listing_drafted', listingTitle: 'Cat ornament' });
  assert.equal(nextSale(ctx({ products: [drafted] })).code, 'submit');
  assert.match(nextSale(ctx({ products: [drafted] })).detail, /does not list it/);
});

test('print coverage, copy, price, and margin stop the card before arming', () => {
  const bad = product({ stage: 'PENDING_APPROVAL', listingTitle: 'Cat', flags: JSON.stringify([{ code: 'print_not_ready', detail: 'front is short' }]) });
  const print = nextSale(ctx({ products: [bad] }));
  assert.equal(print.code, 'print_not_ready');
  assert.match(print.detail, /front is short/);
  assert.match(print.detail, /Do not lower the coverage rule/);
  const noCopy = product({ stage: 'listing_drafted', listingTitle: '' });
  assert.equal(nextSale(ctx({ products: [noCopy] })).code, 'need_copy');
  const noPrice = product({ stage: 'listing_drafted', listingTitle: 'Cat', list_price_cents: null });
  assert.equal(nextSale(ctx({ products: [noPrice] })).code, 'need_price');
  const thin = product({ stage: 'PENDING_APPROVAL', listingTitle: 'Cat', projected_margin_cents: 50 });
  const margin = nextSale(ctx({ products: [thin] }));
  assert.equal(margin.code, 'margin_below_floor');
  assert.match(margin.detail, /\$0\.50/);
  assert.match(margin.detail, /\$2\.00/);
});

test('dry run ready does not disarm, and live writes name the publish refusal', () => {
  const pending = product({ stage: 'PENDING_APPROVAL', listingTitle: 'Cat ornament', pod_external_id: 'stub-1', pod_cost_source: 'estimate' });
  const ready = nextSale(ctx({ products: [pending] }));
  assert.equal(ready.code, 'dry_run_ready');
  assert.equal(ready.writes, false);
  assert.equal(ready.dryRun, true);
  assert.match(ready.detail, /\$0\.20/);
  assert.match(ready.detail, /does not turn dry run off/);
  assert.match(ready.detail, /estimate/);
  const live = nextSale(ctx({ dryRun: false, products: [product({ stage: 'approved', listingTitle: 'Cat', pod_external_id: 'stub-9', pod_cost_source: 'estimate' })] }));
  assert.equal(live.code, 'no_pod_product');
  assert.match(live.detail, /does not generate a new image/);
  const cost = nextSale(ctx({ dryRun: false, products: [product({ stage: 'approved', listingTitle: 'Cat', pod_external_id: 'printify-1', pod_cost_source: 'estimate' })] }));
  assert.equal(cost.code, 'estimated_cost');
  const linked = nextSale(ctx({
    dryRun: false,
    liveBlockers: [{ code: 'printify_not_linked', message: 'The Printify shop is connected to "nothing", not Etsy.' }],
    products: [product({ stage: 'approved', listingTitle: 'Cat', pod_external_id: 'printify-1', pod_cost_source: 'printify_product' })],
  }));
  assert.equal(linked.code, 'printify_not_linked');
  const go = nextSale(ctx({
    dryRun: false,
    liveBlockers: [],
    products: [product({ stage: 'approved', listingTitle: 'Cat', pod_external_id: 'printify-1', pod_cost_source: 'printify_product' })],
  }));
  assert.equal(go.code, 'ready_to_publish');
  assert.match(go.detail, /Designed by/);
  assert.equal(go.writes, false);
});

test('a listed product asks for the disclosure, then for the money check', () => {
  const listed = product({ stage: 'published', listingTitle: 'Cat' });
  assert.equal(nextSale(ctx({ products: [listed] })).code, 'disclose');
  assert.match(nextSale(ctx({ products: [listed] })).detail, /does not write those/);
  const sold = nextSale(ctx({ saleCount: 1, products: [product({ stage: 'live', listingTitle: 'Cat' })] }));
  assert.equal(sold.code, 'check_money');
  assert.equal(sold.open, 'sales');
  assert.equal(nextSale(ctx({ products: [product({ stage: 'rejected', designCount: 1 }), product({ id: 4, stage: 'idea', designCount: 0 })] })).code, 'need_design');
});

test('the card component has no dry-run switch', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'client', 'src', 'components', 'NextSale.jsx'), 'utf8');
  assert.doesNotMatch(src, /setDryRun|ARM LIVE WRITES|publish\(/);
  const app = fs.readFileSync(path.join(__dirname, '..', 'client', 'src', 'App.jsx'), 'utf8');
  assert.match(app, /NextSale/);
  assert.doesNotMatch(app.slice(app.indexOf('<NextSale'), app.indexOf('<NextSale') + 500), /setDryRun|publish/);
});

test('GET /api/next-sale reads state, leaks no secret, and leaves dry run on', async () => {
  const SENTINEL = 'SEALED-SENTINEL-9f3a';
  const TOKEN = 'printify-token-should-not-leak';
  const d = makeDeps();
  const server = await new Promise((resolve) => { const s = buildApp(d).listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async () => {
    const r = await fetch(base + '/api/next-sale');
    return { status: r.status, body: await r.json() };
  };
  try {
    const first = await get();
    assert.equal(first.status, 200);
    assert.equal(first.body.code, 'need_printify');
    assert.equal(first.body.writes, false);
    assert.equal(first.body.dryRun, true);
    assert.equal(d.dryRun.isOn(), true);

    d.keystore.set('printify', TOKEN);
    d.keystore.set('etsy_api_key', 'keystring');
    d.keystore.set('etsy_shared_secret', 'shared');
    const now = new Date().toISOString();
    d.db.prepare(`INSERT INTO stores(platform, name, oauth_sealed, shop_id, autopublish, created_at, status, shop_name)
      VALUES('etsy', 'Test', ?, '99', 0, ?, 'connected', 'Test Shop')`).run(SENTINEL, now);
    const id = d.stages.createProduct({ brief: 'ornament' }).id;
    d.db.prepare(`UPDATE products SET stage = 'PENDING_APPROVAL', title = 'Cat', list_price_cents = 2000, projected_margin_cents = 500,
      blueprint = 'ornament', print_provider_id = 'pp', pod_external_id = 'stub-1', pod_cost_source = 'estimate' WHERE id = ?`).run(id);
    d.db.prepare('INSERT INTO designs(product_id, image_path, width, height, cost_cents, source, created_at) VALUES(?, ?, 2000, 2000, 0, ?, ?)').run(id, 'x.png', 'manual', now);
    d.db.prepare("INSERT INTO listings(product_id, platform, title, tags, description, price_cents, status, created_at) VALUES(?, 'etsy', ?, '[]', ?, 2000, 'draft', ?)").run(id, 'Cat ornament', 'A cat.', now);

    const second = await get();
    assert.equal(second.body.code, 'dry_run_ready');
    assert.equal(second.body.productId, id);
    assert.equal(second.body.writes, false);
    const dumped = JSON.stringify(second.body);
    assert.equal(dumped.includes(SENTINEL), false);
    assert.equal(dumped.includes(TOKEN), false);
    assert.equal(d.dryRun.isOn(), true);
    assert.equal(d.db.prepare('SELECT COUNT(*) AS n FROM products').get().n, 1);
  } finally { server.close(); }
});
