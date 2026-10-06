'use strict';
/**
 * llm/pricing.js — dated per-model token prices and the tier -> model defaults.
 *
 * USD per 1M tokens (input, output), standard tier.
 *   verified 2026-10-05 — https://developers.openai.com/api/docs/pricing
 *   (read through the fetch tool's page summary): gpt-4.1-nano 0.10/0.40, gpt-4.1-mini 0.40/1.60,
 *   gpt-4.1 2.00/8.00, gpt-4o-mini 0.15/0.60, gpt-4o 2.50/10.00. That page also lists newer
 *   flagship models; they are not in this table. Add them here (with a date) before selecting one.
 * Cost is computed from the API's reported usage and rounded UP to a whole cent per call.
 * A model with no entry costs what LLM_PRICE_IN_PER_M / LLM_PRICE_OUT_PER_M say, or - if unset -
 * is priced at the most expensive entry here and reported as `priceAssumed: true`
 * (over-estimating makes the daily cap safe rather than leaky).
 */
const PRICE_TABLE_DATE = '2026-10-05';
const PRICES = {
  'gpt-4.1-nano': { in: 0.10, out: 0.40 },
  'gpt-4.1-mini': { in: 0.40, out: 1.60 },
  'gpt-4.1':      { in: 2.00, out: 8.00 },
  'gpt-4o-mini':  { in: 0.15, out: 0.60 },
  'gpt-4o':       { in: 2.50, out: 10.00 },
};
// Built-in tier mapping (assumed sensible, not a benchmark result). Overridden by
// LLM_MODEL_<TIER>, then by the router table (ROUTER_PATH), then these.
const DEFAULT_TIERS = { cheap: 'gpt-4.1-nano', standard: 'gpt-4.1-mini', deep: 'gpt-4.1' };
const WORST = { in: 10.00, out: 10.00 };

function priceFor(model, { priceInPerM = null, priceOutPerM = null } = {}) {
  if (Number.isFinite(priceInPerM) && Number.isFinite(priceOutPerM)) return { in: priceInPerM, out: priceOutPerM, assumed: false, source: 'env' };
  if (PRICES[model]) return { ...PRICES[model], assumed: false, source: 'table' };
  return { ...WORST, assumed: true, source: 'worst-case' };
}

/** Integer cents, rounded up, for given token counts. */
function costCents(price, inTokens, outTokens) {
  const usd = (inTokens * price.in + outTokens * price.out) / 1e6;
  return Math.ceil(usd * 100 - 1e-9);
}

/** Pre-call estimate: ~4 chars/token on the way in, the full max_tokens on the way out. */
function estimateCents(price, text, maxOut) { return costCents(price, Math.ceil(String(text).length / 4), maxOut); }

module.exports = { PRICES, DEFAULT_TIERS, PRICE_TABLE_DATE, priceFor, costCents, estimateCents };
