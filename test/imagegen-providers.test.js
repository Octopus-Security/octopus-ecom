'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeDeps, tmpDir, gradientPng, fakeFetch, fakeHttp } = require('./helpers');
const { createGeminiImages } = require('../server/adapters/imagegen/gemini');
const { createXaiImages } = require('../server/adapters/imagegen/xai');
const { createOpenRouterImages } = require('../server/adapters/imagegen/openrouter');
const pricing = require('../server/adapters/imagegen/pricing');
const { SpendCapError } = require('../server/spend');
const { readPngSize } = require('../server/png');

const quiet = { warn() {}, info() {}, log() {} };
const png = () => gradientPng(8, 12);
const b64 = () => png().toString('base64');
const creds = key => ({ get: () => key, has: () => Boolean(key) });
const geminiBody = () => ({ steps: [{ type: 'model_output', content: [{ type: 'text', text: 'here' }, { type: 'image', data: b64() }] }] });
const dataBody = extra => ({ data: [{ b64_json: b64(), media_type: 'image/png' }], ...extra });

function mk(factory, key, body, opts = {}) {
  const f = opts.fetchImpl || fakeFetch(() => ({ body }));
  const dataDir = tmpDir();
  return { f, dataDir, a: factory({ http: fakeHttp(f), credentials: creds(key), dataDir, upscale: null, log: quiet, ...opts.adapter }) };
}

test('gemini: request shape, response parsing, real size recorded, cost from table with headroom', async () => {
  const { f, a, dataDir } = mk(createGeminiImages, 'g-key', geminiBody(), { adapter: { model: 'gemini-3.1-flash-image', resolution: '2K' } });
  const out = await a.generate('a fox', { width: 4500, height: 5400 });
  const c = f.calls[0];
  assert.equal(c.url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
  assert.equal(c.headers['x-goog-api-key'], 'g-key');
  assert.equal(c.headers['Api-Revision'], '2026-05-20');
  assert.deepEqual(c.body, { model: 'gemini-3.1-flash-image', input: 'a fox', response_format: { type: 'image', mime_type: 'image/png', aspect_ratio: '4:5', image_size: '2K' } });
  assert.equal(out.costCents, Math.ceil(0.101 * 1.25 * 100)); // 13
  assert.equal(out.model, 'gemini-3.1-flash-image');
  const img = out.images[0];
  assert.deepEqual(readPngSize(fs.readFileSync(path.join(dataDir, 'images', img.file))), { width: 8, height: 12 });
  assert.equal(img.upscaled, false); assert.equal(img.nativeWidth, 8);
});

test('gemini: count makes one request each; no image in the answer, unknown model and bad JSON all throw', async () => {
  const { f, a } = mk(createGeminiImages, 'k', geminiBody());
  const out = await a.generate('x', { count: 2 });
  assert.equal(f.calls.length, 2); assert.equal(out.images.length, 2);
  await assert.rejects(mk(createGeminiImages, 'k', { steps: [] }).a.generate('x'), /no image data/);
  await assert.rejects(mk(createGeminiImages, 'k', geminiBody(), { adapter: { model: 'mystery' } }).a.generate('x'), /refusing to spend blindly/);
  await assert.rejects(mk(createGeminiImages, 'k', 'not json').a.generate('x'), /non-JSON/);
});

test('xai: request shape (b64_json, aspect_ratio, resolution), parsing, cost errs high at 2k', async () => {
  const { f, a } = mk(createXaiImages, 'x-key', dataBody(), { adapter: { model: 'grok-imagine-image-2.0', resolution: '2k' } });
  const out = await a.generate('a fox', { width: 4500, height: 5400, count: 1 });
  const c = f.calls[0];
  assert.equal(c.url, 'https://api.x.ai/v1/images/generations');
  assert.equal(c.headers.Authorization, 'Bearer x-key');
  assert.deepEqual(c.body, { model: 'grok-imagine-image-2.0', prompt: 'a fox', n: 1, response_format: 'b64_json', aspect_ratio: '3:4', resolution: '2k' });
  assert.equal(out.costCents, 8); // $0.04 x2 (2k assumed double) 
  assert.equal(pricing.xaiCostCents('grok-imagine-image', '1k', 3), 6);
  await assert.rejects(mk(createXaiImages, 'k', { data: [] }).a.generate('x'), /no b64_json/);
  await assert.rejects(mk(createXaiImages, 'k', dataBody(), { adapter: { model: 'mystery' } }).a.generate('x'), /refusing to spend blindly/);
});

test('openrouter: /images request (no size sent), model required, usage.cost recorded, ceiling when absent', async () => {
  const { f, a } = mk(createOpenRouterImages, 'or-key', dataBody({ usage: { cost: 0.0412 } }), { adapter: { model: 'vendor/some-image-model' } });
  const out = await a.generate('a fox', { width: 5400, height: 4500, count: 1 });
  const c = f.calls[0];
  assert.equal(c.url, 'https://openrouter.ai/api/v1/images');
  assert.equal(c.headers.Authorization, 'Bearer or-key');
  assert.deepEqual(c.body, { model: 'vendor/some-image-model', prompt: 'a fox', n: 1, aspect_ratio: '4:3', output_format: 'png' });
  assert.equal(out.costCents, 5); // 4.12c rounded up
  const o2 = await mk(createOpenRouterImages, 'k', dataBody(), { adapter: { model: 'm' } }).a.generate('x');
  assert.equal(o2.costCents, 25, 'no usage.cost: record the ceiling, not zero');
  assert.equal(mk(createOpenRouterImages, 'k', {}, { adapter: { model: 'm', ceilingCents: 40 } }).a.estimate({ count: 2 }).costCents, 80);
  const none = mk(createOpenRouterImages, 'k', dataBody());
  await assert.rejects(none.a.generate('x'), /no model is chosen/);
  assert.equal(none.f.calls.length, 0);
});

for (const [name, factory, keyName, body, adapter] of [
  ['gemini', createGeminiImages, 'gemini', geminiBody(), {}],
  ['xai', createXaiImages, 'xai', dataBody(), {}],
  ['openrouter', createOpenRouterImages, 'openrouter', dataBody(), { model: 'm' }],
]) {
  test(`${name}: daily cap refuses BEFORE any request; a missing key throws a clear error and makes no request`, async () => {
    const d = makeDeps({ DAILY_SPEND_CAP: '0.01' });
    const capped = mk(factory, 'k', body, { adapter: { ...adapter, spend: d.spend } });
    await assert.rejects(capped.a.generate('x'), SpendCapError);
    assert.equal(capped.f.calls.length, 0);
    const keyless = mk(factory, '', body, { adapter });
    await assert.rejects(keyless.a.generate('x'), new RegExp(`${keyName}|${name}`, 'i'));
    await assert.rejects(keyless.a.generate('x'), /no .*key is set/i);
    assert.equal(keyless.f.calls.length, 0);
  });
}

// ---- selection, through the real wiring -------------------------------------------------------------
function wired(env, fetchImpl) {
  return makeDeps(env, { http: fakeHttp(fetchImpl), upscale: null });
}

test('default selection is nous; no key means the stub, with no request', async () => {
  const f = fakeFetch(() => ({ body: {} }));
  const d = wired({}, f);
  assert.equal(d.adapters.imagegen.describe().methods.generate, 'stub');
  const out = await d.adapters.imagegen.generate('x', { width: 8, height: 8 });
  assert.equal(out.model, 'stub-png'); assert.equal(f.calls.length, 0);
});

test('provider selection routes to that provider; the key of ANOTHER provider is never used', async () => {
  const f = fakeFetch(url => ({ body: url.includes('x.ai') ? dataBody() : geminiBody() }));
  const d = wired({ OPENAI_API_KEY: 'sk-' + 'q'.repeat(40), XAI_API_KEY: 'xai-key-123456789' }, f);
  d.settings.set('image_provider', 'xai');
  await d.adapters.imagegen.generate('x', { width: 8, height: 12 });
  assert.equal(f.calls[0].url, 'https://api.x.ai/v1/images/generations');
  assert.equal(f.calls[0].headers.Authorization, 'Bearer xai-key-123456789');
  d.settings.set('image_provider', 'gemini'); // listing-copy OpenAI key and xAI key exist, Gemini does not
  await assert.rejects(d.adapters.imagegen.generate('x', { width: 8, height: 12 }), /"gemini" is selected but no Gemini key/);
  assert.equal(f.calls.length, 1, 'no fall back to another paid provider');
  d.keystore.set('gemini', 'gem-key-123456789');
  await d.adapters.imagegen.generate('x', { width: 8, height: 12 });
  assert.equal(f.calls[1].url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
  assert.equal(f.calls[1].headers['x-goog-api-key'], 'gem-key-123456789');
});

test('settings API: choose provider and model, validated; env fallback keys listed; model per provider', async () => {
  const d = wired({ GEMINI_API_KEY: 'gem-env-123456789' }, fakeFetch(() => ({ body: geminiBody() })));
  const names = d.credentials.status().map(c => c.name);
  for (const n of ['nous', 'gemini', 'xai', 'openrouter']) assert.ok(names.includes(n));
  assert.equal(names.includes('openai'), false, 'openai is listing-copy env only, not a panel row');
  assert.equal(d.credentials.status().find(c => c.name === 'nous').envVar, 'NOUS_API_KEY');
  assert.equal(d.credentials.status().find(c => c.name === 'gemini').envVar, 'GEMINI_API_KEY');
  assert.equal(d.credentials.status().find(c => c.name === 'xai').envVar, 'XAI_API_KEY');
  assert.equal(d.credentials.status().find(c => c.name === 'openrouter').envVar, 'OPENROUTER_API_KEY');
  const { resolveSelection } = require('../server/adapters/imagegen');
  assert.equal(resolveSelection(d).provider, 'nous');
  d.settings.set('image_provider', 'gemini'); d.settings.set('image_model_gemini', 'gemini-3-pro-image');
  assert.equal(resolveSelection(d).model, 'gemini-3-pro-image');
  d.settings.set('image_provider', 'bogus');
  assert.equal(resolveSelection(d).provider, 'nous', 'a bad stored value falls back to the default');
  d.settings.set('image_provider', 'openai');
  assert.equal(resolveSelection(d).provider, 'nous', 'a stored openai image provider falls through to nous');
});

test('docker-compose passes every new env var (an env var only exists if compose passes it)', () => {
  const compose = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.yml'), 'utf8');
  for (const v of ['NOUS_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY', 'OPENROUTER_API_KEY', 'IMAGE_PROVIDER', 'IMAGE_MAX_CENTS']) assert.match(compose, new RegExp(`- ${v}=\\$\\{${v}:-\\}`));
});

test('GET/POST /api/settings: image provider is listed, validated and saved; defaults unchanged', async () => {
  const { buildApp } = require('../server/app');
  const d = makeDeps();
  const server = await new Promise(r => { const s = buildApp(d).listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const j = async (method, url, body) => { const r = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
  try {
    const s0 = (await j('GET', '/api/settings')).body.image;
    assert.equal(s0.provider, 'nous'); assert.deepEqual(s0.providers.map(p => p.id), ['nous', 'gemini', 'xai', 'openrouter']);
    assert.equal((await j('POST', '/api/settings', { imageProvider: 'dalle' })).status, 400);
    assert.equal((await j('POST', '/api/settings', { imageProvider: 'openai' })).status, 400);
    assert.equal((await j('POST', '/api/settings', { imageProvider: 'nous', imageModel: 'fal-ai/flux-2/klein/9b' })).status, 200);
    assert.equal((await j('GET', '/api/settings')).body.image.model, 'fal-ai/flux-2/klein/9b');
    assert.equal((await j('POST', '/api/settings', { imageProvider: 'nous', imageModel: 'gpt-image-1' })).status, 400);
    assert.equal((await j('POST', '/api/settings', { imageProvider: 'xai', imageModel: 'not-a-model' })).status, 400);
    assert.equal((await j('POST', '/api/settings', { imageProvider: 'xai', imageModel: 'grok-imagine-image', imageResolution: '1k' })).status, 200);
    const s1 = (await j('GET', '/api/settings')).body.image;
    assert.equal(s1.provider, 'xai'); assert.equal(s1.model, 'grok-imagine-image'); assert.equal(s1.resolution, '1k');
    assert.equal((await j('POST', '/api/settings', { imageProvider: 'openrouter', imageModel: 'vendor/model-x' })).status, 200);
    assert.equal((await j('GET', '/api/settings')).body.image.model, 'vendor/model-x');
  } finally { server.close(); }
});
