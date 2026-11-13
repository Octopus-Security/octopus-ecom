'use strict';
/**
 * imagegen/nous.js — Nous Portal subscription images through the FAL tool gateway.
 *
 * VERIFIED 2026-11-13 from Hermes Agent (tools/fal_common.py, image_generation_tool.py,
 * image_generation_catalog.py) and https://fal.ai/models/fal-ai/flux-2/klein/9b/api :
 *   Origin https://fal-queue-gateway.nousresearch.com. Submit POST {origin}/{model_id}
 *   with the FAL queue JSON body. Auth is Authorization: Key <portal token>
 *   (fal_client SyncClient), not Bearer. The response carries request_id, status_url,
 *   response_url. Poll until COMPLETED (IN_QUEUE, IN_PROGRESS; FAILED is an error).
 *   The result is images[].url. Klein accepts prompt, image_size as a preset or a
 *   custom {width,height}, num_inference_steps (default 4), output_format png, and
 *   enable_safety_checker. Klein's support list does not include num_images.
 *   Hermes defaults: steps 4, output_format png, enable_safety_checker false.
 *   flux-2-pro also has guidance_scale and safety_tolerance. qwen-image has steps,
 *   guidance, acceleration, and output_format. ideogram v3 does not take output_format.
 *
 * ASSUMED (no generation was spent to check): the Portal token is what the gateway
 * accepts in the Key scheme — the chat key for inference-api.nousresearch.com is not
 * proven to be that token. The Nous proxy accepts custom {width,height}, which the
 * FAL model page documents for direct FAL. Status strings match the FAL queue.
 *
 * Ceilings err high and are checked BEFORE any HTTP call. The gateway returns no price.
 * A saved PNG is reused later by the print-provider step; this module runs only when
 * someone asks for a new image.
 */
const { saveImage, checkCount } = require('./shared');

const GATEWAY_ORIGIN = 'https://fal-queue-gateway.nousresearch.com';
const GATEWAY_HOST = 'fal-queue-gateway.nousresearch.com';
const DEFAULT_MODEL = 'fal-ai/flux-2/klein/9b';

/** Per-image ceilings in cents. Klein/pro/qwen are cents per megapixel, rounded up. Ideogram is a flat top of its published range. */
const PRICE = {
  'fal-ai/flux-2/klein/9b': { centsPerMp: 1 },
  'fal-ai/flux-2-pro': { centsPerMp: 3 },
  'fal-ai/qwen-image': { centsPerMp: 2 },
  'fal-ai/ideogram/v3': { flatCents: 9 },
};
const NOUS_MODELS = Object.keys(PRICE);

/**
 * Pixel size actually requested. Multiples of 16, longest side 1024, and the short
 * side at least 512 when the print aspect can meet both. Aspect is preserved by
 * snapping the short side, not by a portrait/landscape preset (a preset would miss
 * the print area).
 */
function printSize(width, height) {
  const w = Math.max(1, Number(width) || 1);
  const h = Math.max(1, Number(height) || 1);
  const LONG = 1024;
  const MIN = 512;
  const snap = (n) => Math.max(16, Math.round(n / 16) * 16);
  if (w >= h) {
    let th = snap(LONG * (h / w));
    if (th > LONG) th = LONG;
    if (th < MIN && h / w >= MIN / LONG) th = MIN;
    return { width: LONG, height: th };
  }
  let tw = snap(LONG * (w / h));
  if (tw > LONG) tw = LONG;
  if (tw < MIN && w / h >= MIN / LONG) tw = MIN;
  return { width: tw, height: LONG };
}

function centsFor(model, w, h) {
  const spec = PRICE[model];
  if (!spec) throw new Error(`No price table for Nous image model "${model}"; refusing to spend blindly.`);
  if (spec.flatCents != null) return spec.flatCents;
  return Math.ceil(((w * h) / 1e6) * spec.centsPerMp);
}

function requestBody(model, prompt, size) {
  const image_size = { width: size.width, height: size.height };
  if (model === 'fal-ai/flux-2/klein/9b') {
    return { prompt, image_size, num_inference_steps: 4, output_format: 'png', enable_safety_checker: false };
  }
  if (model === 'fal-ai/flux-2-pro') {
    return { prompt, image_size, guidance_scale: 4.5, safety_tolerance: '5' };
  }
  if (model === 'fal-ai/qwen-image') {
    return { prompt, image_size, num_inference_steps: 30, guidance_scale: 2.5, acceleration: 'regular', output_format: 'png' };
  }
  if (model === 'fal-ai/ideogram/v3') {
    return { prompt, image_size, rendering_speed: 'BALANCED', expand_prompt: true, style: 'AUTO' };
  }
  throw new Error(`No price table for Nous image model "${model}"; refusing to spend blindly.`);
}

function gatewayError(err) {
  const status = err && err.status;
  const text = `${err && err.body ? err.body : ''} ${err && err.message ? err.message : ''}`;
  if (status === 401 || status === 403) {
    return new Error(`Nous image gateway refused the key (HTTP ${status}). It wants the Portal subscription token (the one from Hermes setup --portal), which is not always the chat inference key. Paste that token in Settings, Credentials, as nous.`);
  }
  if (status === 409 || /billing_error|unsupported_pricing_meter/i.test(text)) {
    return new Error('Nous image gateway rejected this model. Pick fal-ai/flux-2/klein/9b.');
  }
  return err;
}

function httpsHost(url, host) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === host;
  } catch { return false; }
}

function imageHostOk(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname;
  return host === 'fal.media' || host.endsWith('.fal.media');
}

function createNousImages({
  http, credentials, log = console, dataDir, spend, upscale,
  model = DEFAULT_MODEL, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxPolls = 40, pollMs = 2000,
} = {}) {
  return {
    implemented: true,
    estimate({ width = 4500, height = 5400, count = 1 } = {}) {
      const size = printSize(width, height);
      return { ...size, costCents: centsFor(model, size.width, size.height) * count };
    },
    async generate(brief, { width = 4500, height = 5400, count = 1 } = {}) {
      checkCount(count);
      const size = printSize(width, height);
      const each = centsFor(model, size.width, size.height);
      const estimate = each * count;
      if (spend) spend.assertCanSpend(estimate);
      const key = credentials.get('nous');
      if (!key) throw new Error('Image provider "nous" is selected but no Nous key is set (Settings, Credentials, nous, or NOUS_API_KEY).');
      const headers = { Authorization: `Key ${key}` };
      const images = [];
      for (let n = 0; n < count; n++) {
        let submitted;
        try {
          const res = await http.request(`${GATEWAY_ORIGIN}/${model}`, {
            method: 'POST', headers, json: requestBody(model, brief, size), redirect: 'manual', timeoutMs: 60000,
          });
          try { submitted = res.json(); } catch { throw new Error('Nous image gateway returned a non-JSON submit response'); }
        } catch (e) { throw gatewayError(e); }
        const requestId = String(submitted && submitted.request_id || '');
        if (!/^[A-Za-z0-9_-]+$/.test(requestId)) throw new Error('Nous image gateway returned an unexpected request id');
        const statusUrl = httpsHost(submitted.status_url, GATEWAY_HOST) ? submitted.status_url : `${GATEWAY_ORIGIN}/${model}/requests/${requestId}/status`;
        const resultUrl = httpsHost(submitted.response_url, GATEWAY_HOST) ? submitted.response_url : `${GATEWAY_ORIGIN}/${model}/requests/${requestId}`;
        let result;
        for (let i = 0; ; i++) {
          let body;
          try {
            const res = await http.request(statusUrl, { method: 'GET', headers, redirect: 'manual' });
            try { body = res.json(); } catch { throw new Error('Nous image gateway returned a non-JSON status'); }
          } catch (e) { throw gatewayError(e); }
          const st = String(body.status || '').toUpperCase();
          if (st === 'COMPLETED') {
            try {
              const done = await http.request(resultUrl, { method: 'GET', headers, redirect: 'manual' });
              try { result = done.json(); } catch { throw new Error('Nous image gateway returned a non-JSON result'); }
            } catch (e) { throw gatewayError(e); }
            break;
          }
          if (st === 'FAILED') throw new Error(`Nous image generation failed: ${body.error || body.detail || 'FAILED'}`);
          if (st !== 'IN_QUEUE' && st !== 'IN_PROGRESS') throw new Error(`Nous image gateway returned status "${st || 'empty'}"`);
          if (i + 1 >= maxPolls) throw new Error('Nous image generation did not finish in time');
          await sleep(pollMs);
        }
        const list = result && Array.isArray(result.images) ? result.images : [];
        const imageUrl = list.map((img) => img && img.url).find((u) => typeof u === 'string' && u);
        if (!imageUrl) throw new Error('Nous image gateway returned no image URL');
        if (!imageHostOk(imageUrl)) throw new Error('Refusing to download a design from a host other than fal.media');
        let bytes;
        try {
          const file = await http.request(imageUrl, { method: 'GET', binary: true, redirect: 'manual', timeoutMs: 60000 });
          bytes = file.bytes;
        } catch (e) { throw gatewayError(e); }
        if (!bytes || !bytes.length) throw new Error('Nous image download was empty');
        images.push(await saveImage({ png: bytes, width, height, upscale, log, dataDir, extra: { requestedSize: `${size.width}x${size.height}` } }));
      }
      return { images, costCents: each * images.length, model };
    },
  };
}

module.exports = { createNousImages, printSize, GATEWAY_ORIGIN, GATEWAY_HOST, NOUS_MODELS, DEFAULT_MODEL };
