'use strict';
/**
 * imagegen/openrouter.js — OpenRouter image generation, BYOK key `openrouter`, through ../http.js.
 *
 * Docs read 2026-11-11: https://openrouter.ai/docs/features/multimodal/image-generation . VERIFIED there: a dedicated
 * Images API (not chat completions; no page on chat-completions image output was found in the docs index, so that route is NOT used):
 *   POST https://openrouter.ai/api/v1/images   (Authorization: Bearer <key>)
 *   body { model, prompt, n (1-10), size, aspect_ratio, resolution ("2K" in the example), quality, output_format, ... }; only model + prompt required
 *   response { created, data: [{ b64_json, media_type }], usage: { cost, ... } }, images are base64 bytes
 *   models: GET /api/v1/images/models (or /api/v1/models?output_modalities=image); per-endpoint pricing lines
 *   (billable, unit image|megapixel|token, cost_usd) at /api/v1/images/models/{id}/endpoints; a failed generation returns 502 and records no charge.
 *   Providers that reject explicit pixel sizes (xAI, Sourceful) 400 on `size`, so `size` is NEVER sent; only aspect_ratio.
 * ASSUMED, UNVERIFIED: that every image model accepts aspect_ratio and output_format "png" (an unsupported field would 400,
 *   which surfaces as an error, not a charge); a model id has no default here on purpose: the owner chooses one in Settings
 *   (the docs' example is "openai/gpt-image-1", not a recommendation). Pixel size is not stated; the real size is read from the PNG.
 * PRICE: no reliable per-image figure (see ./pricing.js). The cap check uses a flat per-image CEILING (default 25 cents); the cost
 *   RECORDED is the response's usage.cost (USD, rounded up to a cent) when it is a finite number, else the ceiling.
 */
const { openrouterCostCents } = require('./pricing');
const { orientation, saveImage, checkCount } = require('./shared');

const URL_GEN = 'https://openrouter.ai/api/v1/images';
const RATIO = { portrait: '3:4', landscape: '4:3', square: '1:1' };

function createOpenRouterImages({ http, credentials, log = console, dataDir, spend, upscale, model = '', ceilingCents } = {}) {
  const need = () => { if (!model) throw new Error('Image provider "openrouter" is selected but no model is chosen (Settings, Image generation, model, e.g. a model id from openrouter.ai).'); };
  return {
    implemented: true,
    estimate({ width = 4500, height = 5400, count = 1 } = {}) {
      need();
      return { size: null, aspectRatio: RATIO[orientation(width, height)], costCents: openrouterCostCents(ceilingCents, count), ceiling: true };
    },
    async generate(brief, { width = 4500, height = 5400, count = 1 } = {}) {
      checkCount(count);
      const { aspectRatio, costCents: estimate } = this.estimate({ width, height, count });
      if (spend) spend.assertCanSpend(estimate);
      const key = credentials.get('openrouter');
      if (!key) throw new Error('Image provider "openrouter" is selected but no OpenRouter key is set (Settings, Credentials, openrouter, or OPENROUTER_API_KEY).');
      const res = await http.request(URL_GEN, {
        method: 'POST', headers: { Authorization: `Bearer ${key}` },
        json: { model, prompt: brief, n: count, aspect_ratio: aspectRatio, output_format: 'png' },
        timeoutMs: 240000,
      });
      let body;
      try { body = res.json(); } catch { throw new Error('OpenRouter Images returned a non-JSON body'); }
      const items = Array.isArray(body && body.data) ? body.data.filter(d => d && typeof d.b64_json === 'string' && d.b64_json) : [];
      if (!items.length) throw new Error('OpenRouter Images returned no b64_json image data');
      const images = [];
      for (const it of items) images.push(await saveImage({ png: Buffer.from(it.b64_json, 'base64'), width, height, upscale, log, dataDir, extra: { aspectRatio } }));
      const usd = body.usage && Number(body.usage.cost);
      // Billed amount if the response states one; otherwise the ceiling for what came back (never below what was charged on the estimate side).
      const costCents = Number.isFinite(usd) && usd >= 0 && body.usage.cost !== null ? Math.ceil(usd * 100 - 1e-9) : openrouterCostCents(ceilingCents, images.length);
      return { images, costCents, model };
    },
  };
}
module.exports = { createOpenRouterImages, URL_GEN };
