'use strict';
// M3: Etsy OAuth (PKCE, state), sealed tokens, refresh (expiry, 401, single-flight, failure), no-shop. Fake fetch only.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { makeDeps } = require('./helpers');
const { liveDeps, connectStore, KEY, SECRET, REDIRECT } = require('./etsy-helpers');
const { buildApp } = require('../server/app');
const { challengeOf, newVerifier } = require('../server/etsy/auth');

async function serve(d) {
  const server = await new Promise(r => { const s = buildApp(d).listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const j = async (method, url, body) => { const r = await fetch(base + url, { method, redirect: 'manual', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, loc: r.headers.get('location'), text: await r.text() }; };
  return { server, j, json: async (...a) => { const r = await j(...a); return { ...r, body: r.text ? JSON.parse(r.text) : null }; } };
}
const pending = d => d.db.prepare('SELECT * FROM oauth_pending').all();

test('PKCE: S256 matches the RFC 7636 test vector; verifier is 43-128 chars; the authorize URL carries the challenge of the STORED verifier', () => {
  assert.equal(challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  for (let i = 0; i < 20; i++) { const v = newVerifier(); assert.ok(v.length >= 43 && v.length <= 128 && /^[A-Za-z0-9_-]+$/.test(v)); }
  const { d } = liveDeps();
  const c = d.etsyAuth.start(); const u = new URL(c.url);
  assert.equal(u.origin + u.pathname, 'https://www.etsy.com/oauth/connect');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('client_id'), KEY, 'client_id is the keystring ALONE, not key:secret');
  assert.equal(u.searchParams.get('redirect_uri'), REDIRECT);
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.deepEqual(u.searchParams.get('scope').split(' '), ['listings_r', 'listings_w', 'transactions_r', 'shops_r']);
  const row = pending(d)[0];
  const verifier = d.keystore.openJson(row.verifier_sealed).verifier;
  assert.equal(u.searchParams.get('code_challenge'), crypto.createHash('sha256').update(verifier).digest('base64url'));
  assert.ok(!row.verifier_sealed.includes(verifier), 'the verifier is sealed at rest');
});

test('state is single use and expires after 10 minutes; unknown state is refused', () => {
  const { d, clock } = liveDeps();
  const a = d.etsyAuth.start();
  assert.ok(d.etsyAuth.consume(a.state));
  assert.throws(() => d.etsyAuth.consume(a.state), e => e.code === 'invalid_state', 'replay');
  assert.throws(() => d.etsyAuth.consume('made-up'), e => e.code === 'invalid_state');
  assert.throws(() => d.etsyAuth.consume(''), e => e.code === 'invalid_state');
  const b = d.etsyAuth.start();
  clock.t += 10 * 60 * 1000 + 1;
  assert.throws(() => d.etsyAuth.consume(b.state), e => e.code === 'state_expired');
  assert.equal(pending(d).length, 0);
});

test('no Etsy app credentials: connect says so plainly (400), status says stubs, nothing is stored', async () => {
  const d = makeDeps();
  const s = await serve(d);
  try {
    const c = await s.json('GET', '/api/etsy/connect');
    assert.equal(c.status, 400); assert.match(c.body.error, /No Etsy app credentials/); assert.match(c.body.error, /ETSY_API_KEY/);
    const st = await s.json('GET', '/api/etsy/status');
    assert.equal(st.body.stub, true); assert.match(st.body.message, /No Etsy app credentials/); assert.equal(pending(d).length, 0);
    const sync = await s.json('POST', '/api/sales/sync');
    assert.equal(sync.status, 200); assert.equal(sync.body.source, 'stub');
  } finally { s.server.close(); }
});

test('with credentials but no redirect URI the error names ETSY_REDIRECT_URI', async () => {
  const d = makeDeps({ ETSY_API_KEY: KEY, ETSY_SHARED_SECRET: SECRET });
  const s = await serve(d);
  try { const c = await s.json('GET', '/api/etsy/connect'); assert.equal(c.status, 400); assert.match(c.body.error, /ETSY_REDIRECT_URI/); } finally { s.server.close(); }
});

test('full flow: connect -> callback validates state, exchanges the code with the verifier, seals tokens, reads the shop; tokens never appear in any API response', async () => {
  const { d, st } = liveDeps({ validAccess: new Set() });
  const s = await serve(d);
  try {
    const c = await s.json('GET', '/api/etsy/connect');
    const url = new URL(c.body.url); const state = url.searchParams.get('state');
    const verifier = d.keystore.openJson(pending(d)[0].verifier_sealed).verifier;
    const cb = await s.j('GET', `/api/etsy/callback?code=authcode123&state=${state}`);
    assert.equal(cb.status, 302); assert.equal(cb.loc, '/?etsy=connected');
    const call = st.tokenCalls[0];
    assert.equal(call.grant_type, 'authorization_code'); assert.equal(call.code, 'authcode123'); assert.equal(call.client_id, KEY);
    assert.equal(call.code_verifier, verifier); assert.equal(call.redirect_uri, REDIRECT);
    const row = d.db.prepare('SELECT * FROM stores').get();
    assert.equal(row.status, 'connected'); assert.equal(row.shop_id, '555'); assert.equal(row.shop_name, 'My Shop');
    assert.ok(row.oauth_sealed && !/at-|rt-/.test(row.oauth_sealed), 'sealed at rest, not plaintext');
    assert.equal(pending(d).length, 0, 'state burned');
    // replay of the same callback is refused
    const again = await s.j('GET', `/api/etsy/callback?code=authcode123&state=${state}`);
    assert.match(decodeURIComponent(again.loc), /etsy=error/);
    // the API never carries a token
    const dumps = [(await s.j('GET', '/api/etsy/status')).text, (await s.j('GET', '/api/settings')).text, (await s.j('GET', '/api/summary')).text];
    for (const t of dumps) assert.ok(!/at-\d|rt-\d/.test(t), 'no token in ' + t.slice(0, 60));
    const status = JSON.parse(dumps[0]).stores[0];
    assert.equal(status.connected, true); assert.equal(status.shopName, 'My Shop'); assert.ok(status.tokenExpiresAt);
    // and the redactor knows the token values
    const tk = d.etsyAuth.readTokens(row.id);
    assert.ok(d.credentials.allValues().includes(tk.accessToken) && d.credentials.allValues().includes(tk.refreshToken));
  } finally { s.server.close(); }
});

test('callback with a bad state or an Etsy denial lands on the panel with a message, and stores nothing', async () => {
  const { d } = liveDeps();
  const s = await serve(d);
  try {
    const bad = await s.j('GET', '/api/etsy/callback?code=x&state=nope');
    assert.match(decodeURIComponent(bad.loc), /etsy=error.*state/i);
    const c = await s.json('GET', '/api/etsy/connect'); const state = new URL(c.body.url).searchParams.get('state');
    const denied = await s.j('GET', `/api/etsy/callback?error=access_denied&error_description=user+said+no&state=${state}`);
    assert.match(decodeURIComponent(denied.loc.replace(/\+/g, ' ')), /did not authorise/);
    assert.equal(pending(d).length, 0); assert.equal(d.db.prepare('SELECT COUNT(*) n FROM stores WHERE oauth_sealed IS NOT NULL').get().n, 0);
  } finally { s.server.close(); }
});

test('NO SHOP: the account connects, the store shows the "open a shop" message, and nothing is silent', async () => {
  const { d, st } = liveDeps({ shop: null });
  const s = await serve(d);
  try {
    const c = await s.json('GET', '/api/etsy/connect'); const state = new URL(c.body.url).searchParams.get('state');
    const cb = await s.j('GET', `/api/etsy/callback?code=c&state=${state}`);
    assert.equal(cb.loc, '/?etsy=no_shop');
    const store = (await s.json('GET', '/api/etsy/status')).body.stores[0];
    assert.equal(store.needsShop, true); assert.equal(store.connected, false);
    assert.match(store.message, /Open an Etsy shop first \(Shop Manager → open shop\), then reconnect/);
    assert.ok(d.db.prepare('SELECT oauth_sealed FROM stores').get().oauth_sealed, 'tokens are kept so Check shop works');
    // the operator opens a shop, then rechecks
    st.shop = { shop_id: 555, shop_name: 'Fresh Shop', url: 'u', user_id: 1, currency_code: 'USD' };
    const re = await s.json('POST', `/api/etsy/stores/${store.id}/recheck`);
    assert.equal(re.body.store.connected, true); assert.equal(re.body.store.shopName, 'Fresh Shop');
  } finally { s.server.close(); }
});

test('every Etsy API call sends x-api-key as keystring:shared_secret plus the Bearer token', async () => {
  const { d, st, calls } = liveDeps({ listings: { 900: { listing_id: 900, state: 'active', url: 'https://etsy.test/l/900', title: 't', tags: [], price: { amount: 2500, divisor: 100, currency_code: 'USD' }, views: 12, num_favorers: 3, shop_id: 555 } } });
  const id = connectStore(d);
  const l = await d.adapters.storefront.getListing(id, 900);
  assert.equal(l.views, 12); assert.equal(l.priceCents, 2500);
  const c = calls.find(x => x.url.includes('/listings/900'));
  assert.equal(c.headers['x-api-key'], `${KEY}:${SECRET}`); assert.equal(c.headers.Authorization, 'Bearer 1.at-1');
  assert.equal(st.tokenCalls.length, 0);
});

test('refresh BEFORE expiry: a token near its end is rotated first, and the new pair is what is stored', async () => {
  const { d, st, calls, clock } = liveDeps({ listings: { 900: { listing_id: 900, state: 'active', shop_id: 555, price: { amount: 100, divisor: 100 } } } });
  const id = connectStore(d, { expiresAt: clock.t + 30_000 }); // inside the 2-minute margin
  await d.adapters.storefront.getListing(id, 900);
  assert.equal(st.tokenCalls.length, 1); assert.equal(st.tokenCalls[0].grant_type, 'refresh_token'); assert.equal(st.tokenCalls[0].refresh_token, '1.rt-1'); assert.equal(st.tokenCalls[0].client_id, KEY);
  const used = calls.filter(x => x.url.includes('/listings/900')).map(x => x.headers.Authorization);
  assert.deepEqual(used, ['Bearer 1.at-2']);
  assert.equal(d.etsyAuth.readTokens(id).refreshToken, '1.rt-3', 'the rotated refresh token was persisted');
  assert.ok(Date.parse(d.db.prepare('SELECT token_expires_at FROM stores WHERE id=?').get(id).token_expires_at) > clock.t);
});

test('refresh on a 401: the call is retried once with a fresh token', async () => {
  const { d, st, calls } = liveDeps({ listings: { 900: { listing_id: 900, state: 'active', shop_id: 555, price: { amount: 100, divisor: 100 } } } });
  const id = connectStore(d);
  st.validAccess.delete('1.at-1'); // Etsy has revoked the access token early
  const l = await d.adapters.storefront.getListing(id, 900);
  assert.equal(l.id, '900');
  assert.equal(st.tokenCalls.length, 1);
  assert.deepEqual(calls.filter(x => x.url.includes('/listings/900')).map(x => x.headers.Authorization), ['Bearer 1.at-1', 'Bearer 1.at-2']);
});

test('single-flight: concurrent calls with an expired token cause exactly ONE refresh', async () => {
  const { d, st, clock } = liveDeps({ listings: { 900: { listing_id: 900, state: 'active', shop_id: 555, price: { amount: 100, divisor: 100 } } } });
  const id = connectStore(d, { expiresAt: clock.t - 1000 });
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => d.adapters.storefront.getListing(id, 900)));
  assert.ok(rs.every(r => r.id === '900'));
  assert.equal(st.tokenCalls.length, 1);
});

test('refresh refused by Etsy: the store is marked disconnected with a clear message and the tokens are dropped', async () => {
  const { d, st, clock } = liveDeps({ refreshFail: 400 });
  const id = connectStore(d, { expiresAt: clock.t - 1000 });
  await assert.rejects(d.adapters.storefront.getListing(id, 900), e => e.code === 'disconnected' && /Reconnect Etsy/.test(e.message));
  const row = d.db.prepare('SELECT * FROM stores WHERE id=?').get(id);
  assert.equal(row.status, 'disconnected'); assert.match(row.status_detail, /Reconnect Etsy/); assert.equal(row.oauth_sealed, null);
  assert.equal(st.tokenCalls.length, 1);
  await assert.rejects(d.adapters.storefront.getListing(id, 900), e => e.code === 'disconnected', 'no further refresh attempts with no token');
  assert.equal(st.tokenCalls.length, 1);
});

test('a TRANSIENT refresh failure (503) does not disconnect the store', async () => {
  const { d, clock } = liveDeps({ refreshFail: 503 });
  const id = connectStore(d, { expiresAt: clock.t - 1000 });
  await assert.rejects(d.adapters.storefront.getListing(id, 900));
  assert.equal(d.db.prepare('SELECT status FROM stores WHERE id=?').get(id).status, 'connected');
  assert.ok(d.db.prepare('SELECT oauth_sealed FROM stores WHERE id=?').get(id).oauth_sealed);
});

test('disconnect and autopublish are confirm-gated; disconnect deletes the sealed tokens and switches autopublish off', async () => {
  const { d } = liveDeps();
  const id = connectStore(d);
  const s = await serve(d);
  try {
    const on1 = await s.json('POST', `/api/etsy/stores/${id}/autopublish`, { enabled: true });
    assert.equal(on1.body.needsConfirm, true); assert.match(on1.body.summary, /AUTOPUBLISH/); assert.equal(d.db.prepare('SELECT autopublish a FROM stores WHERE id=?').get(id).a, 0);
    const on2 = await s.json('POST', `/api/etsy/stores/${id}/autopublish`, { enabled: true, token: on1.body.token });
    assert.equal(on2.body.store.autopublish, true);
    assert.equal((await s.json('POST', `/api/etsy/stores/${id}/autopublish`, { enabled: false })).body.store.autopublish, false, 'turning it off needs no confirm');
    await s.json('POST', `/api/etsy/stores/${id}/autopublish`, { enabled: true, token: (await s.json('POST', `/api/etsy/stores/${id}/autopublish`, { enabled: true })).body.token });
    const d1 = await s.json('POST', `/api/etsy/stores/${id}/disconnect`);
    assert.equal(d1.body.needsConfirm, true); assert.ok(d.db.prepare('SELECT oauth_sealed FROM stores WHERE id=?').get(id).oauth_sealed);
    const d2 = await s.json('POST', `/api/etsy/stores/${id}/disconnect`, { token: d1.body.token });
    assert.equal(d2.body.store.status, 'disconnected'); assert.equal(d2.body.store.autopublish, false);
    assert.equal(d.db.prepare('SELECT oauth_sealed FROM stores WHERE id=?').get(id).oauth_sealed, null);
    assert.equal((await s.json('POST', `/api/etsy/stores/${id}/disconnect`, { token: d1.body.token })).status, 409, 'token is single use');
  } finally { s.server.close(); }
});

test('http.js hostLimits: a local daily budget stops requests to that host with a 429-shaped error', async () => {
  const { makeHttp } = require('../server/adapters/http');
  const { fakeFetch } = require('./helpers');
  const f = fakeFetch(() => ({ body: {} }));
  const h = makeHttp({ fetchImpl: f, sleep: async () => {}, hostLimits: { 'api.etsy.com': { ratePerSec: 4, perDay: 3 } } });
  for (let i = 0; i < 3; i++) await h.request('https://api.etsy.com/x');
  await assert.rejects(h.request('https://api.etsy.com/x'), e => e.status === 429 && /daily request budget/.test(e.message));
  await h.request('https://other.example/x'); assert.equal(f.calls.length, 4);
});
