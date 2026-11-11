'use strict';
/**
 * pricing.js — OpenAI image models: the sizes the API accepts and what one image costs.
 *
 * Money is integer cents; the table is in 1/100 cent ("hundredths") only where a
 * price is not a whole cent. Costs are rounded UP to a whole cent per call.
 *
 * gpt-image-1 sizes and per-image prices:
 *   verified 2026-10-05 — https://developers.openai.com/api/docs/models/gpt-image-1
 *   (read through the fetch tool's page summary: three sizes are priced, 1024x1024,
 *   1024x1536, 1536x1024, at low/medium/high). The page does not list a larger size
 *   for this model, so the largest supported size is taken to be 1536 on the long edge.
 *   The current image-generation guide (https://developers.openai.com/api/docs/guides/image-generation)
 *   documents custom sizes up to 3840 on an edge, but only for the newer gpt-image-2.5
 *   models, which are NOT priced here; select one with IMAGE_MODEL only after adding it.
 * Prices as read, USD per image:
 *   low 1024x1024 0.011, 1024x1536 0.016, 1536x1024 0.016
 *   medium 0.042 / 0.063 / 0.063      high 0.167 / 0.25 / 0.25
 */
const PRICE_TABLE_DATE = '2026-10-05';

// cents per image, as hundredths of a cent to keep integers: 0.011 USD = 110 hundredths.
const MODELS = {
  'gpt-image-1': {
    sizes: ['1024x1024', '1024x1536', '1536x1024'],
    hundredthsCents: {
      low:    { '1024x1024': 110, '1024x1536': 160, '1536x1024': 160 },
      medium: { '1024x1024': 420, '1024x1536': 630, '1536x1024': 630 },
      high:   { '1024x1024': 1670, '1024x1536': 2500, '1536x1024': 2500 },
    },
  },
};

/** The largest supported size whose orientation matches the request (area wins). */
function pickSize(model, width, height) {
  const m = MODELS[model];
  if (!m) throw new Error(`No size/price table for image model "${model}"; refusing to spend blindly.`);
  const want = width === height ? 'square' : width > height ? 'landscape' : 'portrait';
  const orient = s => { const [w, h] = s.split('x').map(Number); return w === h ? 'square' : w > h ? 'landscape' : 'portrait'; };
  const area = s => s.split('x').map(Number).reduce((a, b) => a * b, 1);
  return m.sizes.filter(s => orient(s) === want).sort((a, b) => area(b) - area(a))[0];
}

/** Whole cents (rounded up) for `n` images. Throws on an unknown model/quality/size. */
function imageCostCents(model, quality, size, n = 1) {
  const h = MODELS[model] && MODELS[model].hundredthsCents[quality] && MODELS[model].hundredthsCents[quality][size];
  if (!h) throw new Error(`No price for ${model} ${quality} ${size}; refusing to spend blindly.`);
  return Math.ceil((h * n) / 100);
}

module.exports = { MODELS, PRICE_TABLE_DATE, pickSize, imageCostCents };

/* ---------------------------------------------------------------------------------------------
 * Gemini, xAI and OpenRouter (added 2026-11-11). Same rules: integer cents, rounded UP, and an
 * unknown model/size is REFUSED for Gemini and xAI (their prices are tabled). OpenRouter lists
 * hundreds of models, so its ESTIMATE is a configurable per-image ceiling instead (see below).
 * ------------------------------------------------------------------------------------------- */

/**
 * Gemini: USD per image, "Standard" tier (not Batch/Flex/Priority).
 *   verified 2026-11-11 — https://aistudio.google.com/docs/pricing (ai.google.dev/gemini-api/docs/pricing
 *   301-redirects there). The page converts token rates to per-image figures. The Imagen models were not in
 *   the part of the page that was read, so they are NOT priced here.
 * Thinking models also bill text/thinking tokens ("billed by default for thinking models", image-generation
 * guide, read 2026-11-11) and the page gives no per-image figure for those, so GEMINI_HEADROOM adds 25% to
 * every estimate. That headroom is an assumption, not a documented number.
 * Pixel dimensions per size are NOT stated on the pages read: "1K/2K/4K" are tier names only.
 */
const GEMINI_HEADROOM = 1.25;
const GEMINI_MODELS = {
  'gemini-nano-banana-2.1':      { label: 'Nano Banana 2.1', sizes: ['1K', '2K', '4K'], usd: { '1K': 0.0336, '2K': 0.0504, '4K': 0.113 } },
  'gemini-3.1-flash-lite-image': { label: 'Nano Banana 2 Lite', sizes: ['1K'], usd: { '1K': 0.0336 } },
  'gemini-3.1-flash-image':      { label: 'Nano Banana 2', sizes: ['1K', '2K', '4K'], usd: { '1K': 0.067, '2K': 0.101, '4K': 0.151 } },
  'gemini-3-pro-image':          { label: 'Nano Banana Pro', sizes: ['1K', '2K', '4K'], usd: { '1K': 0.134, '2K': 0.134, '4K': 0.24 } },
  // Deprecated (shutdown 2027-03-15 per the pricing page); up to 1024x1024 only.
  'gemini-2.5-flash-image':      { label: 'Nano Banana (deprecated)', sizes: ['1K'], usd: { '1K': 0.039 } },
};

/**
 * xAI: USD per image.
 *   verified 2026-11-11 — https://docs.x.ai/developers/pricing: grok-imagine-image $0.02, grok-imagine-image-2.0 $0.04
 *   ("fixed fee" per image). The pages say nothing about whether resolution "2k" costs more than "1k", so
 *   2k is estimated at DOUBLE the listed price (assumed, unverified; errs high on purpose because it feeds the cap).
 */
const XAI_MODELS = {
  'grok-imagine-image':     { sizes: ['1k', '2k'], usd: 0.02 },
  'grok-imagine-image-2.0': { sizes: ['1k', '2k'], usd: 0.04 },
};

/**
 * OpenRouter: no reliable per-image price. Its image endpoints publish pricing per endpoint
 * (/api/v1/images/models/{id}/endpoints: unit image|megapixel|token, cost_usd), read 2026-11-11 at
 * https://openrouter.ai/docs/features/multimodal/image-generation, but that is per model and per provider and is not
 * fetched here. The pre-flight estimate is therefore a flat CEILING per image (default 25 cents, assumed:
 * above every price seen on the other providers), overridable via the setting `image_max_cents` / IMAGE_MAX_CENTS.
 * The cost RECORDED after a call is the response's own `usage.cost` when present.
 */
const OPENROUTER_DEFAULT_CEILING_CENTS = 25;

function geminiCostCents(model, size, n = 1) {
  const m = GEMINI_MODELS[model];
  const usd = m && m.usd[size];
  if (!usd) throw new Error(`No price for Gemini model "${model}" at ${size}; refusing to spend blindly.`);
  return Math.ceil(usd * GEMINI_HEADROOM * 100 * n - 1e-9);
}
function xaiCostCents(model, resolution, n = 1) {
  const m = XAI_MODELS[model];
  if (!m || !m.sizes.includes(resolution)) throw new Error(`No price for xAI model "${model}" at ${resolution}; refusing to spend blindly.`);
  const usd = m.usd * (resolution === '2k' ? 2 : 1);
  return Math.ceil(usd * 100 * n - 1e-9);
}
function openrouterCostCents(ceilingCents, n = 1) {
  const c = Number.isFinite(ceilingCents) && ceilingCents > 0 ? ceilingCents : OPENROUTER_DEFAULT_CEILING_CENTS;
  return Math.ceil(c * n);
}

module.exports.GEMINI_MODELS = GEMINI_MODELS;
module.exports.XAI_MODELS = XAI_MODELS;
module.exports.GEMINI_HEADROOM = GEMINI_HEADROOM;
module.exports.OPENROUTER_DEFAULT_CEILING_CENTS = OPENROUTER_DEFAULT_CEILING_CENTS;
module.exports.geminiCostCents = geminiCostCents;
module.exports.xaiCostCents = xaiCostCents;
module.exports.openrouterCostCents = openrouterCostCents;
