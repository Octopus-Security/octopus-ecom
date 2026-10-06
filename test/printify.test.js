'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeDeps, fakeFetch, fakeHttp, tmpDir, gradientPng } = require('./helpers');
const { makeHttp } = require('../server/adapters/http');
const { createPrintify, CATALOG_RPS } = require('../server/adapters/pod/printify');

const TOKEN = 'pfy-token-0123456789abcdef';
const creds = { get: () => TOKEN, has: () => true };
const VARIANTS = [
  { id: 101, title: 'S', options: { size: 'S' }, placeholders: [{ position: 'front', width: 4500, height: 5400 }] },
  { id: 102, title: 'M', options: { size: 'M' }, placeholders: [{ position: 'front', width: 4500, height: 5400 }] },
];
const PRODUCT = (cost = 1337) => ({
  id: 'prod_abc', variants: [{ id: 101, title: 'S', cost, price: 2500, is_enabled: true }, { id: 102, title: 'M', cost: cost + 100, price: 2500, is_enabled: true }],
  images: [{ src: 'https://images.example/mock-front.png', variant_ids: [101, 102], position: 'front', is_default: true }, { src: 'https://images.example/mock-back.png', variant_ids: [101], position: 'back', is_default: false }],
});
/** A tiny fake Printify. `inStock` is the default list, out-of-stock appears only with show-out-of-stock. */
function fakePrintify({ shops = [{ id: 7, title: 'Shop', sales_channel: 'etsy' }], inStock = [101, 102], status = {} } = {}) {
  return fakeFetch((url, init) => {
    const u = new URL(url); const p = u.pathname.replace('/v1', ''); const m = init.method || 'GET';
    if (status[p]) return { status: status[p], body: { error: 'x' } };
    if (p === '/shops.json') return { body: shops };
    if (p === '/catalog/blueprints.json') return { body: [{ id: 6, title: 'Unisex Tee', brand: 'B', images: [] }] };
    if (/\/print_providers\.json$/.test(p)) return { body: [{ id: 29, title: 'Provider', decoration_methods: ['dtg'] }] };
    if (/\/variants\.json$/.test(p)) {
      const all = u.searchParams.get('show-out-of-stock') === '1';
      return { body: { id: 29, title: 'Provider', variants: VARIANTS.filter(v => all || inStock.includes(v.id)) } };
    }
    if (p === '/uploads/images.json' && m === 'POST') return { body: { id: 'img_1', width: 4500, height: 5400 } };
    if (p === '/shops/7/products.json' && m === 'POST') return { body: { id: 'prod_abc', variants: [], images: [] } };
    if (p === '/shops/7/products/prod_abc.json') return { body: PRODUCT() };
    return { status: 404, body: { error: 'nope ' + p } };
  });
}
const mk = (f, env = {}) => createPrintify({ http: fakeHttp(f), credentials: creds, env });

test('reads: paths, Bearer auth + User-Agent, numeric ids only; variants carry print-area pixels but no cost', async () => {
  const f = fakePrintify(); const a = mk(f);
  assert.deepEqual(await a.listBlueprints(), [{ id: 6, title: 'Unisex Tee', brand: 'B' }]);
  assert.equal((await a.listPrintProviders(6))[0].id, 29);
  const v = await a.listVariants(6, 29);
  assert.deepEqual(v.variants[0].placeholders, [{ position: 'front', width: 4500, height: 5400 }]);
  assert.equal(v.variants[0].costCents, null, 'the catalog does not expose a base cost');
  assert.ok(f.calls.every(c => c.headers.Authorization === `Bearer ${TOKEN}` && c.headers['User-Agent'] === 'octopus-ecom'));
  assert.ok(f.calls.every(c => c.url.startsWith('https://api.printify.com/v1/')));
  await assert.rejects(a.listPrintProviders('stub-tee'), /not a Printify numeric id/);
});

test('getAvailability: a variant missing from the default list but present with show-out-of-stock is out of stock', async () => {
  const a = mk(fakePrintify({ inStock: [101] }));
  const av = await a.getAvailability(6, 29);
  assert.deepEqual(av.variants.map(v => [v.id, v.inStock]), [[101, true], [102, false]]);
});

test('getVariantCosts: catalog says costs are unavailable; a real product id gives the read-only variant cost', async () => {
  const a = mk(fakePrintify());
  const cat = await a.getVariantCosts(6, 29);
  assert.equal(cat.costsAvailable, false); assert.ok(cat.variants.every(v => v.costCents === null));
  const prod = await a.getVariantCosts(6, 29, { externalId: 'prod_abc' });
  assert.equal(prod.costsAvailable, true); assert.deepEqual(prod.variants.map(v => v.costCents), [1337, 1437]);
});

test('shop resolution: one shop is used, several need PRINTIFY_SHOP_ID, none is an explicit error', async () => {
  await assert.rejects(mk(fakePrintify({ shops: [] })).getMockups('prod_abc'), /no shop/);
  await assert.rejects(mk(fakePrintify({ shops: [{ id: 7, title: 'A' }, { id: 8, title: 'B' }] })).getMockups('prod_abc'), /PRINTIFY_SHOP_ID/);
  const m = await mk(fakePrintify({ shops: [{ id: 7, title: 'A' }, { id: 8, title: 'B' }] }), { PRINTIFY_SHOP_ID: '7' }).getMockups('prod_abc');
  assert.deepEqual(m.map(x => x.placement), ['front', 'back']); assert.equal(m[0].isDefault, true);
});

function designFile(w = 40, h = 48) { const dir = tmpDir(); const file = path.join(dir, 'd.png'); fs.writeFileSync(file, gradientPng(w, h)); return file; }

test('upload: base64 contents in the body; over the limit fails clearly WITHOUT calling the API and without downscaling', async () => {
  const f = fakePrintify(); const file = designFile();
  const ok = await mk(f).uploadImage({ file, fileName: 'x.png' });
  assert.equal(ok.id, 'img_1');
  const up = f.calls.find(c => c.url.endsWith('/uploads/images.json'));
  assert.equal(up.method, 'POST'); assert.equal(Buffer.from(up.body.contents, 'base64').equals(fs.readFileSync(file)), true);
  const f2 = fakePrintify();
  await assert.rejects(mk(f2, { PRINTIFY_MAX_UPLOAD_BYTES: '100' }).uploadImage({ file, fileName: 'x.png' }), e => e.code === 'too_large' && /NOT downscaled/.test(e.message));
  assert.equal(f2.calls.length, 0, 'nothing was sent');
  const f3 = fakePrintify({ status: { '/uploads/images.json': 413 } });
  await assert.rejects(mk(f3).uploadImage({ file, fileName: 'x.png' }), e => e.code === 'too_large' && /HTTP 413/.test(e.message));
});

test('createProduct: upload, then product body with print_areas/placeholders, then base cost + mockups read back', async () => {
  const f = fakePrintify(); const file = designFile();
  const r = await mk(f).createProduct({ blueprintId: 6, providerId: 29, variantIds: [101, 102], listPriceCents: 2500, title: 'T', description: 'D', imagePath: file, imageWidth: 40, imageHeight: 48, placeholder: { width: 4500, height: 5400 } });
  assert.equal(r.externalId, 'prod_abc'); assert.equal(r.faked, false);
  assert.equal(r.baseCostCents, 1437, 'max over the chosen variants'); assert.equal(r.mockups.length, 2);
  const post = f.calls.find(c => c.url.endsWith('/shops/7/products.json'));
  assert.equal(post.body.blueprint_id, 6); assert.equal(post.body.print_provider_id, 29);
  assert.deepEqual(post.body.variants, [{ id: 101, price: 2500, is_enabled: true }, { id: 102, price: 2500, is_enabled: true }]);
  const ph = post.body.print_areas[0].placeholders[0];
  assert.equal(ph.position, 'front'); assert.deepEqual(ph.images[0], { id: 'img_1', x: 0.5, y: 0.5, scale: 1, angle: 0 });
  await assert.rejects(mk(fakePrintify()).createProduct({ blueprintId: 6, providerId: 29, variantIds: [101], listPriceCents: 0, imagePath: file }), /list price/);
  await assert.rejects(mk(f).publish(), /real Printify product id/);
});

test('catalog calls are paced under the documented 100/min (CATALOG_RPS), not the 600/min global', async () => {
  assert.ok(CATALOG_RPS * 60 <= 100);
  let t = 0; const sleeps = [];
  const http = makeHttp({ fetchImpl: fakePrintify(), sleep: async ms => { sleeps.push(ms); t += ms; }, now: () => t, random: () => 0.5 });
  const a = createPrintify({ http, credentials: creds });
  for (let bp = 1; bp <= 9; bp++) await a.listPrintProviders(bp); // 9 distinct URLs: no cache hits
  assert.ok(sleeps.length >= 4, 'burst of 5 then it waits');
  assert.ok(sleeps.every(ms => ms >= 600), `waits are ~1/${CATALOG_RPS}s: ${sleeps}`);
});

test('429 from Printify is retried honouring Retry-After (http.js), then succeeds', async () => {
  let n = 0; const slept = [];
  const f = fakeFetch(() => (++n === 1 ? { status: 429, body: {}, headers: { 'retry-after': '2' } } : { body: [{ id: 6, title: 'T' }] }));
  const http = makeHttp({ fetchImpl: f, sleep: async ms => slept.push(ms), random: () => 0.5 });
  assert.equal((await createPrintify({ http, credentials: creds }).listBlueprints()).length, 1);
  assert.deepEqual(slept, [2000]);
});

// ---- pipeline over the real adapter ---------------------------------------------------------------
async function liveDeps(env) {
  const f = fakePrintify();
  const d = makeDeps({ PRINTIFY_API_TOKEN: TOKEN, PRINTIFY_SHOP_ID: '7', ...env }, { http: fakeHttp(f) });
  return { d, f };
}

test('DRY_RUN + token: catalog READS are real, the product create is FAKED, cost is a flagged estimate, no POST goes out', async () => {
  const { d, f } = await liveDeps({});
  const p = d.pipeline.create({ brief: 'a fox', listPrice: 25, blueprint: '6', printProviderId: '29' });
  const sel = await d.pipeline.selectPod(p.id, { blueprint: '6', providerId: '29', variantIds: [101] });
  assert.deepEqual(JSON.parse(sel.print_spec).positions, [{ position: 'front', width: 4500, height: 5400 }]);
  assert.equal(JSON.parse(sel.print_spec).source, 'printify');
  await d.pipeline.generateDesign(p.id);
  const out = await d.pipeline.createPodProduct(p.id);
  assert.equal(out.stage, 'mockup_ready'); assert.match(out.pod_external_id, /^stub-prod-/);
  assert.equal(out.pod_cost_source, 'estimate');
  assert.ok(JSON.parse(out.flags).some(x => x.code === 'pod_cost_estimated'));
  assert.ok(f.calls.some(c => c.method === 'GET' && c.url.includes('/variants.json')), 'real read');
  assert.ok(!f.calls.some(c => c.method === 'POST'), 'no write left the process');
});

test('live (DRY_RUN off) + token: product created on Printify, base cost read back as printify_product, no estimate flag, no cost row', async () => {
  const { d, f } = await liveDeps({ DRY_RUN: 'false' });
  const p = d.pipeline.create({ brief: 'a fox', listPrice: 25 });
  await d.pipeline.selectPod(p.id, { blueprint: '6', providerId: '29', variantIds: [101, 102] });
  await d.pipeline.generateDesign(p.id);
  const out = await d.pipeline.createPodProduct(p.id);
  assert.equal(out.pod_external_id, 'prod_abc'); assert.equal(out.pod_cost_source, 'printify_product'); assert.equal(out.pod_base_cost_cents, 1437);
  assert.deepEqual(JSON.parse(out.flags), []);
  const det = d.pipeline.detail(p.id);
  assert.deepEqual(det.mockups.map(m => m.url), ['https://images.example/mock-front.png', 'https://images.example/mock-back.png']);
  assert.equal(det.costs.filter(c => c.kind === 'pod').length, 0, 'base cost is COGS on sale, not spend at draft time');
  assert.equal(d.spend.summary().spend.totalCents, 0);
  assert.ok(f.calls.some(c => c.url.endsWith('/uploads/images.json')));
});

test('a design over the upload limit moves the product to failed with a clear reason (no silent downscale)', async () => {
  const { d } = await liveDeps({ DRY_RUN: 'false', PRINTIFY_MAX_UPLOAD_BYTES: '50' });
  const p = d.pipeline.create({ brief: 'x', listPrice: 25 });
  await d.pipeline.selectPod(p.id, { blueprint: '6', providerId: '29' });
  await d.pipeline.generateDesign(p.id);
  await assert.rejects(d.pipeline.createPodProduct(p.id), e => e.status === 502 && /NOT downscaled/.test(e.message));
  assert.equal(d.stages.get(p.id).stage, 'failed');
});

test('supplier watcher reads REAL Printify data when a token exists (fake fetch): cost from the product, availability from the catalog', async () => {
  const f = fakePrintify({ inStock: [101] });
  const d = makeDeps({ PRINTIFY_API_TOKEN: TOKEN, PRINTIFY_SHOP_ID: '7' }, { http: fakeHttp(f) });
  const t = new Date().toISOString();
  const id = Number(d.db.prepare(`INSERT INTO products(stage,title,blueprint,print_provider_id,list_price_cents,shipping_cents,pod_base_cost_cents,pod_external_id,pod_variant_ids,pod_cost_source,created_at,updated_at)
    VALUES('listing_drafted','Fox tee','6','29',1800,0,1000,'prod_abc','[101,102]','printify_product',?,?)`).run(t, t).lastInsertRowid);
  const r = await d.watch.runAll({ trigger: 'manual', only: ['supplier'] });
  assert.match(r.runs[0].summary, /\[source: adapter\]/);
  const p = d.db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  assert.equal(p.pod_base_cost_cents, 1437, 'max over the chosen variants, from the product read-back');
  assert.ok(JSON.parse(p.flags).some(x => x.code === 'margin_non_positive' || x.code === 'margin_below_floor'));
  assert.ok(d.db.prepare('SELECT 1 FROM alerts WHERE kind = ?').get('out_of_stock'), 'variant 102 is missing from the in-stock list');
  assert.ok(f.calls.some(c => c.url.endsWith('/products/prod_abc.json')));
});

test('supplier watcher never lets stub figures overwrite a real Printify cost', async () => {
  const d = makeDeps(); // no token: the watcher reads the stub
  const t = new Date().toISOString();
  const id = Number(d.db.prepare(`INSERT INTO products(stage,title,blueprint,print_provider_id,list_price_cents,shipping_cents,pod_base_cost_cents,pod_variant_ids,pod_cost_source,created_at,updated_at)
    VALUES('listing_drafted','x','stub-tee','stub-pp',2500,0,1437,'[]','printify_product',?,?)`).run(t, t).lastInsertRowid);
  await d.watch.runAll({ trigger: 'manual', only: ['supplier'] });
  assert.equal(d.db.prepare('SELECT pod_base_cost_cents c FROM products WHERE id = ?').get(id).c, 1437);
});
