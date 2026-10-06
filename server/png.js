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

module.exports = { solidPng, readPngSize };
