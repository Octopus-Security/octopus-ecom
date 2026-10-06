'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeDeps } = require('./helpers');
const { SpendCapError } = require('../server/spend');

const mk = (env, tweak) => { const d = makeDeps(env); if (tweak) tweak(d); return d; };
const stageOf = (d, id) => d.stages.get(id).stage;

test('happy path with stubs: idea -> design_generated, design + copy rows, events, stays at design_generated', async () => {
  const d = mk();
  const p = d.pipeline.create({ brief: 'a cozy fox in a scarf', niche: 'cozy animals', keywords: ['fox', 'scarf', 'fox'], listPrice: 24.5 });
  assert.equal(p.stage, 'idea'); assert.equal(p.list_price_cents, 2450); assert.deepEqual(JSON.parse(p.keywords), ['fox', 'scarf']);
  const g = await d.pipeline.generateDesign(p.id);
  assert.equal(g.stage, 'design_generated'); assert.equal(g.model_used, 'stub-png');
  const c = await d.pipeline.draftCopy(p.id);
  assert.equal(c.product.stage, 'design_generated', 'stays put until M2 makes mockups');
  const det = d.pipeline.detail(p.id);
  assert.equal(det.designs.length, 1); assert.equal(det.designs[0].width, 4500); assert.equal(det.designs[0].height, 5400);
  assert.ok(det.copy.title && det.copy.tags.length <= 13 && det.copy.description);
  assert.equal(det.product.title, det.copy.title);
  assert.deepEqual(det.events.filter(e => e.kind === 'stage').map(e => e.stageTo), ['idea', 'design_generated']);
  assert.ok(det.events.some(e => e.kind === 'note' && /copy drafted/.test(e.note)));
  assert.equal(det.costTotalCents, 0);
  const rows = d.db.prepare("SELECT status, platform FROM listings WHERE product_id = ?").all(p.id);
  assert.deepEqual(rows.map(r => ({ ...r })), [{ status: 'draft', platform: 'etsy' }]);
  // drafting again updates the one draft instead of piling up rows
  await d.pipeline.draftCopy(p.id);
  assert.equal(d.db.prepare('SELECT COUNT(*) n FROM listings WHERE product_id = ?').get(p.id).n, 1);
});

test('costs: image and llm rows are written with the ACTUAL cost, attributed to the product', async () => {
  const d = mk({}, d => {
    d.adapters.imagegen = { generate: async () => ({ images: [{ file: 'x.png', width: 1024, height: 1536, nativeWidth: 1024, nativeHeight: 1536 }], costCents: 25, model: 'gpt-image-1' }) };
    d.adapters.listingcopy = { generate: async () => ({ title: 'T', tags: ['a'], description: 'D', costCents: 2, model: 'gpt-4.1-mini' }) };
  });
  const p = d.pipeline.create({ brief: 'x' });
  await d.pipeline.generateDesign(p.id); await d.pipeline.draftCopy(p.id);
  const det = d.pipeline.detail(p.id);
  assert.deepEqual(det.costs.map(c => [c.kind, c.amountCents]), [['image', 25], ['llm', 2]]);
  assert.equal(d.spend.summary().spend.totalCents, 27);
  assert.equal(det.designs[0].costCents, 25);
});

test('failure path: an adapter error -> failed with a reason, never a throw out of the process; money still recorded', async () => {
  const d = mk({}, d => { d.adapters.imagegen = { generate: async () => { throw new Error('HTTP 500 from provider'); } }; });
  const p = d.pipeline.create({ brief: 'x' });
  await assert.rejects(d.pipeline.generateDesign(p.id), e => e.status === 502 && e.failed && /HTTP 500/.test(e.message));
  const row = d.stages.get(p.id);
  assert.equal(row.stage, 'failed'); assert.match(row.failed_reason, /image generation failed: HTTP 500/);
  // retry from failed works (failed -> idea -> design_generated)
  d.adapters.imagegen = d.adapters.imagegen = { generate: async () => ({ images: [{ file: 'a.png', width: 10, height: 10 }], costCents: 0, model: 's' }) };
  const again = await d.pipeline.generateDesign(p.id);
  assert.equal(again.stage, 'design_generated'); assert.equal(again.failed_reason, null);
});

test('copy failure (unparseable model output) -> failed; empty title after repair -> failed', async () => {
  const d = mk({}, d => { d.adapters.listingcopy = { generate: async () => { throw new Error('listing copy: the model did not return parseable JSON'); } }; });
  const p = d.pipeline.create({ brief: 'x' });
  await d.pipeline.generateDesign(p.id);
  await assert.rejects(d.pipeline.draftCopy(p.id), /parseable JSON/);
  assert.equal(stageOf(d, p.id), 'failed');
  const d2 = mk({}, d => { d.adapters.listingcopy = { generate: async () => ({ title: '\u{1F600}', tags: [], description: 'x', costCents: 1, model: 'm' }) }; });
  const p2 = d2.pipeline.create({ brief: 'x' });
  await d2.pipeline.generateDesign(p2.id);
  await assert.rejects(d2.pipeline.draftCopy(p2.id), /title is empty/);
  assert.equal(stageOf(d2, p2.id), 'failed');
  assert.equal(d2.spend.summary().spend.totalCents, 1, 'the LLM cost was still recorded');
});

test('spend cap: refusal is a pause (stage unchanged, 429, note event), not a failed product', async () => {
  const d = mk({}, d => { d.adapters.imagegen = { generate: async () => { throw new SpendCapError('Daily spend cap reached', { capCents: 1, todayCents: 1 }); } }; });
  const p = d.pipeline.create({ brief: 'x' });
  await assert.rejects(d.pipeline.generateDesign(p.id), e => e.status === 429 && e.code === 'spend_cap');
  assert.equal(stageOf(d, p.id), 'idea');
  assert.ok(d.pipeline.detail(p.id).events.some(e => /paused/.test(e.note)));
});

test('regenerate keeps history: new design row each time, optional edited brief, stage unchanged', async () => {
  const d = mk();
  const p = d.pipeline.create({ brief: 'first idea' });
  await d.pipeline.generateDesign(p.id);
  const second = await d.pipeline.generateDesign(p.id, { brief: 'second idea, bolder' });
  assert.equal(second.stage, 'design_generated'); assert.equal(second.brief, 'second idea, bolder');
  const det = d.pipeline.detail(p.id);
  assert.equal(det.designs.length, 2);
  assert.match(det.designs[0].prompt, /second idea/); assert.match(det.designs[1].prompt, /first idea/);
  assert.ok(det.events.some(e => e.note === 'brief edited'));
  assert.ok(det.events.some(e => /design regenerated/.test(e.note)));
  assert.notEqual(det.designs[0].id, det.designs[1].id);
});

test('regenerating from listing_drafted steps back to design_generated through transition()', async () => {
  const d = mk();
  const p = d.pipeline.create({ brief: 'x' });
  await d.pipeline.generateDesign(p.id);
  d.db.exec(`UPDATE products SET stage='mockup_ready' WHERE id=${p.id}`); // simulate M2 state without going through M2
  d.stages.transition(p.id, 'listing_drafted', { actor: 'human' });
  const r = await d.pipeline.generateDesign(p.id);
  assert.equal(r.stage, 'design_generated');
});

test('stage guards: no design from published/approved; copy needs a design and design_generated', async () => {
  const d = mk();
  const p = d.pipeline.create({ brief: 'x' });
  await assert.rejects(d.pipeline.draftCopy(p.id), e => e.status === 409);
  d.stages.transition(p.id, 'rejected', { actor: 'human' });
  await assert.rejects(d.pipeline.generateDesign(p.id), e => e.status === 409 && e.code === 'illegal_stage');
  await assert.rejects(d.pipeline.generateDesign(9999), e => e.status === 404);
});

test('validation and blocklist flag on the brief at create; edited brief re-checks', async () => {
  const d = mk();
  assert.throws(() => d.pipeline.create({ brief: '  ' }), /brief is required/);
  assert.throws(() => d.pipeline.create({ brief: 'x', listPrice: -1 }), /listPrice/);
  assert.throws(() => d.pipeline.create({ brief: 'x', keywords: Array(31).fill('k') }), /30 keywords/);
  const p = d.pipeline.create({ brief: 'a pikachu portrait' });
  assert.ok(JSON.parse(p.flags).some(f => f.code === 'blocklist' && /pikachu/.test(f.detail)));
  await d.pipeline.generateDesign(p.id, { brief: 'a friendly yellow mouse' });
  assert.deepEqual(JSON.parse(d.stages.get(p.id).flags), [], 'cleared once the brief is clean');
});

test('manual copy edit: rules re-enforced, blocklist re-run; PENDING_APPROVAL steps back to listing_drafted', async () => {
  const d = mk();
  const p = d.pipeline.create({ brief: 'x' });
  await d.pipeline.generateDesign(p.id); await d.pipeline.draftCopy(p.id);
  const e = await d.pipeline.editCopy(p.id, { title: 'Marvel hero '.repeat(20), tags: ['ok tag', 'x'.repeat(25)] });
  assert.ok(e.product.title.length <= 140); assert.deepEqual(e.blocklistHits, ['marvel']);
  assert.deepEqual(d.pipeline.detail(p.id).copy.tags, ['ok tag']);
  assert.ok(e.repairs.some(r => r.code === 'dropped_too_long'));
  const ok = await d.pipeline.editCopy(p.id, { title: 'Friendly Fox Print' });
  assert.deepEqual(ok.blocklistHits, []); assert.ok(!d.pipeline.detail(p.id).product.flags.length);
  d.db.exec(`UPDATE products SET stage='mockup_ready' WHERE id=${p.id}`);
  d.stages.transition(p.id, 'listing_drafted', { actor: 'human' }); d.stages.transition(p.id, 'PENDING_APPROVAL', { actor: 'human' });
  const back = await d.pipeline.editCopy(p.id, { description: 'new words' });
  assert.equal(back.product.stage, 'listing_drafted');
});

test('one operation per product at a time (no double spend on a double click)', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const d = mk({}, d => { d.adapters.imagegen = { generate: async () => { await gate; return { images: [{ file: 'a.png', width: 10, height: 10 }], costCents: 0, model: 's' }; } }; });
  const p = d.pipeline.create({ brief: 'x' });
  const first = d.pipeline.generateDesign(p.id);
  await assert.rejects(d.pipeline.generateDesign(p.id), e => e.status === 409 && e.code === 'busy');
  release(); await first;
  await d.pipeline.generateDesign(p.id); // free again
});
