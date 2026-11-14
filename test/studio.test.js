'use strict';
// Studio: keep unmarked pixels, refuse an empty mask before spend, start a sticker from the saved PNG.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeDeps, gradientPng, fakeFetch, fakeHttp } = require('./helpers');
const { compositeKeep, inspectPicture } = require('../server/studio');
const { decodePng, encodePng, solidPng } = require('../server/png');
const { approvalSummary } = require('../server/domain/stages');
const { buildApp } = require('../server/app');

function rgb(w, h, color) {
  const pixels = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) { pixels[i * 3] = color[0]; pixels[i * 3 + 1] = color[1]; pixels[i * 3 + 2] = color[2]; }
  return encodePng({ width: w, height: h, channels: 3, pixels });
}
function maskOf(w, h, paint) {
  const pixels = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!paint(x, y)) continue;
    const o = (y * w + x) * 3;
    pixels[o] = pixels[o + 1] = pixels[o + 2] = 255;
  }
  return encodePng({ width: w, height: h, channels: 3, pixels });
}
const at = (img, x, y) => { const o = (y * img.width + x) * img.channels; return [img.pixels[o], img.pixels[o + 1], img.pixels[o + 2]]; };

test('compositeKeep with feather 0 copies unmarked pixels and replaces marked ones', () => {
  const w = 20; const h = 12;
  const original = gradientPng(w, h);
  const edited = rgb(w, h, [220, 30, 30]);
  const mask = maskOf(w, h, (x) => x < 10);
  const out = decodePng(compositeKeep(original, edited, mask, { feather: 0 }).png);
  const orig = decodePng(original);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const got = at(out, x, y);
    if (x < 10) assert.deepEqual(got, [220, 30, 30], `${x},${y}`);
    else assert.deepEqual(got, at(orig, x, y), `${x},${y}`);
  }
});

test('compositeKeep feathers the seam and resizes a different edit', () => {
  const w = 20; const h = 8;
  const original = gradientPng(w, h);
  const edited = rgb(4, 4, [10, 20, 30]);
  const mask = maskOf(w, h, (x) => x < 8);
  const out = decodePng(compositeKeep(original, edited, mask).png);
  const orig = decodePng(original);
  assert.deepEqual(at(out, 0, 4), [10, 20, 30]);
  assert.deepEqual(at(out, 19, 4), at(orig, 19, 4));
  assert.notDeepEqual(at(out, 8, 4), at(orig, 8, 4));
});

test('a flat or black picture is flagged and a drawing is not', () => {
  const flat = inspectPicture(rgb(24, 16, [10, 20, 30]));
  assert.equal(flat.issues[0].code, 'picture_flat');
  const black = inspectPicture(rgb(24, 16, [0, 0, 0]));
  assert.equal(black.issues[0].code, 'picture_blank');
  const drawing = inspectPicture(gradientPng(24, 16));
  assert.deepEqual(drawing.issues, []);
  const block = inspectPicture(solidPng(24, 16));
  assert.equal(block.skipped, true);
  const summary = approvalSummary({ id: 3, flags: JSON.stringify([{ code: 'picture_flat', detail: 'almost one flat colour' }]) });
  assert.match(summary, /PICTURE CHECK: almost one flat colour/);
});

test('compositeKeep rejects an empty mask and a size mismatch', () => {
  const original = gradientPng(8, 6);
  const edited = rgb(8, 6, [1, 2, 3]);
  assert.throws(() => compositeKeep(original, edited, maskOf(8, 6, () => false), { feather: 0 }), /empty/);
  assert.throws(() => compositeKeep(original, edited, maskOf(4, 6, () => true), { feather: 0 }), /size/);
});

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
const raw = async (url, buf, type = 'image/png') => {
  const r = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': type }, body: buf });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const spent = (id) => d.db.prepare('SELECT COALESCE(SUM(amount_cents),0) v FROM costs WHERE product_id = ?').get(id).v;
async function product() {
  const c = await j('POST', '/api/products', { brief: 'a fox in a scarf', niche: 'cozy', keywords: ['fox'], listPrice: 24, shipping: 3, blueprint: 'stub-tee', printProviderId: 'stub-pp' });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  return c.body.product.id;
}

test('a vary line aims the next picture and leaves the brief, and a flat file is flagged', async () => {
  const id = await product();
  const varied = await j('POST', `/api/products/${id}/generate-design`, { vary: 'yellow hard hat' });
  assert.equal(varied.status, 200, JSON.stringify(varied.body));
  assert.equal(d.pipeline.need(id).brief, 'a fox in a scarf');
  const row = d.db.prepare('SELECT prompt FROM designs WHERE product_id = ? ORDER BY id DESC LIMIT 1').get(id);
  assert.match(row.prompt, /yellow hard hat/);
  assert.match(row.prompt, /fox in a scarf/);
  const note = d.db.prepare("SELECT note FROM events WHERE product_id = ? AND note LIKE '%seed %' ORDER BY id DESC LIMIT 1").get(id);
  assert.match(note.note, /seed \d+/);
  const flat = await raw(`/api/products/${id}/upload-design`, rgb(32, 24, [8, 8, 8]));
  assert.equal(flat.status, 200, JSON.stringify(flat.body));
  const flagged = d.pipeline.detail(id).product.flags.find((f) => f.code === 'picture_blank');
  assert.ok(flagged, JSON.stringify(d.pipeline.detail(id).product.flags));
  assert.equal((await raw(`/api/products/${id}/upload-design`, gradientPng(32, 24))).status, 200);
  assert.equal(d.pipeline.detail(id).product.flags.some((f) => f.code === 'picture_blank' || f.code === 'picture_flat'), false);
});

test('an uploaded PNG is the text-and-sticker save and spends nothing', async () => {
  const id = await product();
  const r = await raw(`/api/products/${id}/upload-design`, gradientPng(32, 24));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = d.db.prepare('SELECT source, model, cost_cents FROM designs WHERE product_id = ?').get(id);
  assert.equal(row.source, 'manual');
  assert.equal(row.model, 'manual');
  assert.equal(row.cost_cents, 0);
  assert.equal(spent(id), 0);
});

test('redraw keeps unmarked pixels, rejects an empty or huge mask before spend, and a sticker copies the file', async () => {
  const id = await product();
  const png = gradientPng(32, 24);
  assert.equal((await raw(`/api/products/${id}/upload-design`, png)).status, 200);
  const empty = await raw(`/api/products/${id}/redraw?prompt=${encodeURIComponent('fix the tail please')}`, maskOf(32, 24, () => false));
  assert.equal(empty.status, 400);
  assert.equal(empty.body.code, 'empty_mask');
  assert.equal(spent(id), 0);
  assert.equal(d.pipeline.need(id).stage, 'design_generated');
  assert.equal(d.db.prepare('SELECT COUNT(*) n FROM designs WHERE product_id = ?').get(id).n, 1);

  const huge = await d.pipeline.redrawRegion(id, maskOf(32, 24, () => true), { prompt: 'fix the tail please' }).then(() => null, (e) => e);
  assert.equal(huge.code, 'mask_too_large');
  assert.match(huge.message, /Regenerate/);
  assert.equal(spent(id), 0);
  assert.equal(d.db.prepare('SELECT COUNT(*) n FROM designs WHERE product_id = ?').get(id).n, 1);

  const short = await d.pipeline.redrawRegion(id, maskOf(32, 24, (x) => x < 16), { prompt: 'nope' }).then(() => null, (e) => e);
  assert.equal(short.code, 'bad_prompt');
  assert.equal(spent(id), 0);

  let seen = '';
  const origEdit = d.adapters.imagegen.edit;
  d.adapters.imagegen.edit = async (prompt, opts) => { seen = prompt; return origEdit(prompt, opts); };
  let out;
  try {
    out = await d.pipeline.redrawRegion(id, maskOf(32, 24, (x) => x < 16), { prompt: 'fix the tail please', feather: 0 });
  } finally { d.adapters.imagegen.edit = origEdit; }
  assert.match(seen, /fix the tail please/);
  assert.match(seen, /unchanged/);
  assert.equal(out.stage, 'design_generated');
  const row = d.db.prepare('SELECT * FROM designs WHERE product_id = ? ORDER BY id DESC LIMIT 1').get(id);
  assert.equal(row.source, 'redraw');
  assert.equal(row.model, 'stub-edit');
  assert.equal(row.cost_cents, 0);
  assert.equal(row.prompt, 'fix the tail please');
  assert.equal(spent(id), 0);
  const got = decodePng(fs.readFileSync(path.join(d.dataDir, 'images', row.image_path)));
  const orig = decodePng(png);
  for (let y = 0; y < 24; y++) for (let x = 0; x < 32; x++) {
    const px = at(got, x, y);
    if (x < 16) assert.deepEqual(px, [220, 30, 30], `${x},${y}`);
    else assert.deepEqual(px, at(orig, x, y), `${x},${y}`);
  }

  const tee = await d.pipeline.startSticker(id, { blueprint: 'stub-tee' }).then(() => null, (e) => e);
  assert.equal(tee.code, 'not_sticker');

  const sticker = await d.pipeline.startSticker(id);
  assert.equal(sticker.blueprintTitle, 'Kiss-cut Sticker (stub)');
  assert.equal(sticker.product.blueprint, 'stub-sticker');
  assert.equal(sticker.product.print_provider_id, 'stub-pp');
  assert.equal(sticker.product.stage, 'design_generated');
  assert.equal(sticker.product.brief, 'a fox in a scarf');
  assert.equal(sticker.product.list_price_cents, 2400);
  assert.equal(sticker.product.shipping_cents, 300);
  assert.deepEqual(JSON.parse(sticker.product.keywords), ['fox']);
  const child = d.db.prepare('SELECT source, model, cost_cents, width, height FROM designs WHERE product_id = ?').get(sticker.product.id);
  assert.equal(child.source, 'manual');
  assert.equal(child.model, 'manual');
  assert.equal(child.cost_cents, 0);
  assert.equal(child.width, 32);
  assert.equal(child.height, 24);
  assert.equal(spent(sticker.product.id), 0);
  assert.equal(d.pipeline.need(id).blueprint, 'stub-tee');
});

test('a provider other than Nous refuses the redraw and does not call the gateway', async () => {
  const f = fakeFetch(() => { throw new Error('should not be called'); });
  const local = makeDeps({ IMAGE_UPSCALE: 'off' }, { http: fakeHttp(f) });
  const p = local.pipeline.create({ brief: 'a fox in a scarf', listPrice: 20, blueprint: 'stub-tee', printProviderId: 'stub-pp' });
  await local.pipeline.attachDesign(p.id, gradientPng(16, 12));
  local.settings.set('image_provider', 'gemini');
  const err = await local.pipeline.redrawRegion(p.id, maskOf(16, 12, (x) => x < 4), { prompt: 'fix the tail please' }).then(() => null, (e) => e);
  assert.equal(err.code, 'edit_unsupported');
  assert.match(err.message, /Nous Portal/);
  assert.equal(local.pipeline.need(p.id).stage, 'design_generated');
  assert.equal(f.calls.length, 0);
  await assert.rejects(() => local.adapters.imagegen.edit('fix the tail please', { png: gradientPng(8, 8) }), /Nous Portal/);
  assert.equal(f.calls.length, 0);
});

test('redraw and sticker routes: no design, and the HTTP sticker response', async () => {
  const bare = await product();
  const missing = await raw(`/api/products/${bare}/redraw?prompt=${encodeURIComponent('fix the tail please')}`, maskOf(8, 8, () => true));
  assert.equal(missing.status, 409);
  assert.equal(missing.body.code, 'no_design');
  const id = await product();
  assert.equal((await raw(`/api/products/${id}/upload-design`, gradientPng(16, 12))).status, 200);
  const sticker = await j('POST', `/api/products/${id}/sticker`, {});
  assert.equal(sticker.status, 201, JSON.stringify(sticker.body));
  assert.equal(sticker.body.product.blueprint, 'stub-sticker');
  assert.equal(sticker.body.product.stage, 'design_generated');
  assert.equal(spent(sticker.body.product.id), 0);
});
