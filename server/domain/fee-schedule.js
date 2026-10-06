'use strict';
/**
 * fee-schedule.js — the editable Etsy fee schedule: defaults, provenance, validation, persistence.
 * Money is integer cents, percentages are integer basis points (100 bps = 1%). Stored as ONE JSON value under the
 * `fee_schedule` setting, so a save is atomic; `version` increments on every save and every projection records which
 * schedule it used, so editing a rate never silently rewrites what an earlier projection said.
 *
 * Provenance. VERIFIED 2026-10-06: the owner read Etsy's own "Fees for selling on Etsy" page (shown during shop setup)
 * and supplied it. That page lists: set-up fee $29 (at shop opening); listing fee $0.20 per listing on create or renew;
 * transaction fee 6.5% of the order total EXCLUDING tax (item price + shipping); payment processing 3% of the order total
 * INCLUDING tax and shipping, + $0.25 (US; varies by country); currency conversion 2.5% of sales funds when the listing
 * currency differs from the payment account currency; Offsite Ads 12-15% of the order total on sales made through those ads
 * (optional for most sellers, may become required by 12-month sales). Fees exclude VAT/similar taxes.
 * ASSUMED, UNVERIFIED (not on that page): which of 12%/15% applies (commonly 15% under $10k/yr, 12% at or above); the
 * $100 per-order Offsite Ads cap; the currency-conversion base; the sales-tax rate (an estimate used ONLY for the
 * processing-fee base); the expected Offsite Ads share. NOT MODELLED: the $0.20 auto-renew fee charged again on each sale
 * of a multi-quantity listing (assumed, unverified).
 */

const VERIFIED_ON = '2026-10-06';
const VERIFIED_SOURCE = "Etsy's own \"Fees for selling on Etsy\" page (shop-setup flow), read by the owner";

// key -> { label, unit: 'cents'|'bps', min, max, status: 'verified'|'assumed', note }
const FIELDS = {
  setupFeeCents:          { label: 'One-time set-up fee', unit: 'cents', min: 0, max: 100000, status: 'verified', note: 'Due once, at shop opening. Not part of per-unit margin; used for break-even.' },
  listingFeeCents:        { label: 'Listing fee (per listing)', unit: 'cents', min: 0, max: 1000, status: 'verified', note: 'Charged on create or renew.' },
  transactionBps:         { label: 'Transaction fee', unit: 'bps', min: 0, max: 3000, status: 'verified', note: 'Of the order total EXCLUDING tax (item + shipping).' },
  processingBps:          { label: 'Payment processing fee', unit: 'bps', min: 0, max: 2000, status: 'verified', note: 'Of the order total INCLUDING tax and shipping (US).' },
  processingFixedCents:   { label: 'Payment processing fixed fee', unit: 'cents', min: 0, max: 500, status: 'verified', note: 'Added to the percentage (US; varies by country).' },
  currencyConversionBps:  { label: 'Currency conversion fee', unit: 'bps', min: 0, max: 1000, status: 'verified', note: 'Of sales funds, only when the listing currency differs from the payout currency. Base (order total incl. tax) assumed, unverified.' },
  currencyConversionApplies: { label: 'Listing currency differs from payout currency', unit: 'bool', status: 'verified', note: 'Off by default.' },
  offsiteAdsBps:          { label: 'Offsite Ads fee rate', unit: 'bps', min: 0, max: 3000, status: 'assumed', note: 'Etsy says 12-15% of the order total on ad-driven sales; which rate applies is assumed (15% under $10k/yr, 12% at or above), unverified.' },
  offsiteAdsCapCents:     { label: 'Offsite Ads fee cap per order', unit: 'cents', min: 0, max: 1000000, status: 'assumed', note: 'Commonly $100 per order; not on the page, unverified.' },
  offsiteAdsShareBps:     { label: 'Expected share of sales from Offsite Ads', unit: 'bps', min: 0, max: 10000, status: 'assumed', note: 'Your estimate. Expected cost per sale = rate x share. Default 0.' },
  salesTaxBps:            { label: 'Assumed sales-tax rate', unit: 'bps', min: 0, max: 2500, status: 'assumed', note: 'ESTIMATE, used only for the processing-fee base. Etsy collects and remits US marketplace sales tax, so tax is not your revenue, but the processing fee is charged on it.' },
};

const DEFAULTS = Object.freeze({
  setupFeeCents: 2900, listingFeeCents: 20, transactionBps: 650, processingBps: 300, processingFixedCents: 25,
  currencyConversionBps: 250, currencyConversionApplies: false,
  offsiteAdsBps: 1500, offsiteAdsCapCents: 10000, offsiteAdsShareBps: 0, salesTaxBps: 700,
});

/** The schedule in force when nothing has been saved: the verified defaults, version 0. */
const DEFAULT_SCHEDULE = Object.freeze({ ...DEFAULTS, version: 0, updatedAt: null });

class FeeScheduleError extends Error { constructor(m) { super(m); this.status = 400; } }

/** Validate a (partial) edit over `base`; returns the merged values (no version). Unknown keys and bad values are refused. */
function validate(patch, base = DEFAULTS) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new FeeScheduleError('schedule must be an object');
  const out = {};
  for (const k of Object.keys(FIELDS)) out[k] = base[k];
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'version' || k === 'updatedAt') continue; // server-owned
    const f = FIELDS[k];
    if (!f) throw new FeeScheduleError(`unknown fee field: ${k}`);
    if (f.unit === 'bool') {
      if (typeof v !== 'boolean') throw new FeeScheduleError(`${k} must be true or false`);
      out[k] = v;
    } else {
      if (!Number.isInteger(v) || v < f.min || v > f.max) throw new FeeScheduleError(`${k} must be a whole number of ${f.unit === 'cents' ? 'cents' : 'basis points'} from ${f.min} to ${f.max}`);
      out[k] = v;
    }
  }
  return out;
}

/** The schedule currently in force (stored, else defaults). A corrupt stored value falls back to defaults rather than throwing. */
function loadSchedule(settings) {
  const raw = settings && settings.get('fee_schedule');
  if (!raw) return DEFAULT_SCHEDULE;
  try {
    const o = JSON.parse(raw);
    return { ...validate(o), version: Number.isInteger(o.version) ? o.version : 0, updatedAt: o.updatedAt || null };
  } catch { return DEFAULT_SCHEDULE; }
}

function saveSchedule(settings, patch, now = () => new Date()) {
  const cur = loadSchedule(settings);
  const merged = validate(patch, cur);
  const next = { ...merged, version: cur.version + 1, updatedAt: now().toISOString() };
  settings.set('fee_schedule', JSON.stringify(next));
  return next;
}

/** Reset to the verified defaults; still a new version, so history shows the reset. */
const resetSchedule = (settings, now) => saveSchedule(settings, { ...DEFAULTS }, now);

module.exports = { VERIFIED_ON, VERIFIED_SOURCE, FIELDS, DEFAULTS, DEFAULT_SCHEDULE, FeeScheduleError, validate, loadSchedule, saveSchedule, resetSchedule };
