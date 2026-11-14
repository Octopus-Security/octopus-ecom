'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert');

let selectMask; let maskCount; let clearMasked;
before(async () => {
  ({ selectMask, maskCount, clearMasked } = await import('../client/src/select.js'));
});

function solid(w, h, rgba) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgba[0]; data[i + 1] = rgba[1]; data[i + 2] = rgba[2]; data[i + 3] = rgba[3];
  }
  return data;
}

function put(data, w, x, y, rgba) {
  const i = (y * w + x) * 4;
  data[i] = rgba[0]; data[i + 1] = rgba[1]; data[i + 2] = rgba[2]; data[i + 3] = rgba[3];
}

test('fuzzy select stays inside one patch and does not cross a different colour', () => {
  const w = 5, h = 3;
  const data = solid(w, h, [255, 255, 255, 255]);
  put(data, w, 2, 1, [0, 0, 0, 255]);
  put(data, w, 4, 2, [255, 255, 255, 255]);
  // A black wall at x=3 separates the right column.
  for (let y = 0; y < h; y++) put(data, w, 3, y, [0, 0, 0, 255]);
  const mask = selectMask(data, w, h, 0, 0, 0, true);
  assert.equal(mask[0], 1);
  assert.equal(mask[1], 1);
  assert.equal(mask[2], 1);
  assert.equal(mask[3], 0);
  assert.equal(mask[w * 2 + 4], 0, 'white on the far side of the wall stays unselected');
  assert.equal(maskCount(mask), 8);
});

test('select by colour grabs the same colour on both sides of a wall', () => {
  const w = 5, h = 1;
  const data = solid(w, h, [10, 20, 30, 255]);
  put(data, w, 2, 0, [200, 0, 0, 255]);
  const mask = selectMask(data, w, h, 0, 0, 0, false);
  assert.equal(maskCount(mask), 4);
  assert.equal(mask[2], 0);
});

test('tolerance includes a near colour and refuses a far one', () => {
  const data = solid(2, 1, [100, 100, 100, 255]);
  put(data, 2, 1, 0, [108, 100, 100, 255]);
  const loose = selectMask(data, 2, 1, 0, 0, 8, false);
  assert.equal(loose[0], 1);
  assert.equal(loose[1], 1);
  const tight = selectMask(data, 2, 1, 0, 0, 0, false);
  assert.equal(tight[0], 1);
  assert.equal(tight[1], 0);
});

test('a transparent pixel is never selected, including the click itself', () => {
  const data = solid(2, 1, [255, 0, 0, 255]);
  put(data, 2, 0, 0, [255, 0, 0, 0]);
  const clicked = selectMask(data, 2, 1, 0, 0, 100, false);
  assert.equal(maskCount(clicked), 0);
  const other = selectMask(data, 2, 1, 1, 0, 0, false);
  assert.equal(other[0], 0);
  assert.equal(other[1], 1);
});

test('clearMasked punches out only the selection', () => {
  const data = solid(2, 1, [1, 2, 3, 255]);
  const mask = selectMask(data, 2, 1, 0, 0, 0, true);
  mask[1] = 0;
  assert.equal(clearMasked(data, mask), 1);
  assert.equal(data[3], 0);
  assert.equal(data[7], 255);
  assert.equal(data[0], 1);
});
