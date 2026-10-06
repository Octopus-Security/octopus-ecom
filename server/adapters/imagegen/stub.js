'use strict';
/** Stub ImageGen: writes placeholder PNGs at the REQUESTED size under DATA_DIR/images. Costs nothing. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { solidPng } = require('../../png');

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
      return { images, costCents: 0, model: 'stub-png' };
    },
  };
}
module.exports = { createStub };
