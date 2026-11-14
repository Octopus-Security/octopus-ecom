'use strict';
/** Stub ImageGen: writes placeholder PNGs at the REQUESTED size under DATA_DIR/images. Costs nothing. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { solidPng, encodePng, readPngSize } = require('../../png');

function createStub({ dataDir }) {
  return {
    implemented: true,
    async generate(brief, { width = 4500, height = 5400, count = 1 } = {}) {
      const dir = path.join(dataDir, 'images');
      fs.mkdirSync(dir, { recursive: true });
      const images = [];
      for (let i = 0; i < count; i++) {
        const hue = crypto.createHash('sha256').update(`${brief}:${i}`).digest();
        const file = `stub-${crypto.randomBytes(6).toString('hex')}.png`;
        fs.writeFileSync(path.join(dir, file), solidPng(width, height, [hue[0], hue[1], hue[2]]));
        images.push({ file, width, height, mime: 'image/png' });
      }
      const seed = crypto.createHash('sha256').update(String(brief)).digest().readUInt32BE(0) % 2147483646 + 1;
      return { images, costCents: 0, model: 'stub-png', seed };
    },
    /** Whole-image stand-in for a region edit. 8-bit RGB so the composite can read it back. Costs nothing. */
    async edit(_prompt, { png } = {}) {
      const { width, height } = readPngSize(png);
      const pixels = Buffer.alloc(width * height * 3);
      for (let i = 0; i < pixels.length; i += 3) { pixels[i] = 220; pixels[i + 1] = 30; pixels[i + 2] = 30; }
      return { png: encodePng({ width, height, channels: 3, pixels }), costCents: 0, model: 'stub-edit', width, height };
    },
  };
}
module.exports = { createStub };
