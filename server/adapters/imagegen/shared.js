'use strict';
/** imagegen/shared.js — pieces every non-OpenAI image adapter repeats: orientation, saving, the fit step. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fitToArea } = require('../../upscale');

function orientation(width, height) { return width === height ? 'square' : width > height ? 'landscape' : 'portrait'; }

/** Fit one decoded PNG to the print area (records native vs upscaled honestly), write it, return the image row. */
async function saveImage({ png, width, height, upscale, log, dataDir, extra = {} }) {
  const fit = await fitToArea({ png, width, height, upscale, log }); // throws if the provider did not return a PNG
  const dir = path.join(dataDir, 'images');
  fs.mkdirSync(dir, { recursive: true });
  const file = `gen-${crypto.randomBytes(6).toString('hex')}.png`;
  fs.writeFileSync(path.join(dir, file), fit.png);
  return { file, width: fit.width, height: fit.height, mime: 'image/png', nativeWidth: fit.nativeWidth, nativeHeight: fit.nativeHeight, upscaled: fit.upscaled, upscaleMethod: fit.upscaleMethod, ...extra };
}

function checkCount(count) { if (!Number.isInteger(count) || count < 1 || count > 4) throw new Error('count must be 1-4'); }

module.exports = { orientation, saveImage, checkCount };
