/** Paint a chosen colour into selected pixels. This does not call a model. */

export function rgbToHex(r, g, b) {
  const byte = (n) => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, '0');
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

export function hexToRgb(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!match) return [255, 255, 255];
  const n = parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Set RGB and full opacity where mask is 1. Returns how many pixels changed. */
export function coverMasked(data, mask, hex) {
  const [r, g, b] = hexToRgb(hex);
  const count = data.length / 4;
  let n = 0;
  for (let i = 0; i < count; i++) {
    if (!mask[i]) continue;
    const o = i * 4;
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    data[o + 3] = 255;
    n += 1;
  }
  return n;
}
