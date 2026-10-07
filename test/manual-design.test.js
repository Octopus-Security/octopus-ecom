'use strict';
// Bring-your-own design: copy-prompt + upload, over real HTTP with stubs. Loads the real app and entrypoint.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeDeps, gradientPng } = require('./helpers');
const { buildApp } = require('../server/app');
const { buildAuth } = require('../server/auth');
const { designPrompt } = require('../server/domain/prompts');
const { solidPng } = require('../server/png');

let server; let base; let d;
before(async () => {
  d = makeDeps({ IMAGE_UPSCALE: 'off' });
  server = await new Promise((r) => { const s = buildApp(d).listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
const j = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const up = async (id, buf, type = 'image/png') => {
  const r = await fetch(`${base}/api/products/${id}/upload-design`, { method: 'POST', headers: { 'Content-Type': type }, body: buf });
  return { status: r.status, body: await r.json().catch(() => null) };
};
async function product(extra = {}) {
  const v = (await j('GET', '/api/pod/blueprints/stub-tee/providers/stub-pp/variants')).body.variants;
  const c = await j('POST', '/api/products', { brief: 'a fox in a scarf', niche: 'cozy', listPrice: 30, blueprint: 'stub-tee', printProviderId: 'stub-pp', variantIds: [v[0].id], ...extra });
  assert.equal(c.status, 201);
  return c.body.product.id;
}
const area = async (id) => (await j('GET', `/api/products/${id}`)).body.product.print_spec.positions[0];
const full = async (id) => { const a = await area(id); return solidPng(a.width, a.height); };

test('copy prompt: the exact pipeline prompt plus size, aspect and guard rails', async () => {
  const id = await product();
  const r = await j('GET', `/api/products/${id}/design-prompt`);
  assert.equal(r.status, 200);
  const p = d.pipeline.need(id); const a = await area(id);
  assert.equal(r.body.prompt, designPrompt(p));
  assert.equal(r.body.width, a.width); assert.equal(r.body.height, a.height);
  assert.match(r.body.aspect, /^\d+:\d+$/);
  assert.ok(r.body.text.startsWith(r.body.prompt));
  assert.match(r.body.text, new RegExp(`${a.width}x${a.height}`));
  assert.match(r.body.text, /Transparent background/); assert.match(r.body.text, /No trademarks, no characters, no brand names/);
  assert.equal((await j('GET', '/api/products/99999/design-prompt')).status, 404);
});

test('upload: a print-size PNG becomes a manual design, costs $0 and reaches the next states', async () => {
  const id = await product();
  const before = d.db.prepare('SELECT COALESCE(SUM(amount_cents),0) v FROM costs WHERE product_id = ?').get(id).v;
  const r = await up(id, await full(id));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.product.stage, 'design_generated');
  const row = d.db.prepare('SELECT * FROM designs WHERE product_id = ?').get(id);
  assert.equal(row.source, 'manual'); assert.equal(row.model, 'manual'); assert.equal(row.cost_cents, 0);
  assert.ok(fs.existsSync(path.join(d.dataDir, 'images', row.image_path)));
  assert.equal(d.db.prepare('SELECT COALESCE(SUM(amount_cents),0) v FROM costs WHERE product_id = ?').get(id).v, before);
  const det = (await j('GET', `/api/products/${id}`)).body;
  assert.equal(det.designs[0].source, 'manual');
  assert.equal(det.product.flags.some(f => f.code === 'print_not_ready'), false);
  assert.equal((await j('POST', `/api/products/${id}/create-pod`, {})).body.product.stage, 'mockup_ready');
  assert.equal((await j('POST', `/api/products/${id}/draft-listing`, {})).body.product.stage, 'listing_drafted');
  assert.equal((await j('POST', `/api/products/${id}/submit`, {})).body.product.stage, 'PENDING_APPROVAL');
  // a replacement upload from a later stage steps back to design_generated, like a regenerate
  assert.equal((await up(id, await full(id))).body.product.stage, 'design_generated');
  assert.equal(d.db.prepare('SELECT COUNT(*) n FROM designs WHERE product_id = ?').get(id).n, 2);
});

test('upload: non-images, JPEG, empty and wrong-extension bodies are refused by magic bytes', async () => {
  const id = await product();
  assert.equal((await up(id, Buffer.from('hello, not an image'), 'image/png')).status, 415);
  assert.equal((await up(id, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml')).status, 415);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
  const rj = await up(id, jpeg, 'image/jpeg');
  assert.equal(rj.status, 415); assert.equal(rj.body.code, 'jpeg_unsupported');
  assert.equal((await up(id, Buffer.alloc(0))).status, 400);
  // PNG magic but a broken body is still refused
  assert.equal((await up(id, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]))).status, 415);
  assert.equal(d.db.prepare('SELECT COUNT(*) n FROM designs WHERE product_id = ?').get(id).n, 0);
  assert.equal(d.pipeline.need(id).stage, 'idea');
});

test('upload: an oversized body is refused (413) and nothing is stored', async () => {
  const id = await product();
  const r = await up(id, Buffer.alloc(26 * 1024 * 1024, 1));
  assert.equal(r.status, 413);
  assert.equal(d.db.prepare('SELECT COUNT(*) n FROM designs WHERE product_id = ?').get(id).n, 0);
});

test('upload: unknown product 404; illegal stage 409', async () => {
  assert.equal((await up(99999, await solidPng(10, 10))).status, 404);
  const id = await product();
  d.stages.transition(id, 'rejected', { actor: 'human', note: 'x' });
  assert.equal((await up(id, solidPng(10, 10))).status, 409);
});

test('a too-small manual design is handled exactly like a too-small generated one', async () => {
  const small = gradientPng(60, 80);
  // generated: a fake image adapter that writes the same small PNG through the same fitToArea path
  const { fitToArea } = require('../server/upscale');
  const realGen = d.adapters.imagegen;
  d.adapters.imagegen = { ...realGen, generate: async (_p, { width, height }) => {
    const fit = await fitToArea({ png: small, width, height, upscale: null });
    fs.mkdirSync(path.join(d.dataDir, 'images'), { recursive: true });
    fs.writeFileSync(path.join(d.dataDir, 'images', 'gen-small.png'), fit.png);
    return { images: [{ file: 'gen-small.png', width: fit.width, height: fit.height, nativeWidth: fit.nativeWidth, nativeHeight: fit.nativeHeight, upscaled: false }], costCents: 0, model: 'fake' };
  } };
  const g = await product(); const m = await product();
  assert.equal((await j('POST', `/api/products/${g}/generate-design`, {})).status, 200);
  d.adapters.imagegen = realGen;
  assert.equal((await up(m, small)).status, 200);
  const sig = async id => { const x = (await j('GET', `/api/products/${id}`)).body; return { stage: x.product.stage, flags: x.product.flags.map(f => f.code), ok: x.printReadiness && x.printReadiness.ok, size: `${x.designs[0].width}x${x.designs[0].height}` }; };
  const sg = await sig(g); const sm = await sig(m);
  assert.deepEqual(sm, sg);
  assert.equal(sm.ok, false); assert.ok(sm.flags.includes('print_not_ready')); assert.equal(sm.stage, 'design_generated');
  const a = await j('POST', `/api/products/${m}/create-pod`, {}); const b = await j('POST', `/api/products/${g}/create-pod`, {});
  assert.equal(a.status, 422); assert.equal(a.status, b.status); assert.equal(a.body.code, b.body.code);
  assert.equal(d.pipeline.need(m).stage, 'design_generated');
});

test('with the upscale hook on, a small manual PNG is upscaled and recorded like a generated one', async () => {
  const d2 = makeDeps({}); // default IMAGE_UPSCALE: bilinear
  const s2 = await new Promise((r) => { const s = buildApp(d2).listen(0, '127.0.0.1', () => r(s)); });
  try {
    const b2 = `http://127.0.0.1:${s2.address().port}`;
    const c = await (await fetch(`${b2}/api/products`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brief: 'a fox' }) })).json();
    const r = await fetch(`${b2}/api/products/${c.product.id}/upload-design`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: gradientPng(30, 36) });
    assert.equal(r.status, 200);
    const row = d2.db.prepare('SELECT * FROM designs').get();
    assert.equal(row.native_width, 30); assert.ok(row.width > 30); assert.match(row.upscale_method, /bilinear/); assert.equal(row.source, 'manual');
  } finally { s2.close(); }
});

test('owner gate: signed-out 401 and non-owner 403 on both new routes, same as other owner-only routes', async () => {
  const cfgSso = { ...d.cfg, authMode: 'sso', owners: ['boss'] };
  const mk = (user) => buildAuth(cfgSso, { ssoFactory: () => (req, _res, next) => { if (user) req.user = user; next(); }, log: { warn() {} } });
  for (const [user, status] of [[null, 401], [{ username: 'rando' }, 403], [{ username: 'boss' }, 200]]) {
    const s = await new Promise((r) => { const x = buildApp({ ...d, auth: mk(user) }).listen(0, '127.0.0.1', () => r(x)); });
    const b = `http://127.0.0.1:${s.address().port}`;
    try {
      const id = d.pipeline.create({ brief: 'owner gate' }).id;
      const g = await fetch(`${b}/api/products/${id}/design-prompt`);
      const u = await fetch(`${b}/api/products/${id}/upload-design`, { method: 'POST', headers: { 'Content-Type': 'image/png', Origin: b }, body: solidPng(10, 10) });
      const other = await fetch(`${b}/api/products/${id}/draft-copy`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: b }, body: '{}' });
      assert.equal(g.status, status, JSON.stringify(user));
      if (status === 200) assert.equal(u.status, 200); else { assert.equal(u.status, status); assert.equal(u.status, other.status); }
    } finally { s.close(); }
  }
});

test('the real entrypoint still loads with the new routes (no listen on require)', () => {
  const ep = require('../server/index.js');
  assert.ok(ep);
});
