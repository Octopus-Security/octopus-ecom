'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeDeps, fakeFetch, fakeHttp } = require('./helpers');
const { makeLlm } = require('./../server/llm');
const { priceFor, costCents } = require('../server/llm/pricing');
const { SpendCapError } = require('../server/spend');
const { loadConfig } = require('../server/config');

const KEY = 'sk-test-' + 'B'.repeat(30);
const quiet = { info() {}, warn() {} };
const chat = (content, usage = { prompt_tokens: 1000, completion_tokens: 500 }) => ({ body: { choices: [{ message: { content } }], usage } });

function llmWith(env, f, extra = {}) {
  const d = makeDeps(env);
  return { d, llm: makeLlm({ cfg: loadConfig({ DATA_DIR: d.dataDir, ...env }), credentials: d.credentials, http: fakeHttp(f), spend: d.spend, log: quiet, env, ...extra }) };
}

test('price math: integer cents, rounded up', () => {
  assert.equal(costCents(priceFor('gpt-4.1-mini'), 1000, 500), 1);       // 0.0004+0.0008 = 0.12c -> 1
  assert.equal(costCents(priceFor('gpt-4.1'), 100000, 50000), 60);       // 0.2+0.4 = $0.60
  assert.equal(priceFor('unknown-model').assumed, true);
  assert.equal(priceFor('unknown-model', { priceInPerM: 1, priceOutPerM: 2 }).assumed, false);
});

test('openai provider: request shape, tier -> model, json mode, usage-based cost', async () => {
  const f = fakeFetch(() => chat('{"a":1}'));
  const { llm } = llmWith({ OPENAI_API_KEY: KEY }, f);
  assert.equal(llm.describe().provider, 'openai');
  const out = await llm.complete({ system: 'sys', prompt: 'hi', tier: 'standard', json: true });
  const c = f.calls[0];
  assert.equal(c.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(c.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(c.body.model, 'gpt-4.1-mini');
  assert.deepEqual(c.body.messages, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }]);
  assert.deepEqual(c.body.response_format, { type: 'json_object' });
  assert.deepEqual(out, { text: '{"a":1}', model: 'gpt-4.1-mini', costCents: 1, priceAssumed: false });
  await llm.complete({ prompt: 'x', tier: 'deep' }); await llm.complete({ prompt: 'x', tier: 'cheap' });
  assert.deepEqual(f.calls.slice(1).map(x => x.body.model), ['gpt-4.1', 'gpt-4.1-nano']);
});

test('provider is resolved per call: a key saved later switches stub -> openai without restart', async () => {
  const f = fakeFetch(() => chat('ok'));
  const { d, llm } = llmWith({}, f);
  assert.equal(llm.describe().provider, 'stub');
  d.keystore.set('openai', KEY);
  assert.equal(llm.describe().provider, 'openai');
  await llm.complete({ prompt: 'x' }); assert.equal(f.calls.length, 1);
});

test('openai-compatible: LLM_BASE_URL, optional key, model overrides, env price', async () => {
  const f = fakeFetch(() => chat('hello'));
  const env = { LLM_BASE_URL: 'http://router.local:9999/v1/', LLM_MODEL_CHEAP: 'local-small', LLM_PRICE_IN_PER_M: '1', LLM_PRICE_OUT_PER_M: '2' };
  const { llm } = llmWith(env, f);
  assert.equal(llm.describe().provider, 'openai-compatible');
  const out = await llm.complete({ prompt: 'x', tier: 'cheap' });
  assert.equal(f.calls[0].url, 'http://router.local:9999/v1/chat/completions');
  assert.equal(f.calls[0].headers.Authorization, undefined, 'no key -> no Authorization header');
  assert.equal(f.calls[0].body.model, 'local-small');
  assert.equal(out.costCents, 1); assert.equal(out.priceAssumed, false);
  const f2 = fakeFetch(() => chat('hello'));
  const { llm: l2 } = llmWith({ LLM_BASE_URL: 'http://x/v1', LLM_API_KEY: 'k-123456789' }, f2, { env: { LLM_API_KEY: 'k-123456789' } });
  await l2.complete({ prompt: 'x' });
  assert.equal(f2.calls[0].headers.Authorization, 'Bearer k-123456789');
});

test('router table: its model is used for the tier; LLM_MODEL_<TIER> beats it', async () => {
  const fs = require('node:fs'); const path = require('node:path'); const { tmpDir } = require('./helpers');
  const dir = tmpDir('r-'); fs.mkdirSync(path.join(dir, 'server'));
  fs.writeFileSync(path.join(dir, 'server', 'router.js'), `module.exports={TIERS:{cheap:'a',standard:'b',deep:'c'},ALIASES:{a:{model:'r-cheap'},b:{model:'r-std'},c:{model:'r-deep'}}}`);
  const f = fakeFetch(() => chat('x'));
  const { llm } = llmWith({ OPENAI_API_KEY: KEY, ROUTER_PATH: dir, LLM_MODEL_DEEP: 'forced' }, f);
  await llm.complete({ prompt: 'x', tier: 'cheap' }); await llm.complete({ prompt: 'x', tier: 'deep' });
  assert.deepEqual(f.calls.map(c => c.body.model), ['r-cheap', 'forced']);
  assert.equal(llm.describe().routing.path, 'router');
});

test('an unknown model is costed at a worst case and flagged priceAssumed', async () => {
  const f = fakeFetch(() => chat('x', { prompt_tokens: 1000, completion_tokens: 1000 }));
  const { llm } = llmWith({ OPENAI_API_KEY: KEY, LLM_MODEL_CHEAP: 'brand-new-model' }, f);
  const out = await llm.complete({ prompt: 'x', tier: 'cheap' });
  assert.equal(out.priceAssumed, true); assert.equal(out.costCents, 2);
});

test('cap refuses before the call; bad responses throw', async () => {
  const f = fakeFetch(() => chat('x'));
  const { d, llm } = llmWith({ OPENAI_API_KEY: KEY, DAILY_SPEND_CAP: '0.01' }, f);
  d.spend.addCost({ kind: 'image', amountCents: 1 });
  await assert.rejects(llm.complete({ prompt: 'x' }), SpendCapError);
  assert.equal(f.calls.length, 0);
  const { llm: l2 } = llmWith({ OPENAI_API_KEY: KEY }, fakeFetch(() => ({ body: { choices: [] } })));
  await assert.rejects(l2.complete({ prompt: 'x' }), /no message content/);
  const { llm: l3 } = llmWith({ OPENAI_API_KEY: KEY }, fakeFetch(() => ({ status: 401, body: 'nope' })));
  await assert.rejects(l3.complete({ prompt: 'x' }), /HTTP 401/);
});
