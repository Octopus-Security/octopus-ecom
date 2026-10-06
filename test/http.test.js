'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeHttp, HttpError, parseRetryAfter } = require('../server/adapters/http');

const res = (status, body = '{}', headers = {}) => ({ status, text: async () => body, headers: { get: (k) => headers[k.toLowerCase()] ?? null } });
function harness(responses, opts = {}) {
  const calls = []; const sleeps = []; const logs = [];
  let i = 0;
  const fetchImpl = async (url, init) => { calls.push({ url, init }); const r = responses[Math.min(i++, responses.length - 1)]; if (r instanceof Error) throw r; return r; };
  const http = makeHttp({ fetchImpl, sleep: async (ms) => { sleeps.push(ms); }, random: () => 1, log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) }, ...opts });
  return { http, calls, sleeps, logs };
}

test('backs off on 429 honouring Retry-After, then succeeds', async () => {
  const h = harness([res(429, '', { 'retry-after': '2' }), res(200, '{"ok":1}')]);
  const out = await h.http.request('https://api.example.test/v1/x?token=SECRET', { method: 'GET' });
  assert.equal(out.status, 200); assert.deepEqual(out.json(), { ok: 1 });
  assert.equal(h.calls.length, 2);
  assert.ok(h.sleeps.includes(2000), `slept ${h.sleeps}`);
});
test('exponential backoff with jitter on 5xx for GET; gives up after maxRetries with an HttpError', async () => {
  const h = harness([res(503, 'down')], { maxRetries: 3, baseDelayMs: 100 });
  await assert.rejects(h.http.request('https://api.example.test/a'), (e) => e instanceof HttpError && e.status === 503);
  assert.equal(h.calls.length, 4);
  const delays = h.sleeps.filter(s => s >= 100);
  assert.deepEqual(delays, [100, 200, 400]); // random()=1 => full delay
});
test('Retry-After as an HTTP date is honoured', () => {
  assert.equal(parseRetryAfter('Wed, 21 Oct 2026 07:28:05 GMT', Date.parse('Wed, 21 Oct 2026 07:28:00 GMT')), 5000);
  assert.equal(parseRetryAfter('3', 0), 3000);
  assert.equal(parseRetryAfter('junk', 0), null);
});
test('a POST is retried on 429 but NOT on 5xx (it may have been processed)', async () => {
  const a = harness([res(429, '', { 'retry-after': '1' }), res(201)]);
  assert.equal((await a.http.request('https://api.example.test/p', { method: 'POST', json: { a: 1 } })).status, 201);
  assert.equal(a.calls.length, 2);
  assert.equal(a.calls[0].init.body, '{"a":1}');
  const b = harness([res(500, 'oops'), res(201)]);
  await assert.rejects(b.http.request('https://api.example.test/p', { method: 'POST', json: {} }), HttpError);
  assert.equal(b.calls.length, 1);
});
test('4xx other than 429 fails immediately', async () => {
  const h = harness([res(404, 'nope')]);
  await assert.rejects(h.http.request('https://api.example.test/z'), (e) => e.status === 404);
  assert.equal(h.calls.length, 1);
});
test('network errors retry for GET', async () => {
  const h = harness([new Error('ECONNRESET'), res(200)]);
  assert.equal((await h.http.request('https://api.example.test/z')).status, 200);
  assert.equal(h.calls.length, 2);
});
test('timeout aborts a hung request', async () => {
  const fetchImpl = (url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))));
  const http = makeHttp({ fetchImpl, sleep: async () => {}, timeoutMs: 20, maxRetries: 0, log: { info() {}, warn() {} } });
  await assert.rejects(http.request('https://api.example.test/hang'), /timed out after 20ms/);
});
test('per-host token bucket delays requests beyond the burst (fake clock)', async () => {
  let t = 0; const sleeps = [];
  const http = makeHttp({
    fetchImpl: async () => res(200), now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; },
    ratePerSec: 2, burst: 2, log: { info() {}, warn() {} },
  });
  for (let i = 0; i < 4; i++) await http.request('https://one.example.test/x');
  assert.equal(sleeps.length, 2, `sleeps: ${sleeps}`);
  assert.ok(sleeps.every(s => s >= 500));
  sleeps.length = 0;
  await http.request('https://other.example.test/x'); // separate bucket
  assert.equal(sleeps.length, 0);
});
test('logs never include the query string or headers', async () => {
  const h = harness([res(503), res(503)], { maxRetries: 1, baseDelayMs: 1 });
  await assert.rejects(h.http.request('https://api.example.test/v1/x?api_key=TOPSECRET', { headers: { Authorization: 'Bearer TOPSECRET' } }));
  assert.ok(h.logs.length > 0);
  assert.ok(!h.logs.join('\n').includes('TOPSECRET'));
});
