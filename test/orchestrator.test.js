'use strict';
// M4: the batch orchestrator. Stops at PENDING_APPROVAL, never publishes without the autopublish conditions, pauses on the spend cap,
// resumes after a (simulated) restart, cancels. Everything runs on stubs or injected fakes: no network, no keys.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeDeps } = require('./helpers');
const { solidPng } = require('../server/png');
const { makeOrchestrator, templateConcepts, jaccard, sigWords } = require('../server/orchestrator');
const { buildApp } = require('../server/app');

const INPUT = { niche: 'cozy woodland animals', count: 3, keywords: 'fox, owl, hedgehog', blueprint: 'stub-tee', printProviderId: 'stub-pp', listPrice: 28 };
const run = async (d, input = INPUT) => { const b = await d.orchestrator.start(input); await d.orchestrator.idle(); return d.orchestrator.view(b.id); };
const stageOf = (d, id) => d.stages.get(id).stage;

/** A fake LLM for ideation / listing copy / QA. kind is decided from the system prompt; `qa` is the issues list (or a raw string). */
function fakeLlm(d, { qa = [], concepts = [], path = 'fallback', onCall = () => {}, model = 'fake-llm', cost = 0 } = {}) {
  d.llm.describe = () => ({ provider: 'openai', routing: { path } });
  d.llm.complete = async ({ system, tier }) => {
    const kind = /review an Etsy/.test(system) ? 'qa' : /write Etsy listing copy/.test(system) ? 'copy' : 'ideation';
    onCall(kind, tier);
    const text = kind === 'qa' ? (typeof qa === 'string' ? qa : JSON.stringify({ issues: qa }))
      : kind === 'copy' ? JSON.stringify({ title: 'Cozy woodland fox print', tags: ['fox print', 'woodland art', 'cozy gift'], description: 'An original fox illustration, printed on demand.' })
      : JSON.stringify({ concepts });
    return { text, model: `${model}-${tier}`, costCents: cost };
  };
}

/** An image generator that writes a real PNG of w x h and charges `cents`; `gate` lets a test hold it. */
function fakeImages(d, { w = 4500, h = 5400, cents = 0, gate = null, calls = { n: 0 } } = {}) {
  d.adapters.imagegen = {
    async generate() {
      calls.n++;
      if (gate) await gate();
      const dir = path.join(d.dataDir, 'images'); fs.mkdirSync(dir, { recursive: true });
      const file = `f-${calls.n}-${Math.random().toString(16).slice(2)}.png`; fs.writeFileSync(path.join(dir, file), solidPng(w, h));
      return { images: [{ file, width: w, height: h }], costCents: cents, model: 'fake-image' };
    },
    describe() { return { methods: { generate: 'real' } }; },
  };
  return calls;
}

test('stops at PENDING_APPROVAL: N distinct concepts, every product at PENDING_APPROVAL, nothing approved or published, nothing sent to publish', async () => {
  const d = makeDeps();
  let publishes = 0; const pub = d.adapters.pod.publish; d.adapters.pod.publish = async (...a) => { publishes++; return pub(...a); };
  d.publisher.publish = async () => { throw new Error('a batch must not publish'); };
  const v = await run(d);
  assert.equal(v.status, 'done'); assert.equal(v.items.length, 3);
  assert.equal(new Set(v.items.map(i => i.concept)).size, 3);
  for (const i of v.items) {
    assert.equal(i.status, 'done'); assert.equal(i.stage, 'PENDING_APPROVAL'); assert.equal(stageOf(d, i.productId), 'PENDING_APPROVAL');
    assert.equal(i.step, 'pending_approval');
    assert.deepEqual(i.models, { concept: 'stub-llm', image: 'stub-png', copy: 'stub-copy' }, 'model per step recorded');
    assert.equal(i.costCents, 0);
  }
  assert.equal(v.counts.atPendingApproval, 3);
  assert.equal(publishes, 0);
  assert.equal(d.db.prepare("SELECT COUNT(*) n FROM products WHERE stage IN ('approved','published','live')").get().n, 0);
  assert.equal(d.db.prepare("SELECT COUNT(*) n FROM events WHERE kind='stage' AND stage_to IN ('approved','published','live')").get().n, 0);
  assert.equal(d.db.prepare("SELECT COUNT(*) n FROM events WHERE kind='stage' AND stage_to = 'PENDING_APPROVAL' AND actor = 'agent'").get().n, 3);
  assert.equal(d.db.prepare("SELECT COUNT(*) n FROM listings WHERE status != 'draft'").get().n, 0);
  // each product carries the batch's settings and a real design at the print size
  const p = d.stages.get(v.items[0].productId);
  assert.equal(p.list_price_cents, 2800); assert.equal(p.blueprint, 'stub-tee'); assert.equal(p.niche, 'cozy woodland animals');
  assert.equal(d.pipeline.checkPrint(p.id).ok, true);
});

test('validation: count cap, required fields, a branded niche is refused before anything is spent, unreadable blueprint', async () => {
  const d = makeDeps();
  await assert.rejects(d.orchestrator.start({ ...INPUT, count: 26 }), e => e.status === 400 && e.code === 'count_cap');
  await assert.rejects(d.orchestrator.start({ ...INPUT, count: 0 }), /count/);
  await assert.rejects(d.orchestrator.start({ ...INPUT, niche: '  ' }), /niche is required/);
  await assert.rejects(d.orchestrator.start({ ...INPUT, listPrice: 0 }), /listPrice/);
  await assert.rejects(d.orchestrator.start({ ...INPUT, blueprint: '' }), /blueprint/);
  await assert.rejects(d.orchestrator.start({ ...INPUT, concurrency: 3 }), /concurrency/);
  await assert.rejects(d.orchestrator.start({ ...INPUT, niche: 'pokemon cards' }), e => e.code === 'niche_blocklisted' && e.status === 422);
  await assert.rejects(d.orchestrator.start({ ...INPUT, keywords: 'fox, nike' }), e => e.code === 'niche_blocklisted');
  await assert.rejects(d.orchestrator.start({ ...INPUT, storeId: 999 }), /storeId/);
  d.adapters.pod.listVariants = async () => { throw new Error('boom'); };
  await assert.rejects(d.orchestrator.start(INPUT), e => e.code === 'pod_unreadable');
  assert.equal(d.db.prepare('SELECT COUNT(*) n FROM batches').get().n, 0);
  assert.equal(d.db.prepare('SELECT COUNT(*) n FROM products').get().n, 0);
});

test('concepts: LLM ideas are used, brand/duplicate concepts are dropped and counted, templates top up; the model never needs to be right', async () => {
  const d = makeDeps();
  const seen = [];
  fakeLlm(d, { model: 'fake-llm', cost: 3, concepts: [
      'A sleepy red fox curled in autumn leaves, soft watercolour, warm palette',
      'A sleepy red fox curled up in the autumn leaves, soft watercolour, warm palette',  // near duplicate
      'A Pikachu wearing a woodland scarf in flat vector style',                           // brand
      'A barn owl on a moonlit branch, two-colour risograph, deep blue and cream',
      'x',                                                                                  // too short
  ], onCall: (k, t) => seen.push({ k, t }) });
  const v = await run(d, { ...INPUT, count: 4 });
  assert.equal(v.items.length, 4);
  assert.ok(v.items[0].concept.startsWith('A sleepy red fox')); assert.ok(v.items.some(i => /barn owl/.test(i.concept)));
  assert.ok(!v.items.some(i => /pikachu/i.test(i.concept)));
  assert.equal(v.ideation.droppedBlocklist >= 1, true); assert.equal(v.ideation.droppedDuplicate >= 1, true);
  assert.equal(v.ideation.source, 'llm+template'); assert.equal(v.ideation.model, 'fake-llm-standard');
  assert.ok(v.ideation.costCents >= 3);
  assert.ok(d.db.prepare("SELECT COUNT(*) n FROM costs WHERE kind='llm' AND product_id IS NULL AND note LIKE 'batch % ideation%'").get().n >= 1, 'ideation cost is recorded');
  assert.ok(seen.some(s => s.k === 'ideation'));
});

test('templates are deterministic, varied and original; jaccard dedupe behaves', () => {
  const a = templateConcepts({ niche: 'n', keywords: ['fox', 'owl'], count: 8 }); const b = templateConcepts({ niche: 'n', keywords: ['fox', 'owl'], count: 8 });
  assert.deepEqual(a, b); assert.equal(new Set(a).size, 8);
  assert.ok(a.some(c => c.startsWith('fox,')) && a.some(c => c.startsWith('owl,')), 'spread across subjects');
  assert.equal(jaccard(sigWords('red fox in leaves'), sigWords('red fox in leaves')), 1);
  assert.ok(jaccard(sigWords('red fox in leaves'), sigWords('blue whale at sea')) < 0.2);
});

test('a second batch of the same niche does not repeat the first batch\'s concepts', async () => {
  const d = makeDeps();
  const a = await run(d); const b = await run(d);
  const first = new Set(a.items.map(i => i.concept));
  assert.ok(b.items.every(i => !first.has(i.concept)));
  assert.ok(b.ideation.droppedDuplicate >= 3);
});

test('NEVER publishes unless store autopublish AND DRY_RUN off AND no flags AND QA ran; with all of them it goes through approve + publish', async () => {
  // a POD stub that reports a real-looking (non-estimate) cost, so no pod_cost_estimated flag exists
  const realish = d => { const w = d.adapters.pod; const cp = w.createProduct; d.adapters.pod = { ...w, describe: w.describe, listVariants: (...a) => w.listVariants(...a), createProduct: async (o) => { const r = await cp(o); return { ...r, faked: false, estimated: false, variants: r.variants.map(x => ({ ...x, estimated: false })) }; } }; };
  const store = (d, auto) => Number(d.db.prepare("INSERT INTO stores(platform,name,autopublish,created_at) VALUES('etsy','s',?,?)").run(auto, new Date().toISOString()).lastInsertRowid);
  const qaLlm = (d, issues = []) => fakeLlm(d, { qa: issues });
  const published = d => { const calls = []; d.publisher.publish = async (id, o) => { calls.push([id, o.actor]); d.stages.transition(id, 'published', { actor: o.actor, note: 'fake publish' }); return { product: d.stages.get(id) }; }; return calls; };
  const cases = [
    ['autopublish off', { env: { DRY_RUN: 'false' }, auto: 0, issues: [] }],
    ['DRY_RUN on', { env: {}, auto: 1, issues: [] }],
    ['a QA flag', { env: { DRY_RUN: 'false' }, auto: 1, issues: [{ type: 'ip_risk', detail: 'reads like a known slogan' }] }],
  ];
  for (const [name, c] of cases) {
    const d = makeDeps(c.env); realish(d); qaLlm(d, c.issues); const calls = published(d);
    const v = await run(d, { ...INPUT, count: 2, storeId: store(d, c.auto) });
    assert.equal(calls.length, 0, name);
    assert.ok(v.items.every(i => i.stage === 'PENDING_APPROVAL'), name);
  }
  // QA did not run (stub LLM) -> no autopublish even with everything else in place
  { const d = makeDeps({ DRY_RUN: 'false' }); realish(d); const calls = published(d);
    const v = await run(d, { ...INPUT, count: 2, storeId: store(d, 1) });
    assert.equal(calls.length, 0, 'stub LLM: QA skipped');
    assert.ok(v.items.every(i => i.stage === 'PENDING_APPROVAL' && i.qa === 'skipped')); }
  // everything in place
  const d = makeDeps({ DRY_RUN: 'false' }); realish(d); qaLlm(d, []); const calls = published(d);
  const v = await run(d, { ...INPUT, count: 2, storeId: store(d, 1) });
  assert.equal(calls.length, 2); assert.ok(calls.every(c => c[1] === 'agent'));
  assert.ok(v.items.every(i => i.step === 'published' && i.qa === 'ran' && i.stage === 'published'));
  assert.ok(d.db.prepare("SELECT 1 FROM events WHERE kind='stage' AND stage_to='approved' AND actor='agent'").get(), 'approval went through stages.transition by the agent');
  // a failed autopublish steps back to the human gate
  const d2 = makeDeps({ DRY_RUN: 'false' }); realish(d2); qaLlm(d2, []);
  d2.publisher.publish = async () => { throw new Error('Printify said no'); };
  const v2 = await run(d2, { ...INPUT, count: 1, storeId: store(d2, 1) });
  assert.equal(v2.items[0].stage, 'PENDING_APPROVAL'); assert.match(v2.items[0].error, /autopublish stopped: Printify said no/);
});

test('QA (deep tier when a tier table exists) can only ADD flags; a QA that finds nothing removes none', async () => {
  const mk = (path) => {
    const d = makeDeps(); const tiers = [];
    fakeLlm(d, { path, onCall: (k, t) => { if (k !== 'copy') tiers.push([k, t]); }, cost: 1, qa: [{ type: 'originality', detail: 'looks like a famous poster' }, { type: 'weird', detail: 'odd' }, { type: 'ip_risk' }] });
    return { d, tiers };
  };
  const { d, tiers } = mk('router');
  const v = await run(d, { ...INPUT, count: 1 });
  assert.deepEqual(tiers, [['ideation', 'cheap'], ['qa', 'deep']], 'router table present: cheap for ideas, deep for QA (copy stays standard)');
  const codes = v.items[0].flags.map(f => f.code);
  assert.ok(codes.includes('qa_originality') && codes.includes('qa_other'), codes.join());
  assert.ok(!codes.includes('qa_ip_risk'), 'an issue with no detail is ignored');
  assert.equal(v.items[0].models.qa, 'fake-llm-deep'); assert.equal(v.items[0].models.copy, 'fake-llm-standard'); assert.ok(v.items[0].costCents >= 2, 'copy + QA cost attributed to the product');
  assert.match(require('../server/domain/stages').approvalSummary(d.stages.get(v.items[0].productId)), /AUTOMATED REVIEW raised: qa_originality/);
  const f = mk('fallback'); await run(f.d, { ...INPUT, count: 1 });
  assert.deepEqual(f.tiers, [['ideation', 'standard'], ['qa', 'standard']], 'no tier table: one tier, not a silent deep');
  // add-only: existing flags survive, a clean QA removes nothing, re-adding an existing code keeps the original
  const p = d.stages.get(v.items[0].productId);
  d.db.prepare('UPDATE products SET flags = ? WHERE id = ?').run(JSON.stringify([{ code: 'blocklist', detail: 'nike [brief]' }]), p.id);
  const after = d.pipeline.addFlags(p.id, [{ code: 'qa_x', detail: 'new' }, { code: 'blocklist', detail: 'REPLACED?' }]);
  assert.deepEqual(after.map(x => [x.code, x.detail]), [['blocklist', 'nike [brief]'], ['qa_x', 'new']]);
  d.pipeline.addFlags(p.id, []);
  assert.equal(JSON.parse(d.stages.get(p.id).flags).length, 2);
  // and the QA pass itself, on a product that already carries a flag, only adds
  const clean = mk('fallback'); clean.d.llm.complete = (orig => async (a) => (/review an Etsy/.test(a.system) ? { text: '{"issues":[]}', model: 'm', costCents: 0 } : orig(a)))(clean.d.llm.complete);
  const cv = await run(clean.d, { ...INPUT, count: 1 });
  assert.equal(cv.items[0].qa, 'ran'); assert.ok(!cv.items[0].flags.some(x => x.code.startsWith('qa_')));
});

test('QA that cannot run (error / bad JSON) adds no flag but is recorded, and blocks autopublish', async () => {
  for (const qa of ['not json at all', '{"nothing":1}']) {
    const d = makeDeps(); fakeLlm(d, { qa });
    const v = await run(d, { ...INPUT, count: 1 });
    assert.equal(v.items[0].qa, 'error'); assert.equal(v.items[0].status, 'done'); assert.equal(v.items[0].stage, 'PENDING_APPROVAL');
    assert.ok(!v.items[0].flags.some(f => f.code.startsWith('qa_')));
    assert.ok(d.db.prepare("SELECT 1 FROM events WHERE product_id = ? AND note LIKE 'QA could not run%'").get(v.items[0].productId));
  }
  const d = makeDeps(); fakeLlm(d); const orig = d.llm.complete;
  d.llm.complete = async (a) => { if (/review an Etsy/.test(a.system)) throw new Error('provider 503'); return orig(a); };
  const v = await run(d, { ...INPUT, count: 1 });
  assert.equal(v.items[0].qa, 'error'); assert.equal(v.items[0].stage, 'PENDING_APPROVAL');
});

test('SPEND CAP: the batch pauses (paused_cap), the item is pending not failed, no stub fallback; resume continues exactly where it stopped', async () => {
  const d = makeDeps();
  d.settings.set('daily_spend_cap_cents', 100);
  const calls = fakeImages(d, { cents: 60 });
  const b = await d.orchestrator.start({ ...INPUT, count: 4 }); await d.orchestrator.idle();
  let v = d.orchestrator.view(b.id);
  assert.equal(v.status, 'paused_cap'); assert.match(v.statusDetail, /spend cap/);
  assert.equal(v.items.filter(i => i.status === 'done').length, 2, 'two images fit before the guard saw 120 >= 100');
  assert.equal(v.items.filter(i => i.status === 'pending').length, 2);
  assert.equal(v.items.filter(i => i.status === 'failed').length, 0, 'a cap is a pause, never a failure');
  assert.equal(calls.n, 2, 'no image was requested once the cap was reached');
  assert.equal(d.db.prepare("SELECT paused_day FROM batches WHERE id = ?").get(b.id).paused_day.length, 10);
  assert.equal(d.db.prepare("SELECT COUNT(*) n FROM products WHERE stage = 'failed'").get().n, 0);
  // a second pause attempt does nothing new; resuming by hand while still capped says so and pauses again at the first paid step
  v = (d.orchestrator.resume(b.id), await d.orchestrator.idle(), d.orchestrator.view(b.id));
  assert.equal(v.status, 'paused_cap'); assert.equal(calls.n, 2);
  // the cap is raised: resume finishes the rest
  d.settings.set('daily_spend_cap_cents', 10000);
  d.orchestrator.resume(b.id); await d.orchestrator.idle();
  v = d.orchestrator.view(b.id);
  assert.equal(v.status, 'done'); assert.equal(v.counts.atPendingApproval, 4); assert.equal(calls.n, 4);
  assert.deepEqual(v.items.map(i => i.costCents), [60, 60, 60, 60], 'per-item cost recorded');
  assert.ok(v.items.every(i => i.models.image === 'fake-image'));
  assert.equal(v.costCents, 240);
  // only a paused batch can be resumed
  assert.throws(() => d.orchestrator.resume(b.id), e => e.status === 409);
});

test('SPEND CAP: the real adapters refuse inside (SpendCapError) and that pauses the batch too; the next ET day resumes by itself (tick)', async () => {
  const d = makeDeps();
  let n = 0;
  d.adapters.imagegen = { async generate() { n++; const { SpendCapError } = require('../server/spend'); throw new SpendCapError('Daily spend cap reached (inside the adapter)', { capCents: 1, todayCents: 1 }); }, describe() { return { methods: { generate: 'stub' } }; } };
  const b = await d.orchestrator.start({ ...INPUT, count: 2 }); await d.orchestrator.idle();
  assert.equal(d.orchestrator.view(b.id).status, 'paused_cap'); assert.equal(n, 1);
  assert.equal(d.orchestrator.view(b.id).items.filter(i => i.status === 'failed').length, 0);
  assert.equal(d.orchestrator.tick(), 0, 'same day: not resumed automatically');
  d.db.prepare("UPDATE batches SET paused_day = '2000-01-01' WHERE id = ?").run(b.id); // "yesterday"
  fakeImages(d); // the cap condition is gone
  assert.equal(d.orchestrator.tick(), 1); await d.orchestrator.idle();
  assert.equal(d.orchestrator.view(b.id).status, 'done');
});

test('SPEND CAP during ideation pauses the batch with no items; resume ideates again', async () => {
  const d = makeDeps();
  d.llm.describe = () => ({ provider: 'openai', routing: { path: 'fallback' } });
  d.settings.set('daily_spend_cap_cents', 0);
  let called = 0; d.llm.complete = async () => { called++; return { text: '{"concepts":[]}', model: 'm', costCents: 0 }; };
  const b = await d.orchestrator.start({ ...INPUT, count: 2 }); await d.orchestrator.idle();
  let v = d.orchestrator.view(b.id);
  assert.equal(v.status, 'paused_cap'); assert.equal(v.items.length, 0); assert.equal(called, 0);
  d.settings.set('daily_spend_cap_cents', 10000); d.orchestrator.resume(b.id); await d.orchestrator.idle();
  v = d.orchestrator.view(b.id); assert.equal(v.status, 'done'); assert.equal(v.items.length, 2);
});

/** Build the on-disk state a crash leaves: item 1 done, item 2 'running' with a paid design, item 3 pending. */
async function crashed(d, { attempts = 1 } = {}) {
  const calls = fakeImages(d, { cents: 5 });
  const t = new Date().toISOString();
  const bid = Number(d.db.prepare(`INSERT INTO batches(niche,keywords,requested_count,blueprint,print_provider_id,variant_ids,list_price_cents,shipping_cents,status,concurrency,created_at,updated_at)
    VALUES('cozy','[]',3,'stub-tee','stub-pp','[]',2800,0,'running',1,?,?)`).run(t, t).lastInsertRowid);
  const item = (idx, status, pid, att) => Number(d.db.prepare('INSERT INTO batch_items(batch_id,idx,concept,status,step,attempts,product_id,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(bid, idx, `concept number ${idx} with unique words ${idx}${idx}`, status, 'x', att, pid, t).lastInsertRowid);
  const mk = async (brief, upTo) => {
    const p = d.pipeline.create({ brief, listPrice: 28 }); await d.pipeline.selectPod(p.id, { blueprint: 'stub-tee', providerId: 'stub-pp' });
    if (upTo >= 1) await d.pipeline.generateDesign(p.id);
    return p.id;
  };
  const p2 = await mk('concept number 2 with unique words 22', 1);
  item(1, 'done', null, 1); const i2 = item(2, 'running', p2, attempts); const i3 = item(3, 'pending', null, 0);
  return { bid, i2, i3, p2, calls };
}

test('RESTART: running items are marked interrupted and retried ONCE from their stage (no second paid design); pending items continue', async () => {
  const d = makeDeps();
  const { bid, i2, i3, p2, calls } = await crashed(d);
  assert.equal(calls.n, 1);
  const o = makeOrchestrator({ db: d.db, pipeline: d.pipeline, stages: d.stages, adapters: d.adapters, llm: d.llm, spend: d.spend, settings: d.settings, publisher: d.publisher, dryRun: d.dryRun, cfg: d.cfg, log: d.log }); // a fresh process
  const r = o.recover();
  assert.deepEqual(r, { interrupted: 1, retried: 1, failed: 0, ideating: 0 });
  await o.idle();
  const v = o.view(bid);
  assert.equal(v.status, 'done');
  assert.equal(v.items.find(i => i.id === i2).attempts, 2); assert.equal(v.items.find(i => i.id === i2).stage, 'PENDING_APPROVAL');
  assert.equal(d.db.prepare('SELECT COUNT(*) n FROM designs WHERE product_id = ?').get(p2).n, 1, 'the design already paid for was reused');
  assert.equal(calls.n, 2, 'only item 3 generated a design after the restart');
  assert.equal(v.items.find(i => i.id === i3).stage, 'PENDING_APPROVAL');
  assert.equal(d.db.prepare("SELECT status FROM batch_items WHERE batch_id = ? AND idx = 1").get(bid).status, 'done');
});

test('RESTART: an item interrupted a second time is failed, not retried again; an interrupted ideation is redone', async () => {
  const d = makeDeps();
  const { bid, i2 } = await crashed(d, { attempts: 2 });
  const o = makeOrchestrator({ db: d.db, pipeline: d.pipeline, stages: d.stages, adapters: d.adapters, llm: d.llm, spend: d.spend, settings: d.settings, publisher: d.publisher, dryRun: d.dryRun, cfg: d.cfg, log: d.log });
  assert.deepEqual(o.recover(), { interrupted: 1, retried: 0, failed: 1, ideating: 0 }); await o.idle();
  const it = o.view(bid).items.find(i => i.id === i2);
  assert.equal(it.status, 'failed'); assert.match(it.error, /interrupted twice/);
  // ideation
  const t = new Date().toISOString();
  const id2 = Number(d.db.prepare(`INSERT INTO batches(niche,keywords,requested_count,blueprint,print_provider_id,variant_ids,list_price_cents,shipping_cents,status,concurrency,created_at,updated_at)
    VALUES('cozy owls','[]',2,'stub-tee','stub-pp','[]',2800,0,'ideating',1,?,?)`).run(t, t).lastInsertRowid);
  assert.equal(o.recover().ideating, 1); await o.idle();
  assert.equal(o.view(id2).status, 'done'); assert.equal(o.view(id2).items.length, 2);
});

test('CANCEL: the step in flight finishes, nothing new starts, pending items are cancelled, no further products are created', async () => {
  const d = makeDeps();
  let release; const held = new Promise(r => { release = r; });
  let started; const startedP = new Promise(r => { started = r; });
  const calls = fakeImages(d, { gate: async () => { started(); await held; } });
  const b = await d.orchestrator.start({ ...INPUT, count: 5 });
  await startedP;
  assert.equal(d.orchestrator.view(b.id).items[0].status, 'running');
  const cancelled = d.orchestrator.cancel(b.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.throws(() => d.orchestrator.cancel(b.id), e => e.status === 409);
  release(); await d.orchestrator.idle();
  const v = d.orchestrator.view(b.id);
  assert.equal(v.status, 'cancelled'); assert.equal(calls.n, 1);
  assert.deepEqual(v.items.map(i => i.status), ['cancelled', 'cancelled', 'cancelled', 'cancelled', 'cancelled']);
  assert.equal(v.items.filter(i => i.productId).length, 1, 'only the item already in flight had a product');
  assert.equal(d.db.prepare("SELECT COUNT(*) n FROM products").get().n, 1);
  assert.equal(d.db.prepare("SELECT COUNT(*) n FROM products WHERE stage IN ('approved','published','live')").get().n, 0);
  // cancel is also fine while ideating, and a cancelled batch never resumes
  assert.throws(() => d.orchestrator.resume(b.id), e => e.status === 409);
  const d2 = makeDeps(); let rel2; d2.llm.describe = () => ({ provider: 'openai', routing: {} }); d2.llm.complete = () => new Promise(r => { rel2 = () => r({ text: '{"concepts":[]}', model: 'm', costCents: 0 }); });
  const b2 = await d2.orchestrator.start(INPUT); d2.orchestrator.cancel(b2.id); rel2(); await d2.orchestrator.idle();
  assert.equal(d2.orchestrator.view(b2.id).items.length, 0); assert.equal(d2.orchestrator.view(b2.id).status, 'cancelled');
});

test('a design too small to print fails THAT item with print_not_ready; the rest of the batch carries on; nothing is published', async () => {
  const d = makeDeps();
  let n = 0; const calls = fakeImages(d);
  const gen = d.adapters.imagegen.generate;
  d.adapters.imagegen.generate = async (...a) => { n++; if (n === 2) { const r = fakeImages(d, { w: 3600, h: 5400 }); const out = await d.adapters.imagegen.generate(...a); fakeImages(d, { calls }); d.adapters.imagegen.generate = gen; return out; } return gen(...a); };
  const v = await run(d, { ...INPUT, count: 3 });
  assert.equal(v.status, 'done');
  assert.deepEqual(v.items.map(i => i.status), ['done', 'failed', 'done']);
  assert.match(v.items[1].error, /^print_not_ready: /); assert.match(v.items[1].error, /needs 4500x5400px/);
  assert.equal(v.items[1].stage, 'design_generated'); assert.ok(v.items[1].flags.some(f => f.code === 'print_not_ready'));
  assert.equal(d.db.prepare("SELECT COUNT(*) n FROM products WHERE stage IN ('approved','published','live')").get().n, 0);
});

test('an adapter failure fails that item with the reason; others continue', async () => {
  const d = makeDeps();
  let n = 0; const g = d.adapters.imagegen.generate;
  d.adapters.imagegen.generate = async (...a) => { if (++n === 1) throw new Error('HTTP 500 from provider'); return g(...a); };
  const v = await run(d, { ...INPUT, count: 2 });
  assert.deepEqual(v.items.map(i => i.status), ['failed', 'done']); assert.match(v.items[0].error, /image generation failed: HTTP 500/);
  assert.equal(v.status, 'done');
});

test('over HTTP: POST /api/batch -> 202, poll to done, all at PENDING_APPROVAL; list; validation errors; cancel/resume refusals', async () => {
  const d = makeDeps();
  const server = await new Promise(r => { const s = buildApp(d).listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const j = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json() }; };
  try {
    assert.equal((await j('POST', '/api/batch', { ...INPUT, count: 99 })).status, 400);
    assert.equal((await j('POST', '/api/batch', { ...INPUT, niche: 'nike shoes' })).status, 422);
    const r = await j('POST', '/api/batch', INPUT);
    assert.equal(r.status, 202); assert.equal(r.body.batch.status, 'ideating');
    const id = r.body.batch.id;
    let b; for (let i = 0; i < 100; i++) { b = (await j('GET', `/api/batch/${id}`)).body.batch; if (b.status === 'done') break; await new Promise(x => setTimeout(x, 20)); }
    assert.equal(b.status, 'done'); assert.equal(b.counts.atPendingApproval, 3);
    assert.equal((await j('GET', '/api/batch')).body.batches[0].id, id);
    assert.equal((await j('GET', '/api/batch/999')).status, 404);
    assert.equal((await j('POST', `/api/batch/${id}/cancel`, {})).status, 409);
    assert.equal((await j('POST', `/api/batch/${id}/resume`, {})).status, 409);
    const board = (await j('GET', '/api/products')).body;
    assert.equal(board.columns.PENDING_APPROVAL.length, 3); assert.equal(board.columns.published.length + board.columns.approved.length + board.columns.live.length, 0);
    // a single product whose brief names a blocked brand is flagged on the board (and costs nothing to find out)
    const bad = await j('POST', '/api/products', { brief: 'a Pikachu portrait', listPrice: 20 });
    const card = (await j('GET', '/api/products')).body.columns.idea.find(c => c.id === bad.body.product.id);
    assert.ok(card.flags.some(f => f.code === 'blocklist' && /pikachu/.test(f.detail)));
  } finally { server.close(); }
});

test('concurrency 2 runs two items at once and still ends at PENDING_APPROVAL for all', async () => {
  const d = makeDeps();
  let live = 0; let peak = 0;
  const g = d.adapters.imagegen.generate;
  d.adapters.imagegen.generate = async (...a) => { live++; peak = Math.max(peak, live); await new Promise(r => setTimeout(r, 15)); try { return await g(...a); } finally { live--; } };
  const v = await run(d, { ...INPUT, count: 4, concurrency: 2 });
  assert.equal(peak, 2); assert.equal(v.counts.atPendingApproval, 4);
  const d1 = makeDeps(); let live1 = 0; let peak1 = 0; const g1 = d1.adapters.imagegen.generate;
  d1.adapters.imagegen.generate = async (...a) => { live1++; peak1 = Math.max(peak1, live1); await new Promise(r => setTimeout(r, 5)); try { return await g1(...a); } finally { live1--; } };
  await run(d1, { ...INPUT, count: 3 }); assert.equal(peak1, 1, 'default concurrency is 1');
});
