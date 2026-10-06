'use strict';
// M1 routes over real HTTP.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { makeDeps } = require('./helpers');
const { buildApp } = require('../server/app');
const { readPngSize } = require('../server/png');

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
let id;

test('POST /api/products validates and creates an idea', async () => {
  assert.equal((await j('POST', '/api/products', { niche: 'x' })).status, 400);
  assert.equal((await j('POST', '/api/products', { brief: 'x', listPrice: 'abc' })).status, 400);
  const r = await j('POST', '/api/products', { brief: 'a fox in a scarf', niche: 'cozy animals', keywords: ['fox', 'scarf'], listPrice: 22, blueprint: 'bella-canvas-3001' });
  assert.equal(r.status, 201); assert.equal(r.body.product.stage, 'idea'); assert.equal(r.body.product.list_price_cents, 2200);
  id = r.body.product.id;
});
test('generate-design (stub), draft-copy, then GET detail', async () => {
  const g = await j('POST', `/api/products/${id}/generate-design`, {});
  assert.equal(g.status, 200); assert.equal(g.body.product.stage, 'design_generated');
  const c = await j('POST', `/api/products/${id}/draft-copy`, {});
  assert.equal(c.status, 200); assert.ok(c.body.product.title);
  const det = (await j('GET', `/api/products/${id}`)).body;
  assert.equal(det.designs.length, 1); assert.ok(det.copy.tags.length <= 13); assert.ok(det.events.length >= 2); assert.ok(Array.isArray(det.costs));
  assert.equal(det.product.keywords.length, 2);
});
test('image route serves the PNG (authenticated route; real dimensions), 404 otherwise', async () => {
  const det = (await j('GET', `/api/products/${id}`)).body;
  const r = await fetch(base + det.designs[0].url);
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/png');
  assert.deepEqual(readPngSize(Buffer.from(await r.arrayBuffer())), { width: 4500, height: 5400 });
  assert.equal((await j('GET', '/api/images/99999')).status, 404);
  assert.equal((await j('GET', '/api/images/abc')).status, 404);
});
test('regenerate with an edited brief keeps both designs', async () => {
  const r = await j('POST', `/api/products/${id}/generate-design`, { brief: 'a fox, bolder colours' });
  assert.equal(r.body.product.brief, 'a fox, bolder colours');
  assert.equal((await j('GET', `/api/products/${id}`)).body.designs.length, 2);
});
test('PATCH copy re-enforces rules and returns repairs + blocklist hits', async () => {
  const r = await j('PATCH', `/api/products/${id}/copy`, { title: 'Disney fox '.repeat(30), tags: ['good tag', 'g'.repeat(30), 'good tag'] });
  assert.equal(r.status, 200);
  assert.ok(r.body.product.title.length <= 140); assert.deepEqual(r.body.blocklistHits, ['disney']);
  const det = (await j('GET', `/api/products/${id}`)).body;
  assert.deepEqual(det.copy.tags, ['good tag']); assert.ok(det.product.flags.some(f => f.code === 'blocklist'));
  assert.equal((await j('PATCH', '/api/products/99999/copy', { title: 'x' })).status, 404);
});
test('the board card carries thumbnail, title, model, cost, size, flags', async () => {
  const card = (await j('GET', '/api/products')).body.columns.design_generated.find(c => c.id === id);
  assert.match(card.thumbnail, /^\/api\/images\/\d+$/); assert.ok(card.title); assert.equal(card.modelUsed, 'stub-png');
  assert.equal(card.costCents, 0); assert.equal(card.designSize, '4500x5400'); assert.ok(card.flags.length);
});
test('errors: unknown product 404, illegal stage 409', async () => {
  assert.equal((await j('GET', '/api/products/99999')).status, 404);
  assert.equal((await j('POST', '/api/products/99999/generate-design', {})).status, 404);
  assert.equal((await j('POST', `/api/products/${id}/draft-copy`, {})).status, 200);
  const b = (await j('POST', '/api/products', { brief: 'y' })).body.product.id;
  assert.equal((await j('POST', `/api/products/${b}/draft-copy`, {})).status, 409);
});
test('a provider failure is a 502 with the product moved to failed; cap refusal is a 429', async () => {
  const real = d.adapters.imagegen;
  d.adapters.imagegen = { generate: async () => { throw new Error('upstream down'); } };
  const p = (await j('POST', '/api/products', { brief: 'z' })).body.product.id;
  const r = await j('POST', `/api/products/${p}/generate-design`, {});
  assert.equal(r.status, 502); assert.equal(r.body.failed, true);
  assert.equal((await j('GET', `/api/products/${p}`)).body.product.stage, 'failed');
  d.settings.set('daily_spend_cap_cents', 0);
  d.adapters.imagegen = { generate: async () => { d.spend.assertCanSpend(1); } };
  const q = (await j('POST', '/api/products', { brief: 'w' })).body.product.id;
  const r2 = await j('POST', `/api/products/${q}/generate-design`, {});
  assert.equal(r2.status, 429); assert.equal(r2.body.code, 'spend_cap');
  assert.equal((await j('GET', `/api/products/${q}`)).body.product.stage, 'idea');
  d.adapters.imagegen = real;
});
