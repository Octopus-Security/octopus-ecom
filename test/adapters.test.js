'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeDeps } = require('./helpers');
const { CONTRACTS, assertAdapter, NotImplemented } = require('../server/adapters/contract');
const { readPngSize } = require('../server/png');
const { normalizeTags } = require('../server/domain/etsy-rules');

test('every real adapter satisfies its contract; the M2/M3 ones are still scaffolds', () => {
  assertAdapter('imagegen', require('../server/adapters/imagegen/openai').createOpenAiImages());
  assertAdapter('listingcopy', require('../server/adapters/listingcopy/llm').createLlmCopy());
  const real = {
    pod: require('../server/adapters/pod/printify').createPrintify(),
    storefront: require('../server/adapters/storefront/etsy').createEtsy(),
  };
  for (const [k, impl] of Object.entries(real)) { assertAdapter(k, impl); assert.equal(impl.implemented, false, k); }
  assertAdapter('pod', require('../server/adapters/pod/printful').createPrintful());
});
test('scaffolds throw NotImplemented', async () => {
  await assert.rejects(require('../server/adapters/pod/printify').createPrintify().createProduct(), NotImplemented);
});
test('all five adapters work as stubs with no credentials', async () => {
  const d = makeDeps();
  const a = d.adapters;
  assert.equal(a.describe().length, 5);
  assert.ok(a.describe().every(x => !x.realReady));
  const img = await a.imagegen.generate('a fox', { width: 640, height: 480, count: 2 });
  assert.equal(img.images.length, 2); assert.equal(img.costCents, 0);
  const buf = fs.readFileSync(path.join(d.dataDir, 'images', img.images[0].file));
  assert.deepEqual(readPngSize(buf), { width: 640, height: 480 });
  const bps = await a.pod.listBlueprints();
  assert.ok(bps[0].printArea.width > 0);
  const prod = await a.pod.createProduct({ blueprintId: 'stub-tee', providerId: 'stub-pp', title: 't' });
  assert.equal(prod.faked, true);
  assert.equal((await a.pod.getMockups(prod.externalId)).length, 1);
  assert.equal((await a.pod.publish(prod.externalId)).faked, true);
  const l = await a.storefront.createListing({ title: 'x' });
  assert.equal((await a.storefront.updateListing(l.id, { title: 'y' })).title, 'y');
  assert.deepEqual(await a.storefront.getReceipts(), []);
  const t = await a.trend.suggest('retro space cats');
  assert.deepEqual(t.keywords, ['retro', 'space', 'cats']);
  const c = await a.listingcopy.generate({}, 'retro space cats', ['retro', 'space', 'cats']);
  assert.ok(c.title.length <= 140); assert.ok(c.tags.length <= 13); assert.deepEqual(c.tags, normalizeTags(c.tags));
});
test('a real credential does not select an unimplemented real adapter; OpenAI key selects imagegen + listingcopy', () => {
  const d = makeDeps({ PRINTIFY_API_TOKEN: 'tok-printify-123456789', OPENAI_API_KEY: 'sk-' + 'q'.repeat(40) });
  const by = Object.fromEntries(d.adapters.describe().map(x => [x.kind, x]));
  assert.equal(by.pod.realReady, false); assert.equal(by.storefront.realReady, false); assert.equal(by.trend.realReady, false);
  assert.equal(by.imagegen.realReady, true); assert.equal(by.imagegen.methods.generate, 'real'); // spend: real even in DRY_RUN
  assert.equal(by.listingcopy.realReady, true);
});
test('png encoder: exact dimensions at print size, small on disk', () => {
  const { solidPng } = require('../server/png');
  const buf = solidPng(4500, 5400);
  assert.deepEqual(readPngSize(buf), { width: 4500, height: 5400 });
  assert.ok(buf.length < 1_000_000, `${buf.length} bytes`);
  assert.throws(() => readPngSize(Buffer.from('not a png at all, definitely not')));
  assert.throws(() => solidPng(0, 10));
});
test('contract table has the five kinds', () => assert.deepEqual(Object.keys(CONTRACTS).sort(), ['imagegen', 'listingcopy', 'pod', 'storefront', 'trend']));
