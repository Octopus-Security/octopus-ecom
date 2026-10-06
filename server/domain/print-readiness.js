'use strict';
/**
 * print-readiness.js — is the design big enough for the print area? PIXEL-based, computed from the file itself.
 *
 * Inputs: the TRUE pixel size of the latest design (read from the PNG IHDR chunk of the stored file, never from
 * designs.width/height or any hook's claim) and `products.print_spec` (`positions:[{position,width,height}]`, the print-area
 * pixels Printify reports for the chosen variants; optional `widthIn`/`heightIn` physical size when a source carries it).
 *
 * THE RULE (configurable, default strict):
 *   rw = designWidth / requiredWidth        rh = designHeight / requiredHeight
 *   fit "cover"   (default, PRINT_FIT=cover)    coverage = min(rw, rh)   - BOTH dimensions must reach the requirement.
 *   fit "contain" (PRINT_FIT=contain)           coverage = max(rw, rh)   - the design is scaled uniformly to sit INSIDE the
 *       area (letter-boxed, nothing cropped), so what matters is that its LIMITING side is at least full size. A design that
 *       matches the area's height at 1:1 but is narrower passes, because it is placed at scale 1.0 with blank margins either side.
 *       This is how the Printify adapter actually places the image (contain-fit, adapters/pod/printify.js), so it is the
 *       accurate model of the print, but it is an operator decision: the product will not fill the print area.
 *   A position passes when coverage >= PRINT_MIN_COVERAGE (default 1.0). Lower it (e.g. 0.8) to accept a design that
 *   meets 80% of the requirement under the chosen fit; the result still says exactly what was short.
 *
 * Only positions the design is PLACED on are decided (the pipeline places one design on the product's primary position);
 * other positions are listed as `placed:false` and cannot fail the check.
 *
 * Effective DPI: reported only when the position carries physical size (widthIn). Printify's placeholders are pixels only,
 * so normally the result says "pixel-based only". No DPI threshold is enforced.
 *
 * Upscaling: if the stored design was upscaled from a smaller native size (M1 resamples gpt-image-1's 1024x1536 to fit
 * 3600x5400) the message says so. The check uses the stored (true) pixels, so an upscaled design that reaches the size passes the
 * pixel test, but the note tells the operator it adds pixels, not detail. nativeCoverage reports the native size against the requirement.
 */
const fs = require('node:fs');
const path = require('node:path');
const { readPngSize } = require('../png');

const DEFAULT_MIN_COVERAGE = 1.0;
const FITS = ['cover', 'contain'];

/** True pixel size of a PNG file (reads only the header). */
function readFileSize(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(32);
    const n = fs.readSync(fd, buf, 0, 32, 0);
    return readPngSize(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
}

const pct = x => `${(x * 100).toFixed(x < 1 && x > 0.995 ? 1 : 0)}%`;

/**
 * evaluate({design:{width,height,nativeWidth,nativeHeight,upscaleMethod}, spec, minCoverage, fit, placedPosition})
 * -> {ok, fit, minCoverage, positions:[{position,required:{width,height},design:{width,height},rw,rh,coverage,placed,ok,dpi,short}], reason, notes}
 * `design` must already hold TRUE pixels (see checkProduct, which reads them from the file).
 */
function evaluate({ design, spec, minCoverage = DEFAULT_MIN_COVERAGE, fit = 'cover', placedPosition = null }) {
  const notes = [];
  const positions = Array.isArray(spec && spec.positions) ? spec.positions.filter(p => p && p.width > 0 && p.height > 0) : [];
  if (!positions.length) {
    return { ok: false, unknown: true, fit, minCoverage, positions: [], notes, reason: 'print requirements are unknown for this product (no print-area pixels recorded): choose the blueprint and print provider again so they can be read' };
  }
  const placed = placedPosition || positions[0].position;
  const rows = positions.map(p => {
    const rw = design.width / p.width; const rh = design.height / p.height;
    const coverage = fit === 'contain' ? Math.max(rw, rh) : Math.min(rw, rh);
    const isPlaced = p.position === placed;
    const dpi = Number(p.widthIn) > 0 ? Math.round(design.width / p.widthIn) : null;
    const ok = !isPlaced || coverage + 1e-9 >= minCoverage;
    return { position: p.position, required: { width: p.width, height: p.height }, design: { width: design.width, height: design.height }, rw, rh, coverage, placed: isPlaced, ok, dpi };
  });
  const bad = rows.filter(r => r.placed && !r.ok);
  const aspectOff = rows.filter(r => r.placed && Math.abs(Math.log((design.width / design.height) / (r.required.width / r.required.height))) > 0.05);
  if (aspectOff.length) notes.push(fit === 'contain'
    ? 'the design\'s aspect ratio differs from the print area: it will be placed whole with blank margins (contain-fit)'
    : 'the design\'s aspect ratio differs from the print area: it will be cropped or must be re-composed (cover)');
  if (rows.every(r => r.dpi === null)) notes.push('pixel-based only: this print spec carries no physical size, so no DPI could be computed');
  const upscaled = design.upscaleMethod && design.nativeWidth && design.nativeHeight && (design.nativeWidth !== design.width || design.nativeHeight !== design.height);
  if (upscaled) {
    const w = rows.find(r => r.placed);
    const nat = w ? (fit === 'contain' ? Math.max(design.nativeWidth / w.required.width, design.nativeHeight / w.required.height) : Math.min(design.nativeWidth / w.required.width, design.nativeHeight / w.required.height)) : null;
    notes.push(`the design was upscaled (${design.upscaleMethod}) from its native ${design.nativeWidth}x${design.nativeHeight}${nat !== null ? `, which is ${pct(nat)} of the requirement before upscaling` : ''}; upscaling adds pixels, not detail`);
  }
  let reason = null;
  if (bad.length) {
    const b = bad[0];
    reason = `design is ${b.design.width}x${b.design.height}px but the ${b.position} print area needs ${b.required.width}x${b.required.height}px: `
      + `${fit} coverage ${pct(b.coverage)} (width ${pct(b.rw)}, height ${pct(b.rh)}) is below the required ${pct(minCoverage)}`
      + `${upscaled ? ` (upscaled from native ${design.nativeWidth}x${design.nativeHeight})` : ''}`
      + `. Regenerate at a larger size, or lower PRINT_MIN_COVERAGE / set PRINT_FIT=contain if you accept the result`;
  }
  return { ok: bad.length === 0, unknown: false, fit, minCoverage, positions: rows, notes, reason };
}

/**
 * checkProduct(db, dataDir, product, {minCoverage, fit}) -> evaluate() result plus {designId, source:'png-header'}.
 * Reads the latest design row's file. A missing/unreadable file is `ok:false` (we cannot say it is ready).
 */
function checkProduct({ db, dataDir, product, minCoverage = DEFAULT_MIN_COVERAGE, fit = 'cover' }) {
  let spec = null; try { spec = JSON.parse(product.print_spec || 'null'); } catch { spec = null; }
  const row = db.prepare('SELECT * FROM designs WHERE product_id = ? ORDER BY id DESC LIMIT 1').get(product.id);
  if (!row || !row.image_path) return { ok: false, unknown: true, fit, minCoverage, positions: [], notes: [], reason: 'the product has no design file to measure' };
  let size;
  try { size = readFileSize(path.resolve(dataDir || '.', 'images', row.image_path)); }
  catch (e) { return { ok: false, unknown: true, fit, minCoverage, positions: [], notes: [], designId: row.id, reason: `could not read the design's pixel size from its file (${e.message})` }; }
  const out = evaluate({
    design: { width: size.width, height: size.height, nativeWidth: row.native_width, nativeHeight: row.native_height, upscaleMethod: row.upscale_method },
    spec, minCoverage, fit, placedPosition: spec && spec.positions && spec.positions[0] ? spec.positions[0].position : null,
  });
  return { ...out, designId: row.id, source: 'png-header', storedSize: { width: row.width, height: row.height } };
}

/** Validate operator config. */
const validMinCoverage = v => Number.isFinite(v) && v >= 0.1 && v <= 1;
const validFit = v => FITS.includes(v);

module.exports = { evaluate, checkProduct, readFileSize, validMinCoverage, validFit, DEFAULT_MIN_COVERAGE, FITS };
