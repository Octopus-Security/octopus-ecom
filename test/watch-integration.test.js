'use strict';
// The watch + playbook feature as wired into the real app: routes mounted behind auth, adapter contract, boot.
const { test } = require('node:test');
const assert = require('node:assert');
const { makeDeps } = require('./helpers');
const { buildApp } = require('../server/app');
const { routeAdapter } = require('../server/adapters/route');
const { CONTRACTS } = require('../server/adapters/contract');

test('contract carries the two watcher reads', () => {
  assert.equal(CONTRACTS.pod.getAvailability, 'read');
  assert.equal(CONTRACTS.storefront.getListingStats, 'read');
});

test('a read method the real adapter lacks falls back to the stub instead of throwing', async () => {
  const calls = [];
  const stub = { listBlueprints: async () => 0, listPrintProviders: async () => 0, getVariantCosts: async () => 0, getAvailability: async () => { calls.push('stub.avail'); return { variants: [] }; }, createProduct: async () => 0, getMockups: async () => 0, publish: async () => 0 };
  // implemented real adapter, credential present, but no getAvailability (like printify.js before M2)
  const real = { implemented: true, listBlueprints: async () => 0, listPrintProviders: async () => 0, getVariantCosts: async () => 0, createProduct: async () => 0, getMockups: async () => 0, publish: async () => 0 };
  const a = routeAdapter({ kind: 'pod', stub, real, hasCredential: () => true, isDryRun: () => false, log: { info() {} } });
  assert.deepEqual(await a.getAvailability('bp', 'pp'), { variants: [] });
  assert.deepEqual(calls, ['stub.avail']);
  assert.equal(a.describe().methods.getAvailability, 'stub');
  assert.equal(a.describe().methods.getVariantCosts, 'real');
  // a scaffold (what printify.js/etsy.js are today) is also stubbed
  const scaffold = { implemented: false };
  const b = routeAdapter({ kind: 'pod', stub, real: scaffold, hasCredential: () => true, isDryRun: () => false, log: { info() {} } });
  await b.getAvailability('bp', 'pp');
  assert.equal(calls.length, 2);
});

test('watch + playbook routes are mounted, authed, and run-now works on stubs', async () => {
  const d = makeDeps();
  const s = await new Promise((r) => { const x = buildApp(d).listen(0, '127.0.0.1', () => r(x)); });
  const base = `http://127.0.0.1:${s.address().port}`;
  try {
    const get = async (u) => { const r = await fetch(base + u); return { status: r.status, body: await r.json() }; };
    assert.equal((await get('/api/watch/alerts')).status, 200);
    assert.equal((await get('/api/watch/runs')).status, 200);
    const pbs = await get('/api/playbooks');
    assert.equal(pbs.status, 200); assert.ok(pbs.body.playbooks.length > 0);
    const run = await fetch(base + '/api/watch/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(run.status, 200);
    const x = await fetch(base + '/api/watch/run', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
    assert.equal(x.status, 403);
    // signed-out is refused under sso
    const { buildAuth } = require('../server/auth');
    const sso = buildAuth({ ...d.cfg, authMode: 'sso', owners: ['boss'] }, { ssoFactory: () => (_q, _s, n) => n(), log: { warn() {} } });
    const s2 = await new Promise((r) => { const y = buildApp({ ...d, auth: sso }).listen(0, '127.0.0.1', () => r(y)); });
    for (const u of ['/api/watch/alerts', '/api/playbooks']) assert.equal((await fetch(`http://127.0.0.1:${s2.address().port}${u}`)).status, 401);
    s2.close();
  } finally { s.close(); }
});
