'use strict';
/**
 * redbubble-rules.js — Redbubble's upload limits, copy adaptation, a linter, and per-product-type advice.
 *
 * PROVENANCE (researched 2026-10-06). Redbubble's own help centre and blog returned HTTP 403 to the fetch tool, so NO limit
 * below was read on an official page. Each says where it came from; the status words are:
 *   corroborated: a web-search summary quoting Redbubble's help article, or two or more independent third-party guides agree
 *   assumed:      one third-party source, or sources disagree. Treat as a guess and confirm in the upload form.
 * When Redbubble's form disagrees with a number here, trust the form and change the constant.
 *
 *   TAGS: at most 15, each at most 50 chars. corroborated: search summary of https://help.redbubble.com/hc/en-us/articles/360047166432
 *         ("How do I tag my designs?"). One tag goes in the "main tag" field, the rest in "supporting tags" (assumed: third-party guide).
 *   TITLE: 60 chars. assumed: metadatareactor.com says strict 60; another guide says "no strict limit, ~60 ideal".
 *   DESCRIPTION: sources disagree (250 vs 500). We WARN above 250 and ERROR above 500, and the adapted copy is cut to 250,
 *         which is safe under either reading.
 *   IMAGE: 7632x6480 recommended for large-format products (corroborated: Redbubble blog 2018 "Uploading on Redbubble" via search
 *         summary + icons8.com); PNG; maximum 13500x13500 px or 300 MB (corroborated: same).
 *   MARKUP: default 20%. Above 20% an "excess markup fee" takes 50% of the extra, from 2025-09-01 for Standard and Premium
 *         accounts (corroborated: search summary of https://blog.redbubble.com/2025/08/excess-markup-fee-explained/).
 */
const { enforceCopy, truncateWords } = require('./etsy-rules');
const { scanFields } = require('./blocklist');

const LIMITS = Object.freeze({
  maxTags: 15, maxTagLen: 50, minTagsAdvised: 8,
  maxTitle: 60, descSafe: 250, descMax: 500,
  imageW: 7632, imageH: 6480, maxW: 13500, maxH: 13500, maxBytes: 300 * 1024 * 1024,
  markupPct: 20,
});

const SOURCES = Object.freeze({
  tags: 'corroborated (search summary of https://help.redbubble.com/hc/en-us/articles/360047166432; page itself returned 403)',
  title: 'assumed (https://metadatareactor.com/blog/how-to-grow-on-redbubble-2026/; another guide says no strict limit)',
  description: 'assumed (sources disagree: ~250 vs 500; https://autokeyworder.com/redbubble-tag-generator/ , https://metadatareactor.com/blog/redbubble-tags-guide/)',
  image: 'corroborated (https://blog.redbubble.com/2018/05/uploading-on-redbubble/ via search summary, and https://icons8.com/blog/articles/redbubble-image-size/)',
  markup: 'corroborated (search summary of https://help.redbubble.com/hc/en-us/articles/202270799 and https://blog.redbubble.com/2025/08/excess-markup-fee-explained/)',
  productTypes: 'assumed (third-party guides: https://icons8.com/blog/articles/redbubble-image-size/ , https://www.topbubbleindex.com/blog/redbubble-sizing-guide/); Redbubble scales and crops per product itself',
});

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'your', 'you', 'this', 'that', 'are', 'but', 'not', 'all', 'has', 'was', 'its', 'our', 'gift', 'gifts']);
const EMOJI = /[\p{Extended_Pictographic}‍️]/u;

/** A tag the way Redbubble wants it: lower-case words, no commas, collapsed spaces. */
const cleanTag = t => String(t || '').replace(/[,;|]/g, ' ').replace(EMOJI, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

/** Redbubble tags from Etsy tags first (already vetted, ordered by value), then operator keywords, then title words. */
function adaptTags({ etsyTags = [], keywords = [], title = '' }) {
  const out = []; const seen = new Set();
  const add = raw => {
    const t = cleanTag(raw);
    if (!t || t.length > LIMITS.maxTagLen || seen.has(t) || out.length >= LIMITS.maxTags) return;
    seen.add(t); out.push(t);
  };
  etsyTags.forEach(add); keywords.forEach(add);
  String(title).toLowerCase().split(/[^\p{L}\p{Nd}'-]+/u).filter(w => w.length >= 4 && !STOP.has(w)).forEach(add);
  return out;
}

const ETSY_ISM = /\b(etsy|shipping|ship(s|ped)?|delivery|deliver(ed)?|processing time|order by|printify|production partner|returns?|refunds?)\b/i;

/** First lines of an Etsy description that are about the design, not about Etsy shipping; cut to the safe length. */
function adaptDescription({ description = '', fallback = '' }) {
  const kept = String(description).replace(/\r\n/g, '\n').split(/\n+/).map(s => s.trim()).filter(Boolean).filter(l => !ETSY_ISM.test(l));
  let d = kept.join(' ').replace(/\s+/g, ' ').replace(EMOJI, '').trim();
  if (!d) d = String(fallback || '').replace(/\s+/g, ' ').trim();
  if (d.length > LIMITS.descSafe) {
    const cut = d.slice(0, LIMITS.descSafe);
    const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    d = stop >= 80 ? cut.slice(0, stop + 1) : truncateWords(d, LIMITS.descSafe);
  }
  return d;
}

/**
 * adaptCopy({etsy:{title,tags,description}, keywords, brief}) -> {title, mainTag, supportingTags, tags, description, repairs[]}.
 * The Etsy copy has already been through enforceCopy at save time; it is run again so a hand-edited value is repaired the same way.
 */
function adaptCopy({ etsy = null, keywords = [], brief = '', productTitle = '' } = {}) {
  const base = enforceCopy({ title: (etsy && etsy.title) || productTitle || brief, tags: (etsy && etsy.tags) || [], description: (etsy && etsy.description) || '' });
  const repairs = base.repairs.filter(r => r.code !== 'empty').map(r => ({ ...r }));
  let title = EMOJI.test(base.title) ? base.title.replace(EMOJI, '').replace(/\s+/g, ' ').trim() : base.title;
  if (title.length > LIMITS.maxTitle) {
    const before = title.length; title = truncateWords(title, LIMITS.maxTitle);
    repairs.push({ field: 'title', code: 'truncated_rb', detail: `Etsy title of ${before} chars cut to ${title.length} for Redbubble (limit ${LIMITS.maxTitle}, assumed)` });
  }
  const tags = adaptTags({ etsyTags: base.tags, keywords, title });
  if (!etsy) repairs.push({ field: 'copy', code: 'no_etsy_copy', detail: 'no Etsy listing copy exists yet; title and tags are built from the product title, brief and keywords. Draft the copy first for better results.' });
  const description = adaptDescription({ description: base.description, fallback: brief });
  return { title, mainTag: tags[0] || '', supportingTags: tags.slice(1), tags, description, repairs };
}

/**
 * lintCopy({title, tags[], description}, {db}) -> {ok, errors[], warnings[]}. `ok` = no errors (warnings are advice).
 * Each issue: {field, code, detail}. Blocklist runs when a db is given: a hit is an ERROR, as on the Etsy path.
 */
function lintCopy(copy, { db = null } = {}) {
  const errors = []; const warnings = [];
  const e = (field, code, detail) => errors.push({ field, code, detail });
  const w = (field, code, detail) => warnings.push({ field, code, detail });
  const title = String(copy.title || '').trim();
  const tags = Array.isArray(copy.tags) ? copy.tags.map(t => String(t)) : [];
  const description = String(copy.description || '').trim();
  if (!title) e('title', 'title_empty', 'the title is empty');
  else if ([...title].length > LIMITS.maxTitle) e('title', 'title_too_long', `${[...title].length} chars; limit ${LIMITS.maxTitle} (assumed)`);
  if (EMOJI.test(title)) w('title', 'title_emoji', 'emoji in a title is probably stripped or rejected (assumed)');
  if (!tags.length) e('tags', 'tags_empty', 'no tags: a work without tags is hard to find');
  if (tags.length > LIMITS.maxTags) e('tags', 'tags_too_many', `${tags.length} tags; limit ${LIMITS.maxTags}`);
  else if (tags.length && tags.length < LIMITS.minTagsAdvised) w('tags', 'tags_few', `${tags.length} tags; most of the ${LIMITS.maxTags} slots are unused (advice, not a rule)`);
  const seen = new Set();
  tags.forEach((t, i) => {
    const v = t.trim().toLowerCase();
    if (!v) e('tags', 'tag_empty', `tag ${i + 1} is empty`);
    if ([...v].length > LIMITS.maxTagLen) e('tags', 'tag_too_long', `"${v.slice(0, 30)}..." is ${[...v].length} chars; limit ${LIMITS.maxTagLen}`);
    if (/[,;]/.test(v)) e('tags', 'tag_separator', `"${v}" contains a comma or semicolon: it would be split into several tags`);
    if (EMOJI.test(v)) w('tags', 'tag_emoji', `"${v}" contains an emoji (assumed not accepted)`);
    if (seen.has(v)) e('tags', 'tag_duplicate', `"${v}" appears twice`); seen.add(v);
  });
  if (!description) w('description', 'description_empty', 'no description: it feeds Redbubble and Google search');
  else if ([...description].length > LIMITS.descMax) e('description', 'description_too_long', `${[...description].length} chars; the larger of the two limits seen is ${LIMITS.descMax}`);
  else if ([...description].length > LIMITS.descSafe) w('description', 'description_long', `${[...description].length} chars; sources disagree on 250 vs ${LIMITS.descMax}, so anything over ${LIMITS.descSafe} may be cut`);
  if (ETSY_ISM.test(description)) w('description', 'etsy_wording', 'mentions Etsy, shipping, returns or a production partner: those words belong to the Etsy listing, not here');
  if (db) {
    const found = scanFields(db, { title, tags, description });
    if (found.length) e('blocklist', 'blocklist', `blocklist hit: ${found.map(h => h.term).join(', ')}`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Product types. Sizes are ASSUMED (see SOURCES.productTypes). `minShort`/`minLong` are the shorter and longer sides in pixels,
 * orientation-insensitive; `aspect` is width/height best range; outside it the type is advised against.
 * large: true = a large-format product, judged on the design's REAL detail pixels (native size when it was upscaled).
 */
const PRODUCT_TYPES = Object.freeze([
  { id: 'tshirt', label: 'T-shirts, hoodies, apparel', minShort: 2875, minLong: 3900, aspect: [0.4, 2.5], note: 'Works with most shapes; a transparent background is best on coloured garments.' },
  { id: 'sticker', label: 'Stickers', minShort: 2800, minLong: 2800, aspect: [0.5, 2], note: 'Die-cut around the artwork; keep important detail away from the edge.' },
  { id: 'square', label: 'Hats, pins, acrylic blocks, art boards (square products)', minShort: 2800, minLong: 2800, aspect: [0.8, 1.25], note: 'These products are square; other shapes are cropped or shrunk.' },
  { id: 'poster', label: 'Posters, canvas, framed prints, art prints', minShort: 3000, minLong: 3000, aspect: [0.5, 2], note: 'Detail is visible up close; an upscaled image looks soft at poster size.' },
  { id: 'mug', label: 'Mugs', minShort: 1500, minLong: 3000, aspect: [1.2, 3], note: 'A mug wraps a wide image; a tall design ends up small. Assumed ratio.' },
  { id: 'phonecase', label: 'Phone cases', minShort: 2000, minLong: 3500, aspect: [0.4, 0.8], note: 'Tall, narrow shape. Assumed ratio.' },
  { id: 'bag', label: 'Tote bags, pouches, pillows, notebooks', minShort: 2500, minLong: 2500, aspect: [0.5, 2], note: 'Flexible shapes.' },
  { id: 'large', label: 'Large format: duvet covers, blankets, tapestries, rugs', minShort: 6000, minLong: 6000, aspect: [0.6, 1.8], large: true, note: 'Only worth enabling with real detail at about 7632x6480; an upscaled image looks blurry at this size.' },
]);

/**
 * advise({width, height, nativeWidth, nativeHeight}) -> [{id,label,status:'enable'|'caution'|'disable',reason}].
 * `width/height` are the STORED design pixels; when the design was upscaled from a smaller native size, large-format types are judged
 * on the native pixels because that is the detail that really exists.
 */
function advise({ width, height, nativeWidth = null, nativeHeight = null }) {
  const sides = (w, h) => ({ short: Math.min(w, h), long: Math.max(w, h) });
  const stored = sides(width, height);
  const real = nativeWidth && nativeHeight ? sides(nativeWidth, nativeHeight) : stored;
  const ratio = width / height;
  return PRODUCT_TYPES.map(t => {
    const s = t.large ? real : stored;
    const out = { id: t.id, label: t.label, note: t.note };
    const short = s.short < t.minShort; const longS = s.long < t.minLong;
    if (ratio < t.aspect[0] || ratio > t.aspect[1]) return { ...out, status: 'disable', reason: `shape ${ratio.toFixed(2)}:1 is outside what this product suits (${t.aspect[0]} to ${t.aspect[1]}, assumed)` };
    if (short || longS) {
      const gap = Math.min(s.short / t.minShort, s.long / t.minLong);
      const detail = `${s.short}x${s.long}px against about ${t.minShort}x${t.minLong}px (assumed)`;
      return gap < 0.7 ? { ...out, status: 'disable', reason: `too small: ${detail}` } : { ...out, status: 'caution', reason: `slightly small: ${detail}; Redbubble will print it but it may look soft` };
    }
    return { ...out, status: 'enable', reason: `${s.short}x${s.long}px meets about ${t.minShort}x${t.minLong}px (assumed)` };
  });
}

/** What the pack image will be: the design fitted inside 7632x6480 by the same rule as upscale.js (aspect kept, never claims more). */
function plannedSize({ width, height, upscaleAvailable }) {
  const scale = Math.min(LIMITS.imageW / width, LIMITS.imageH / height);
  if (!(scale > 1) || !upscaleAvailable) return { width, height, upscaled: false };
  return { width: Math.round(width * scale), height: Math.round(height * scale), upscaled: true };
}

module.exports = { LIMITS, SOURCES, PRODUCT_TYPES, adaptCopy, adaptTags, adaptDescription, lintCopy, advise, plannedSize, cleanTag };
