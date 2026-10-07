'use strict';
/**
 * imagegen/openai.js — OpenAI Images, BYOK, through ../http.js.
 *
 * Request: POST https://api.openai.com/v1/images/generations
 *   { model, prompt, size, quality, n, output_format: 'png' }, Authorization: Bearer <key>
 *   response: { data: [{ b64_json }] }
 * API shape: assumed, unverified. The image guide (https://developers.openai.com/api/docs/guides/image-generation,
 * read 2026-10-05) confirms GPT Image models return base64 image data, default format png, and
 * that output_format can be png/jpeg/webp; it does not describe gpt-image-1's endpoint body, so the
 * body above is from memory. `response_format` is deliberately NOT sent (not confirmed for GPT
 * Image models). Sizes/prices: see ./pricing.js (verified 2026-10-05).
 *
 * PRINT-GRADE, honestly: the API's largest size is far below a 4500x5400 print area, so the image
 * is then passed through the pluggable UPSCALE hook (../../upscale.js). Every returned image carries
 * its REAL width/height plus nativeWidth/nativeHeight/upscaled/upscaleMethod. Never a claimed size.
 *
 * The daily cap is checked BEFORE the call with the price-table estimate (a refusal makes no request).
 * The caller records the actual cost after.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fitToArea } = require('../../upscale');
const { pickSize, imageCostCents } = require('./pricing');

const URL_GEN = 'https://api.openai.com/v1/images/generations';
const QUALITIES = ['low', 'medium', 'high'];

function createOpenAiImages({ http, credentials, log = console, dataDir, spend, upscale, model = 'gpt-image-1', quality = 'high' } = {}) {
  return {
    implemented: true,
    /** What one call would cost, in cents (throws for an unpriced model/quality). */
    estimate({ width = 4500, height = 5400, count = 1, quality: q = quality } = {}) {
      const size = pickSize(model, width, height);
      return { size, costCents: imageCostCents(model, q, size, count) };
    },
    async generate(brief, { width = 4500, height = 5400, count = 1, quality: q = quality } = {}) {
      if (!QUALITIES.includes(q)) throw new Error(`quality must be one of ${QUALITIES.join('/')}`);
      if (!Number.isInteger(count) || count < 1 || count > 4) throw new Error('count must be 1-4');
      const { size, costCents: estimate } = this.estimate({ width, height, count, quality: q });
      if (spend) spend.assertCanSpend(estimate); // throws SpendCapError BEFORE any request
      const key = credentials.get('openai');
      if (!key) throw new Error('No OpenAI key');
      const res = await http.request(URL_GEN, {
        method: 'POST', headers: { Authorization: `Bearer ${key}` },
        json: { model, prompt: brief, size, quality: q, n: count, output_format: 'png' },
        timeoutMs: 240000,
      });
      let body;
      try { body = res.json(); } catch { throw new Error('OpenAI Images returned a non-JSON body'); }
      const items = Array.isArray(body && body.data) ? body.data.filter(d => d && typeof d.b64_json === 'string') : [];
      if (items.length === 0) throw new Error('OpenAI Images returned no b64_json image data');

      const dir = path.join(dataDir, 'images');
      fs.mkdirSync(dir, { recursive: true });
      const images = [];
      for (const it of items) {
        const fit = await fitToArea({ png: Buffer.from(it.b64_json, 'base64'), width, height, upscale, log }); // throws if the model did not return a PNG
        const { png, width: outW, height: outH, nativeWidth, nativeHeight, upscaleMethod: method } = fit;
        const file = `gen-${crypto.randomBytes(6).toString('hex')}.png`;
        fs.writeFileSync(path.join(dir, file), png);
        images.push({ file, width: outW, height: outH, mime: 'image/png', nativeWidth, nativeHeight, upscaled: fit.upscaled, upscaleMethod: method, requestedSize: size, quality: q });
      }
      // Billed per image returned; never more than the estimate for the count asked.
      return { images, costCents: imageCostCents(model, q, size, images.length), model };
    },
  };
}
module.exports = { createOpenAiImages, URL_GEN };
