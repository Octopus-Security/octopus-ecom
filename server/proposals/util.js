'use strict';
/** proposals/util.js — small pure helpers shared by the generator, the templates and the service. */

/** Collapse whitespace, strip control characters, cut to `max` characters. */
const clean = (s, max = 500) => String(s === undefined || s === null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(w => w.length > 2);
const STOP = new Set(['the', 'and', 'with', 'for', 'style', 'design', 'print', 'art', 'poster', 'shirt', 'featuring', 'illustration', 'artwork', 'made', 'celebrating']);
const sigWords = (s) => new Set(words(s).filter(w => !STOP.has(w)));
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let i = 0; for (const x of a) if (b.has(x)) i++;
  return i / (a.size + b.size - i);
}

function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function hash(str) { let h = 2166136261; for (const c of String(str)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

const titleCase = (s) => String(s || '').replace(/\b([a-z])([a-z']*)/g, (_m, a, b) => a.toUpperCase() + b);

/** Array from an array, a comma/newline separated string, or nothing; each item cleaned, de-duplicated, capped. */
function list(v, { max = 10, len = 60 } = {}) {
  const arr = Array.isArray(v) ? v : String(v === undefined || v === null ? '' : v).split(/[,\n]/);
  return [...new Set(arr.map(x => clean(x, len)).filter(Boolean))].slice(0, max);
}

module.exports = { clean, words, sigWords, jaccard, mulberry32, hash, titleCase, list };
