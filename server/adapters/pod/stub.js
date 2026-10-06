'use strict';
/**
 * Stub PODProvider: a fake catalog, fake variant costs, fake product ids and locally generated placeholder
 * mockup PNGs. Nothing leaves the process. Pixel sizes are a dated illustration, NOT Printify's: they are
 * the same order as the real placeholders the real adapter reads (assumed 2026-10-05, unverified).
 * It also serves as the DRY_RUN stand-in for real blueprint ids: unknown ids get a generic tee-like entry,
 * and any cost it returns is an ESTIMATE (`estimated: true`), never a Printify price.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { solidPng } = require('../../png');

const BLUEPRINTS = [
  { id: 'stub-tee', title: 'Unisex Tee (stub)', brand: 'Stub', baseCents: 1250, placeholder: { position: 'front', width: 4500, height: 5400 },
    variants: [['S', 0], ['M', 0], ['L', 0], ['XL', 200]] },
  { id: 'stub-mug', title: '11oz Ceramic Mug (stub)', brand: 'Stub', baseCents: 650, placeholder: { position: 'front', width: 2475, height: 1155 },
    variants: [['11oz', 0]] },
  { id: 'stub-poster', title: 'Matte Poster (stub)', brand: 'Stub', baseCents: 1100, placeholder: { position: 'front', width: 5400, height: 7200 },
    variants: [['12x16 in', 0], ['18x24 in', 700]] },
];
const GENERIC = { id: '?', title: 'Generic blueprint (stub)', baseCents: 1250, placeholder: { position: 'front', width: 4500, height: 5400 }, variants: [['M', 0]] };
const bp = id => BLUEPRINTS.find(b => String(b.id) === String(id)) || { ...GENERIC, id: String(id) };
const vid = (b, i) => `${b.id}-v${i + 1}`;

function createStub({ dataDir } = {}) {
  const products = new Map();
  let seq = 0;
  const variantsOf = b => b.variants.map(([title, extra], i) => ({
    id: vid(b, i), title, options: { size: title }, placeholders: [{ ...b.placeholder }], costCents: b.baseCents + extra, estimated: true,
  }));
  return {
    implemented: true,
    async listBlueprints() { return BLUEPRINTS.map(b => ({ id: b.id, title: b.title, brand: b.brand })); },
    async listPrintProviders(blueprintId) { return [{ id: 'stub-pp', title: 'Stub Print Provider', blueprintId }]; },
    async listVariants(blueprintId /*, providerId */) { return { variants: variantsOf(bp(blueprintId)), source: 'stub' }; },
    async getVariantCosts(blueprintId /*, providerId, opts */) {
      return { currency: 'USD', costsAvailable: true, estimated: true, variants: variantsOf(bp(blueprintId)).map(v => ({ id: v.id, title: v.title, costCents: v.costCents })) };
    },
    async getAvailability(blueprintId /*, providerId */) {
      return { variants: variantsOf(bp(blueprintId)).map(v => ({ id: v.id, title: v.title, inStock: true })) };
    },
    /** A WRITE: faked. Generates placeholder mockups locally; the cost is an estimate and says so. */
    async createProduct({ blueprintId, providerId, title, variantIds = [], placeholder }) {
      const externalId = `stub-prod-${++seq}-${crypto.randomBytes(3).toString('hex')}`;
      const b = bp(blueprintId);
      const mockups = [];
      if (dataDir) {
        const dir = path.join(dataDir, 'mockups'); fs.mkdirSync(dir, { recursive: true });
        const h = crypto.createHash('sha256').update(externalId).digest();
        for (const [i, place] of ['front', 'lifestyle'].entries()) {
          const file = `stub-mockup-${externalId}-${place}.png`;
          fs.writeFileSync(path.join(dir, file), solidPng(600, 600, [(h[i] + 90) % 256, h[i + 1], h[i + 2]]));
          mockups.push({ file, url: null, placement: place, isDefault: i === 0, variantIds });
        }
      }
      const costOf = id => { const v = variantsOf(b).find(x => x.id === id); return v ? v.costCents : b.baseCents; };
      const variants = (variantIds.length ? variantIds : [vid(b, 0)]).map(id => ({ id, costCents: costOf(id), estimated: true }));
      const baseCostCents = Math.max(...variants.map(v => v.costCents));
      products.set(externalId, { externalId, blueprintId, providerId, title, mockups, published: false, placeholder });
      return { externalId, variants, mockups, baseCostCents, faked: true, estimated: true };
    },
    async getShopInfo() { return { id: 'stub-shop', title: 'Stub Printify shop', salesChannel: 'stub', stub: true }; },
    async getPublishState(externalId) { return { isLocked: false, visible: true, externalId: `stub-etsy-${externalId}`, handle: null, stub: true }; },
    async getMockups(externalId) { const p = products.get(externalId); return p ? p.mockups : []; },
    async publish(externalId /*, storeRef */) {
      const p = products.get(externalId);
      if (p) p.published = true;
      return { ok: true, faked: true, externalId };
    },
  };
}
module.exports = { createStub, BLUEPRINTS };
