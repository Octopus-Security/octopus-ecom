'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const f = require('../server/domain/fees');
const fs_ = require('../server/domain/fee-schedule');
const { DEFAULT_SCHEDULE } = fs_;
const { normalizeTags, clampTitle, MAX_TAGS, MAX_TAG_LEN, MAX_TITLE } = require('../server/domain/etsy-rules');
const { seedBlocklist, checkBlocklist } = require('../server/domain/blocklist');
const { makeDeps } = require('./helpers');
const fs = require('node:fs');
const path = require('node:path');

test('projected margin: $30 item, $5 shipping, $12.50 base; tax-exclusive transaction base, tax-inclusive processing base', () => {
  const m = f.projectMargin({ listPriceCents: 3000, shippingCents: 500, podBaseCostCents: 1250 });
  assert.equal(m.listingFeeCents, 20);
  assert.equal(m.transactionFeeCents, 228);          // 6.5% of 3500 (no tax)
  assert.equal(m.taxEstimateCents, 245);             // 7% of 3500, estimate
  assert.equal(m.processingFeeCents, 137);           // 3% of (3500 + 245) + 25 = 112 + 25
  assert.equal(m.currencyConversionFeeCents, 0); assert.equal(m.offsiteAdsFeeCents, 0);
  assert.equal(m.marginCents, 3000 - 1250 - 20 - 228 - 137);
  assert.equal(m.totalFeesCents, 20 + 228 + 137);
  assert.equal(m.totalFeesCents, m.feeLines.reduce((a, l) => a + l.cents, 0));
  assert.equal(m.marginPct, Math.round((m.marginCents / 3000) * 10000) / 100);
  assert.equal(m.scheduleVersion, 0);
  assert.ok(Number.isInteger(m.marginCents));
});
test('tax rate moves only the processing fee, never the transaction fee', () => {
  const a = f.projectMargin({ listPriceCents: 3000, shippingCents: 500, podBaseCostCents: 0 }, { ...DEFAULT_SCHEDULE, salesTaxBps: 0 });
  const b = f.projectMargin({ listPriceCents: 3000, shippingCents: 500, podBaseCostCents: 0 }, { ...DEFAULT_SCHEDULE, salesTaxBps: 1000 });
  assert.equal(a.transactionFeeCents, b.transactionFeeCents);
  assert.equal(a.processingFeeCents, Math.round(3500 * 0.03) + 25);
  assert.equal(b.processingFeeCents, Math.round(3850 * 0.03) + 25);
});
test('currency conversion applies only when toggled; offsite ads cost = rate x share, capped per order', () => {
  const base = { listPriceCents: 3000, shippingCents: 0, podBaseCostCents: 1000 };
  assert.equal(f.projectMargin(base).currencyConversionFeeCents, 0);
  const cc = f.projectMargin(base, { ...DEFAULT_SCHEDULE, currencyConversionApplies: true });
  assert.equal(cc.currencyConversionFeeCents, Math.round(3210 * 0.025));
  assert.equal(cc.marginCents, f.projectMargin(base).marginCents - cc.currencyConversionFeeCents);
  assert.equal(f.projectMargin(base, { ...DEFAULT_SCHEDULE, offsiteAdsShareBps: 0 }).offsiteAdsFeeCents, 0);
  assert.equal(f.projectMargin(base, { ...DEFAULT_SCHEDULE, offsiteAdsShareBps: 2000 }).offsiteAdsFeeCents, Math.round(450 * 0.2));
  const big = f.projectMargin({ ...base, listPriceCents: 100000 }, { ...DEFAULT_SCHEDULE, offsiteAdsShareBps: 10000 });
  assert.equal(big.offsiteAdsFeeCents, 10000, 'capped at $100 per ad order');
});
test('explicit POD shipping counts shipping charged as revenue; omitted keeps the pass-through formula', () => {
  const legacy = f.projectMargin({ listPriceCents: 3000, shippingCents: 500, podBaseCostCents: 1000 });
  const ex = f.projectMargin({ listPriceCents: 3000, shippingCents: 500, podBaseCostCents: 1000, podShippingCostCents: 400 });
  assert.equal(ex.marginCents, legacy.marginCents + 500 - 400);
});
test('min list price: the solved price really meets the target after rounding, and one cent less does not', () => {
  const cases = [
    { podBaseCostCents: 1250, podShippingCostCents: 450, shippingCents: 499, marginCents: 500 },
    { podBaseCostCents: 1250, podShippingCostCents: 450, shippingCents: 0, marginPct: 30 },
    { podBaseCostCents: 99, shippingCents: 0, marginCents: 0 },
    { podBaseCostCents: 2200, podShippingCostCents: 500, shippingCents: 500, marginPct: 40 },
  ];
  const scheds = [DEFAULT_SCHEDULE, { ...DEFAULT_SCHEDULE, currencyConversionApplies: true, offsiteAdsShareBps: 3000, salesTaxBps: 0 }, { ...DEFAULT_SCHEDULE, offsiteAdsShareBps: 10000, offsiteAdsCapCents: 50 }];
  for (const sch of scheds) for (const c of cases) {
    const r = f.minListPrice(c, sch);
    const at = (p) => f.projectMargin({ listPriceCents: p, shippingCents: c.shippingCents, podBaseCostCents: c.podBaseCostCents, podShippingCostCents: c.podShippingCostCents ?? 0 }, sch);
    const need = (p) => (c.marginPct !== undefined ? Math.ceil((c.marginPct / 100) * p - 1e-9) : c.marginCents);
    assert.ok(at(r.listPriceCents).marginCents >= need(r.listPriceCents), JSON.stringify(c));
    assert.ok(at(r.listPriceCents - 1).marginCents < need(r.listPriceCents - 1), `${JSON.stringify(c)} is not minimal`);
    assert.equal(r.projection.marginCents, at(r.listPriceCents).marginCents);
  }
});
test('min list price refuses an unreachable percentage, and bad input', () => {
  assert.throws(() => f.minListPrice({ podBaseCostCents: 100, marginPct: 95 }), /No price/);
  assert.throws(() => f.minListPrice({ podBaseCostCents: 100 }), /exactly one/);
  assert.throws(() => f.minListPrice({ podBaseCostCents: 100, marginCents: 1, marginPct: 1 }), /exactly one/);
  assert.throws(() => f.minListPrice({ podBaseCostCents: -1, marginCents: 1 }));
});
test('break-even units to recover the set-up fee', () => {
  assert.equal(f.breakEvenUnits(500, 2900), 6);
  assert.equal(f.breakEvenUnits(2900, 2900), 1);
  assert.equal(f.breakEvenUnits(0, 2900), null);
  assert.equal(f.breakEvenUnits(-5, 2900), null);
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
test('every schedule field has provenance, and the defaults are the figures verified 2026-10-06', () => {
  for (const k of Object.keys(fs_.DEFAULTS)) { assert.ok(fs_.FIELDS[k], k); assert.match(fs_.FIELDS[k].status, /^(verified|assumed)$/, k); assert.ok(fs_.FIELDS[k].note, k); }
  assert.equal(fs_.VERIFIED_ON, '2026-10-06');
  assert.deepEqual([fs_.DEFAULTS.setupFeeCents, fs_.DEFAULTS.listingFeeCents, fs_.DEFAULTS.transactionBps, fs_.DEFAULTS.processingBps, fs_.DEFAULTS.processingFixedCents, fs_.DEFAULTS.currencyConversionBps], [2900, 20, 650, 300, 25, 250]);
  assert.equal(fs_.DEFAULTS.currencyConversionApplies, false); assert.equal(fs_.DEFAULTS.offsiteAdsShareBps, 0);
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'domain', 'fees.js'), 'utf8');
  assert.doesNotMatch(src, /official page not read/);
});
test('fee schedule validation: whole cents/bps, bounds, unknown keys, booleans', () => {
  const v = (p) => fs_.validate(p);
  assert.equal(v({ transactionBps: 700 }).transactionBps, 700);
  for (const bad of [{ transactionBps: -1 }, { transactionBps: 3001 }, { transactionBps: 6.5 }, { listingFeeCents: '20' }, { salesTaxBps: 2501 }, { setupFeeCents: 100001 }, { currencyConversionApplies: 'yes' }, { nope: 1 }, { offsiteAdsShareBps: 10001 }]) {
    assert.throws(() => v(bad), (e) => e.status === 400, JSON.stringify(bad));
  }
  assert.throws(() => v(null)); assert.throws(() => v([]));
});
test('fee schedule persists as a new version per save; reset returns to the verified defaults; corrupt storage falls back', () => {
  const d = makeDeps();
  assert.equal(fs_.loadSchedule(d.settings).version, 0);
  const s1 = fs_.saveSchedule(d.settings, { transactionBps: 700, currencyConversionApplies: true });
  assert.equal(s1.version, 1); assert.equal(fs_.loadSchedule(d.settings).transactionBps, 700); assert.equal(fs_.loadSchedule(d.settings).processingBps, 300, 'unlisted fields keep their value');
  assert.throws(() => fs_.saveSchedule(d.settings, { transactionBps: -5 }));
  assert.equal(fs_.loadSchedule(d.settings).version, 1, 'a refused edit changes nothing');
  const r = fs_.resetSchedule(d.settings);
  assert.equal(r.version, 2); assert.equal(r.transactionBps, 650); assert.equal(r.currencyConversionApplies, false);
  d.settings.set('fee_schedule', '{not json');
  assert.equal(fs_.loadSchedule(d.settings).version, 0);
});
test('a product records the schedule it was projected under; a later edit does not rewrite it', () => {
  const d = makeDeps();
  const p = d.pipeline.create({ brief: 'x', niche: 'n', listPrice: 30 });
  d.db.prepare('UPDATE products SET pod_base_cost_cents = 1250, list_price_cents = 3000, shipping_cents = 500 WHERE id = ?').run(p.id);
  d.pipeline.applyMargin(p.id);
  const before = d.db.prepare('SELECT projected_margin_cents m, margin_breakdown b FROM products WHERE id = ?').get(p.id);
  const snap = JSON.parse(before.b);
  assert.equal(snap.scheduleVersion, 0); assert.equal(snap.marginCents, before.m); assert.equal(snap.schedule.transactionBps, 650);
  fs_.saveSchedule(d.settings, { transactionBps: 1000 });
  assert.equal(d.db.prepare('SELECT margin_breakdown b FROM products WHERE id = ?').get(p.id).b, before.b, 'stored projection is untouched by an edit');
  const eco = d.pipeline.detail(p.id).economics;
  assert.equal(eco.scheduleVersion, 1); assert.equal(eco.stored.scheduleVersion, 0); assert.ok(eco.marginCents < eco.stored.marginCents);
  d.pipeline.applyMargin(p.id);
  assert.equal(JSON.parse(d.db.prepare('SELECT margin_breakdown b FROM products WHERE id = ?').get(p.id).b).scheduleVersion, 1);
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
