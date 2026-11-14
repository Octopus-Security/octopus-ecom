'use strict';
/**
 * studio.js — keep the unmarked pixels of a stored design.
 * The image model rewrites a whole picture and does not take a mask. compositeKeep
 * copies original pixels back wherever the mask is dark, and feathers the seam.
 */
const { decodePng, encodePng, resizeBilinear } = require('./png');

const MAX_COVERAGE = 0.7;

function luminance(pixels, channels, i) {
  const o = i * channels;
  const r = pixels[o];
  const g = channels > 1 ? pixels[o + 1] : r;
  const b = channels > 2 ? pixels[o + 2] : r;
  return (r + g + b) / 3;
}

/** weights in 0..1 from mask luminance. marked = pixels lighter than mid-grey. */
function maskWeights(mask) {
  const n = mask.width * mask.height;
  const weights = new Float32Array(n);
  let marked = 0;
  for (let i = 0; i < n; i++) {
    const lum = luminance(mask.pixels, mask.channels, i) / 255;
    weights[i] = lum;
    if (lum > 0.5) marked++;
  }
  return { weights, marked, coverage: n ? marked / n : 0 };
}

function boxBlur(src, width, height, radius) {
  if (radius <= 0) return src;
  const tmp = new Float32Array(src.length);
  const dst = new Float32Array(src.length);
  const k = radius * 2 + 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let s = 0;
      for (let i = -radius; i <= radius; i++) s += src[y * width + Math.min(width - 1, Math.max(0, x + i))];
      tmp[y * width + x] = s / k;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let s = 0;
      for (let i = -radius; i <= radius; i++) s += tmp[Math.min(height - 1, Math.max(0, y + i)) * width + x];
      dst[y * width + x] = s / k;
    }
  }
  return dst;
}

/**
 * Reject an empty mask, a mask that is not the stored size, and a mark that covers
 * most of the picture (that is a regenerate, not a region edit). Call this BEFORE any spend.
 */
function inspectMask(maskPng, { width, height }) {
  const mask = decodePng(maskPng);
  if (mask.width !== width || mask.height !== height) {
    throw Object.assign(new Error('mask size does not match the stored design'), { code: 'mask_size' });
  }
  const { marked, coverage } = maskWeights(mask);
  if (marked === 0) throw Object.assign(new Error('mask is empty'), { code: 'empty_mask' });
  if (coverage > MAX_COVERAGE) {
    throw Object.assign(new Error('That mark covers most of the image. Use Regenerate to redraw the whole design.'), { code: 'mask_too_large', coverage });
  }
  return { coverage, marked };
}

/**
 * originalPng and maskPng must be the same pixel size. editedPng is resized when the
 * model returned a different size. feather 0 keeps every unmarked pixel byte-identical
 * and every fully marked pixel equal to the edited image. The default feather is 2.
 */
function compositeKeep(originalPng, editedPng, maskPng, { feather = 2 } = {}) {
  const orig = decodePng(originalPng);
  const mask = decodePng(maskPng);
  if (mask.width !== orig.width || mask.height !== orig.height) {
    throw Object.assign(new Error('mask size does not match the stored design'), { code: 'mask_size' });
  }
  let edited = decodePng(editedPng);
  if (edited.width !== orig.width || edited.height !== orig.height) edited = resizeBilinear(edited, orig.width, orig.height);
  const { weights, marked } = maskWeights(mask);
  if (marked === 0) throw Object.assign(new Error('mask is empty'), { code: 'empty_mask' });
  const radius = Number.isInteger(feather) && feather > 0 ? feather : 0;
  let w = weights;
  if (radius === 0) {
    w = new Float32Array(weights.length);
    for (let i = 0; i < weights.length; i++) w[i] = weights[i] > 0.5 ? 1 : 0;
  } else w = boxBlur(weights, orig.width, orig.height, radius);
  const ch = orig.channels;
  const eCh = edited.channels;
  const out = Buffer.alloc(orig.width * orig.height * ch);
  const rgbN = Math.min(3, ch);
  for (let i = 0; i < orig.width * orig.height; i++) {
    const o = i * ch;
    const weight = w[i];
    if (weight <= 0) { orig.pixels.copy(out, o, o, o + ch); continue; }
    if (weight >= 1) {
      for (let c = 0; c < rgbN; c++) out[o + c] = edited.pixels[i * eCh + Math.min(c, eCh - 1)];
    } else {
      for (let c = 0; c < rgbN; c++) {
        const a = orig.pixels[o + c];
        const b = edited.pixels[i * eCh + Math.min(c, eCh - 1)];
        out[o + c] = Math.round(a + (b - a) * weight);
      }
    }
    if (ch === 4) out[o + 3] = orig.pixels[o + 3];
  }
  return { png: encodePng({ width: orig.width, height: orig.height, channels: ch, pixels: out }), width: orig.width, height: orig.height };
}

/**
 * Cheap picture check. No model call. A dry-run 1-bit block cannot be read and is skipped.
 * Flags a file that is mostly black, or almost one flat colour. A normal drawing on a
 * plain background stays under the flat threshold and is not flagged.
 */
function inspectPicture(png) {
  let img;
  try { img = decodePng(png); }
  catch (e) { return { skipped: true, reason: e.message, issues: [] }; }
  const n = img.width * img.height;
  if (!n) return { skipped: true, reason: 'empty', issues: [] };
  const step = Math.max(1, Math.floor(n / 40000));
  const buckets = new Map();
  let samples = 0;
  let black = 0;
  for (let i = 0; i < n; i += step) {
    const o = i * img.channels;
    const r = img.pixels[o];
    const g = img.channels > 1 ? img.pixels[o + 1] : r;
    const b = img.channels > 2 ? img.pixels[o + 2] : r;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    buckets.set(key, (buckets.get(key) || 0) + 1);
    samples++;
    if (r < 12 && g < 12 && b < 12) black++;
  }
  let top = 0;
  for (const v of buckets.values()) if (v > top) top = v;
  const share = samples ? top / samples : 0;
  const blackShare = samples ? black / samples : 0;
  const issues = [];
  if (blackShare >= 0.9) issues.push({ code: 'picture_blank', detail: 'This picture is mostly black. Regenerate it. A safety filter can return a black image.' });
  else if (share >= 0.97) issues.push({ code: 'picture_flat', detail: 'This picture is almost one flat colour. Regenerate it before you print.' });
  return { skipped: false, samples, share, blackShare, issues };
}

module.exports = { compositeKeep, inspectMask, inspectPicture, MAX_COVERAGE };
