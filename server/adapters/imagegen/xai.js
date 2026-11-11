'use strict';
/**
 * imagegen/xai.js — xAI (Grok Imagine) images, BYOK key `xai`, through ../http.js.
 *
 * Docs read 2026-11-11: https://docs.x.ai/docs/guides/image-generations and
 * https://docs.x.ai/developers/model-capabilities/images/generation . VERIFIED there:
 *   POST https://api.x.ai/v1/images/generations   (OpenAI-shaped; Authorization: Bearer <key>)
 *   models grok-imagine-image, grok-imagine-image-2.0; body fields model, prompt, n (1-10), response_format
 *   (`url` default, or `b64_json`), aspect_ratio (1:1, 3:4, 4:3, 2:3, 3:2, 9:16, 16:9, ..., auto), resolution (`1k` default, `2k`).
 *   `quality` (low/medium/auto) exists for grok-imagine-image-2.0 only; it is NOT sent.
 * ASSUMED, UNVERIFIED: the synchronous response is `{ data: [{ b64_json }] }` (the pages only show the OpenAI SDK reading
 *   response.data[0].b64_json); that output is a PNG (a JPEG answer is rejected by fitToArea); pixel size per resolution
 *   (not stated: the real size is read from the PNG header); whether 2k costs more (see ./pricing.js, estimated at 2x).
 *   `size`/OpenAI-only fields are not sent, so whether xAI rejects them is not relevant.
 */
const { xaiCostCents, XAI_MODELS } = require('./pricing');
const { orientation, saveImage, checkCount } = require('./shared');

const URL_GEN = 'https://api.x.ai/v1/images/generations';
const RATIO = { portrait: '3:4', landscape: '4:3', square: '1:1' };

function createXaiImages({ http, credentials, log = console, dataDir, spend, upscale, model = 'grok-imagine-image-2.0', resolution = '2k' } = {}) {
  const resFor = () => {
    if (!XAI_MODELS[model]) throw new Error(`No size/price table for xAI image model "${model}"; refusing to spend blindly.`);
    const r = String(resolution || '').toLowerCase();
    return XAI_MODELS[model].sizes.includes(r) ? r : '1k';
  };
  return {
    implemented: true,
    estimate({ width = 4500, height = 5400, count = 1 } = {}) {
      const res = resFor();
      return { size: res, aspectRatio: RATIO[orientation(width, height)], costCents: xaiCostCents(model, res, count) };
    },
    async generate(brief, { width = 4500, height = 5400, count = 1 } = {}) {
      checkCount(count);
      const { size, aspectRatio, costCents: estimate } = this.estimate({ width, height, count });
      if (spend) spend.assertCanSpend(estimate);
      const key = credentials.get('xai');
      if (!key) throw new Error('Image provider "xai" is selected but no xAI key is set (Settings, Credentials, xai, or XAI_API_KEY).');
      const res = await http.request(URL_GEN, {
        method: 'POST', headers: { Authorization: `Bearer ${key}` },
        json: { model, prompt: brief, n: count, response_format: 'b64_json', aspect_ratio: aspectRatio, resolution: size },
        timeoutMs: 240000,
      });
      let body;
      try { body = res.json(); } catch { throw new Error('xAI Images returned a non-JSON body'); }
      const items = Array.isArray(body && body.data) ? body.data.filter(d => d && typeof d.b64_json === 'string' && d.b64_json) : [];
      if (!items.length) throw new Error('xAI Images returned no b64_json image data');
      const images = [];
      for (const it of items) images.push(await saveImage({ png: Buffer.from(it.b64_json, 'base64'), width, height, upscale, log, dataDir, extra: { requestedSize: size, aspectRatio } }));
      return { images, costCents: xaiCostCents(model, size, images.length), model };
    },
  };
}
module.exports = { createXaiImages, URL_GEN };
