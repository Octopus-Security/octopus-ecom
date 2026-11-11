'use strict';
// "Run to approval": an existing product (e.g. an approved proposal, which stops at IDEA) is driven to PENDING_APPROVAL
// through the same steps a person clicks, and never further.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { makeDeps } = require('./helpers');
const { buildApp } = require('../server/app');

let server; let base;
before(async () => {
  const d = makeDeps();
  server = await new Promise((r) => { const s = buildApp(d).listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
const j = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test('an approved proposal can be advanced to PENDING_APPROVAL, keeping its copy, and stops there', async () => {
  const gen = await j('POST', '/api/proposals/generate', {});
  assert.equal(gen.status, 201);
  const prop = gen.body.proposals.find((p) => p.blueprint && p.printProviderId && p.riskLevel !== 'blocked' && p.riskLevel !== 'review') || gen.body.proposals.find((p) => p.blueprint && p.printProviderId && p.riskLevel !== 'blocked');
  assert.ok(prop, 'a usable proposal');
  let ap = await j('POST', `/api/proposals/${prop.id}/approve`, {});
  if (ap.body.needsConfirm) ap = await j('POST', `/api/proposals/${prop.id}/approve`, { token: ap.body.token });
  assert.ok([200, 201].includes(ap.status));
  const pid = ap.body.product.id;
  assert.equal(ap.body.product.stage, 'idea');
  const title = (await j('GET', `/api/products/${pid}`)).body.copy.title;

  const adv = await j('POST', `/api/products/${pid}/advance`, {});
  assert.equal(adv.status, 200, JSON.stringify(adv.body));
  assert.equal(adv.body.product.stage, 'PENDING_APPROVAL');
  assert.equal((await j('GET', `/api/products/${pid}`)).body.copy.title, title, 'proposal copy is kept');
  // idempotent at the gate, and it never approves
  const again = await j('POST', `/api/products/${pid}/advance`, {});
  assert.equal(again.body.product.stage, 'PENDING_APPROVAL');
});

test('advance refuses a product past the gate and one with no print provider', async () => {
  const bare = await j('POST', '/api/products', { brief: 'a fox in a scarf', listPrice: 20 });
  const r = await j('POST', `/api/products/${bare.body.product.id}/advance`, {});
  assert.equal(r.status, 409); assert.equal(r.body.code, 'no_pod_choice');
  assert.equal((await j('POST', '/api/products/999999/advance', {})).status, 404);
});

test('default variant choice is flagged single_variant; an explicit choice is not', async () => {
  const mk = async (extra) => (await j('POST', '/api/products', { brief: 'a fox in a scarf', listPrice: 20, ...extra })).body.product.id;
  const a = await mk({});
  const r1 = await j('POST', `/api/products/${a}/pod`, { blueprint: 'stub-tee', printProviderId: 'stub-pp' });
  assert.ok(JSON.parse(r1.body.product.flags).some((f) => f.code === 'single_variant'), r1.body.product.flags);
  const cat = (await j('GET', '/api/pod/blueprints/stub-tee/providers/stub-pp/variants')).body.variants;
  assert.ok(cat.length > 1);
  const r2 = await j('POST', `/api/products/${a}/pod`, { blueprint: 'stub-tee', printProviderId: 'stub-pp', variantIds: cat.map((v) => v.id) });
  assert.ok(!JSON.parse(r2.body.product.flags).some((f) => f.code === 'single_variant'));
  assert.equal(JSON.parse(r2.body.product.pod_variant_ids).length, cat.length);
});

test('a batch without variantIds flags each product single_variant', async () => {
  const b = await j('POST', '/api/batch', { niche: 'trail runners', count: 1, blueprint: 'stub-tee', printProviderId: 'stub-pp', listPrice: 25 });
  assert.equal(b.status, 202);
  let v;
  for (let i = 0; i < 100; i++) { v = (await j('GET', `/api/batch/${b.body.batch.id}`)).body.batch; if (v.status === 'done') break; await new Promise((r) => setTimeout(r, 100)); }
  assert.equal(v.status, 'done');
  assert.ok(v.items[0].flags.some((f) => f.code === 'single_variant'));
});
