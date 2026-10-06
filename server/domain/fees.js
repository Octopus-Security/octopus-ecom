'use strict';
/**
 * fees.js — Etsy US projected-margin formula and the pricing helper (decision 8).
 * All money is integer cents. The RATES live only in fee-schedule.js (defaults + provenance) and are editable in the
 * panel; every function here takes the schedule it should use, defaulting to the verified defaults.
 *
 * Provenance: fees VERIFIED 2026-10-06 from Etsy's own fee page (read by the owner); the assumed items (Offsite Ads rate
 * choice and cap, currency-conversion base, sales-tax rate, auto-renew listing fee not modelled) are listed in
 * fee-schedule.js and are marked "assumed, unverified" there and in the panel.
 *
 * Tax bases: the transaction fee is charged on the order total EXCLUDING tax; the processing fee on the order total
 * INCLUDING tax. Tax is not seller revenue, so it is estimated (salesTaxBps) only to build the processing base.
 */
const { DEFAULT_SCHEDULE, DEFAULTS } = require('./fee-schedule');

// Kept for callers that only need the verified default figure (2026-10-06); live code reads the schedule instead.
const LISTING_FEE_CENTS = DEFAULTS.listingFeeCents;
const TRANSACTION_FEE_BPS = DEFAULTS.transactionBps;
const PROCESSING_FEE_BPS = DEFAULTS.processingBps;
const PROCESSING_FIXED_CENTS = DEFAULTS.processingFixedCents;

const bps = (cents, rate) => Math.round((cents * rate) / 10000);
const nonNeg = (o) => {
  for (const [k, v] of Object.entries(o)) if (v !== undefined && (!Number.isInteger(v) || v < 0)) throw new Error(`${k} must be a non-negative integer (cents)`);
};

/** The fees on ONE order of `orderTotalCents` (item + shipping, no tax), as itemised lines. */
function feeLines(orderTotalCents, schedule = DEFAULT_SCHEDULE) {
  const s = schedule;
  const taxEstimateCents = bps(orderTotalCents, s.salesTaxBps);
  const inclTax = orderTotalCents + taxEstimateCents;
  const adsPerSale = Math.min(s.offsiteAdsCapCents, bps(orderTotalCents, s.offsiteAdsBps));
  return {
    taxEstimateCents,
    lines: [
      { key: 'listing', label: 'Listing fee', cents: s.listingFeeCents, basis: 'per listing' },
      { key: 'transaction', label: 'Transaction fee', cents: bps(orderTotalCents, s.transactionBps), basis: 'order total, excluding tax' },
      { key: 'processing', label: 'Payment processing fee', cents: bps(inclTax, s.processingBps) + s.processingFixedCents, basis: 'order total, including estimated tax, + fixed' },
      { key: 'currency', label: 'Currency conversion fee', cents: s.currencyConversionApplies ? bps(inclTax, s.currencyConversionBps) : 0, basis: s.currencyConversionApplies ? 'order total, including estimated tax' : 'not applied' },
      { key: 'offsite', label: 'Offsite Ads fee (expected)', cents: bps(adsPerSale, s.offsiteAdsShareBps), basis: `${(s.offsiteAdsShareBps / 100).toFixed(2)}% of sales x rate` },
    ],
  };
}

/**
 * Projected unit margin = list price (+ shipping charged - POD shipping cost, when podShippingCostCents is given)
 *   - POD base cost - every fee line. Returns the itemised breakdown plus the legacy fields callers use
 *   (marginCents, listingFeeCents, transactionFeeCents, processingFeeCents, podBaseCostCents).
 * Without podShippingCostCents, decision 8's literal formula holds: shipping charged feeds the fee bases but is treated
 * as pass-through (the POD shipping it would offset is not known), so it is not counted as revenue.
 */
function projectMargin({ listPriceCents, shippingCents = 0, podBaseCostCents, podShippingCostCents }, schedule = DEFAULT_SCHEDULE) {
  nonNeg({ listPriceCents, shippingCents, podBaseCostCents, podShippingCostCents });
  for (const k of ['listPriceCents', 'podBaseCostCents']) if (!Number.isInteger(arguments[0][k])) throw new Error(`${k} must be a non-negative integer (cents)`);
  const explicit = podShippingCostCents !== undefined;
  const orderTotal = listPriceCents + shippingCents;
  const { lines, taxEstimateCents } = feeLines(orderTotal, schedule);
  const by = Object.fromEntries(lines.map(l => [l.key, l.cents]));
  const totalFeesCents = lines.reduce((a, l) => a + l.cents, 0);
  const revenueCents = listPriceCents + (explicit ? shippingCents : 0);
  const marginCents = revenueCents - podBaseCostCents - (explicit ? podShippingCostCents : 0) - totalFeesCents;
  return {
    listPriceCents, shippingCents, marginCents, listingFeeCents: by.listing, transactionFeeCents: by.transaction, processingFeeCents: by.processing,
    currencyConversionFeeCents: by.currency, offsiteAdsFeeCents: by.offsite, podBaseCostCents,
    podShippingCostCents: explicit ? podShippingCostCents : null,
    totalFeesCents, feeLines: lines, orderTotalCents: orderTotal, taxEstimateCents, revenueCents,
    marginPct: listPriceCents > 0 ? Math.round((marginCents / listPriceCents) * 10000) / 100 : null,
    scheduleVersion: schedule.version, scheduleUsed: schedule,
  };
}

/** The compact record stored on a product so a later fee edit does not rewrite what this projection said. */
function snapshot(m) {
  return JSON.stringify({ marginCents: m.marginCents, totalFeesCents: m.totalFeesCents, feeLines: m.feeLines, orderTotalCents: m.orderTotalCents, taxEstimateCents: m.taxEstimateCents, marginPct: m.marginPct, scheduleVersion: m.scheduleVersion, schedule: m.scheduleUsed, at: new Date().toISOString() });
}

/**
 * Minimum list price that meets a target. Target is { marginCents } (absolute) or { marginPct } (of list price).
 * Fees are linear in price, so solve the line directly (once ignoring the Offsite Ads cap, once with it binding), then
 * VERIFY with the real rounded projectMargin and step by a cent until it holds (and back down while a cheaper cent holds).
 */
function minListPrice({ podBaseCostCents, podShippingCostCents = 0, shippingCents = 0, marginCents, marginPct }, schedule = DEFAULT_SCHEDULE) {
  nonNeg({ podBaseCostCents, podShippingCostCents, shippingCents });
  if (!Number.isInteger(podBaseCostCents)) throw new Error('podBaseCostCents must be a non-negative integer (cents)');
  if ((marginCents === undefined) === (marginPct === undefined)) throw new Error('give exactly one of marginCents or marginPct');
  if (marginCents !== undefined && (!Number.isInteger(marginCents) || marginCents < 0)) throw new Error('marginCents must be a non-negative integer (cents)');
  if (marginPct !== undefined && !(Number(marginPct) >= 0 && Number(marginPct) < 100)) throw new Error('marginPct must be from 0 to under 100');
  const s = schedule;
  const k = marginPct !== undefined ? Number(marginPct) / 100 : 0;
  const m = (p) => projectMargin({ listPriceCents: p, shippingCents, podBaseCostCents, podShippingCostCents }, schedule);
  const meets = (p) => { const r = m(p); return r.marginCents >= (marginPct !== undefined ? Math.ceil(k * p - 1e-9) : marginCents); };
  const taxF = 1 + s.salesTaxBps / 10000;
  const closed = (adsRate) => {
    // margin(P) ~ a*P + b, with T = P + shipping; adsRate is the effective fraction (0 when the cap binds)
    const f = s.transactionBps / 10000 + (s.processingBps / 10000) * taxF + (s.currencyConversionApplies ? (s.currencyConversionBps / 10000) * taxF : 0) + adsRate;
    const fixed = s.listingFeeCents + s.processingFixedCents + (adsRate === 0 ? s.offsiteAdsCapCents * s.offsiteAdsShareBps / 10000 : 0);
    const a = 1 - f;
    const b = -podBaseCostCents - podShippingCostCents + (shippingCents - f * shippingCents) - fixed;
    const denom = marginPct !== undefined ? a - k : a;
    if (denom <= 0) return null;
    return ((marginPct !== undefined ? 0 : marginCents) - b) / denom;
  };
  const cands = [closed((s.offsiteAdsBps / 10000) * (s.offsiteAdsShareBps / 10000)), closed(0)].filter(c => c !== null && Number.isFinite(c));
  if (!cands.length) throw new Error('No price can meet that target: fees take too large a share of the price.');
  let best = null;
  for (const c of cands) {
    let p = Math.max(0, Math.ceil(c));
    for (let i = 0; i < 5 && p > 0 && meets(p - 1); i++) p -= 1;
    let n = 0;
    while (!meets(p) && n++ < 2000) p += 1;
    if (meets(p) && (best === null || p < best)) best = p;
  }
  if (best === null) throw new Error('No price can meet that target: fees take too large a share of the price.');
  const projection = m(best);
  return { listPriceCents: best, projection, breakEvenUnits: breakEvenUnits(projection.marginCents, s.setupFeeCents) };
}

/** Units to sell to recover the one-time set-up fee at a given unit margin; null when the margin is not positive. */
function breakEvenUnits(unitMarginCents, setupFeeCents) {
  if (!(unitMarginCents > 0)) return null;
  return Math.ceil(setupFeeCents / unitMarginCents);
}

/** Flags for a projected margin: <= 0 or below the floor blocks autopublish. */
function marginFlags(marginCents, floorCents) {
  if (marginCents <= 0) return [{ code: 'margin_non_positive', detail: `projected margin ${(marginCents / 100).toFixed(2)}` }];
  if (marginCents < floorCents) return [{ code: 'margin_below_floor', detail: `${(marginCents / 100).toFixed(2)} < floor ${(floorCents / 100).toFixed(2)}` }];
  return [];
}

module.exports = { LISTING_FEE_CENTS, TRANSACTION_FEE_BPS, PROCESSING_FEE_BPS, PROCESSING_FIXED_CENTS, feeLines, projectMargin, snapshot, minListPrice, breakEvenUnits, marginFlags };
