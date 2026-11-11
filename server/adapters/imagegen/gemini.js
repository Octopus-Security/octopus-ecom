'use strict';
/**
 * imagegen/gemini.js — Google Gemini image models ("Nano Banana"), BYOK key `gemini`, through ../http.js.
 *
 * Docs read 2026-11-11: https://aistudio.google.com/docs/image-generation (ai.google.dev/gemini-api/docs/image-generation
 * 301-redirects there). VERIFIED from that page: the current surface is the Interactions API,
 *   POST https://generativelanguage.googleapis.com/v1beta/interactions
 *   headers x-goog-api-key, Content-Type: application/json, Api-Revision: 2026-05-20
 *   body { model, input: <string | parts>, response_format: { type: "image", mime_type, aspect_ratio, image_size } }
 *   model ids gemini-nano-banana-2.1, gemini-3.1-flash-lite-image, gemini-3.1-flash-image, gemini-3-pro-image,
 *   gemini-2.5-flash-image (deprecated); image_size "1K"/"2K"/"4K" (uppercase K required; 512px only on 3.1 Flash Image);
 *   aspect_ratio values seen: 1:1, 16:9, 5:4 (plus 1:4, 4:1, 1:8, 8:1 on two models).
 * ASSUMED, UNVERIFIED (the page shows SDK samples, not raw REST JSON):
 *   - the REST response: `steps[]` with `type: "model_output"`, whose `content[]` holds blocks `{type:"image", data:<base64>}`.
 *     Parsing is tolerant (also accepts mime_type / mimeType, and a top-level `output_image.data`).
 *   - mime_type "image/png" is honoured (the page's example asks for image/jpeg); a non-PNG answer is rejected by fitToArea.
 *   - aspect_ratio "4:5" (portrait) exists; only 5:4 and 1:1 were seen on the page.
 *   - pixel dimensions per image_size: the page names tiers only. Real size is read from the PNG header, never claimed.
 * Prices: ./pricing.js (verified 2026-11-11, plus 25% headroom for thinking tokens, assumed).
 * One image per request: count N makes N sequential requests; the cap is checked for ALL of them first.
 */
const { geminiCostCents, GEMINI_MODELS } = require('./pricing');
const { orientation, saveImage, checkCount } = require('./shared');

const URL_GEN = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const API_REVISION = '2026-05-20';
const RATIO = { portrait: '4:5', landscape: '5:4', square: '1:1' };

function findImages(body) {
  const out = [];
  const take = b => { if (b && typeof b.data === 'string' && b.data && (!b.type || b.type === 'image')) out.push(b.data); };
  for (const step of Array.isArray(body && body.steps) ? body.steps : []) {
    if (step && step.type === 'model_output') for (const b of Array.isArray(step.content) ? step.content : []) if (b && b.type === 'image') take(b);
  }
  if (!out.length && body && body.output_image) take(body.output_image);
  return out;
}

function createGeminiImages({ http, credentials, log = console, dataDir, spend, upscale, model = 'gemini-3.1-flash-image', resolution = '2K' } = {}) {
  const sizeFor = () => {
    const m = GEMINI_MODELS[model];
    if (!m) throw new Error(`No size/price table for Gemini image model "${model}"; refusing to spend blindly.`);
    const want = String(resolution || '').toUpperCase();
    return m.sizes.includes(want) ? want : m.sizes[m.sizes.length > 1 ? 1 : 0]; // a size the model lacks falls to its default, not to a guess
  };
  return {
    implemented: true,
    estimate({ width = 4500, height = 5400, count = 1 } = {}) {
      const size = sizeFor();
      return { size, aspectRatio: RATIO[orientation(width, height)], costCents: geminiCostCents(model, size, count) };
    },
    async generate(brief, { width = 4500, height = 5400, count = 1 } = {}) {
      checkCount(count);
      const { size, aspectRatio, costCents: estimate } = this.estimate({ width, height, count });
      if (spend) spend.assertCanSpend(estimate); // BEFORE any request
      const key = credentials.get('gemini');
      if (!key) throw new Error('Image provider "gemini" is selected but no Gemini key is set (Settings, Credentials, gemini, or GEMINI_API_KEY).');
      const images = [];
      for (let i = 0; i < count; i++) {
        const res = await http.request(URL_GEN, {
          method: 'POST', headers: { 'x-goog-api-key': key, 'Api-Revision': API_REVISION },
          json: { model, input: brief, response_format: { type: 'image', mime_type: 'image/png', aspect_ratio: aspectRatio, image_size: size } },
          timeoutMs: 240000,
        });
        let body;
        try { body = res.json(); } catch { throw new Error('Gemini returned a non-JSON body'); }
        const data = findImages(body)[0];
        if (!data) throw new Error('Gemini returned no image data');
        images.push(await saveImage({ png: Buffer.from(data, 'base64'), width, height, upscale, log, dataDir, extra: { requestedSize: size, aspectRatio } }));
      }
      return { images, costCents: geminiCostCents(model, size, images.length), model };
    },
  };
}
module.exports = { createGeminiImages, URL_GEN, API_REVISION };
