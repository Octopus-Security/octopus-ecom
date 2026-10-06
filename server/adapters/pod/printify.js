'use strict';
/**
 * adapters/pod/printify.js — the real Printify adapter (M2). Everything goes through adapters/http.js.
 *
 * Provenance, honestly stated. Read 2026-10-05: https://developers.printify.com/ (fetched through a
 * summariser, so field lists below are as summarised, not a verbatim copy of the page). Each claim is
 * tagged "verified 2026-10-05 — <url>" only where that read showed it, else "assumed, unverified".
 *
 *  - Base URL https://api.printify.com/v1/ and `Authorization: Bearer <token>`; a `User-Agent` header is
 *    required.                                                   verified 2026-10-05 — https://developers.printify.com/
 *  - Rate limits: 600 requests/minute global; catalog endpoints 100 requests/minute per integration;
 *    product publishing 200 requests per 30 minutes; 429 on excess.
 *                                                                verified 2026-10-05 — https://developers.printify.com/
 *    Used here: catalog calls are paced at CATALOG_RPS (1.5/s = 90/min, under 100/min); other calls use the
 *    http.js default (5/s = 300/min, under 600/min). Publish (M3) must stay under 200 per 30 minutes.
 *  - GET shops.json -> [{id,title,sales_channel}]                 verified 2026-10-05 — https://developers.printify.com/
 *  - GET catalog/blueprints.json -> [{id,title,brand,model,images,...}]   verified 2026-10-05 — same page
 *  - GET catalog/blueprints/{id}/print_providers.json -> [{id,title,decoration_methods}]   verified — same page
 *  - GET catalog/blueprints/{id}/print_providers/{pid}/variants.json -> variants with `id`, `title`,
 *    `options`, and `placeholders:[{position,height,width,decoration_method}]` (print-area PIXELS).
 *    verified 2026-10-05 — same page. The same read says this endpoint carries NO PRICING.
 *  - WHERE THE BASE COST LIVES: not in the catalog variants. It is the read-only `cost` of each variant
 *    on a PRODUCT ("fulfillment cost in cents, integer"; `price` is the required retail price in cents).
 *    verified 2026-10-05 — developers.printify.com, product variant table, seen in a search excerpt.
 *    Consequence: a real base cost needs a real product, i.e. a WRITE. Under DRY_RUN there is no
 *    Printify product, so the pipeline's base cost is a labelled stub ESTIMATE until the product is
 *    really created. getVariantCosts therefore returns real costs only when given a real product id.
 *  - POST shops/{shop}/products.json body: title, description, blueprint_id, print_provider_id,
 *    variants:[{id,price,is_enabled}], print_areas:[{variant_ids, placeholders:[{position, images:[{id,x,y,scale,angle}]}]}];
 *    response carries `id`, `variants` and read-only mock-up `images:[{src,variant_ids,position,is_default}]`.
 *    verified 2026-10-05 — https://developers.printify.com/ (the `decoration_method` key on placeholders is
 *    shown in the docs; omitted here, assumed optional for single-method blueprints: unverified).
 *  - GET shops/{shop}/products/{id}.json                           verified 2026-10-05 — same page
 *  - POST shops/{shop}/products/{id}/publish.json                  verified 2026-10-05 — same page (M3 uses it)
 *  - Image upload: POST uploads/images.json with {file_name, contents:<base64>} or {file_name, url}.
 *    The base64-or-URL choice was confirmed by a search summary of the API docs, the exact path, field names
 *    and the response shape (id,width,height,...) were NOT on the page I could read: assumed, unverified.
 *    Size: the Printify help centre says 100 MB for PNG/JPEG (https://help.printify.com/hc/en-us/articles/4483617936657,
 *    seen in a search summary only). Whether the API enforces the same figure is assumed, unverified, so
 *    the limit is configurable (PRINTIFY_MAX_UPLOAD_BYTES) and a 413 from the server is reported as such.
 *    A third-party wrapper's docs claim a 20 MB figure; unconfirmed, and not used.
 *  - Image placement: x/y are the image centre in 0..1 of the print area and `scale` is the image width as a
 *    fraction of the print-area width (1 = full width): assumed, unverified.
 *  - Availability: the default variants list is assumed to return in-stock variants only and
 *    `?show-out-of-stock=1` to return all: assumed, unverified.
 *
 * The 28 MB design is never downscaled: that would defeat print readiness. If it is over the limit
 * the call fails with an explicit message (and the pipeline moves the product to `failed`).
 */
const fs = require('node:fs');
const { readPngSize } = require('../../png');

const BASE = 'https://api.printify.com/v1';
const CATALOG_RPS = 1.5;                 // 90/min against the documented 100/min per integration
const DEFAULT_MAX_UPLOAD = 100 * 1024 * 1024; // help-centre figure, see header
const CACHE_MS = 10 * 60 * 1000;

class PrintifyError extends Error { constructor(m, extra = {}) { super(m); this.name = 'PrintifyError'; Object.assign(this, extra); } }

function createPrintify({ http, credentials, log = console, env = {}, now = Date.now, fsImpl = fs } = {}) {
  const maxUpload = Number(env.PRINTIFY_MAX_UPLOAD_BYTES) > 0 ? Number(env.PRINTIFY_MAX_UPLOAD_BYTES) : DEFAULT_MAX_UPLOAD;
  const cache = new Map();
  let shopCache = null;

  async function api(method, path, { json, catalog = false, timeoutMs } = {}) {
    const token = credentials.get('printify');
    if (!token) throw new PrintifyError('no Printify credential');
    const res = await http.request(`${BASE}${path}`, {
      method, json, timeoutMs,
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'octopus-ecom', Accept: 'application/json' },
      ...(catalog ? { ratePerSec: CATALOG_RPS } : {}),
    });
    return res.json();
  }
  const list = x => (Array.isArray(x) ? x : x && Array.isArray(x.data) ? x.data : []);
  async function cached(key, fn) {
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return hit.v;
    const v = await fn(); cache.set(key, { at: now(), v }); return v;
  }
  const num = (v, what) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw new PrintifyError(`${what} "${v}" is not a Printify numeric id (a stub id cannot be used against the real API)`); return n; };

  async function shopId() {
    if (env.PRINTIFY_SHOP_ID) return num(env.PRINTIFY_SHOP_ID, 'PRINTIFY_SHOP_ID');
    if (shopCache) return shopCache;
    const shops = list(await api('GET', '/shops.json'));
    if (shops.length === 0) throw new PrintifyError('the Printify account has no shop; create one (and connect your store) in Printify first');
    if (shops.length > 1) throw new PrintifyError(`the Printify account has ${shops.length} shops; set PRINTIFY_SHOP_ID to one of: ${shops.map(s => `${s.id} (${s.title})`).join(', ')}`);
    return (shopCache = shops[0].id);
  }

  const variantRow = v => ({
    id: v.id, title: v.title, options: v.options || {},
    placeholders: (v.placeholders || []).map(p => ({ position: p.position, width: p.width, height: p.height })),
    costCents: Number.isInteger(v.cost) ? v.cost : null, // the catalog does not carry one; see header
  });

  async function catalogVariants(blueprintId, providerId, { includeOutOfStock = false } = {}) {
    const b = num(blueprintId, 'blueprint'); const p = num(providerId, 'print provider');
    const q = includeOutOfStock ? '?show-out-of-stock=1' : '';
    const body = await cached(`v:${b}:${p}:${q}`, () => api('GET', `/catalog/blueprints/${b}/print_providers/${p}/variants.json${q}`, { catalog: true }));
    return list(body.variants !== undefined ? body.variants : body);
  }

  function mockupsOf(product) {
    return list(product && product.images).map(i => ({ url: i.src, placement: i.position || null, variantIds: i.variant_ids || [], isDefault: Boolean(i.is_default) })).filter(m => m.url);
  }

  return {
    implemented: true,
    maxUploadBytes: maxUpload,

    async listBlueprints() {
      const bps = await cached('bps', () => api('GET', '/catalog/blueprints.json', { catalog: true }));
      return list(bps).map(b => ({ id: b.id, title: b.title, brand: b.brand || null }));
    },
    async listPrintProviders(blueprintId) {
      const b = num(blueprintId, 'blueprint');
      const pp = await cached(`pp:${b}`, () => api('GET', `/catalog/blueprints/${b}/print_providers.json`, { catalog: true }));
      return list(pp).map(p => ({ id: p.id, title: p.title, blueprintId: b }));
    },
    async listVariants(blueprintId, providerId) {
      return { variants: (await catalogVariants(blueprintId, providerId)).map(variantRow), source: 'printify' };
    },
    /**
     * getVariantCosts(blueprint, provider, {externalId}) -> {variants:[{id,title,costCents|null}], costsAvailable}
     * Real costs exist only on a real product (see header). Without one the rows carry costCents:null.
     */
    async getVariantCosts(blueprintId, providerId, { externalId } = {}) {
      if (externalId && !String(externalId).startsWith('stub-')) {
        const p = await api('GET', `/shops/${await shopId()}/products/${encodeURIComponent(externalId)}.json`);
        const v = list(p.variants).filter(x => x.is_enabled !== false).map(x => ({ id: x.id, title: x.title, costCents: Number.isInteger(x.cost) ? x.cost : null }));
        return { currency: 'USD', variants: v, costsAvailable: v.some(x => x.costCents !== null), from: 'product' };
      }
      const v = (await catalogVariants(blueprintId, providerId)).map(x => ({ id: x.id, title: x.title, costCents: null }));
      return { currency: 'USD', variants: v, costsAvailable: false, from: 'catalog' };
    },
    async getAvailability(blueprintId, providerId) {
      const inStock = new Set((await catalogVariants(blueprintId, providerId)).map(v => v.id));
      const all = await catalogVariants(blueprintId, providerId, { includeOutOfStock: true });
      return { variants: all.map(v => ({ id: v.id, title: v.title, inStock: inStock.has(v.id) })) };
    },

    /** Upload the design. Fails clearly if over the limit; NEVER downsamples. */
    async uploadImage({ file, fileName }) {
      const st = fsImpl.statSync(file);
      if (st.size > maxUpload) {
        throw new PrintifyError(`design is ${(st.size / 1048576).toFixed(1)} MB, over the ${(maxUpload / 1048576).toFixed(0)} MB Printify upload limit; it was NOT downscaled because that would break print readiness. Regenerate at a smaller size or raise PRINTIFY_MAX_UPLOAD_BYTES if Printify allows more.`, { code: 'too_large' });
      }
      const buf = fsImpl.readFileSync(file);
      let size = null; try { size = readPngSize(buf); } catch { /* not a PNG: let Printify judge */ }
      let r;
      try { r = await api('POST', '/uploads/images.json', { json: { file_name: fileName, contents: buf.toString('base64') }, timeoutMs: 180000 }); }
      catch (e) {
        if (e.status === 413) throw new PrintifyError(`Printify refused the upload as too large (HTTP 413) at ${(st.size / 1048576).toFixed(1)} MB; not downscaled. Lower PRINTIFY_MAX_UPLOAD_BYTES to match.`, { code: 'too_large' });
        throw e;
      }
      if (!r || !r.id) throw new PrintifyError('Printify upload returned no image id');
      return { id: r.id, width: r.width || (size && size.width) || null, height: r.height || (size && size.height) || null };
    },

    /**
     * createProduct({blueprintId, providerId, variantIds, listPriceCents, title, description, imagePath, imageWidth, imageHeight, position, placeholder})
     *   -> {externalId, variants:[{id,costCents}], mockups, baseCostCents, faked:false}
     * A WRITE: the router only sends it here with DRY_RUN off.
     */
    async createProduct(o) {
      const b = num(o.blueprintId, 'blueprint'); const p = num(o.providerId, 'print provider');
      if (!Array.isArray(o.variantIds) || !o.variantIds.length) throw new PrintifyError('createProduct needs at least one variant id');
      if (!Number.isInteger(o.listPriceCents) || o.listPriceCents <= 0) throw new PrintifyError('createProduct needs a list price in cents');
      const up = await this.uploadImage({ file: o.imagePath, fileName: `design-${Date.now()}.png` });
      const ph = o.placeholder || {};
      const aspect = (o.imageWidth || up.width) / (o.imageHeight || up.height);
      const parea = ph.width && ph.height ? ph.width / ph.height : aspect;
      const scale = aspect >= parea ? 1 : aspect / parea; // contain-fit; see header (assumed)
      const body = {
        title: o.title, description: o.description || o.title, blueprint_id: b, print_provider_id: p,
        variants: o.variantIds.map(id => ({ id: Number(id), price: o.listPriceCents, is_enabled: true })),
        print_areas: [{ variant_ids: o.variantIds.map(Number), placeholders: [{ position: o.position || 'front', images: [{ id: up.id, x: 0.5, y: 0.5, scale, angle: 0 }] }] }],
      };
      const sid = await shopId();
      const created = await api('POST', `/shops/${sid}/products.json`, { json: body, timeoutMs: 60000 });
      if (!created || !created.id) throw new PrintifyError('Printify returned no product id');
      let product = created;
      if (!mockupsOf(product).length) { try { product = await api('GET', `/shops/${sid}/products/${created.id}.json`); } catch (e) { log.warn(`[printify] mockup read-back failed: ${e.message}`); } }
      const chosen = new Set(o.variantIds.map(Number));
      const variants = list(product.variants).filter(v => chosen.has(v.id)).map(v => ({ id: v.id, title: v.title, costCents: Number.isInteger(v.cost) ? v.cost : null }));
      const costs = variants.map(v => v.costCents).filter(Number.isInteger);
      return { externalId: String(created.id), variants, mockups: mockupsOf(product), baseCostCents: costs.length ? Math.max(...costs) : null, faked: false, uploadedImageId: up.id };
    },
    async getMockups(externalId) {
      const p = await api('GET', `/shops/${await shopId()}/products/${encodeURIComponent(externalId)}.json`);
      return mockupsOf(p);
    },
    /** M3: POST shops/{shop}/products/{id}/publish.json. Signature only here; refuses so nothing can publish by accident. */
    async publish(/* externalId, storeRef */) { throw new PrintifyError('pod.printify.publish is M3: not implemented in M2'); },
  };
}
module.exports = { createPrintify, PrintifyError, CATALOG_RPS, DEFAULT_MAX_UPLOAD };
