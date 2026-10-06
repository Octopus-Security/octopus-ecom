'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { makeDeps } = require('./helpers');
const { createCortex, CortexError } = require('../server/llm/cortex');
const { buildPlanContext, MAX_CHARS } = require('../server/plan/context');
const { buildApp } = require('../server/app');
const actor = require('../server/llm/actor');

const quiet = { info() {}, warn() {}, error() {} };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sse = (events) => new Response(events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
function recorder(responder) { const calls = []; const f = async (url, init) => { calls.push({ url, headers: init.headers, body: JSON.parse(init.body) }); return responder(url, init, calls.length); }; f.calls = calls; return f; }
const CORTEX_ENV = { INTERNAL_SECRET: 's3cret-internal', CORTEX_URL: 'http://cortex.test:3010' };

test('cortex provider: request shape, alias per tier, username, no cost counted', async () => {
  const f = recorder(() => json(200, { reply: '{"a":1}', model: 'claude-sonnet-4-6', inputTokens: 10, outputTokens: 5, funding: 'credits' }));
  const c = createCortex({ url: 'http://cortex.test:3010/', secret: 'sh', fetchImpl: f, log: quiet });
  const out = await c.complete({ system: 'SYS', prompt: 'hi', tier: 'standard', json: true, user: 'alice' });
  const call = f.calls[0];
  assert.equal(call.url, 'http://cortex.test:3010/api/internal/llm');
  assert.equal(call.headers['x-internal-secret'], 'sh');
  assert.equal(call.body.username, 'alice');
  assert.equal(call.body.alias, 'sonnet');
  assert.deepEqual(call.body.messages, [{ role: 'user', content: 'hi' }]);
  assert.match(call.body.system, /^SYS[\s\S]*JSON/);
  assert.equal(out.text, '{"a":1}'); assert.equal(out.costCents, 0); assert.equal(out.billedBy, 'cortex');
  await c.complete({ prompt: 'x', tier: 'cheap', user: 'a' }); await c.complete({ prompt: 'x', tier: 'deep', user: 'a' });
  assert.deepEqual(f.calls.slice(1).map((x) => x.body.alias), ['haiku', 'opus']);
});

test('cortex provider: username comes from the request actor, else the fallback; never from the body of a caller', async () => {
  const f = recorder(() => json(200, { reply: 'ok', model: 'm' }));
  const c = createCortex({ secret: 'sh', fallbackUser: 'boss', fetchImpl: f, log: quiet });
  await actor.run('bob', () => c.complete({ prompt: 'x' }));
  await c.complete({ prompt: 'x' });
  assert.deepEqual(f.calls.map((x) => x.body.username), ['bob', 'boss']);
  assert.equal(f.calls[0].url, 'http://octopus-cortex:3010/api/internal/llm');
  const none = createCortex({ secret: 'sh', fetchImpl: f, log: quiet });
  await assert.rejects(() => none.complete({ prompt: 'x' }), (e) => e.code === 'no_user');
});

test('cortex provider: error mapping', async () => {
  const mk = (r) => createCortex({ secret: 'sh', fetchImpl: async () => r(), log: quiet });
  await assert.rejects(() => mk(() => json(402, { error: 'No API key or credits.' })).complete({ prompt: 'x', user: 'a' }), (e) => e instanceof CortexError && e.status === 402 && e.code === 'no_funding' && /credits/.test(e.message));
  await assert.rejects(() => mk(() => json(403, { error: 'Forbidden' })).complete({ prompt: 'x', user: 'a' }), (e) => e.code === 'bad_secret' && !/Forbidden/.test(e.message));
  await assert.rejects(() => mk(() => json(503, { error: 'INTERNAL_SECRET not configured' })).complete({ prompt: 'x', user: 'a' }), (e) => e.code === 'cortex_unconfigured');
  await assert.rejects(() => mk(() => json(500, { error: 'boom' })).complete({ prompt: 'x', user: 'a' }), (e) => e.status === 502 && e.message === 'boom');
  await assert.rejects(() => mk(() => { throw new Error('ECONNREFUSED'); }).complete({ prompt: 'x', user: 'a' }), (e) => e.code === 'unreachable' && /unreachable/.test(e.message));
  await assert.rejects(() => createCortex({ secret: '', fetchImpl: async () => json(200, {}), log: quiet }).complete({ prompt: 'x', user: 'a' }), (e) => e.code === 'no_secret');
});

test('cortex stream: deltas, done metadata, onStart only after acceptance, 402 before any byte', async () => {
  const f = recorder(() => sse([{ text: 'Hel' }, { text: 'lo' }, { done: true, funding: 'own-key', model: 'claude-sonnet-4-6', inputTokens: 3, outputTokens: 2 }, '[DONE]']));
  const c = createCortex({ secret: 'sh', fetchImpl: f, log: quiet });
  const seen = []; let started = 0;
  const out = await c.chat({ system: 'S', messages: [{ role: 'user', content: 'q' }], tier: 'deep', user: 'alice', onStart: () => started++, onText: (t) => seen.push(t) });
  assert.equal(f.calls[0].url, 'http://octopus-cortex:3010/api/internal/llm/stream');
  assert.equal(f.calls[0].body.alias, 'opus'); assert.equal(f.calls[0].body.username, 'alice');
  assert.deepEqual(seen, ['Hel', 'lo']); assert.equal(started, 1);
  assert.equal(out.text, 'Hello'); assert.equal(out.funding, 'own-key');
  let s2 = 0;
  await assert.rejects(() => createCortex({ secret: 'sh', fetchImpl: async () => json(402, { error: 'Credits ran out.' }), log: quiet }).chat({ messages: [{ role: 'user', content: 'q' }], user: 'a', onStart: () => s2++ }), (e) => e.code === 'no_funding');
  assert.equal(s2, 0);
  await assert.rejects(() => createCortex({ secret: 'sh', fetchImpl: async () => sse([{ text: 'par' }, { error: 'overloaded' }]), log: quiet }).chat({ messages: [{ role: 'user', content: 'q' }], user: 'a' }), (e) => e.code === 'stream_error' && e.partial === 'par');
});

test('facade: cortex auto-selected by INTERNAL_SECRET, LLM_PROVIDER=cortex without it falls back to the stub, DRY_RUN stub unchanged', async () => {
  const f = recorder(() => json(200, { reply: 'copy', model: 'claude-sonnet-4-6' }));
  const d = makeDeps(CORTEX_ENV, { fetchImpl: f });
  assert.equal(d.llm.describe().provider, 'cortex');
  const out = await actor.run('carol', () => d.llm.complete({ prompt: 'p', tier: 'standard' }));
  assert.equal(out.costCents, 0); assert.equal(f.calls[0].body.username, 'carol');
  assert.equal(f.calls[0].url, 'http://cortex.test:3010/api/internal/llm');
  const d2 = makeDeps({ LLM_PROVIDER: 'cortex' });
  assert.equal(d2.llm.describe().provider, 'stub'); assert.match(d2.llm.describe().note, /INTERNAL_SECRET/);
  assert.equal(makeDeps({}).llm.describe().provider, 'stub');
  assert.equal(makeDeps({ ...CORTEX_ENV, LLM_PROVIDER: 'openai' }).llm.describe().requested, 'openai');
});

// ---- Plan chat over HTTP: two users, one app ----
function appFor(deps) {
  deps.auth = { identify: (req, _res, next) => { const u = req.get('x-test-user'); if (u) req.user = { username: u }; next(); }, requireOwner: (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Not authenticated' })) };
  const srv = http.createServer(buildApp(deps));
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` })));
}
const req = async (base, user, method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'x-test-user': user, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch { /* sse */ }
  return { status: r.status, data, text };
};

test('plan chat: streams, persists, bills the caller, and another user gets 404', async () => {
  const f = recorder(() => sse([{ text: 'Try ' }, { text: 'mugs.' }, { done: true, funding: 'credits', model: 'claude-sonnet-4-6' }, '[DONE]']));
  const d = makeDeps(CORTEX_ENV, { fetchImpl: f });
  const { srv, base } = await appFor(d);
  try {
    const c = (await req(base, 'alice', 'POST', '/api/plan', {})).data.conversation;
    const m = await req(base, 'alice', 'POST', `/api/plan/${c.id}/messages`, { content: 'What next?', tier: 'deep' });
    assert.equal(m.status, 200); assert.match(m.text, /"text":"Try "/); assert.match(m.text, /"done":true/);
    assert.equal(f.calls[0].body.username, 'alice'); assert.equal(f.calls[0].body.alias, 'opus');
    assert.match(f.calls[0].body.system, /SHOP DATA/);
    const got = await req(base, 'alice', 'GET', `/api/plan/${c.id}`);
    assert.deepEqual(got.data.messages.map((x) => [x.role, x.content]), [['user', 'What next?'], ['assistant', 'Try mugs.']]);
    assert.equal(got.data.conversation.title, 'What next?');
    // user B: 404 on every verb, and the list never shows A's chat
    for (const [method, path, body] of [['GET', `/api/plan/${c.id}`], ['DELETE', `/api/plan/${c.id}`], ['POST', `/api/plan/${c.id}/messages`, { content: 'hi' }]]) {
      assert.equal((await req(base, 'bob', method, path, body)).status, 404, `${method} ${path}`);
    }
    assert.equal(f.calls.length, 1); // bob's attempt never reached the model
    assert.deepEqual((await req(base, 'bob', 'GET', '/api/plan')).data.conversations, []);
    assert.equal((await req(base, 'alice', 'GET', '/api/plan')).data.conversations.length, 1);
    // history sent on turn two is alice's own
    await req(base, 'alice', 'POST', `/api/plan/${c.id}/messages`, { content: 'and pricing?' });
    assert.deepEqual(f.calls[1].body.messages.map((x) => x.content), ['What next?', 'Try mugs.', 'and pricing?']);
    assert.equal((await req(base, 'alice', 'POST', `/api/plan/${c.id}/messages`, { content: 'x', tier: 'huge' })).status, 400);
    assert.equal((await req(base, 'alice', 'GET', '/api/plan/999')).status, 404);
  } finally { srv.close(); }
});

test('plan chat: no funding is a 402 with the reason, and nothing is saved; cortex down is a 502', async () => {
  const d = makeDeps(CORTEX_ENV, { fetchImpl: async () => json(402, { error: 'No API key or credits.' }) });
  const { srv, base } = await appFor(d);
  try {
    const c = (await req(base, 'alice', 'POST', '/api/plan', {})).data.conversation;
    const r = await req(base, 'alice', 'POST', `/api/plan/${c.id}/messages`, { content: 'hello' });
    assert.equal(r.status, 402); assert.equal(r.data.code, 'no_funding'); assert.match(r.data.error, /credits/);
    assert.equal((await req(base, 'alice', 'GET', `/api/plan/${c.id}`)).data.messages.length, 0);
  } finally { srv.close(); }
  const d2 = makeDeps(CORTEX_ENV, { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  const a2 = await appFor(d2);
  try {
    const c = (await req(a2.base, 'alice', 'POST', '/api/plan', {})).data.conversation;
    const r = await req(a2.base, 'alice', 'POST', `/api/plan/${c.id}/messages`, { content: 'hello' });
    assert.equal(r.status, 502); assert.equal(r.data.code, 'unreachable');
  } finally { a2.srv.close(); }
});

test('plan chat: stub provider answers offline; a BYOK provider is refused, not spent', async () => {
  const d = makeDeps({});
  const { srv, base } = await appFor(d);
  try {
    const c = (await req(base, 'alice', 'POST', '/api/plan', {})).data.conversation;
    const r = await req(base, 'alice', 'POST', `/api/plan/${c.id}/messages`, { content: 'hello' });
    assert.equal(r.status, 200); assert.match(r.text, /stub/);
  } finally { srv.close(); }
  const d2 = makeDeps({ OPENAI_API_KEY: 'sk-test-' + 'B'.repeat(30) }, { fetchImpl: async () => { throw new Error('must not call'); } });
  const a2 = await appFor(d2);
  try {
    const c = (await req(a2.base, 'alice', 'POST', '/api/plan', {})).data.conversation;
    const r = await req(a2.base, 'alice', 'POST', `/api/plan/${c.id}/messages`, { content: 'hello' });
    assert.equal(r.status, 503); assert.equal(r.data.code, 'chat_needs_cortex');
  } finally { a2.srv.close(); }
});

test('context builder: small, structured, no credentials, no conversations, fees read through the injected function', () => {
  const d = makeDeps({});
  const empty = buildPlanContext({ db: d.db, settings: d.settings, spend: d.spend });
  assert.match(empty, /Products: none yet/); assert.match(empty, /Sales: none yet/); assert.match(empty, /margin floor \$2\.00/);
  const t = new Date().toISOString();
  for (let i = 0; i < 30; i++) d.db.prepare('INSERT INTO products(stage,brief,niche,title,list_price_cents,projected_margin_cents,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(i % 2 ? 'idea' : 'draft_ready', 'b'.repeat(300), 'cats', `Cat mug ${i} ${'x'.repeat(200)}`, 2400, 612, t, t);
  d.db.prepare('INSERT INTO plan_conversations(owner,title,tier,created_at,updated_at) VALUES(?,?,?,?,?)').run('alice', 'SECRET-CONVO', 'standard', t, t);
  d.credentials.set && d.credentials.set('openai', 'sk-test-' + 'Z'.repeat(30));
  const ctx = buildPlanContext({ db: d.db, settings: d.settings, spend: d.spend });
  assert.ok(ctx.length <= MAX_CHARS, `${ctx.length} chars`);
  assert.match(ctx, /idea 15, draft_ready 15/); assert.match(ctx, /\$6\.12/);
  assert.equal((ctx.match(/^- /gm) || []).length, 8);
  assert.doesNotMatch(ctx, /SECRET-CONVO|sk-test|ZZZZ/);
  const adapted = buildPlanContext({ db: d.db, settings: d.settings, spend: d.spend, fees: () => ({ listingFeeCents: 30, transactionBps: 700, processingBps: 300, processingFixedCents: 25, marginFloorCents: 500 }) });
  assert.match(adapted, /listing \$0\.30, transaction 7\.0%/); assert.match(adapted, /floor \$5\.00/);
});
