'use strict';
// Real HTTP against buildApp on an ephemeral port: auth gates, settings never leak, confirm gates.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { makeDeps } = require('./helpers');
const { buildApp } = require('../server/app');

const SECRET_VALUE = 'sk-test-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ9876';
let server; let base; let d;

before(async () => {
  d = makeDeps();
  server = await new Promise((r) => { const s = buildApp(d).listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const j = async (method, url, body, headers = {}) => {
  const r = await fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test('/healthz and /api/build', async () => {
  assert.deepEqual((await j('GET', '/healthz')).body, { ok: true });
  const b = (await j('GET', '/api/build')).body;
  assert.equal(b.ok, true); assert.equal(b.service, 'octopus-ecom'); assert.match(b.build, /^[0-9a-f]{12}$|^unknown$/); assert.ok(b.startedAt);
});
test('/api/products is an empty board with every stage column', async () => {
  const b = (await j('GET', '/api/products')).body;
  assert.equal(b.count, 0);
  assert.equal(b.stages.length, 11);
  for (const s of b.stages) assert.deepEqual(b.columns[s], []);
});
test('a product appears in its stage column', async () => {
  d.stages.createProduct({ brief: 'a cat in space' });
  const b = (await j('GET', '/api/products')).body;
  assert.equal(b.columns.idea.length, 1); assert.equal(b.columns.idea[0].title, 'a cat in space');
});
test('/api/summary', async () => {
  const s = (await j('GET', '/api/summary')).body;
  assert.equal(s.dryRun, true); assert.equal(s.spend.totalCents, 0); assert.equal(s.netCents, 0);
  assert.equal(s.adapters.length, 5); assert.equal(s.llm.provider, 'stub');
});
test('credentials: set returns no value; list shows presence only; never the value anywhere', async () => {
  const set = await j('POST', '/api/settings/credentials', { name: 'openai', value: SECRET_VALUE });
  assert.equal(set.status, 200);
  const all = JSON.stringify([set.body, (await j('GET', '/api/settings')).body, (await j('GET', '/api/summary')).body]);
  assert.ok(!all.includes(SECRET_VALUE) && !all.includes('ZZZZZZZZ'));
  const cred = (await j('GET', '/api/settings')).body.credentials.find(c => c.name === 'openai');
  assert.equal(cred.present, true); assert.equal(cred.source, 'keystore'); assert.equal(cred.tail, '9876');
  assert.equal((await j('POST', '/api/settings/credentials', { name: 'nope', value: 'x' })).status, 400);
});
test('credential delete is confirm-gated and token-bound', async () => {
  const first = await j('DELETE', '/api/settings/credentials/openai', {});
  assert.equal(first.body.needsConfirm, true);
  assert.equal(d.keystore.get('openai'), SECRET_VALUE, 'nothing deleted yet');
  const bogus = await j('DELETE', '/api/settings/credentials/openai', { token: 'bogus' });
  assert.equal(bogus.status, 409);
  const done = await j('DELETE', '/api/settings/credentials/openai', { token: first.body.token });
  assert.equal(done.body.deleted, true);
  assert.equal(d.keystore.get('openai'), '');
});
test('DRY_RUN disarm over HTTP: gate, phrase, then OFF; ON is immediate', async () => {
  const g = (await j('POST', '/api/settings/dry-run', { dryRun: false })).body;
  assert.equal(g.needsConfirm, true);
  assert.equal((await j('POST', '/api/settings/dry-run', { dryRun: false, token: g.token, confirm: 'nope' })).status, 400);
  assert.equal(d.dryRun.isOn(), true);
  const ok = await j('POST', '/api/settings/dry-run', { dryRun: false, token: g.token, confirm: 'ARM LIVE WRITES' });
  assert.equal(ok.body.dryRun, false);
  assert.equal((await j('POST', '/api/settings/dry-run', { dryRun: true })).body.dryRun, true);
  assert.equal((await j('POST', '/api/settings/dry-run', { dryRun: 'false' })).status, 400);
});
test('caps are settable in dollars and validated', async () => {
  const r = await j('POST', '/api/settings', { dailySpendCap: 12.5, marginFloor: 3 });
  assert.equal(r.body.dailySpendCapCents, 1250); assert.equal(r.body.marginFloorCents, 300);
  assert.equal((await j('POST', '/api/settings', { dailySpendCap: -1 })).status, 400);
});
test('cross-origin writes are refused', async () => {
  const r = await j('POST', '/api/settings', { dailySpendCap: 1 }, { Origin: 'https://evil.example' });
  assert.equal(r.status, 403);
});
test('unknown API routes 404 as JSON', async () => assert.equal((await j('GET', '/api/nope')).status, 404));

test('sso owner gate: signed-out 401, non-owner 403, owner passes (injected identify)', async () => {
  const cfgSso = { ...d.cfg, authMode: 'sso', owners: ['boss'] };
  const { buildAuth } = require('../server/auth');
  const mk = (user) => buildAuth(cfgSso, { ssoFactory: () => (req, _res, next) => { if (user) req.user = user; next(); }, log: { warn() {} } });
  for (const [user, status] of [[null, 401], [{ username: 'rando' }, 403], [{ username: 'boss' }, 200]]) {
    const app = buildApp({ ...d, auth: mk(user) });
    const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
    const res = await fetch(`http://127.0.0.1:${s.address().port}/api/summary`);
    s.close();
    assert.equal(res.status, status, JSON.stringify(user));
  }
});
