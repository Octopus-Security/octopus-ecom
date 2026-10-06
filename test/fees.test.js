'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const f = require('../server/domain/fees');
const { normalizeTags, clampTitle, MAX_TAGS, MAX_TAG_LEN, MAX_TITLE } = require('../server/domain/etsy-rules');
const { seedBlocklist, checkBlocklist } = require('../server/domain/blocklist');
const { makeDeps } = require('./helpers');
const fs = require('node:fs');
const path = require('node:path');

test('projected margin: $30 item, $5 shipping, $12.50 base', () => {
  const m = f.projectMargin({ listPriceCents: 3000, shippingCents: 500, podBaseCostCents: 1250 });
  assert.equal(m.listingFeeCents, 20);
  assert.equal(m.transactionFeeCents, 228);          // 6.5% of 3500
  assert.equal(m.processingFeeCents, 130);           // 3% of 3500 + 25
  assert.equal(m.marginCents, 3000 - 1250 - 20 - 228 - 130);
  assert.ok(Number.isInteger(m.marginCents));
});
test('margin flags: <=0 and below floor, none above', () => {
  assert.equal(f.marginFlags(0, 200)[0].code, 'margin_non_positive');
  assert.equal(f.marginFlags(-5, 200)[0].code, 'margin_non_positive');
  assert.equal(f.marginFlags(150, 200)[0].code, 'margin_below_floor');
  assert.deepEqual(f.marginFlags(200, 200), []);
});
test('non-integer or negative money is refused', () => {
  assert.throws(() => f.projectMargin({ listPriceCents: 10.5, podBaseCostCents: 1 }));
  assert.throws(() => f.projectMargin({ listPriceCents: 100, podBaseCostCents: -1 }));
});
test('every fee constant carries a provenance comment', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'domain', 'fees.js'), 'utf8');
  for (const name of ['LISTING_FEE_CENTS', 'TRANSACTION_FEE_BPS', 'PROCESSING_FEE_BPS', 'PROCESSING_FIXED_CENTS']) {
    const i = src.indexOf(`const ${name}`);
    assert.match(src.slice(Math.max(0, i - 220), i), /(corroborated|verified|assumed) 2026-10-05/, name);
  }
});
test('etsy tag/title rules', () => {
  const tags = normalizeTags(Array.from({ length: 30 }, (_, i) => `tag${i}`).concat(['x'.repeat(21), 'TAG1']));
  assert.equal(tags.length, MAX_TAGS);
  assert.ok(tags.every(t => t.length <= MAX_TAG_LEN));
  assert.equal(new Set(tags).size, tags.length);
  assert.equal(clampTitle('a'.repeat(200)).length, MAX_TITLE);
});
test('blocklist is seeded once, editable, and matches whole words only', () => {
  const d = makeDeps();
  assert.equal(seedBlocklist(d.db), 0, 'already seeded by createDeps');
  assert.deepEqual(checkBlocklist(d.db, ['Cool Nike style shirt']), ['nike']);
  assert.deepEqual(checkBlocklist(d.db, ['nikenow unrelated'], ), []);
  d.db.prepare("INSERT INTO blocklist(term,kind,added_at) VALUES('acme','brand','x')").run();
  assert.deepEqual(checkBlocklist(d.db, ['ACME rocket']), ['acme']);
});
