'use strict';
// Nous Portal sign-in and refresh. Fake HTTP only. Nothing here contacts portal.nousresearch.com.
const { test } = require('node:test');
const assert = require('node:assert');
const { makeDeps, gradientPng, fakeFetch, fakeHttp, portalJwt } = require('./helpers');
const { buildApp } = require('../server/app');

const ACCESS = portalJwt({ tail: 'acc1' });
const NEXT = portalJwt({ tail: 'acc2' });
const DEVICE = 'device-code-secret-value';
const REFRESH = 'refresh-token-secret-value';
const ROTATED = 'refresh-token-rotated-value';

function session(access, refresh, expiresAt) {
  return JSON.stringify({ v: 1, access_token: access, refresh_token: refresh, expires_at: expiresAt });
}

test('sign-in returns a user code and stores tokens that never leave the server', async () => {
  let polls = 0;
  const f = fakeFetch((url) => {
    const u = String(url);
    if (u.endsWith('/api/oauth/device/code')) {
      return { body: {
        device_code: DEVICE, user_code: 'ABCD-EFGH', expires_in: 600, interval: 1,
        verification_uri: 'https://portal.nousresearch.com/manage-subscription',
        verification_uri_complete: 'https://portal.nousresearch.com/manage-subscription?user_code=ABCD-EFGH',
      } };
    }
    polls += 1;
    if (polls === 1) return { status: 400, body: { error: 'authorization_pending' } };
    return { body: { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 } };
  });
  const d = makeDeps({}, { http: fakeHttp(f) });
  const server = await new Promise((r) => { const s = buildApp(d).listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const j = async (url) => {
    const r = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    return { status: r.status, body: await r.json() };
  };
  try {
    const start = await j('/api/nous/login');
    assert.equal(start.status, 200);
    assert.equal(start.body.userCode, 'ABCD-EFGH');
    assert.equal(start.body.interval, 5);
    assert.match(start.body.verificationUrl, /^https:\/\/portal\.nousresearch\.com\//);
    const started = JSON.stringify(start.body);
    assert.ok(!started.includes(DEVICE));
    const pending = await j('/api/nous/login/poll');
    assert.equal(pending.body.pending, true);
    assert.equal(pending.body.interval, 5);
    const done = await j('/api/nous/login/poll');
    assert.equal(done.body.ok, true);
    assert.equal(done.body.source, 'keystore');
    const shown = JSON.stringify(done.body);
    assert.ok(!shown.includes(ACCESS) && !shown.includes(REFRESH) && !shown.includes(DEVICE));
    const stored = d.keystore.get('nous');
    assert.ok(stored.includes(ACCESS) && stored.includes(REFRESH));
    const scrubbed = d.redactor.redactText(`token ${ACCESS} ${REFRESH}`);
    assert.equal(scrubbed.includes(ACCESS), false);
    assert.equal(scrubbed.includes(REFRESH), false);
  } finally { server.close(); }
});

test('an expired Portal sign-in is refreshed once and the rotated token is what the gateway sees', async () => {
  let refreshes = 0;
  const bytes = gradientPng(8, 8);
  const f = fakeFetch((url) => {
    const u = String(url);
    if (u === 'https://portal.nousresearch.com/api/oauth/token') {
      refreshes += 1;
      return { body: { access_token: NEXT, refresh_token: ROTATED, expires_in: 3600 } };
    }
    if (u.includes('fal.media')) return { body: bytes };
    if (u.endsWith('/status')) return { body: { status: 'COMPLETED' } };
    if (u.includes('/requests/')) return { body: { images: [{ url: 'https://v3.fal.media/files/x.png' }] } };
    return { body: { request_id: 'req_ok1' } };
  });
  const d = makeDeps({ IMAGE_UPSCALE: 'off' }, { http: fakeHttp(f), upscale: null });
  d.keystore.set('nous', session(portalJwt({ exp: 1_000, tail: 'old1' }), REFRESH, '2001-01-01T00:00:00.000Z'));
  const one = d.adapters.imagegen.generate('a frog', { width: 64, height: 64 });
  const two = d.adapters.imagegen.generate('a frog', { width: 64, height: 64 });
  await Promise.all([one, two]);
  assert.equal(refreshes, 1);
  const posts = f.calls.filter((c) => String(c.url).includes('fal-queue-gateway'));
  assert.ok(posts.length >= 1);
  for (const c of posts) assert.equal(c.headers.Authorization, `Key ${NEXT}`);
  const portal = f.calls.find((c) => String(c.url).includes('portal.nousresearch.com'));
  assert.equal(portal.headers['x-nous-refresh-token'], REFRESH);
  assert.match(portal.body, /grant_type=refresh_token/);
  assert.ok(!String(portal.body).includes(REFRESH));
  const stored = JSON.parse(d.keystore.get('nous'));
  assert.equal(stored.refresh_token, ROTATED);
  assert.equal(stored.access_token, NEXT);
});
