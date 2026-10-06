'use strict';
/**
 * fees.js — Etsy US fee constants and the projected-margin formula (decision 8).
 * All money is integer cents. Constants live ONLY here, each with its provenance.
 *
 * Provenance, honestly stated (checked 2026-10-05): Etsy's own pages
 * (help.etsy.com Fees and Payments Policy, etsy.com/legal/fees) returned
 * HTTP 403 to the fetch tool, so they were NOT read. The figures below were read
 * on a third-party page (fitsmallbusiness.com/etsy-seller-fees, "Updated Jun 23,
 * 2025") and corroborated by search-result summaries from several other
 * third-party calculators. So they are marked "corroborated, official page not
 * read" rather than "verified".
 */

// corroborated 2026-10-05, official Etsy page not read (403) — source: https://fitsmallbusiness.com/etsy-seller-fees/
const LISTING_FEE_CENTS = 20;                  // $0.20 per listing (also renews every 4 months if it auto-renews; renewal is not modelled)

// corroborated 2026-10-05, official Etsy page not read (403) — source: https://fitsmallbusiness.com/etsy-seller-fees/
const TRANSACTION_FEE_BPS = 650;               // 6.5% of item price + shipping (+ gift wrap/personalisation, not modelled)

// corroborated 2026-10-05, official Etsy page not read (403) — source: https://fitsmallbusiness.com/etsy-seller-fees/
const PROCESSING_FEE_BPS = 300;                // 3% of the order total ...
const PROCESSING_FIXED_CENTS = 25;             // ... + $0.25 (US sellers; other countries differ)

// assumed 2026-10-05, unverified — offsite ads (12%/15% of order) and currency conversion are NOT modelled; they only apply in some cases.

const bps = (cents, rate) => Math.round((cents * rate) / 10000);

/**
 * Projected unit margin = list price - POD base cost - listing fee
 *   - transaction fee(list price + shipping charged) - processing fee.
 * Decision 8's literal formula: shipping charged feeds the fee bases but is not
 * counted as revenue (the POD shipping cost it would offset is not modelled in M0).
 */
function projectMargin({ listPriceCents, shippingCents = 0, podBaseCostCents }) {
  for (const [k, v] of Object.entries({ listPriceCents, shippingCents, podBaseCostCents })) {
    if (!Number.isInteger(v) || v < 0) throw new Error(`${k} must be a non-negative integer (cents)`);
  }
  const orderTotal = listPriceCents + shippingCents;
  const listingFeeCents = LISTING_FEE_CENTS;
  const transactionFeeCents = bps(orderTotal, TRANSACTION_FEE_BPS);
  const processingFeeCents = bps(orderTotal, PROCESSING_FEE_BPS) + PROCESSING_FIXED_CENTS;
  const marginCents = listPriceCents - podBaseCostCents - listingFeeCents - transactionFeeCents - processingFeeCents;
  return { marginCents, listingFeeCents, transactionFeeCents, processingFeeCents, podBaseCostCents };
}

/** Flags for a projected margin: <= 0 or below the floor blocks autopublish. */
function marginFlags(marginCents, floorCents) {
  if (marginCents <= 0) return [{ code: 'margin_non_positive', detail: `projected margin ${(marginCents / 100).toFixed(2)}` }];
  if (marginCents < floorCents) return [{ code: 'margin_below_floor', detail: `${(marginCents / 100).toFixed(2)} < floor ${(floorCents / 100).toFixed(2)}` }];
  return [];
}

module.exports = { LISTING_FEE_CENTS, TRANSACTION_FEE_BPS, PROCESSING_FEE_BPS, PROCESSING_FIXED_CENTS, projectMargin, marginFlags };
