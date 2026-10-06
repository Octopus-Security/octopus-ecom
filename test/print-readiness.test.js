'use strict';
// M4: print-readiness. The true pixel size comes from the PNG header; below the requirement the product cannot reach mockup_ready.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeDeps } = require('./helpers');
const { solidPng } = require('../server/png');
const { evaluate, readFileSize } = require('../server/domain/print-readiness');
const { loadConfig } = require('../server/config');
const { buildApp } = require('../server/app');

const TEE = { positions: [{ position: 'front', width: 4500, height: 5400 }] };
const dz = (width, height, extra = {}) => ({ width, height, ...extra });

test('rule, default (cover, 100%): both dimensions must reach the print area', () => {
  assert.equal(evaluate({ design: dz(4500, 5400), spec: TEE }).ok, true);
  assert.equal(evaluate({ design: dz(6000, 7000), spec: TEE }).ok, true, 'larger is fine');
  const short = evaluate({ design: dz(4499, 5400), spec: TEE });
  assert.equal(short.ok, false);
  assert.match(short.reason, /4499x5400px/); assert.match(short.reason, /needs 4500x5400px/); assert.match(short.reason, /cover coverage 100%|below the required 100%/);
  assert.equal(evaluate({ design: dz(1024, 1536), spec: TEE }).ok, false);
});

test('the M1 upscale case: a 1024x1536 gpt-image-1 design upscaled to 3600x5400 is REFUSED at the default, and says it was upscaled', () => {
  const r = evaluate({ design: dz(3600, 5400, { nativeWidth: 1024, nativeHeight: 1536, upscaleMethod: 'bilinear' }), spec: TEE });
  assert.equal(r.ok, false);
  assert.ok(Math.abs(r.positions[0].coverage - 0.8) < 1e-9, 'width is 80% of 4500, height is 100%: cover coverage is the smaller, 0.8');
  assert.match(r.reason, /3600x5400px/); assert.match(r.reason, /needs 4500x5400px/); assert.match(r.reason, /upscaled from native 1024x1536/);
  assert.ok(r.notes.some(n => /upscaled \(bilinear\) from its native 1024x1536/.test(n) && /adds pixels, not detail/.test(n)));
  assert.match(r.reason, /PRINT_MIN_COVERAGE/); assert.match(r.reason, /PRINT_FIT=contain/);
});

test('rule, configurable: min coverage and contain-fit are explicit, and each accepts what it says it accepts', () => {
  const up = dz(3600, 5400, { nativeWidth: 1024, nativeHeight: 1536, upscaleMethod: 'bilinear' });
  assert.equal(evaluate({ design: up, spec: TEE, minCoverage: 0.8 }).ok, true, '0.8 accepts 80%');
  assert.equal(evaluate({ design: up, spec: TEE, minCoverage: 0.81 }).ok, false);
  // contain: the limiting side (height 5400) is at full size, so the design is placed 1:1 with blank side margins
  const c = evaluate({ design: up, spec: TEE, fit: 'contain' });
  assert.equal(c.ok, true); assert.equal(c.positions[0].coverage, 1);
  assert.ok(c.notes.some(n => /blank margins \(contain-fit\)/.test(n)));
  // contain does NOT rescue a design that is small on its longest-relative side too
  assert.equal(evaluate({ design: dz(2000, 2000), spec: TEE, fit: 'contain' }).ok, false);
  assert.equal(evaluate({ design: dz(2000, 2000), spec: TEE, fit: 'contain', minCoverage: 0.4 }).ok, true);
});

test('only the position the design is placed on is decided; DPI is reported only when the spec has physical size', () => {
  const spec = { positions: [{ position: 'front', width: 4500, height: 5400, widthIn: 15, heightIn: 18 }, { position: 'back', width: 4500, height: 5400 }] };
  const r = evaluate({ design: dz(4500, 5400), spec });
  assert.equal(r.ok, true);
  assert.equal(r.positions.find(p => p.position === 'front').dpi, 300);
  assert.equal(r.positions.find(p => p.position === 'back').placed, false);
  assert.equal(evaluate({ design: dz(100, 100), spec, placedPosition: 'back' }).ok, false);
  assert.ok(evaluate({ design: dz(4500, 5400), spec: TEE }).notes.some(n => /pixel-based only/.test(n)));
});

test('unknown requirements are a refusal, not a pass', () => {
  const r = evaluate({ design: dz(9999, 9999), spec: null });
  assert.equal(r.ok, false); assert.equal(r.unknown, true); assert.match(r.reason, /unknown/);
});

test('the size is read from the file header, not from the stored metadata', () => {
  const d = makeDeps();
  const dir = path.join(d.dataDir, 'images'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'lie.png'), solidPng(1000, 1200));
  assert.deepEqual(readFileSize(path.join(dir, 'lie.png')), { width: 1000, height: 1200 });
  const p = d.pipeline.create({ brief: 'x', listPrice: 20 });
  d.db.prepare("UPDATE products SET print_spec = ? WHERE id = ?").run(JSON.stringify(TEE), p.id);
  d.db.prepare("INSERT INTO designs(product_id,image_path,prompt,width,height,created_at) VALUES(?,?,?,?,?,?)").run(p.id, 'lie.png', 'x', 4500, 5400, new Date().toISOString()); // metadata LIES
  const r = d.pipeline.checkPrint(p.id);
  assert.equal(r.ok, false); assert.deepEqual(r.positions[0].design, { width: 1000, height: 1200 }); assert.equal(r.source, 'png-header');
  assert.deepEqual(r.storedSize, { width: 4500, height: 5400 });
  // a missing or non-PNG file cannot be called ready
  d.db.prepare("UPDATE designs SET image_path = 'nope.png' WHERE product_id = ?").run(p.id);
  const gone = d.pipeline.checkPrint(p.id); assert.equal(gone.ok, false); assert.match(gone.reason, /could not read/);
});

/** A product at design_generated with a real PNG of the given true size on disk. */
async function withDesign(d, w, h, native = {}, brief = 'a fox in a scarf') {
  d.adapters.imagegen = { generate: async () => {
    const dir = path.join(d.dataDir, 'images'); fs.mkdirSync(dir, { recursive: true });
    const file = `t-${w}x${h}-${Math.random().toString(16).slice(2)}.png`; fs.writeFileSync(path.join(dir, file), solidPng(w, h));
    return { images: [{ file, width: w, height: h, ...native }], costCents: 0, model: 'fake-image' };
  }, describe() { return { methods: { generate: 'real' } }; } };
  const p = d.pipeline.create({ brief, listPrice: 30 });
  await d.pipeline.selectPod(p.id, { blueprint: 'stub-tee', providerId: 'stub-pp' });
  await d.pipeline.generateDesign(p.id);
  return p.id;
}

test('create-pod REFUSES a too-small design: clear reason, print_not_ready flag, stage unchanged, nothing sent to the POD provider', async () => {
  const d = makeDeps();
  let podCalls = 0; const real = d.adapters.pod.createProduct; d.adapters.pod.createProduct = async (...a) => { podCalls++; return real(...a); };
  const id = await withDesign(d, 3600, 5400, { nativeWidth: 1024, nativeHeight: 1536, upscaled: true, upscaleMethod: 'bilinear' });
  assert.ok(d.pipeline.detail(id).product.flags.some(f => f.code === 'print_not_ready'), 'flagged as soon as the design exists');
  await assert.rejects(d.pipeline.createPodProduct(id), e => e.status === 422 && e.code === 'print_not_ready' && /needs 4500x5400px/.test(e.message) && /upscaled from native 1024x1536/.test(e.message));
  assert.equal(podCalls, 0);
  assert.equal(d.stages.get(id).stage, 'design_generated');
  const det = d.pipeline.detail(id);
  assert.ok(det.product.flags.some(f => f.code === 'print_not_ready'));
  assert.equal(det.printReadiness.ok, false);
  assert.ok(det.events.some(e => /print-readiness refused/.test(e.note)));
  // the same product passes once the rule is relaxed (a panel override) ...
  d.settings.set('print_min_coverage', '0.8');
  assert.equal((await d.pipeline.createPodProduct(id)).stage, 'mockup_ready');
  assert.ok(!d.pipeline.detail(id).product.flags.some(f => f.code === 'print_not_ready'), 'flag cleared when it passes');
});

test('contain-fit via the panel setting accepts the narrower design; a regenerated larger design clears the flag', async () => {
  const d = makeDeps();
  const id = await withDesign(d, 3600, 5400);
  d.settings.set('print_fit', 'contain');
  assert.equal((await d.pipeline.createPodProduct(id)).stage, 'mockup_ready');
  const d2 = makeDeps();
  const id2 = await withDesign(d2, 3600, 5400);
  await assert.rejects(d2.pipeline.createPodProduct(id2), /print_not_ready|Not print-ready/);
  await withDesign(d2, 4500, 5400); // new generation on a new product; regenerate the SAME product at full size:
  d2.adapters.imagegen.generate = async () => { const f = `full-${Date.now()}.png`; fs.writeFileSync(path.join(d2.dataDir, 'images', f), solidPng(4500, 5400)); return { images: [{ file: f, width: 4500, height: 5400 }], costCents: 0, model: 'fake' }; };
  await d2.pipeline.generateDesign(id2);
  assert.ok(!d2.pipeline.detail(id2).product.flags.some(f => f.code === 'print_not_ready'));
  assert.equal((await d2.pipeline.createPodProduct(id2)).stage, 'mockup_ready');
});

test('the STUB image generator makes the requested size, so the no-key flow passes the default rule end to end', async () => {
  const d = makeDeps();
  const p = d.pipeline.create({ brief: 'a fox', listPrice: 30 });
  await d.pipeline.selectPod(p.id, { blueprint: 'stub-tee', providerId: 'stub-pp' });
  await d.pipeline.generateDesign(p.id);
  const r = d.pipeline.checkPrint(p.id);
  assert.equal(r.ok, true); assert.deepEqual(r.positions[0].design, { width: 4500, height: 5400 }); assert.equal(r.fit, 'cover'); assert.equal(r.minCoverage, 1);
  assert.equal((await d.pipeline.createPodProduct(p.id)).stage, 'mockup_ready');
  // and a mug (landscape 2475x1155) and a poster (5400x7200) too
  for (const [bp, w, h] of [['stub-mug', 2475, 1155], ['stub-poster', 5400, 7200]]) {
    const q = d.pipeline.create({ brief: `a fox on ${bp}`, listPrice: 30 });
    await d.pipeline.selectPod(q.id, { blueprint: bp, providerId: 'stub-pp' }); await d.pipeline.generateDesign(q.id);
    assert.deepEqual(d.pipeline.checkPrint(q.id).positions[0].design, { width: w, height: h });
    assert.equal((await d.pipeline.createPodProduct(q.id)).stage, 'mockup_ready');
  }
});

test('a print_not_ready flag blocks the agent from approving, like any flag', async () => {
  const d = makeDeps({ DRY_RUN: 'false' });
  const id = await withDesign(d, 3600, 5400);
  d.db.prepare("UPDATE products SET stage = 'PENDING_APPROVAL', store_id = ? WHERE id = ?").run(Number(d.db.prepare("INSERT INTO stores(platform,name,autopublish,created_at) VALUES('etsy','s',1,?)").run(new Date().toISOString()).lastInsertRowid), id);
  await assert.rejects(d.pipeline.approve(id, { actor: 'agent' }), /flagged \(print_not_ready\)/);
});

test('config: PRINT_MIN_COVERAGE and PRINT_FIT are validated and a bad value refuses to boot', () => {
  assert.equal(loadConfig({}).print.minCoverage, 1); assert.equal(loadConfig({}).print.fit, 'cover');
  assert.equal(loadConfig({ PRINT_MIN_COVERAGE: '0.8', PRINT_FIT: 'contain' }).print.minCoverage, 0.8);
  for (const bad of [{ PRINT_MIN_COVERAGE: '0' }, { PRINT_MIN_COVERAGE: '1.5' }, { PRINT_MIN_COVERAGE: 'x' }, { PRINT_FIT: 'stretch' }]) assert.throws(() => loadConfig(bad), /Refusing to boot/);
});

test('over HTTP: create-pod answers 422 print_not_ready with the readiness detail; the rule is readable and settable', async () => {
  const d = makeDeps();
  const server = await new Promise(r => { const s = buildApp(d).listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const j = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json() }; };
  try {
    const id = await withDesign(d, 2000, 2000);
    const r = await j('POST', `/api/products/${id}/create-pod`, {});
    assert.equal(r.status, 422); assert.equal(r.body.code, 'print_not_ready'); assert.equal(r.body.readiness.ok, false);
    assert.equal((await j('GET', '/api/settings')).body.print.minCoverage, 1);
    assert.equal((await j('POST', '/api/settings', { printMinCoverage: 0.1 })).body.print.minCoverage, 0.1);
    assert.equal((await j('POST', '/api/settings', { printMinCoverage: 2 })).status, 400);
    assert.equal((await j('POST', '/api/settings', { printFit: 'stretch' })).status, 400);
    assert.equal((await j('POST', `/api/products/${id}/create-pod`, {})).status, 200, 'passes at 10% coverage');
  } finally { server.close(); }
});
