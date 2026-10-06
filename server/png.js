'use strict';
/**
 * png.js — dependency-free PNG encode/decode-header, for stub images that must
 * carry the REQUESTED dimensions (print-readiness reads them back from IHDR).
 * 1-bit indexed colour keeps even 4500x5400 images ~3 MB raw before deflate.
 */
const zlib = require('node:zlib');

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Solid-colour PNG of exactly width x height. rgb = [r,g,b]. */
function solidPng(width, height, rgb = [90, 110, 160]) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 20000 || height > 20000) throw new Error('bad PNG dimensions');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 1; ihdr[9] = 3; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 1-bit, indexed
  const plte = Buffer.from([...rgb, 255, 255, 255]);
  const rowBytes = Math.ceil(width / 8) + 1; // filter byte 0 + all pixels index 0
  const raw = Buffer.alloc(rowBytes * height);
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('PLTE', plte), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Read {width, height} from the IHDR chunk; throws on anything that is not a PNG. */
function readPngSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24 || !buf.subarray(0, 8).equals(SIG) || buf.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Not a PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}


/**
 * Decode a non-interlaced, 8-bit PNG (grey, grey+alpha, RGB, RGBA, palette) to
 * {width, height, channels: 3|4, pixels}. Anything else throws, and the caller
 * keeps the image at its native size rather than guessing.
 */
function decodePng(buf) {
  const { width, height } = readPngSize(buf);
  let pos = 8; let ihdr = null; let plte = null; let trns = null; const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos); const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') ihdr = data; else if (type === 'PLTE') plte = data; else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data); else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!ihdr) throw new Error('PNG has no IHDR');
  const depth = ihdr[8]; const ctype = ihdr[9]; const interlace = ihdr[12];
  if (depth !== 8) throw new Error(`unsupported PNG bit depth ${depth}`);
  if (interlace !== 0) throw new Error('interlaced PNG is not supported');
  const samples = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  if (!samples) throw new Error(`unsupported PNG colour type ${ctype}`);
  if (ctype === 3 && !plte) throw new Error('palette PNG without PLTE');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * samples;
  if (raw.length < (stride + 1) * height) throw new Error('PNG pixel data is truncated');
  const cur = Buffer.alloc(stride); let prev = Buffer.alloc(stride);
  const outCh = (ctype === 6 || ctype === 4 || (ctype === 3 && trns)) ? 4 : 3;
  const pixels = Buffer.alloc(width * height * outCh);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]; const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= samples ? cur[i - samples] : 0; const b = prev[i]; const c = i >= samples ? prev[i - samples] : 0;
      let v;
      if (f === 0) v = row[i]; else if (f === 1) v = row[i] + a; else if (f === 2) v = row[i] + b; else if (f === 3) v = row[i] + ((a + b) >> 1);
      else if (f === 4) { const pa = Math.abs(b - c); const pb = Math.abs(a - c); const pc = Math.abs(a + b - 2 * c); v = row[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      else throw new Error(`bad PNG filter ${f}`);
      cur[i] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * outCh;
      if (ctype === 2 || ctype === 6) { pixels[o] = cur[x * samples]; pixels[o + 1] = cur[x * samples + 1]; pixels[o + 2] = cur[x * samples + 2]; if (outCh === 4) pixels[o + 3] = ctype === 6 ? cur[x * 4 + 3] : 255; }
      else if (ctype === 0 || ctype === 4) { const g = cur[x * samples]; pixels[o] = pixels[o + 1] = pixels[o + 2] = g; if (outCh === 4) pixels[o + 3] = ctype === 4 ? cur[x * 2 + 1] : 255; }
      else { const k = cur[x]; pixels[o] = plte[k * 3]; pixels[o + 1] = plte[k * 3 + 1]; pixels[o + 2] = plte[k * 3 + 2]; if (outCh === 4) pixels[o + 3] = trns && k < trns.length ? trns[k] : 255; }
    }
    prev = Buffer.from(cur);
  }
  return { width, height, channels: outCh, pixels };
}

/** Encode 8-bit RGB/RGBA pixels as a PNG (Sub filter: smooth/upscaled images compress far better than with none). */
function encodePng({ width, height, channels, pixels }) {
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1); const s = y * stride;
    raw[o] = 1;
    for (let i = 0; i < stride; i++) raw[o + 1 + i] = (pixels[s + i] - (i >= channels ? pixels[s + i - channels] : 0)) & 255;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Bilinear resample (pixel-centre mapping) to exactly outW x outH. */
function resizeBilinear({ width, height, channels, pixels }, outW, outH) {
  const out = Buffer.alloc(outW * outH * channels);
  const xi0 = new Int32Array(outW); const xi1 = new Int32Array(outW); const xw = new Float32Array(outW);
  for (let x = 0; x < outW; x++) {
    const sx = Math.min(width - 1, Math.max(0, ((x + 0.5) * width) / outW - 0.5));
    xi0[x] = Math.floor(sx); xi1[x] = Math.min(width - 1, xi0[x] + 1); xw[x] = sx - xi0[x];
  }
  for (let y = 0; y < outH; y++) {
    const sy = Math.min(height - 1, Math.max(0, ((y + 0.5) * height) / outH - 0.5));
    const y0 = Math.floor(sy); const y1 = Math.min(height - 1, y0 + 1); const wy = sy - y0;
    const r0 = y0 * width * channels; const r1 = y1 * width * channels; let o = y * outW * channels;
    for (let x = 0; x < outW; x++) {
      const a = r0 + xi0[x] * channels; const b = r0 + xi1[x] * channels; const c = r1 + xi0[x] * channels; const d = r1 + xi1[x] * channels; const wx = xw[x];
      for (let k = 0; k < channels; k++) {
        const top = pixels[a + k] + (pixels[b + k] - pixels[a + k]) * wx;
        const bot = pixels[c + k] + (pixels[d + k] - pixels[c + k]) * wx;
        out[o++] = Math.round(top + (bot - top) * wy);
      }
    }
  }
  return { width: outW, height: outH, channels, pixels: out };
}

module.exports = { solidPng, readPngSize, decodePng, encodePng, resizeBilinear };
