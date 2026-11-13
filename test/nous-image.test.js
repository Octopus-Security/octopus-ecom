'use strict';
// Nous image gateway, fake HTTP only. Nothing here contacts fal-queue-gateway.nousresearch.com.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeDeps, tmpDir, gradientPng, fakeFetch, fakeHttp, quiet, portalJwt } = require('./helpers');
const { createNousImages, printSize, DEFAULT_MODEL } = require('../server/adapters/imagegen/nous');
const { SpendCapError } = require('../server/spend');
const { readPngSize } = require('../server/png');

const png = () => gradientPng(8, 12);
const TOKEN = portalJwt();
const creds = (key) => ({ get: (name) => (name === 'nous' ? key : ''), has: (name) => name === 'nous' && Boolean(key) });

function responder(bytes, opt = {}) {
  const imageUrl = opt.imageUrl || 'https://v3.fal.media/files/x.png';
  const requestId = opt.requestId || 'req_ok1';
  return (url) => {
    const u = String(url);
    if (u.includes('fal.media')) return { status: opt.imageStatus || 200, body: bytes };
    if (u.endsWith('/status')) return { body: { status: opt.poll || 'COMPLETED' } };
    if (u.includes('/requests/')) return { body: { images: [{ url: imageUrl }] } };
    const status = opt.submitStatus || 200;
    return {
      status,
      body: status >= 400 ? (opt.submitBody || 'refused') : {
        request_id: requestId,
        ...(opt.statusUrl ? { status_url: opt.statusUrl } : {}),
        ...(opt.responseUrl ? { response_url: opt.responseUrl } : {}),
      },
    };
  };
}

function adapter(bytes, opt = {}) {
  const f = fakeFetch(opt.fetch || responder(bytes, opt));
  const dataDir = opt.dataDir || tmpDir();
  const a = createNousImages({
    http: fakeHttp(f), credentials: creds(opt.key === undefined ? TOKEN : opt.key),
    dataDir, upscale: null, log: quiet, spend: opt.spend, model: opt.model || DEFAULT_MODEL,
    sleep: async () => {}, maxPolls: opt.maxPolls || 40,
  });
  return { f, a, dataDir };
}

test('print size snaps the short side and keeps aspect', () => {
  assert.deepEqual(printSize(3951, 4477), { width: 896, height: 1024 });
  assert.deepEqual(printSize(4500, 5400), { width: 848, height: 1024 });
  assert.deepEqual(printSize(100, 10000), { width: 16, height: 1024 });
  assert.deepEqual(printSize(1024, 1024), { width: 1024, height: 1024 });
});

test('Klein asks for the snapped size, Key auth, and a fal.media PNG with no key on the CDN', async () => {
  const { f, a, dataDir } = adapter(png());
  const out = await a.generate('a frog writing code', { width: 3951, height: 4477 });
  const post = f.calls.find((c) => c.method === 'POST');
  assert.equal(post.url, 'https://fal-queue-gateway.nousresearch.com/fal-ai/flux-2/klein/9b');
  assert.equal(post.headers.Authorization, `Key ${TOKEN}`);
  assert.equal(post.headers['Idempotency-Key'], undefined);
  assert.deepEqual(post.body, {
    prompt: 'a frog writing code', image_size: { width: 896, height: 1024 },
    num_inference_steps: 4, output_format: 'png', enable_safety_checker: false,
  });
  assert.equal(out.costCents, 1);
  assert.equal(out.model, DEFAULT_MODEL);
  const cdn = f.calls.filter((c) => String(c.url).includes('fal.media'));
  assert.equal(cdn.length, 1);
  assert.equal(cdn[0].headers.Authorization, undefined);
  for (const c of f.calls) if (String(c.url).includes('fal-queue-gateway.nousresearch.com')) assert.equal(c.headers.Authorization, `Key ${TOKEN}`);
  const file = fs.readFileSync(path.join(dataDir, 'images', out.images[0].file));
  assert.equal(file.subarray(0, 4).toString('hex'), '89504e47');
  assert.deepEqual(readPngSize(file), { width: 8, height: 12 });
});

test('a status_url on another host is not followed', async () => {
  const { f, a } = adapter(png(), {
    statusUrl: 'https://queue.fal.run/fal-ai/flux-2/klein/9b/requests/req_ok1/status',
    responseUrl: 'https://queue.fal.run/fal-ai/flux-2/klein/9b/requests/req_ok1',
  });
  await a.generate('x', { width: 64, height: 64 });
  assert.equal(f.calls.some((c) => String(c.url).includes('queue.fal.run')), false);
  assert.ok(f.calls.some((c) => String(c.url) === 'https://fal-queue-gateway.nousresearch.com/fal-ai/flux-2/klein/9b/requests/req_ok1/status'));
});

test('an image URL on any other host is refused with no fetch', async () => {
  const { f, a } = adapter(png(), { imageUrl: 'https://evil.example/a.png' });
  await assert.rejects(a.generate('x', { width: 64, height: 64 }), /fal\.media/);
  assert.equal(f.calls.some((c) => String(c.url).includes('evil.example')), false);
});

test('a CDN redirect is refused', async () => {
  const { f, a } = adapter(png(), { imageStatus: 302 });
  await assert.rejects(a.generate('x', { width: 64, height: 64 }), /refusing to follow/);
  assert.equal(f.calls.filter((c) => String(c.url).includes('fal.media')).length, 1);
});

test('missing key and a zero cap make no request; 401 names the Portal token; 409 names Klein', async () => {
  const keyless = adapter(png(), { key: '' });
  await assert.rejects(keyless.a.generate('x', { width: 64, height: 64 }), /Sign in to Nous Portal/);
  assert.equal(keyless.f.calls.length, 0);
  const capped = adapter(png(), { spend: makeDeps({ DAILY_SPEND_CAP: '0' }).spend });
  await assert.rejects(capped.a.generate('x', { width: 3951, height: 4477 }), SpendCapError);
  assert.equal(capped.f.calls.length, 0);
  const unknown = adapter(png(), { model: 'fal-ai/not-a-model' });
  await assert.rejects(unknown.a.generate('x', { width: 64, height: 64 }), /refusing to spend blindly/);
  assert.equal(unknown.f.calls.length, 0);
  const denied = adapter(png(), { submitStatus: 401 });
  await assert.rejects(denied.a.generate('x', { width: 64, height: 64 }), /chat inference key cannot be used/);
  assert.equal(denied.f.calls.length, 1);
  const billing = adapter(png(), { submitStatus: 409, submitBody: 'BILLING_ERROR unsupported_pricing_meter' });
  await assert.rejects(billing.a.generate('x', { width: 64, height: 64 }), /fal-ai\/flux-2\/klein\/9b/);
  assert.equal(billing.f.calls.length, 1);
});

test('a chat inference key never calls the gateway', async () => {
  const { f, a } = adapter(png(), { key: 'sk-nous-chat-key-1234' });
  await assert.rejects(a.generate('x', { width: 64, height: 64 }), /chat inference key/);
  assert.equal(f.calls.length, 0);
});

test('polling stops when the gateway never finishes', async () => {
  const f = fakeFetch((url) => (String(url).includes('/status') ? { body: { status: 'IN_QUEUE' } } : { body: { request_id: 'abc' } }));
  const a = createNousImages({ http: fakeHttp(f), credentials: creds(TOKEN), dataDir: tmpDir(), upscale: null, log: quiet, sleep: async () => {}, maxPolls: 2 });
  await assert.rejects(a.generate('x', { width: 64, height: 64 }), /did not finish/);
  assert.equal(f.calls.filter((c) => String(c.url).endsWith('/status')).length, 2);
});

test('pro, qwen and ideogram send their own bodies and never num_images', async () => {
  const cases = [
    ['fal-ai/flux-2-pro', { guidance_scale: 4.5, safety_tolerance: '5' }, false],
    ['fal-ai/qwen-image', { num_inference_steps: 30, guidance_scale: 2.5, acceleration: 'regular', output_format: 'png' }, true],
    ['fal-ai/ideogram/v3', { rendering_speed: 'BALANCED', expand_prompt: true, style: 'AUTO' }, false],
  ];
  for (const [model, extra, hasFormat] of cases) {
    const { f, a } = adapter(png(), { model });
    await a.generate('prompt', { width: 64, height: 64 });
    const post = f.calls.find((c) => c.method === 'POST');
    assert.equal(post.url, `https://fal-queue-gateway.nousresearch.com/${model}`);
    assert.equal(post.body.num_images, undefined);
    assert.equal(post.body.output_format, hasFormat ? 'png' : undefined);
    for (const [k, v] of Object.entries(extra)) assert.equal(post.body[k], v, model);
  }
  const ideo = createNousImages({ model: 'fal-ai/ideogram/v3', credentials: creds(TOKEN), http: fakeHttp(fakeFetch(() => ({ body: {} }))), dataDir: tmpDir(), upscale: null, log: quiet });
  assert.equal(ideo.estimate({ width: 100, height: 100, count: 2 }).costCents, 18);
});

test('DRY_RUN with a nous key still calls the gateway and saves that PNG', async () => {
  const f = fakeFetch(responder(png()));
  const d = makeDeps({ NOUS_API_KEY: TOKEN, IMAGE_UPSCALE: 'off' }, { http: fakeHttp(f), upscale: null });
  assert.equal(d.dryRun.isOn(), true);
  assert.equal(d.adapters.imagegen.describe().methods.generate, 'real');
  const out = await d.adapters.imagegen.generate('a frog', { width: 3951, height: 4477 });
  assert.equal(out.model, DEFAULT_MODEL);
  assert.equal(f.calls[0].headers.Authorization, `Key ${TOKEN}`);
  assert.equal(f.calls[0].body.image_size.width, 896);
  const file = fs.readFileSync(path.join(d.dataDir, 'images', out.images[0].file));
  assert.equal(file.subarray(0, 4).toString('hex'), '89504e47');
  assert.notEqual(readPngSize(file).width, 3951);
});

test('a small nous PNG is kept when print coverage fails, and create-pod does not generate again', async () => {
  const f = fakeFetch(responder(gradientPng(64, 80)));
  const d = makeDeps({ NOUS_API_KEY: TOKEN, IMAGE_UPSCALE: 'off' }, { http: fakeHttp(f), upscale: null });
  const p = d.pipeline.create({ brief: 'a frog writing code', listPrice: 20 });
  await d.pipeline.selectPod(p.id, { blueprint: 'stub-tee', providerId: 'stub-pp', variantIds: ['stub-tee-v1'] });
  await d.pipeline.generateDesign(p.id);
  const calls = f.calls.length;
  assert.ok(calls >= 4);
  assert.equal(d.db.prepare('SELECT model, source FROM designs WHERE product_id = ?').get(p.id).model, DEFAULT_MODEL);
  await assert.rejects(() => d.pipeline.createPodProduct(p.id), (e) => e.code === 'print_not_ready');
  assert.equal(f.calls.length, calls, 'print refusal must not buy another image');
  assert.equal(d.pipeline.need(p.id).stage, 'design_generated');
  assert.equal(d.db.prepare('SELECT COUNT(*) n FROM designs WHERE product_id = ?').get(p.id).n, 1);
});
