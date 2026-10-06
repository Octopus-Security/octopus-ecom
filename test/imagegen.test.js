'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeDeps, tmpDir, gradientPng, fakeFetch, fakeHttp } = require('./helpers');
const { createOpenAiImages } = require('../server/adapters/imagegen/openai');
const { pickSize, imageCostCents } = require('../server/adapters/imagegen/pricing');
const { makeSpend, SpendCapError } = require('../server/spend');
const { readPngSize, decodePng, encodePng } = require('../server/png');
const { bilinearUpscale } = require('../server/upscale');

const KEY = 'sk-test-' + 'A'.repeat(30);
const creds = { get: () => KEY, has: () => true };
const ok = png => ({ body: { data: [{ b64_json: png.toString('base64') }] } });

function make({ upscale, spend, fetchImpl, model, quality } = {}) {
  const f = fetchImpl || fakeFetch(() => ok(gradientPng(8, 12)));
  const dataDir = tmpDir();
  return { f, dataDir, a: createOpenAiImages({ http: fakeHttp(f), credentials: creds, dataDir, spend, upscale, model, quality, log: { warn() {}, info() {} } }) };
}

test('price table: sizes and costs (rounded up to whole cents)', () => {
  assert.equal(pickSize('gpt-image-1', 4500, 5400), '1024x1536');
  assert.equal(pickSize('gpt-image-1', 5400, 4500), '1536x1024');
  assert.equal(pickSize('gpt-image-1', 100, 100), '1024x1024');
  assert.equal(imageCostCents('gpt-image-1', 'high', '1024x1536'), 25);
  assert.equal(imageCostCents('gpt-image-1', 'medium', '1024x1536', 2), 13); // 12.6c -> 13
  assert.equal(imageCostCents('gpt-image-1', 'low', '1024x1024'), 2);        // 1.1c -> 2
  assert.throws(() => imageCostCents('gpt-image-1', 'ultra', '1024x1024'), /refusing to spend blindly/);
  assert.throws(() => pickSize('mystery-model', 1, 1), /refusing to spend blindly/);
});

test('real request shape: POST, bearer key, model/size/quality/n/output_format; b64 decoded; cost from table', async () => {
  const { f, a, dataDir } = make({ upscale: null });
  const out = await a.generate('a fox', { width: 4500, height: 5400, count: 1, quality: 'high' });
  assert.equal(f.calls.length, 1);
  const c = f.calls[0];
  assert.equal(c.url, 'https://api.openai.com/v1/images/generations');
  assert.equal(c.method, 'POST');
  assert.equal(c.headers.Authorization, `Bearer ${KEY}`);
  assert.deepEqual(c.body, { model: 'gpt-image-1', prompt: 'a fox', size: '1024x1536', quality: 'high', n: 1, output_format: 'png' });
  assert.equal(out.costCents, 25); assert.equal(out.model, 'gpt-image-1');
  const img = out.images[0];
  const buf = fs.readFileSync(path.join(dataDir, 'images', img.file));
  assert.deepEqual(readPngSize(buf), { width: 8, height: 12 });
  assert.equal(img.width, 8); assert.equal(img.upscaled, false); assert.equal(img.nativeWidth, 8);
});

test('upscale hook: real stored size is reported honestly (fits inside target, keeps aspect)', async () => {
  const { a, dataDir } = make({ upscale: bilinearUpscale });
  const out = await a.generate('x', { width: 40, height: 60 });
  const img = out.images[0];
  assert.equal(img.upscaled, true);
  assert.deepEqual(readPngSize(fs.readFileSync(path.join(dataDir, 'images', img.file))), { width: img.width, height: img.height });
  assert.deepEqual([img.width, img.height], [40, 60]);
  assert.deepEqual([img.nativeWidth, img.nativeHeight], [8, 12]);
  assert.match(img.upscaleMethod, /bilinear/);
  // target aspect differs from the image: it fits inside, it does not stretch
  const b = await bilinearUpscale({ png: gradientPng(8, 12), targetWidth: 100, targetHeight: 100 });
  assert.deepEqual([b.width, b.height], [67, 100]);
});

test('an upscale hook that lies about its size is not believed; one that throws keeps native size', async () => {
  const liar = async ({ png }) => ({ png, width: 4500, height: 5400, method: 'liar' });
  const out = await make({ upscale: liar }).a.generate('x', { width: 40, height: 60 });
  assert.deepEqual([out.images[0].width, out.images[0].height], [8, 12]);
  const boom = async () => { throw new Error('gpu on fire'); };
  const o2 = await make({ upscale: boom }).a.generate('x', { width: 40, height: 60 });
  assert.deepEqual([o2.images[0].width, o2.images[0].height], [8, 12]);
  assert.match(o2.images[0].upscaleMethod, /upscale failed.*gpu on fire/);
  assert.equal(o2.images[0].upscaled, false);
});

test('daily cap refuses BEFORE any request is made', async () => {
  const d = makeDeps({ DAILY_SPEND_CAP: '0.20' });
  d.spend.addCost({ kind: 'llm', amountCents: 10 });
  const { f, a } = make({ spend: d.spend });
  await assert.rejects(a.generate('x', { quality: 'high' }), SpendCapError);
  assert.equal(f.calls.length, 0);
});

test('daily cap allows a request that fits', async () => {
  const d = makeDeps({ DAILY_SPEND_CAP: '1.00' });
  const { f, a } = make({ spend: d.spend });
  await a.generate('x', { quality: 'low', width: 1024, height: 1024 });
  assert.equal(f.calls.length, 1);
});

test('errors: 429 is retried then succeeds; 500 on a POST is not retried; bad bodies throw', async () => {
  let n = 0;
  const f = fakeFetch(() => (++n === 1 ? { status: 429, body: 'slow down', headers: { 'retry-after': '0' } } : ok(gradientPng(4, 4))));
  const out = await make({ fetchImpl: f, upscale: null }).a.generate('x', { width: 4, height: 4 });
  assert.equal(f.calls.length, 2); assert.equal(out.images.length, 1);
  const f500 = fakeFetch(() => ({ status: 500, body: 'oops' }));
  await assert.rejects(make({ fetchImpl: f500 }).a.generate('x'), /HTTP 500/);
  assert.equal(f500.calls.length, 1, 'a POST that may have been processed is never blindly retried');
  await assert.rejects(make({ fetchImpl: fakeFetch(() => ({ body: { data: [] } })) }).a.generate('x'), /no b64_json/);
  await assert.rejects(make({ fetchImpl: fakeFetch(() => ({ body: { data: [{ b64_json: Buffer.from('not a png at all, nope nope nope').toString('base64') }] } })) }).a.generate('x'), /Not a PNG/);
});

test('png codec round-trips RGB and RGBA, and decodes other filters', () => {
  const src = { width: 5, height: 4, channels: 4, pixels: Buffer.from(Array.from({ length: 80 }, (_, i) => (i * 37) & 255)) };
  const back = decodePng(encodePng(src));
  assert.equal(back.channels, 4); assert.deepEqual([...back.pixels], [...src.pixels]);
  const rgb = decodePng(gradientPng(7, 3)); assert.equal(rgb.channels, 3); assert.equal(rgb.width, 7);
  assert.throws(() => decodePng(require('../server/png').solidPng(4, 4)), /bit depth/);
});

test('imagegen routes real when a key exists (even in DRY_RUN); stub otherwise', async () => {
  const d0 = makeDeps();
  assert.equal(d0.adapters.imagegen.describe().methods.generate, 'stub');
  const f = fakeFetch(() => ok(gradientPng(8, 12)));
  const d1 = makeDeps({ OPENAI_API_KEY: KEY }, { http: fakeHttp(f), upscale: null });
  assert.equal(d1.dryRun.isOn(), true);
  assert.equal(d1.adapters.imagegen.describe().methods.generate, 'real');
  const out = await d1.adapters.imagegen.generate('x', { width: 8, height: 12 });
  assert.equal(out.costCents, 25);
});
