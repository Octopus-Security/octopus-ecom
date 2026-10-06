'use strict';
/**
 * upscale.js — the UPSCALE step interface for image generation.
 *
 *   upscale({ png: Buffer, targetWidth, targetHeight })
 *     -> Promise<{ png: Buffer, width, height, method: string }>
 *
 * The contract: return a PNG whose REAL dimensions are reported in width/height.
 * A hook may reach less than the target (the default preserves aspect ratio and
 * fits inside it); it must never claim more than it produced. Print-readiness
 * (M4) compares the real size with the blueprint's requirement and rejects what
 * falls short. Plug in a better hook (Real-ESRGAN, a hosted upscaler, ...) via
 * createDeps({ upscale }).
 *
 * The default is a pure-JS bilinear resample: it adds PIXELS, not detail. The
 * file gets bigger and softer; `method` says so, and the design row records both
 * the native and the final size.
 */
const { decodePng, encodePng, resizeBilinear } = require('./png');

async function bilinearUpscale({ png, targetWidth, targetHeight }) {
  const img = decodePng(png);
  const scale = Math.min(targetWidth / img.width, targetHeight / img.height);
  if (!(scale > 1)) return { png, width: img.width, height: img.height, method: 'none (already at or above target)' };
  const w = Math.round(img.width * scale); const h = Math.round(img.height * scale);
  const out = resizeBilinear(img, w, h);
  return { png: encodePng(out), width: w, height: h, method: `bilinear x${scale.toFixed(3)} (pure JS; adds pixels, not detail)` };
}

module.exports = { bilinearUpscale };
