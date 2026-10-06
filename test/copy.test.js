'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeDeps } = require('./helpers');
const { enforceCopy, MAX_TITLE, MAX_TAGS, MAX_TAG_LEN, truncateWords } = require('../server/domain/etsy-rules');
const { createLlmCopy, extractJson } = require('../server/adapters/listingcopy/llm');

const codes = r => r.repairs.map(x => `${x.field}:${x.code}`);

test('title: truncates on a word boundary to <= 140 and records it', () => {
  const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
  const r = enforceCopy({ title: long, tags: [], description: 'd' });
  assert.ok(r.title.length <= MAX_TITLE); assert.ok(long.startsWith(r.title));
  assert.ok(long[r.title.length] === ' ', 'cut at a word boundary');
  assert.ok(codes(r).includes('title:truncated'));
  assert.equal(truncateWords('a'.repeat(200), 140).length, 140, 'no space: hard cut');
});
test('title: disallowed characters stripped; % : & + only once each', () => {
  const r = enforceCopy({ title: 'Cats \u{1F431} & Dogs & Birds: 50% off: 100% fun + more + less', tags: ['x'], description: 'd' });
  assert.ok(!/\u{1F431}/u.test(r.title));
  for (const ch of ['%', ':', '&', '+']) assert.ok(r.title.split(ch).length - 1 <= 1, ch);
  assert.ok(r.title.includes('Cats') && r.title.includes('Birds'));
  assert.ok(codes(r).includes('title:chars_removed') && codes(r).includes('title:repeat_char_removed'));
  assert.ok(!/\s{2,}/.test(r.title));
});
test('tags: <= 13, each <= 20, deduped, trimmed, lowercased; over-long dropped; chars cleaned', () => {
  const tags = ['  Retro Cat ', 'retro cat', 'a'.repeat(21), 'space-cat', "cat's", 'cats!!', '#hash', ...Array.from({ length: 20 }, (_, i) => `tag number ${i}`), ''];
  const r = enforceCopy({ title: 't', tags, description: 'd' });
  assert.equal(r.tags.length, MAX_TAGS);
  assert.ok(r.tags.every(t => t.length <= MAX_TAG_LEN && t === t.trim() && t === t.toLowerCase()));
  assert.equal(new Set(r.tags).size, r.tags.length);
  assert.ok(r.tags.includes('retro cat') && r.tags.includes('cats') && r.tags.includes('hash') && r.tags.includes("cat's"));
  const c = codes(r);
  for (const k of ['tags:dropped_duplicate', 'tags:dropped_too_long', 'tags:chars_removed', 'tags:dropped_extra']) assert.ok(c.includes(k), k);
  assert.ok(r.repairs.find(x => x.code === 'dropped_too_long').detail.includes('21 chars'));
});
test('garbage in, valid out: string tags, null fields, non-list tags', () => {
  const r = enforceCopy({ title: null, tags: 'one, two ,three', description: undefined });
  assert.deepEqual(r.tags, ['one', 'two', 'three']); assert.equal(r.title, '');
  assert.ok(codes(r).includes('tags:split_string') && codes(r).includes('description:empty'));
  assert.deepEqual(enforceCopy({ title: 'x', tags: { a: 1 }, description: 'd' }).tags, []);
});
test('clean input produces no repairs', () => assert.deepEqual(enforceCopy({ title: 'Retro Cat Poster', tags: ['retro cat'], description: 'A cat.' }).repairs, []));

test('extractJson tolerates fences and chatter, rejects prose', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Sure! {"a":2} hope that helps'), { a: 2 });
  assert.throws(() => extractJson('no json here'), /parseable JSON/);
});

test('LLM listing copy: asks for buyer phrasing / no stuffing / no brands at tier standard; returns raw model output', async () => {
  const calls = [];
  const llm = { complete: async (a) => { calls.push(a); return { text: JSON.stringify({ title: 'T', tags: ['a'], description: 'D' }), model: 'm', costCents: 3 }; } };
  const out = await createLlmCopy({ llm }).generate({ brief: 'a fox in a scarf' }, 'cozy animals', ['fox', 'winter']);
  assert.deepEqual(out, { title: 'T', tags: ['a'], description: 'D', costCents: 3, model: 'm' });
  assert.equal(calls[0].tier, 'standard'); assert.equal(calls[0].json, true);
  assert.match(calls[0].system, /buyer/i); assert.match(calls[0].system, /keyword stuffing/i); assert.match(calls[0].system, /trademarks/i);
  assert.match(calls[0].prompt, /fox in a scarf/); assert.match(calls[0].prompt, /cozy animals/);
});

test('pipeline enforces limits and flags a blocklist hit even when the model ignores the rules', async () => {
  const d = makeDeps();
  const bad = { title: 'Nike Air '.repeat(30), tags: Array.from({ length: 30 }, (_, i) => `tag-${i}-` + 'x'.repeat(i)), description: 'Official Disney tee' };
  d.adapters.listingcopy = { generate: async () => ({ ...bad, costCents: 0, model: 'rogue' }), describe() {} };
  const pl = require('../server/pipeline').makePipeline({ db: d.db, stages: d.stages, adapters: d.adapters, spend: d.spend, log: { warn() {}, info() {} } });
  const p = pl.create({ brief: 'a dog' });
  await pl.generateDesign(p.id);
  const out = await pl.draftCopy(p.id);
  const det = pl.detail(p.id);
  assert.ok(det.copy.title.length <= 140); assert.ok(det.copy.tags.length <= 13); assert.ok(det.copy.tags.every(t => t.length <= 20));
  assert.ok(out.repairs.length > 0); assert.ok(det.copy.repairs.length > 0, 'repairs persisted');
  assert.deepEqual(out.blocklistHits.sort(), ['disney', 'nike']);
  const flag = det.product.flags.find(f => f.code === 'blocklist');
  assert.ok(flag && flag.detail.includes('nike'), 'flag set, nothing silently dropped');
  assert.ok(det.copy.title.toLowerCase().includes('nike'), 'the offending text is kept and flagged, not silently rewritten');
});
