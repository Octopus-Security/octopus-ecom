'use strict';
// M4: refunds are subtracted from the matching sale, idempotently, and reach NET.
const { test } = require('node:test');
const assert = require('node:assert');
const { liveDeps, connectStore, approvedProduct, money } = require('./etsy-helpers');
const { cents } = require('../server/adapters/storefront/etsy');

const T0 = Math.floor(Date.parse('2026-10-01T12:00:00Z') / 1000);
const tx = (id, listing, qty, unit, ship = 0) => ({ transaction_id: id, listing_id: listing, quantity: qty, price: money(unit), shipping_cost: money(ship), title: 't' });
const refund = (amount, ts, extra = {}) => ({ amount: money(amount), created_timestamp: ts, reason: 'buyer request', note_from_issuer: null, status: 'complete', ...extra });
const receipt = (id, ts, txs, refunds = []) => ({ receipt_id: id, created_timestamp: ts, is_paid: true, refunds, grandtotal: money(1), transactions: txs });
const bps = (c, r) => Math.round((c * r) / 10000);

function published(d, storeId) {
  const id = approvedProduct(d, { cost: 1337, storeId });
  d.db.prepare("UPDATE products SET stage='live' WHERE id=?").run(id);
  d.db.prepare("UPDATE listings SET external_id='900', status='active', store_id=? WHERE product_id=?").run(storeId, id);
  return id;
}
const sale = (d, order) => d.db.prepare('SELECT * FROM sales WHERE external_order_id = ? ORDER BY id').all(order);

test('a refund on a receipt is subtracted from its sale; refund amount, key and reason are stored; NET follows', async () => {
  const { d, st } = liveDeps();
  const store = connectStore(d); published(d, store);
  st.receipts = [receipt(1001, T0, [tx(5001, 900, 1, 2500)], [refund(1000, T0 + 3600)])];
  const out = await d.sales.sync();
  assert.equal(out.refundsSeen, 1); assert.equal(out.refundsApplied, 1); assert.equal(out.refundedCents, 1000);
  const [s] = sale(d, '1001');
  const fees = bps(2500, 650) + bps(2500 + bps(2500, 700), 300) + 25; // processing base includes the estimated 7% tax
  assert.equal(s.refund_cents, 1000); assert.equal(s.net_cents, 2500 - fees - 1000);
  const r = d.db.prepare('SELECT * FROM refunds').get();
  assert.equal(r.amount_cents, 1000); assert.equal(r.applied_cents, 1000); assert.equal(r.external_order_id, '1001'); assert.equal(r.reason, 'buyer request'); assert.equal(r.refund_key, `1001:${T0 + 3600}:1000:1`);
  const sum = d.spend.summary();
  assert.equal(sum.revenue.grossCents, 2500); assert.equal(sum.revenue.refundedCents, 1000);
  assert.equal(sum.netCents, (2500 - fees - 1000) - 1337, 'NET = net after fees and refunds, minus COGS (the COGS is not reversed)');
  assert.equal(d.sales.list().sales[0].refundCents, 1000); assert.equal(d.sales.list().perStore[0].refundedCents, 1000);
});

test('idempotent: re-syncing the same receipt (overlap) never subtracts twice, however often', async () => {
  const { d, st } = liveDeps();
  const store = connectStore(d); published(d, store);
  st.receipts = [receipt(1001, T0, [tx(5001, 900, 1, 2500)], [refund(700, T0 + 10)])];
  await d.sales.sync();
  for (let i = 0; i < 3; i++) { const o = await d.sales.sync(); assert.equal(o.refundsApplied, 0); assert.equal(o.refundsDuplicate, 1); }
  assert.equal(sale(d, '1001')[0].refund_cents, 700);
  assert.equal(d.db.prepare('SELECT COUNT(*) n FROM refunds').get().n, 1);
});

test('a refund issued AFTER the sale was ingested is found on a later sync (look-back window) and a second refund adds to it', async () => {
  const { d, st, calls } = liveDeps();
  const store = connectStore(d); published(d, store);
  st.receipts = [receipt(1001, T0, [tx(5001, 900, 1, 2500)])];
  await d.sales.sync();
  assert.equal(sale(d, '1001')[0].refund_cents, 0);
  st.receipts[0].refunds = [refund(500, T0 + 86400)];
  const o = await d.sales.sync();
  assert.equal(o.refundsApplied, 1); assert.equal(sale(d, '1001')[0].refund_cents, 500);
  const before = sale(d, '1001')[0].net_cents;
  st.receipts[0].refunds.push(refund(500, T0 + 2 * 86400));  // same amount, different time: a distinct refund
  st.receipts[0].refunds.push(refund(500, T0 + 2 * 86400));  // identical twin: the n-th identical gets its own key
  await d.sales.sync();
  assert.equal(sale(d, '1001')[0].refund_cents, 1500); assert.equal(sale(d, '1001')[0].net_cents, before - 1000);
  assert.equal(d.db.prepare('SELECT COUNT(*) n FROM refunds').get().n, 3);
  // the re-read of an already-ingested receipt did not re-fetch its payment fee
  const feeCalls = calls.filter(c => /\/payments/.test(c.url)).length;
  assert.equal(feeCalls, 1, 'payments read once, for the first ingest only');
});

test('a refund on a multi-line receipt is spread by gross, to the cent; one larger than the sale is capped; a refund with no sale yet waits', async () => {
  const { d, st } = liveDeps();
  const store = connectStore(d); published(d, store);
  st.receipts = [receipt(1003, T0, [tx(5003, 900, 1, 2500), tx(5004, 900, 1, 1000, 500)], [refund(1001, T0 + 5)])]; // grosses 2500 and 1500
  await d.sales.sync();
  const [a, b] = sale(d, '1003');
  assert.equal(a.gross_cents, 2500); assert.equal(b.gross_cents, 1500);
  assert.equal(a.refund_cents + b.refund_cents, 1001, 'no cent lost to rounding');
  assert.equal(a.refund_cents, Math.round(1001 * 2500 / 4000));
  // bigger than everything the receipt grossed: capped, and the report says what was applied vs asked
  st.receipts = [receipt(1004, T0 + 100, [tx(5005, 900, 1, 1000)], [refund(5000, T0 + 200)])];
  await d.sales.sync();
  assert.equal(sale(d, '1004')[0].refund_cents, 1000); assert.equal(sale(d, '1004')[0].net_cents < 0, true);
  const r = d.db.prepare("SELECT * FROM refunds WHERE external_order_id = '1004'").get();
  assert.equal(r.amount_cents, 5000); assert.equal(r.applied_cents, 1000);
  // a refund on an unpaid receipt has no sale to hit: nothing is recorded, nothing breaks
  st.receipts = [{ ...receipt(1005, T0 + 300, [tx(5006, 900, 1, 1000)], [refund(100, T0 + 301)]), is_paid: false }];
  const o = await d.sales.sync();
  assert.equal(o.refundsApplied, 0); assert.equal(d.db.prepare("SELECT COUNT(*) n FROM refunds WHERE external_order_id = '1005'").get().n, 0);
});

test('stub (simulated) sales carry no refunds; and the Etsy adapter maps ShopRefund (no id field exists) to cents', async () => {
  assert.equal(cents(money(1234)), 1234);
  const { d, st } = liveDeps();
  const store = connectStore(d); published(d, store);
  st.receipts = [receipt(1001, T0, [tx(5001, 900, 1, 2500)], [refund(250, T0 + 1, { reason: null, status: null })])];
  await d.sales.sync();
  const r = d.db.prepare('SELECT * FROM refunds').get();
  assert.equal(r.reason, null); assert.equal(r.status, null); assert.match(r.refund_key, /^1001:\d+:250:1$/);
  const { makeDeps } = require('./helpers');
  const s = makeDeps();
  assert.equal((await s.adapters.storefront.getReceipts(null, { listingIds: ['x'] })).receipts[0].refunds, 0);
});
