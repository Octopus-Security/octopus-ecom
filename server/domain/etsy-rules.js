'use strict';
/**
 * etsy-rules.js — Etsy listing text limits.
 * assumed 2026-10-05, unverified (Etsy's pages were unreachable this session; these
 * are the limits stated in the product spec): title <= 140 chars, up to 13 tags,
 * each tag <= 20 chars.
 */
const MAX_TITLE = 140;
const MAX_TAGS = 13;
const MAX_TAG_LEN = 20;

function normalizeTags(tags) {
  const seen = new Set();
  const out = [];
  for (const t of tags || []) {
    const v = String(t).trim().toLowerCase().replace(/\s+/g, ' ');
    if (!v || v.length > MAX_TAG_LEN || seen.has(v)) continue;
    seen.add(v); out.push(v);
    if (out.length === MAX_TAGS) break;
  }
  return out;
}
const clampTitle = t => String(t || '').trim().slice(0, MAX_TITLE);

module.exports = { MAX_TITLE, MAX_TAGS, MAX_TAG_LEN, normalizeTags, clampTitle };
