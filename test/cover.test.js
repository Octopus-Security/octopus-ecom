'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert');

let coverMasked;
let hexToRgb;
let rgbToHex;
before(async () => {
  ({ coverMasked, hexToRgb, rgbToHex } = await import('../client/src/cover.js'));
});

test('cover paints only the selected pixels in the chosen colour', () => {
  const data = new Uint8ClampedArray([
    10, 20, 30, 255,
    40, 50, 60, 255,
    70, 80, 90, 128,
  ]);
  const mask = new Uint8Array([1, 0, 1]);
  assert.equal(coverMasked(data, mask, '#112233'), 2);
  assert.deepEqual(Array.from(data.slice(0, 4)), [0x11, 0x22, 0x33, 255]);
  assert.deepEqual(Array.from(data.slice(4, 8)), [40, 50, 60, 255]);
  assert.deepEqual(Array.from(data.slice(8, 12)), [0x11, 0x22, 0x33, 255]);
});

test('a sampled pixel round-trips to the colour input', () => {
  assert.deepEqual(hexToRgb('#aabbcc'), [170, 187, 204]);
  assert.equal(rgbToHex(170, 187, 204), '#aabbcc');
  assert.deepEqual(hexToRgb('nope'), [255, 255, 255]);
});
