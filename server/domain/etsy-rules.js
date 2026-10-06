'use strict';
/**
 * etsy-rules.js — Etsy listing text limits, ENFORCED IN CODE whatever a model returns.
 *
 * Provenance (2026-10-05): corroborated, official Etsy page NOT read. help.etsy.com returned HTTP 403
 * to the fetch tool and the Etsy developer reference page did not expose field constraints. What a
 * web search returned, from several third-party guides (listingview.io, outfy.com, listadum.com, a
 * connector reference at withone.ai) and consistently with the product spec:
 *   - title <= 140 characters; allowed: letters, digits, punctuation, maths symbols, whitespace,
 *     (tm)/(c)/(r); in a title the characters % : & + may each appear ONCE only
 *       reported regex: /[^\p{L}\p{Nd}\p{P}\p{Sm}\p{Zs}™©®]/u
 *   - up to 13 tags, each <= 20 characters (spaces count); tags may contain only letters, digits,
 *     spaces, hyphen, apostrophe, (tm)/(c)/(r); tags must be unique per listing
 *       reported regex: /[^\p{L}\p{Nd}\p{Zs}\-'™©®]/u
 * Treat as assumed-corroborated; if Etsy's API rejects a listing in M3, trust the API and fix here.
 *
 * enforceCopy() repairs what can be repaired and RECORDS every repair, so a human can see what
 * the model actually returned versus what will be sent. Tags are lower-cased (a house style, not
 * an Etsy rule). It never invents content: an empty title after repair is an error for the caller.
 */
const MAX_TITLE = 140;
const MAX_TAGS = 13;
const MAX_TAG_LEN = 20;

const TITLE_BAD = /[^\p{L}\p{Nd}\p{P}\p{Sm}\p{Zs}™©®]/gu;
const TAG_BAD = /[^\p{L}\p{Nd}\p{Zs}\-'™©®]/gu;
const ONCE_ONLY = ['%', ':', '&', '+'];

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

/** Cut to <= max chars on a word boundary (hard cut only if there is no space to cut at). */
function truncateWords(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > 0 ? cut.slice(0, sp) : s.slice(0, max)).replace(/[\s,;:\-–—|/&+]+$/u, '');
}

function repairTitle(raw, repairs) {
  let t = String(raw === null || raw === undefined ? '' : raw);
  const stripped = t.replace(TITLE_BAD, ' ');
  if (stripped !== t) { repairs.push({ field: 'title', code: 'chars_removed', detail: 'removed characters Etsy titles do not allow (e.g. emoji)' }); t = stripped; }
  for (const ch of ONCE_ONLY) {
    const first = t.indexOf(ch);
    if (first === -1) continue;
    const head = t.slice(0, first + 1); const tail = t.slice(first + 1);
    if (tail.includes(ch)) {
      repairs.push({ field: 'title', code: 'repeat_char_removed', detail: `"${ch}" may appear once in a title; later ones removed` });
      t = head + tail.split(ch).join(' ');
    }
  }
  const ws = t.replace(/\s+/g, ' ').trim();
  if (ws !== String(raw === null || raw === undefined ? '' : raw).trim() && !repairs.some(r => r.field === 'title')) repairs.push({ field: 'title', code: 'whitespace_trimmed', detail: 'collapsed/trimmed whitespace' });
  t = ws;
  if (t.length > MAX_TITLE) {
    const before = t.length; t = truncateWords(t, MAX_TITLE);
    repairs.push({ field: 'title', code: 'truncated', detail: `${before} chars cut to ${t.length} on a word boundary (limit ${MAX_TITLE})` });
  }
  return t;
}

function repairTags(raw, repairs) {
  let list = raw;
  if (typeof list === 'string') { list = list.split(','); repairs.push({ field: 'tags', code: 'split_string', detail: 'tags arrived as one string; split on commas' }); }
  if (!Array.isArray(list)) { if (list !== undefined && list !== null) repairs.push({ field: 'tags', code: 'not_a_list', detail: 'tags were not a list; none kept' }); list = []; }
  const seen = new Set(); const out = [];
  for (const item of list) {
    const orig = String(item === null || item === undefined ? '' : item);
    let v = orig.replace(TAG_BAD, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    if (v !== orig.trim().toLowerCase().replace(/\s+/g, ' ')) repairs.push({ field: 'tags', code: 'chars_removed', detail: `"${orig.slice(0, 40)}" -> "${v}"` });
    if (!v) { if (orig.trim()) repairs.push({ field: 'tags', code: 'dropped_empty', detail: `"${orig.slice(0, 40)}" had nothing usable` }); continue; }
    if (v.length > MAX_TAG_LEN) { repairs.push({ field: 'tags', code: 'dropped_too_long', detail: `"${v}" is ${v.length} chars (limit ${MAX_TAG_LEN})` }); continue; }
    if (seen.has(v)) { repairs.push({ field: 'tags', code: 'dropped_duplicate', detail: `"${v}"` }); continue; }
    if (out.length >= MAX_TAGS) { repairs.push({ field: 'tags', code: 'dropped_extra', detail: `"${v}" is past the ${MAX_TAGS}-tag limit` }); continue; }
    seen.add(v); out.push(v);
  }
  return out;
}

/** enforceCopy({title, tags, description}) -> {title, tags, description, repairs[]}. Always within limits. */
function enforceCopy(copy = {}) {
  const repairs = [];
  const title = repairTitle(copy.title, repairs);
  const tags = repairTags(copy.tags, repairs);
  let description = String(copy.description === null || copy.description === undefined ? '' : copy.description).replace(/\r\n/g, '\n').trim();
  if (!description) repairs.push({ field: 'description', code: 'empty', detail: 'description is empty' });
  return { title, tags, description, repairs };
}

module.exports = { MAX_TITLE, MAX_TAGS, MAX_TAG_LEN, normalizeTags, clampTitle, enforceCopy, truncateWords };
