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
