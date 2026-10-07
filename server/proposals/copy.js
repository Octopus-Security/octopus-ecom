'use strict';
/**
 * proposals/copy.js — the listing text of a proposal: Etsy rules enforced and linted, the Redbubble variant derived and linted.
 * Nothing a model (or an owner) typed is trusted: enforceCopy() repairs the Etsy text and every repair is surfaced as a lint
 * warning, so "the model returned 15 tags and one had an emoji" is visible on the card rather than silently fixed.
 * The limits come from domain/etsy-rules.js and domain/redbubble-rules.js, whose provenance (assumed, unverified) applies here.
 */
const { enforceCopy, MAX_TAGS, MAX_TAG_LEN } = require('../domain/etsy-rules');
const { scanFields } = require('../domain/blocklist');
const rb = require('../domain/redbubble-rules');

/** Pad a tag list to 13 from candidate phrases (already-clean tags first), keeping only valid unique tags. Returns {tags, filled}. */
function fillTags(tags, candidates) {
  const seen = new Set(); const out = [];
  const add = (raw) => {
    const t = String(raw || '').toLowerCase().replace(/[^\p{L}\p{Nd}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (!t || t.length > MAX_TAG_LEN || seen.has(t) || out.length >= MAX_TAGS) return false;
    seen.add(t); out.push(t); return true;
  };
  (tags || []).forEach(add);
  const have = out.length; (candidates || []).forEach(add);
  return { tags: out, filled: out.length - have };
}

/** Etsy lint: {ok, errors[], warnings[], copy}. `copy` is the repaired text, which is what gets stored. Blocklist hits are errors. */
function lintEtsy(raw, { db = null } = {}) {
  const c = enforceCopy({ title: raw.title, tags: raw.tags, description: raw.description });
  const errors = []; const warnings = [];
  if (!c.title) errors.push({ field: 'title', code: 'title_empty', detail: 'the title is empty after the Etsy rules were applied' });
  for (const r of c.repairs) {
    if (r.code === 'empty') continue; // reported below as the description warning
    warnings.push({ field: r.field, code: `repaired_${r.code}`, detail: `Etsy rules changed what was written: ${r.detail}` });
  }
  if (c.tags.length < MAX_TAGS) warnings.push({ field: 'tags', code: 'tags_not_13', detail: `${c.tags.length} of ${MAX_TAGS} tag slots used: unused slots are lost search reach (advice, not a rule)` });
  if (!c.description) warnings.push({ field: 'description', code: 'description_empty', detail: 'no description' });
  if (db) {
    const hits = scanFields(db, { title: c.title, tags: c.tags, description: c.description });
    if (hits.length) errors.push({ field: 'blocklist', code: 'blocklist', detail: `blocklist hit: ${hits.map(h => h.term).join(', ')}` });
  }
  return { ok: errors.length === 0, errors, warnings, copy: { title: c.title, tags: c.tags, description: c.description } };
}

/** The Redbubble variant derived from the Etsy copy (rules in redbubble-rules.js). -> {title, tags, description, repairs[]} */
function deriveRedbubble({ etsy, keywords = [], brief = '' }) {
  const a = rb.adaptCopy({ etsy, keywords, brief });
  return { title: a.title, tags: a.tags, description: a.description, repairs: a.repairs };
}

/** Redbubble lint of whatever the card currently holds (derived or hand-edited). */
const lintRedbubble = (copy, { db = null } = {}) => rb.lintCopy(copy, { db });

module.exports = { fillTags, lintEtsy, deriveRedbubble, lintRedbubble };
