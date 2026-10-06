'use strict';
// M3: receipt ingest -> sales + per-sale COGS -> NET; idempotency; untracked listings; stub simulation; watcher hooks.
const { test } = require('node:test');
const assert = require('node:assert');
const { makeDeps } = require('./helpers');
const { liveDeps, connectStore, approvedProduct, money } = require('./etsy-helpers');
const { buildApp } = require('../server/app');

const T0 = Math.floor(Date.parse('2026-10-01T12:00:00Z') / 1000);
const tx = (id, listing, qty, unit, ship = 0) => ({ transaction_id: id, listing_id: listing, quantity: qty, price: money(unit), shipping_cost: money(ship), title: 't' });
const receipt = (id, ts, txs) => ({ receipt_id: id, created_timestamp: ts, is_paid: true, refunds: [], grandtotal: money(1), transactions: txs });
const bps = (c, r) => Math.round((c * r) / 10000);

/** A published product whose Etsy listing is 900, base cost 1337. */
function published(d, storeId) {
  const id = approvedProduct(d, { cost: 1337, storeId });
  d.db.prepare("UPDATE products SET stage='live' WHERE id=?").run(id);
  d.db.prepare("UPDATE listings SET external_id='900', status='active', store_id=? WHERE product_id=?").run(storeId, id);
  return id;
}

test('ingest: gross/fees/net per transaction, COGS written per sale, untracked listings kept at store level, NET reflects it', async () => {
  const { d, st } = liveDeps();
  const store = connectStore(d); const pid = published(d, store);
  st.receipts = [
    receipt(1001, T0, [tx(5001, 900, 2, 2500, 400)]),   // ours: 2 x $25 + $4 shipping = 5400
    receipt(1002, T0 + 60, [tx(5002, 777, 1, 1800)]),   // a listing we do not track
  ];
  st.fees = { 1001: 191 };                                // Etsy payment record gives the processing fee for ONE receipt
  const out = await d.sales.sync();
  assert.equal(out.source, 'etsy'); assert.equal(out.newSales, 2); assert.equal(out.tracked, 1); assert.equal(out.untracked, 1);
  const a = d.db.prepare('SELECT * FROM sales WHERE external_order_id=?').get('1001');
  assert.equal(a.gross_cents, 5400); assert.equal(a.quantity, 2);
  assert.equal(a.etsy_fees_cents, bps(5400, 650)); assert.equal(a.processing_fee_cents, 191); assert.equal(a.fee_source, 'payment_api+computed');
  assert.equal(a.net_cents, 5400 - a.etsy_fees_cents - 191); assert.equal(a.cogs_cents, 2674); assert.equal(a.product_id, pid); assert.ok(a.listing_id);
  const b = d.db.prepare('SELECT * FROM sales WHERE external_order_id=?').get('1002');
  assert.equal(b.listing_id, null); assert.equal(b.store_id, store); assert.equal(b.cogs_cents, null, 'unknown COGS stays unknown');
  assert.equal(b.fee_source, 'computed'); assert.equal(b.processing_fee_cents, bps(1800, 300) + 25); assert.equal(b.etsy_fees_cents, bps(1800, 650));
  // COGS is a `pod` cost row = base cost x qty, attributed to the product
  const cogs = d.db.prepare("SELECT * FROM costs WHERE kind='pod'").all();
  assert.equal(cogs.length, 1); assert.equal(cogs[0].amount_cents, 1337 * 2); assert.equal(cogs[0].product_id, pid);
  // NET roll-up = sum(net) - every cost
  const sum = d.spend.summary();
  assert.equal(sum.revenue.orders, 2); assert.equal(sum.revenue.grossCents, 5400 + 1800);
  assert.equal(sum.netCents, a.net_cents + b.net_cents - 2674);
  assert.equal(sum.revenue.cogsCents, 2674);
  // per-sale COGS must not eat the generation cap
  assert.equal(d.spend.todayCents(), 0);
  // store-level numbers include the untracked receipt
  const list = d.sales.list();
  assert.equal(list.perStore[0].lines, 2); assert.equal(list.perStore[0].untrackedLines, 1);
});

test('idempotent: re-running (and overlapping windows) changes nothing and writes no second COGS row', async () => {
  const { d, st } = liveDeps();
  const store = connectStore(d); published(d, store);
  st.receipts = [receipt(1001, T0, [tx(5001, 900, 1, 2500)])];
  await d.sales.sync();
  const again = await d.sales.sync();
  assert.equal(again.newSales, 0); assert.equal(again.duplicates, 1);
  assert.equal(d.db.prepare('SELECT COUNT(*) n FROM sales').get().n, 1); assert.equal(d.db.prepare("SELECT COUNT(*) n FROM costs WHERE kind='pod'").get().n, 1);
  // a new receipt arrives later; only it is added
  st.receipts.push(receipt(1003, T0 + 3600, [tx(5003, 900, 1, 2500), tx(5004, 900, 1, 2500)]));
  const third = await d.sales.sync();
  assert.equal(third.newSales, 2); assert.equal(d.db.prepare('SELECT COUNT(*) n FROM sales').get().n, 3);
  assert.equal(d.db.prepare("SELECT SUM(amount_cents) s FROM costs WHERE kind='pod'").get().s, 1337 * 3);
  assert.equal(d.db.prepare('SELECT sales_cursor c FROM stores WHERE id=?').get(store).c, T0 + 3600);
});

test('the receipts request pages with limit 100 oldest-first, only paid receipts, from the cursor minus an overlap', async () => {
  const { d, st, calls } = liveDeps();
  const store = connectStore(d); published(d, store);
  st.receipts = Array.from({ length: 130 }, (_, i) => receipt(2000 + i, T0 + i, [tx(9000 + i, 900, 1, 1000)]));
  const out = await d.sales.sync();
  assert.equal(out.newSales, 130); assert.equal(out.complete, true);
  const rc = calls.filter(c => /\/shops\/555\/receipts\?/.test(c.url));
  assert.equal(rc.length, 2);
  const q = new URL(rc[0].url).searchParams;
  assert.equal(q.get('limit'), '100'); assert.equal(q.get('sort_order'), 'asc'); assert.equal(q.get('was_paid'), 'true'); assert.equal(q.get('offset'), '0');
  assert.equal(new URL(rc[1].url).searchParams.get('offset'), '100');
  await d.sales.sync();
  const second = calls.filter(c => /\/shops\/555\/receipts\?/.test(c.url)).pop();
  assert.equal(Number(new URL(second.url).searchParams.get('min_created')), T0 + 129 - 2 * 24 * 3600);
});

test('sync refuses with a clear reason when no Etsy store is connected, or the account has no shop', async () => {
  const { d } = liveDeps();
  const none = await d.sales.sync();
  assert.equal(none.ok, false); assert.match(none.reason, /No connected Etsy store/);
  const store = connectStore(d); d.db.prepare("UPDATE stores SET status='no_shop', shop_id=NULL, status_detail=? WHERE id=?").run('Open an Etsy shop first', store);
  const ns = await d.sales.sync();
  assert.equal(ns.ok, false); assert.match(ns.reason, /Open an Etsy shop first/);
});

test('stub storefront: a manual sync makes SIMULATED sales that never reach real NET; scheduled sync does nothing', async () => {
  const d = makeDeps();
  const pid = d.stages.createProduct({ brief: 'x', listPriceCents: 2500 }).id;
  d.db.prepare("UPDATE products SET stage='live', pod_base_cost_cents=1000 WHERE id=?").run(pid);
  d.db.prepare("INSERT INTO listings(product_id,platform,title,tags,status,external_id,created_at) VALUES(?,'etsy','t','[]','active','stub-etsy-1',?)").run(pid, new Date().toISOString());
  assert.equal((await d.sales.sync({ auto: true })).skipped, true);
  assert.equal(d.db.prepare('SELECT COUNT(*) n FROM sales').get().n, 0);
  const out = await d.sales.sync();
  assert.equal(out.source, 'stub'); assert.equal(out.simulated, true); assert.equal(out.newSales, 1);
  const s = d.db.prepare('SELECT * FROM sales').get(); assert.equal(s.source, 'stub'); assert.equal(s.gross_cents, 2500);
  const sum = d.spend.summary();
  assert.equal(sum.revenue.orders, 0); assert.equal(sum.netCents, 0); assert.equal(sum.simulated.orders, 1); assert.ok(sum.simulated.afterFeesCents > 0);
  assert.equal(d.db.prepare("SELECT COUNT(*) n FROM costs WHERE kind='pod'").get().n, 0, 'no COGS for a simulated sale');
});

test('over HTTP: POST /api/sales/sync and GET /api/sales; a refused sync is a 409 with the reason', async () => {
  const { d, st } = liveDeps();
  const server = await new Promise(r => { const s = buildApp(d).listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const j = async (m, u) => { const r = await fetch(base + u, { method: m }); return { status: r.status, body: await r.json() }; };
  try {
    const no = await j('POST', '/api/sales/sync'); assert.equal(no.status, 409); assert.match(no.body.error, /No connected Etsy store/);
    const store = connectStore(d); published(d, store);
    st.receipts = [receipt(1001, T0, [tx(5001, 900, 1, 2500)])];
    const ok = await j('POST', '/api/sales/sync'); assert.equal(ok.status, 200); assert.equal(ok.body.newSales, 1);
    const list = await j('GET', '/api/sales'); assert.equal(list.body.sales.length, 1); assert.equal(list.body.summary.revenue.orders, 1);
    assert.ok(list.body.sales[0].feeSource);
  } finally { server.close(); }
});

test('the performance watcher runs reconcile + sales sync first and counts INGESTED sales (Etsy has no per-listing counter)', async () => {
  const { d, st } = liveDeps({ listings: { 900: { listing_id: 900, state: 'active', url: 'u', shop_id: 555, views: 500, num_favorers: 2, price: money(2500) } } });
  const store = connectStore(d); const pid = published(d, store);
  d.db.prepare("UPDATE products SET stage='published' WHERE id=?").run(pid);
  st.receipts = [receipt(1001, T0, [tx(5001, 900, 1, 2500)])];
  const run = await d.watch.runAll({ trigger: 'manual', only: ['performance'] });
  const r = run.runs[0];
  assert.equal(r.status, 'ok', JSON.stringify(r)); assert.match(r.summary, /sales sync: ok \(1 new\)/); assert.match(r.summary, /reconcile: ok/);
  assert.equal(d.db.prepare('SELECT stage FROM products WHERE id=?').get(pid).stage, 'live', 'reconcile moved it to live');
  assert.equal(d.db.prepare("SELECT COUNT(*) n FROM alerts WHERE kind='views_no_sales'").get().n, 0, '500 views but a sale exists: no zero-sales alert');
});
