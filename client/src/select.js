/**
 * Colour selection for the studio, on raw RGBA bytes.
 *
 * Fuzzy select is contiguous from the click (eight neighbours), like a magic
 * wand. Select by colour takes every pixel of a similar colour, anywhere.
 * Both compare to the clicked pixel. Tolerance is 0–100: 0 is that exact
 * colour, 100 is the full distance across RGB. Pixels that are already
 * transparent are never selected, so a second pass does not eat the subject
 * through the hole it just made.
 */

const MAX_DIST = Math.sqrt(255 * 255 * 3);

function limitSquared(tolerance) {
  const t = Math.max(0, Math.min(100, Number(tolerance) || 0)) / 100;
  const limit = t * MAX_DIST;
  return limit * limit;
}

function selectMask(data, width, height, x, y, tolerance, contiguous) {
  const mask = new Uint8Array(width * height);
  if (!width || !height || !data) return mask;
  const sx = Math.max(0, Math.min(width - 1, x | 0));
  const sy = Math.max(0, Math.min(height - 1, y | 0));
  const seed = (sy * width + sx) * 4;
  if (data[seed + 3] < 16) return mask;
  const sr = data[seed];
  const sg = data[seed + 1];
  const sb = data[seed + 2];
  const limit2 = limitSquared(tolerance);
  const seen = new Uint8Array(width * height);

  function take(px, py) {
    if (px < 0 || py < 0 || px >= width || py >= height) return false;
    const p = py * width + px;
    if (seen[p]) return false;
    seen[p] = 1;
    const i = p * 4;
    if (data[i + 3] < 16) return false;
    const dr = data[i] - sr;
    const dg = data[i + 1] - sg;
    const db = data[i + 2] - sb;
    if (dr * dr + dg * dg + db * db > limit2) return false;
    mask[p] = 1;
    return true;
  }

  if (!contiguous) {
    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) take(px, py);
    }
    return mask;
  }

  const stack = [sy * width + sx];
  take(sx, sy);
  while (stack.length) {
    const p = stack.pop();
    const px = p % width;
    const py = (p / width) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        if (take(px + dx, py + dy)) stack.push((py + dy) * width + (px + dx));
      }
    }
  }
  return mask;
}

function maskCount(mask) {
  let n = 0;
  for (let i = 0; i < mask.length; i++) n += mask[i];
  return n;
}

/** Sets alpha to 0 where the mask is set. Returns how many pixels changed. */
function clearMasked(data, mask) {
  let n = 0;
  const pixels = mask.length;
  for (let p = 0; p < pixels; p++) {
    if (!mask[p]) continue;
    const i = p * 4;
    if (data[i + 3] === 0) continue;
    data[i + 3] = 0;
    n++;
  }
  return n;
}

export { selectMask, maskCount, clearMasked, limitSquared };
