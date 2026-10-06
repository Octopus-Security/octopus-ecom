'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadRouterTiers } = require('../server/llm/router-path');
const { makeLlm } = require('../server/llm');
const { makeDeps, tmpDir } = require('./helpers');

function fakeRouter(src) {
  const dir = tmpDir('fake-router-');
  fs.mkdirSync(path.join(dir, 'server'));
  fs.writeFileSync(path.join(dir, 'server', 'router.js'), src);
  return dir;
}
const GOOD = `module.exports = { TIERS: { cheap: 'a', standard: 'b', deep: 'c' }, ALIASES: {
  a: { provider: 'p', model: 'm-cheap', cost: 'cheap' }, b: { provider: 'p', model: 'm-std' }, c: { provider: 'p', model: 'm-deep' } } };`;

test('ROUTER_PATH unset -> clean fallback', () => {
  const r = loadRouterTiers({ routerPath: '' });
  assert.deepEqual(r, { path: 'fallback', tiers: null, reason: 'ROUTER_PATH unset' });
});
test('missing router.js -> fallback', () => assert.equal(loadRouterTiers({ routerPath: tmpDir() }).path, 'fallback'));
test('router.js that throws on load -> fallback, never throws', () => {
  const r = loadRouterTiers({ routerPath: fakeRouter("throw new Error('boom at load')") });
  assert.equal(r.path, 'fallback'); assert.match(r.reason, /boom at load/);
});
test('router.js with the wrong shape -> fallback', () => {
  assert.equal(loadRouterTiers({ routerPath: fakeRouter('module.exports = {}') }).path, 'fallback');
  const dangling = fakeRouter("module.exports = { TIERS: { cheap: 'x', standard: 'x', deep: 'x' }, ALIASES: {} }");
  assert.match(loadRouterTiers({ routerPath: dangling }).reason, /does not resolve/);
});
test('a good router.js yields a model per tier and logs which path was taken', () => {
  const logs = [];
  const r = loadRouterTiers({ routerPath: fakeRouter(GOOD), log: { info: (m) => logs.push(m), warn() {} } });
  assert.equal(r.path, 'router');
  assert.deepEqual(Object.keys(r.tiers), ['cheap', 'standard', 'deep']);
  assert.equal(r.tiers.cheap.model, 'm-cheap');
  assert.match(logs.join(), /router tier table/);
});
test('makeLlm: stub by default; unimplemented/unknown providers fall back to the stub', async () => {
  const d = makeDeps();
  const llm = makeLlm({ cfg: d.cfg, credentials: d.credentials, log: { info() {}, warn() {} } });
  assert.equal(llm.describe().provider, 'stub');
  const out = await llm.complete({ prompt: 'hello', tier: 'deep' });
  assert.deepEqual(Object.keys(out).sort(), ['costCents', 'model', 'text']);
  assert.equal(out.costCents, 0);
  assert.equal((await llm.complete({ prompt: 'hello', tier: 'deep' })).text, out.text, 'deterministic');
  assert.equal(JSON.parse((await llm.complete({ prompt: 'x', json: true })).text).stub, true);
  await assert.rejects(llm.complete({ prompt: 'x', tier: 'bogus' }), /Unknown tier/);
  for (const p of ['openai', 'openai-compatible', 'nonsense']) {
    const l = makeLlm({ cfg: { ...d.cfg, llm: { ...d.cfg.llm, provider: p } }, credentials: d.credentials, log: { info() {}, warn() {} } });
    assert.equal(l.describe().provider, 'stub', p);
    assert.ok(l.describe().note);
  }
});
test('makeLlm with a broken ROUTER_PATH still works', async () => {
  const d = makeDeps();
  const llm = makeLlm({ cfg: { ...d.cfg, llm: { ...d.cfg.llm, routerPath: fakeRouter('throw 1') } }, credentials: d.credentials, log: { info() {}, warn() {} } });
  assert.equal(llm.describe().routing.path, 'fallback');
  assert.ok((await llm.complete({ prompt: 'ok' })).text);
});
