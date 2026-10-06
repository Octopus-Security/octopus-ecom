'use strict';
/**
 * adapters/storefront/etsy.js — the real Etsy Open API v3 adapter (M3). Everything goes through adapters/http.js.
 *
 * Provenance. The endpoint paths, parameters, scopes and response FIELD NAMES below were read on 2026-10-05 from
 * Etsy's published OpenAPI document, https://www.etsy.com/openapi/generated/oas/3.0.0.json (fetched directly, not
 * through a summariser). Auth facts are on https://developers.etsy.com/documentation/essentials/authentication
 * (see etsy/auth.js). What was NOT observable is behaviour: nothing here has been run against a live Etsy shop.
 *
 *  - Base https://api.etsy.com ; every call sends `x-api-key: keystring:shared_secret` and `Authorization: Bearer`.
 *    verified 2026-10-05 — authentication page
 *  - GET /v3/application/users/me -> {user_id, shop_id}; scope shops_r.
 *    verified 2026-10-05 — oas 3.0.0.json. What it returns for a user WITHOUT a shop (404, or shop_id absent/0) is
 *    not documented: assumed, unverified; both are handled as "no shop", with a fallback to
 *    GET /v3/application/users/{user_id}/shops (verified path) whose 404 also means "no shop".
 *  - GET /v3/application/shops/{shop_id} -> shop_id, shop_name, url, currency_code, is_vacation, listing_active_count,
 *    user_id ...                                                     verified 2026-10-05 — oas 3.0.0.json
 *  - GET /v3/application/listings/{listing_id} -> state (enum active|inactive|sold_out|draft|removed|expired), url,
 *    title, tags, price {amount,divisor,currency_code}, views, num_favorers.   verified 2026-10-05 — oas 3.0.0.json
 *  - PATCH /v3/application/shops/{shop_id}/listings/{listing_id} (scope listings_w): body accepts title, description,
 *    tags, state ... but NOT price.                                   verified 2026-10-05 — oas 3.0.0.json
 *  - PRICE lives in the listing INVENTORY: GET/PUT /v3/application/listings/{listing_id}/inventory (listings_r /
 *    listings_w). PUT body {products:[{sku, property_values, offerings:[{price, quantity, is_enabled}]}],
 *    price_on_property, quantity_on_property, sku_on_property, readiness_state_on_property}; "when setting a price,
 *    assign a float equal to amount divided by divisor". Read-modify-write of the whole inventory as implemented here
 *    (dropping product_id / offering_id / is_deleted and converting prices to floats) is assumed, unverified.
 *  - POST /v3/application/shops/{shop_id}/listings (createDraftListing) required body: quantity, title, description,
 *    price, who_made, when_made, taxonomy_id.                        verified 2026-10-05 — oas 3.0.0.json
 *    Secondary path only: it needs taxonomy, shipping profile and images, so the primary route is Printify -> Etsy.
 *  - GET /v3/application/shops/{shop_id}/receipts (scope transactions_r): params min_created (epoch s, minimum
 *    946684800), limit (max 100), offset, sort_on (created|updated|receipt_id), sort_order, was_paid. Each receipt
 *    embeds `transactions[]` (transaction_id, listing_id, quantity, price Money = UNIT price, shipping_cost Money) and
 *    `refunds[]`; Money = {amount, divisor, currency_code}.        verified 2026-10-05 — oas 3.0.0.json
 *  - FEES. The API exposes ONE fee: Payment.amount_fees, "the original card processing fee of the order in pennies",
 *    read from GET /v3/application/shops/{shop_id}/receipts/{receipt_id}/payments (scope transactions_r).
 *    verified 2026-10-05 — oas 3.0.0.json. It does NOT expose the 6.5% transaction fee or the listing fee as fields;
 *    ledger entries (getShopPaymentAccountLedgerEntries) carry only amount and a free-text description. So: the
 *    processing fee is taken from the API when the call works, the transaction fee is COMPUTED from domain/fees.js,
 *    and every sale row says which in `fee_source`. Whether amount_fees can include more than the processing fee is
 *    not stated: assumed, unverified. Etsy's own fee pages could not be read (403), see domain/fees.js.
 *  - VIEWS ARE exposed: Listing.views, "tabulated once per day and only for active listings, not real-time; 0 can mean
 *    not yet tabulated". Favourites: num_favorers. There is NO sales counter on a listing, so getListingStats returns
 *    sales: null and the performance watcher counts them from ingested sales instead.
 *    verified 2026-10-05 — oas 3.0.0.json
 *  - Rate limits: QPS and QPD per API key, values not published in the docs (shown in the developer portal); response
 *    headers x-limit-per-second / x-remaining-this-second / x-limit-per-day / x-remaining-today; 429 + retry-after on
 *    excess.                           verified 2026-10-05 — https://developers.etsy.com/documentation/essentials/rate-limits
 *    Used here: a conservative LOCAL ceiling configured in deps.js (ETSY_QPS default 4, ETSY_QPD default 4000;
 *    those two defaults are assumed, unverified, and are env-tunable). x-remaining-today is honoured: at 0 we stop.
 */
const { EtsyError } = require('../../etsy/auth');
const { HttpError } = require('../http');

const BASE = 'https://api.etsy.com';
const PAGE = 100;

/** Money {amount, divisor} -> integer cents (Etsy shop currency; currency conversion is not modelled). */
function cents(m) {
  if (!m || !Number.isFinite(Number(m.amount)) || !Number(m.divisor)) return 0;
  return Math.round((Number(m.amount) * 100) / Number(m.divisor));
}

function createEtsy({ http, etsyAuth, log = console, env = {} } = {}) {
  const noAuth = () => { throw new EtsyError('Etsy auth is not wired', 'no_auth', 500); };
  const auth = etsyAuth || { app: noAuth, requireApp: noAuth };
  const readPerDayFloor = Number(env.ETSY_QPD_RESERVE) >= 0 ? Number(env.ETSY_QPD_RESERVE) : 20;

  /** One authenticated call. A 401 refreshes the token once (single-flight) and retries once. */
  async function call(storeId, method, path, { query, json } = {}) {
    const app = auth.requireApp();
    let token = await auth.accessToken(storeId);
    const url = `${BASE}${path}${query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null))}` : ''}`;
    const go = t => http.request(url, { method, json, headers: { 'x-api-key': app.header, Authorization: `Bearer ${t}`, Accept: 'application/json' } });
    let res;
    try { res = await go(token); }
    catch (e) {
      if (!(e instanceof HttpError) || e.status !== 401) throw e;
      token = await auth.refresh(storeId, { staleAccessToken: token });
      res = await go(token);
    }
    const left = res.headers && res.headers.get ? res.headers.get('x-remaining-today') : null;
    if (left !== null && left !== undefined && left !== '' && Number(left) <= readPerDayFloor) log.warn(`[etsy] only ${left} requests left in Etsy's daily allowance (x-remaining-today)`);
    return res.json();
  }

  const num = (v, what) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw new EtsyError(`${what} "${v}" is not an Etsy numeric id`, 'bad_id', 400); return n; };
  const shopOf = storeId => {
    const id = auth.shopIdOf ? auth.shopIdOf(storeId) : null;
    if (!id) throw new EtsyError('This Etsy store has no shop yet. Open an Etsy shop first (Shop Manager → open shop), then reconnect.', 'no_shop', 409);
    return num(id, 'shop id');
  };

  const shopRow = s => ({
    hasShop: true, shopId: String(s.shop_id), shopName: s.shop_name || null, url: s.url || null, currency: s.currency_code || null,
    userId: s.user_id ? String(s.user_id) : null, isVacation: Boolean(s.is_vacation), activeListings: s.listing_active_count ?? null,
  });

  return {
    implemented: true,

    /** getShop(storeId) -> {hasShop:true, shopId, shopName, ...} | {hasShop:false, userId, message}. Never throws for "no shop". */
    async getShop(storeId) {
      let me = null;
      try { me = await call(storeId, 'GET', '/v3/application/users/me'); }
      catch (e) { if (!(e instanceof HttpError) || e.status !== 404) throw e; }
      const userId = me && me.user_id ? String(me.user_id) : null;
      let shopId = me && me.shop_id ? me.shop_id : null;
      if (!shopId && userId) {
        try { const s = await call(storeId, 'GET', `/v3/application/users/${num(userId, 'user id')}/shops`); shopId = s && s.shop_id; if (s && s.shop_id) return shopRow(s); }
        catch (e) { if (!(e instanceof HttpError) || ![403, 404].includes(e.status)) throw e; }
      }
      if (!shopId) return { hasShop: false, userId, message: 'This Etsy account has no shop. Open an Etsy shop first (Shop Manager → open shop), then reconnect.' };
      return shopRow(await call(storeId, 'GET', `/v3/application/shops/${num(shopId, 'shop id')}`));
    },

    buildAuthUrl() { const s = auth.start(); return { url: s.url, state: s.state, expiresAt: s.expiresAt, scopes: s.scopes }; },
    exchangeCode(o) { return auth.exchangeCode(o); },
    async refreshToken(storeId) { await auth.refresh(storeId); return { ok: true }; },

    /** getListing(storeId, listingId) -> {id, state, url, title, tags, priceCents, currency, views, favorites} | null */
    async getListing(storeId, listingId) {
      try {
        const l = await call(storeId, 'GET', `/v3/application/listings/${num(listingId, 'listing id')}`);
        return { id: String(l.listing_id), state: l.state, url: l.url || null, title: l.title, tags: l.tags || [], priceCents: cents(l.price), currency: l.price && l.price.currency_code || null, views: l.views ?? null, favorites: l.num_favorers ?? null, shopId: l.shop_id ? String(l.shop_id) : null };
      } catch (e) { if (e instanceof HttpError && e.status === 404) return null; throw e; }
    },

    /** createListing(storeId, {quantity,title,description,price (dollars),who_made,when_made,taxonomy_id,...}) — a WRITE (secondary path). */
    async createListing(storeId, data) {
      const body = { ...data };
      for (const k of ['quantity', 'title', 'description', 'price', 'who_made', 'when_made', 'taxonomy_id']) if (body[k] === undefined) throw new EtsyError(`createListing needs ${k}`, 'bad_request', 400);
      const l = await call(storeId, 'POST', `/v3/application/shops/${shopOf(storeId)}/listings`, { json: body });
      return { id: String(l.listing_id), state: l.state, url: l.url || null };
    },

    /**
     * updateListing(storeId, listingId, {title?, tags?, description?, priceCents?}) — a WRITE.
     * Text goes through PATCH listing; the price goes through the inventory (see header).
     */
    async updateListing(storeId, listingId, patch = {}) {
      const id = num(listingId, 'listing id'); const shop = shopOf(storeId);
      const body = {};
      for (const k of ['title', 'tags', 'description']) if (patch[k] !== undefined) body[k] = patch[k];
      let l = null;
      if (Object.keys(body).length) l = await call(storeId, 'PATCH', `/v3/application/shops/${shop}/listings/${id}`, { json: body });
      if (patch.priceCents !== undefined) {
        if (!Number.isInteger(patch.priceCents) || patch.priceCents <= 0) throw new EtsyError('priceCents must be a positive integer', 'bad_request', 400);
        const inv = await call(storeId, 'GET', `/v3/application/listings/${id}/inventory`);
        const price = patch.priceCents / 100;
        const products = (inv.products || []).filter(p => !p.is_deleted).map(p => ({
          sku: p.sku || '', property_values: (p.property_values || []).map(v => ({ property_id: v.property_id, property_name: v.property_name, scale_id: v.scale_id, value_ids: v.value_ids, values: v.values })),
          offerings: (p.offerings || []).filter(o => !o.is_deleted).map(o => ({ price, quantity: o.quantity, is_enabled: o.is_enabled })),
        }));
        if (!products.length) throw new EtsyError('The listing inventory has no products to price', 'bad_inventory', 502);
        await call(storeId, 'PUT', `/v3/application/listings/${id}/inventory`, { json: { products, price_on_property: inv.price_on_property || [], quantity_on_property: inv.quantity_on_property || [], sku_on_property: inv.sku_on_property || [] } });
      }
      return { id: String(id), state: l ? l.state : undefined, url: l ? l.url : undefined, title: l ? l.title : undefined, tags: l ? l.tags : undefined };
    },

    /**
     * getReceipts(storeId, {sinceTs, maxPages, skipFeeFor}) -> {receipts:[{receiptId, createdTs, isPaid, refunds, refundList:[{amountCents,createdTs,reason,status}], processingFeeCents|null, transactions:[...]}],
     *   complete, maxCreated, requests}
     * Paid receipts oldest first. `complete:false` = the page cap was hit; the caller resumes from maxCreated.
     */
    async getReceipts(storeId, { sinceTs = 0, maxPages = 20, withFees = true, skipFeeFor = null } = {}) {
      const shop = shopOf(storeId);
      const receipts = []; let offset = 0; let complete = false; let pages = 0; let maxCreated = sinceTs || 0;
      while (pages < maxPages) {
        const r = await call(storeId, 'GET', `/v3/application/shops/${shop}/receipts`, { query: { min_created: Math.max(946684800, sinceTs || 0), limit: PAGE, offset, sort_on: 'created', sort_order: 'asc', was_paid: true } });
        pages++;
        const rows = r.results || [];
        for (const x of rows) {
          const createdTs = x.created_timestamp || x.create_timestamp || 0;
          maxCreated = Math.max(maxCreated, createdTs);
          receipts.push({
            receiptId: String(x.receipt_id), createdTs, isPaid: x.is_paid !== false, refunds: (x.refunds || []).length,
            // ShopRefund {amount Money, created_timestamp, reason, note_from_issuer, status} - verified 2026-10-05, oas 3.0.0.json: it has NO id field.
            refundList: (x.refunds || []).map(rf => ({ amountCents: cents(rf.amount), createdTs: rf.created_timestamp || 0, reason: rf.reason || null, status: rf.status || null })),
            currency: x.grandtotal && x.grandtotal.currency_code || null,
            processingFeeCents: null,
            transactions: (x.transactions || []).map(t => ({ transactionId: String(t.transaction_id), listingId: t.listing_id ? String(t.listing_id) : null, quantity: t.quantity || 1, unitCents: cents(t.price), shippingCents: cents(t.shipping_cost), title: t.title || null })),
          });
        }
        if (rows.length < PAGE) { complete = true; break; }
        offset += PAGE;
      }
      let requests = pages;
      if (withFees) {
        for (const x of receipts) {
          if (skipFeeFor && skipFeeFor.has(x.receiptId)) continue; // already ingested: re-read only to see refunds, not to re-fetch its fee
          try {
            const p = await call(storeId, 'GET', `/v3/application/shops/${shop}/receipts/${num(x.receiptId, 'receipt id')}/payments`);
            requests++;
            const pay = (p.results || [])[0];
            if (pay && pay.amount_fees) x.processingFeeCents = cents(pay.amount_fees);
          } catch (e) { log.warn(`[etsy] payment fee read failed for receipt ${x.receiptId}: ${e.message}; the fee will be computed`); }
        }
      }
      return { receipts, complete, maxCreated, requests };
    },

    /** getListingStats(externalId) -> {views, favorites, sales:null}. Uses the single connected store. */
    async getListingStats(externalId) {
      const storeId = auth.defaultStoreId ? auth.defaultStoreId() : null;
      if (!storeId) throw new EtsyError('No connected Etsy store to read listing stats with', 'disconnected', 409);
      const l = await this.getListing(storeId, externalId);
      if (!l) throw new EtsyError(`Etsy has no listing ${externalId}`, 'not_found', 404);
      return { views: l.views ?? 0, favorites: l.favorites ?? 0, sales: null, salesSource: 'ingested sales' };
    },
  };
}
module.exports = { createEtsy, cents, BASE };
