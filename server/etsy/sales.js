'use strict';
/**
 * etsy/sales.js — receipt/transaction ingest into `sales`, plus per-sale COGS into `costs`.
 *
 *  - One `sales` row per TRANSACTION (Etsy: one transaction per listing purchased on a receipt), unique on
 *    (external_order_id = receipt id, transaction_id), so re-running a sync, or overlapping its window, never doubles anything.
 *  - gross = unit price x quantity + the shipping charged on that transaction (Etsy bases its fees on both; tax is not seller income
 *    and is left out). Currency conversion is not modelled: amounts are in the shop currency, assumed USD.
 *  - Fees: processing fee from Etsy's payment record when the API gives it; transaction fee ALWAYS computed from domain/fees.js
 *    (the API has no field for it). `fee_source` says which: 'payment_api+computed' or 'computed'. The receipt-level
 *    processing fee is split across its transactions in proportion to gross (remainder to the last).
 *  - COGS: when the listing is one of ours, a `costs` row kind 'pod' of base cost x quantity is written in the same transaction as the
 *    sale, so NET (sales.net - every cost) subtracts it. Receipts for listings we do not track are kept at store level
 *    (listing_id NULL, store_id set) and carry NO COGS: that cost is unknown, and the row says so (cogs_cents NULL).
 *  - Simulated receipts (the stub storefront) are stored with source 'stub', write no COGS, and are excluded from real NET.
 *  - NOT built: refunds. A receipt with refunds is counted in the result (`refundsSeen`) and logged, but not subtracted.
 */
const { tx } = require('../db');
const { TRANSACTION_FEE_BPS, PROCESSING_FEE_BPS, PROCESSING_FIXED_CENTS } = require('../domain/fees');

const OVERLAP_SECONDS = 2 * 24 * 3600; // re-read this far back each time; idempotency makes overlap free
const bps = (c, r) => Math.round((c * r) / 10000);

function makeSales({ db, adapters, spend, etsy, log = console, now = Date.now }) {
  const computedProcessing = gross => bps(gross, PROCESSING_FEE_BPS) + PROCESSING_FIXED_CENTS;

  async function sync({ actor = 'human', auto = false } = {}) {
    const real = adapters.storefront.describe().methods.getReceipts === 'real';
    const store = real ? etsy.etsyStore() : null;
    if (real) {
      if (!store || store.status !== 'connected' || !store.oauth_sealed) return { ok: false, skipped: true, source: 'etsy', reason: store && store.status_detail || 'No connected Etsy store: connect Etsy in Settings → Stores.' };
      if (!store.shop_id) return { ok: false, skipped: true, source: 'etsy', reason: store.status_detail || 'The connected Etsy account has no shop yet.' };
    } else if (auto) {
      return { ok: true, skipped: true, source: 'stub', reason: 'stub storefront: simulated sales are only generated on a manual sync' };
    }
    const source = real ? 'etsy' : 'stub';
    const storeId = store ? store.id : null;
    const sinceTs = store && store.sales_cursor ? Math.max(0, store.sales_cursor - OVERLAP_SECONDS) : 0;
    const known = db.prepare("SELECT external_id FROM listings WHERE platform = 'etsy' AND external_id IS NOT NULL").all().map(r => r.external_id);
    const got = await adapters.storefront.getReceipts(storeId, { sinceTs, listingIds: known });

    const byExt = new Map(db.prepare("SELECT l.id AS listing_id, l.external_id, l.product_id, p.pod_base_cost_cents AS base FROM listings l JOIN products p ON p.id = l.product_id WHERE l.platform = 'etsy' AND l.external_id IS NOT NULL").all().map(r => [r.external_id, r]));
    const out = { ok: true, source, receipts: got.receipts.length, newSales: 0, duplicates: 0, tracked: 0, untracked: 0, cogsCents: 0, grossCents: 0, refundsSeen: 0, complete: got.complete !== false, simulated: Boolean(got.simulated), requests: got.requests || 0 };

    const insert = db.prepare(`INSERT INTO sales(listing_id, external_order_id, transaction_id, store_id, product_id, external_listing_id, quantity, gross_cents, etsy_fees_cents, processing_fee_cents, net_cents, cogs_cents, fee_source, source, ts)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`);
    for (const r of got.receipts) {
      if (!r.isPaid) continue;
      if (r.refunds) { out.refundsSeen++; log.warn(`[sales] receipt ${r.receiptId} has refunds; refunds are not subtracted yet`); }
      const lines = r.transactions.map(t => ({ t, gross: t.unitCents * t.quantity + t.shippingCents }));
      const totalGross = lines.reduce((a, x) => a + x.gross, 0);
      const apiFee = Number.isInteger(r.processingFeeCents) ? r.processingFeeCents : null;
      let feeLeft = apiFee;
      lines.forEach((x, i) => {
        const last = i === lines.length - 1;
        let processing;
        if (apiFee === null) processing = computedProcessing(x.gross);
        else { processing = last ? feeLeft : Math.round(apiFee * (totalGross ? x.gross / totalGross : 1 / lines.length)); feeLeft -= processing; }
        const etsyFee = bps(x.gross, TRANSACTION_FEE_BPS);
        const net = x.gross - etsyFee - processing;
        const lst = x.t.listingId ? byExt.get(x.t.listingId) : null;
        const cogs = !out.simulated && lst && Number.isInteger(lst.base) ? lst.base * x.t.quantity : null;
        const ts = new Date((r.createdTs || Math.floor(now() / 1000)) * 1000).toISOString();
        tx(db, () => {
          const res = insert.run(lst ? lst.listing_id : null, r.receiptId, x.t.transactionId, storeId, lst ? lst.product_id : null, x.t.listingId, x.t.quantity, x.gross, etsyFee, processing, net, cogs, apiFee === null ? 'computed' : 'payment_api+computed', source, ts);
          if (res.changes === 0) { out.duplicates++; return; }
          out.newSales++; out.grossCents += x.gross;
          if (lst) out.tracked++; else out.untracked++;
          if (cogs) { spend.addCost({ productId: lst.product_id, kind: 'pod', amountCents: cogs, note: `COGS order ${r.receiptId} tx ${x.t.transactionId} x${x.t.quantity}` }); out.cogsCents += cogs; }
        });
      });
    }
    if (store) {
      // Only advance the cursor to what was actually read; an incomplete read resumes from there next time.
      db.prepare('UPDATE stores SET sales_cursor = MAX(COALESCE(sales_cursor, 0), ?), last_sales_sync_at = ? WHERE id = ?').run(got.maxCreated || 0, new Date(now()).toISOString(), store.id);
      out.cursor = Math.max(store.sales_cursor || 0, got.maxCreated || 0);
    }
    log.info(`[sales] sync (${source}${auto ? ', scheduled' : ''}, by ${actor}): ${out.newSales} new, ${out.duplicates} already known, ${out.untracked} untracked listing(s)`);
    return out;
  }

  /** Sales list + per-store roll-up (untracked receipts are counted here, never dropped). */
  function list({ limit = 100 } = {}) {
    const rows = db.prepare(`SELECT s.id, s.external_order_id AS orderId, s.transaction_id AS transactionId, s.quantity, s.gross_cents AS grossCents, s.etsy_fees_cents AS etsyFeesCents,
        s.processing_fee_cents AS processingFeeCents, s.net_cents AS netCents, s.cogs_cents AS cogsCents, s.fee_source AS feeSource, s.source, s.ts, s.store_id AS storeId,
        s.product_id AS productId, s.external_listing_id AS externalListingId, p.title AS productTitle
      FROM sales s LEFT JOIN products p ON p.id = s.product_id ORDER BY s.ts DESC, s.id DESC LIMIT ?`).all(Math.min(Math.max(limit | 0, 1), 500));
    const perStore = db.prepare(`SELECT s.store_id AS storeId, st.name AS storeName, s.source, COUNT(*) AS lines, COALESCE(SUM(s.gross_cents),0) AS grossCents, COALESCE(SUM(s.net_cents),0) AS netCents,
        COALESCE(SUM(s.cogs_cents),0) AS cogsCents, SUM(CASE WHEN s.listing_id IS NULL THEN 1 ELSE 0 END) AS untrackedLines
      FROM sales s LEFT JOIN stores st ON st.id = s.store_id GROUP BY s.store_id, s.source`).all();
    return { sales: rows, perStore };
  }

  return { sync, list };
}

module.exports = { makeSales, OVERLAP_SECONDS };
