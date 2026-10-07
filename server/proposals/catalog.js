'use strict';
/**
 * proposals/catalog.js — product types, the blueprint suggestion, and the price / margin estimate for a proposal.
 *
 * Everything here is an ESTIMATE and says so. Printify exposes a variant's real base cost only on a created product
 * (CLAUDE.md), so a proposal can only ever carry: (a) the median variant cost the catalog reports (which under DRY_RUN is the
 * stub's labelled estimate), or (b) when no catalog entry matches, the ASSUMED table below. The assumed figures are
 * placeholders for planning, NOT Printify prices: the first three mirror the stub catalog's illustration values, the rest are
 * guesses of the same order. The margin is `projectMargin` from domain/fees.js over the live fee schedule, so fee rates are
 * never repeated here.
 */
const fees = require('../domain/fees');
const { loadSchedule } = require('../domain/fee-schedule');

// match = what to look for in a catalog blueprint title; hint = what to search for by hand when nothing matches.
const PRODUCT_TYPES = Object.freeze([
  { id: 'tshirt', label: 'T-shirt', noun: 'T-Shirt', match: /\b(?:t-?shirt|tee)s?\b/i, hint: 'Unisex jersey short-sleeve tee', assumedBaseCents: 1250 },
  { id: 'hoodie', label: 'Hoodie / sweatshirt', noun: 'Hoodie', match: /\b(?:hoodie|sweatshirt)s?\b/i, hint: 'Unisex heavy blend hooded sweatshirt', assumedBaseCents: 2700 },
  { id: 'mug', label: 'Mug', noun: 'Mug', match: /\bmugs?\b/i, hint: '11oz ceramic mug', assumedBaseCents: 650 },
  { id: 'poster', label: 'Poster / art print', noun: 'Poster', match: /\bposters?\b|\bart print\b/i, hint: 'Matte vertical poster', assumedBaseCents: 1100 },
  { id: 'sticker', label: 'Sticker', noun: 'Sticker', match: /\bstickers?\b/i, hint: 'Kiss-cut sticker', assumedBaseCents: 250 },
  { id: 'tote', label: 'Tote bag', noun: 'Tote Bag', match: /\btote\b/i, hint: 'Cotton tote bag', assumedBaseCents: 1100 },
]);
const TYPE_IDS = PRODUCT_TYPES.map(t => t.id);
const typeOf = (id) => PRODUCT_TYPES.find(t => t.id === id) || null;
const DEFAULT_AREA = Object.freeze({ width: 4500, height: 5400, position: 'front' });
const ASSUMED_NOTE = 'assumed, unverified: a planning placeholder, not a Printify price';
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };

/**
 * Resolve a product type to a blueprint suggestion from the catalog, never throwing: a catalog that cannot be read, or has no
 * matching blueprint, yields a hint and the assumed base cost. Reads only (listBlueprints / listPrintProviders / listVariants).
 * -> {blueprint, printProviderId, blueprintTitle, note, baseCostCents, baseCostSource, area, matched}
 */
async function resolveBlueprint(type, adapters, log = console) {
  const t = typeOf(type) || PRODUCT_TYPES[0];
  const fallback = (why) => ({ blueprint: null, printProviderId: null, blueprintTitle: null, matched: false, baseCostCents: t.assumedBaseCents, baseCostSource: 'assumed_table', area: { ...DEFAULT_AREA },
    note: `No catalog blueprint chosen (${why}). Look for: ${t.hint}. Base cost uses the ${ASSUMED_NOTE}.` });
  try {
    const list = await adapters.pod.listBlueprints();
    const hit = (Array.isArray(list) ? list : (list && list.blueprints) || []).find(b => t.match.test(String(b.title || '')));
    if (!hit) return fallback('no blueprint title matched');
    const providers = await adapters.pod.listPrintProviders(hit.id);
    const pp = (Array.isArray(providers) ? providers : (providers && providers.providers) || [])[0];
    if (!pp) return { ...fallback('the blueprint lists no print provider'), blueprint: String(hit.id), blueprintTitle: hit.title, matched: true, note: `Blueprint "${hit.title}" matched by title, but no print provider was listed: pick one on the product. Base cost uses the ${ASSUMED_NOTE}.` };
    let baseCostCents = t.assumedBaseCents; let baseCostSource = 'assumed_table'; let area = { ...DEFAULT_AREA };
    try {
      const v = await adapters.pod.listVariants(hit.id, pp.id);
      const variants = (v && v.variants) || [];
      const costs = variants.map(x => x.costCents).filter(Number.isInteger);
      if (costs.length) { baseCostCents = median(costs); baseCostSource = variants.some(x => x.estimated) || (v && v.source === 'stub') ? 'catalog_median_estimate' : 'catalog_median'; }
      const ph = variants.find(x => x.placeholders && x.placeholders[0]);
      if (ph) area = { width: ph.placeholders[0].width, height: ph.placeholders[0].height, position: ph.placeholders[0].position };
    } catch (e) { log.warn(`[proposals] variants read failed for ${hit.id}/${pp.id}: ${e.message}`); }
    return { blueprint: String(hit.id), printProviderId: String(pp.id), blueprintTitle: hit.title, matched: true, baseCostCents, baseCostSource, area,
      note: `Suggested by title match ("${hit.title}", first listed provider "${pp.title || pp.id}"); check the provider's cost, location and print area before you publish. ${baseCostSource === 'assumed_table' ? `Base cost uses the ${ASSUMED_NOTE}.` : 'Base cost is the median variant cost the catalog reported, an ESTIMATE: the real cost is read when the POD product is created.'}` };
  } catch (e) {
    log.warn(`[proposals] blueprint lookup failed for ${t.id}: ${e.message}`);
    return fallback('the catalog could not be read');
  }
}

/** Round up to a charm price: the next whole dollar minus one cent (1851 -> 1899). */
const charm = (cents) => Math.max(99, Math.ceil(cents / 100) * 100 - 1);

/**
 * suggestPrice({baseCostCents, settings}) -> {priceCents, projection}. The lowest charm price whose projected margin meets BOTH the
 * target percentage (setting `proposals_target_margin_pct`, default 30) and the margin floor (`margin_floor_cents`). An ESTIMATE.
 */
function suggestPrice({ baseCostCents, settings }) {
  const schedule = loadSchedule(settings);
  const pct = Math.min(80, Math.max(0, Number(settings && settings.get('proposals_target_margin_pct', '30')) || 30));
  const floor = settings ? settings.getInt('margin_floor_cents', 200) : 200;
  const a = fees.minListPrice({ podBaseCostCents: baseCostCents, marginPct: pct }, schedule).listPriceCents;
  const b = fees.minListPrice({ podBaseCostCents: baseCostCents, marginCents: floor }, schedule).listPriceCents;
  let p = charm(Math.max(a, b));
  let projection = fees.projectMargin({ listPriceCents: p, podBaseCostCents: baseCostCents }, schedule);
  while ((projection.marginCents < floor || projection.marginPct < pct) && p < 1000000) { p += 100; projection = fees.projectMargin({ listPriceCents: p, podBaseCostCents: baseCostCents }, schedule); }
  return { priceCents: p, projection };
}

/** The projection for a price the owner typed. Never throws on a bad price: returns null (the card shows "-"). */
function projectFor({ priceCents, baseCostCents, settings }) {
  if (!Number.isInteger(priceCents) || priceCents < 0 || !Number.isInteger(baseCostCents)) return null;
  return fees.projectMargin({ listPriceCents: priceCents, podBaseCostCents: baseCostCents }, loadSchedule(settings));
}

module.exports = { PRODUCT_TYPES, TYPE_IDS, typeOf, DEFAULT_AREA, ASSUMED_NOTE, resolveBlueprint, suggestPrice, projectFor, charm };
