'use strict';
/** Shared fakes for the M3 tests: a fake Etsy + Printify behind one fake fetch, and live-armed deps. No network. */
const { makeDeps, fakeFetch } = require('./helpers');
const { makeHttp } = require('../server/adapters/http');
const fastHttp = f => makeHttp({ fetchImpl: f, sleep: async () => {}, random: () => 0.5, ratePerSec: 1000, burst: 1000 });

const KEY = 'kstr0123456789'; const SECRET = 'shsec0123456789';
const REDIRECT = 'https://ecom.test/api/etsy/callback';
const LIVE_ENV = { ETSY_API_KEY: KEY, ETSY_SHARED_SECRET: SECRET, ETSY_REDIRECT_URI: REDIRECT, PRINTIFY_API_TOKEN: 'pfy-token-0123456789abcdef', DRY_RUN: 'false', PRINTIFY_SHOP_ID: '7' };
const money = c => ({ amount: c, divisor: 100, currency_code: 'USD' });

/**
 * One state object drives both fakes. Override anything per test via `st`.
 *   st.tokens: how many token POSTs happened; st.shop: the Etsy shop (or null = no shop); st.listings: id -> listing
 *   st.receipts: Etsy receipts; st.fee: processing fee cents by receipt id; st.printifyShops; st.product: Printify product
 */
function makeWorld(over = {}) {
  const st = {
    shop: { shop_id: 555, shop_name: 'My Shop', url: 'https://etsy.test/shop/MyShop', user_id: 1, currency_code: 'USD' },
    validAccess: new Set(['1.at-1']), nextAccess: 2, refreshFail: 0, tokenCalls: [],
    listings: {}, receipts: [], fees: {}, inventory: null,
    printifyShops: [{ id: 7, title: 'My Shop', sales_channel: 'etsy' }],
    product: { id: 'pf_1', is_locked: false, visible: true, external: null, variants: [], images: [] },
    publishCalls: [], putCalls: [], etsyWrites: [],
    ...over,
  };
  const f = fakeFetch((url, init) => {
    const u = new URL(url); const m = init.method || 'GET'; const p = u.pathname;
    if (u.host === 'api.etsy.com') {
      if (p === '/v3/public/oauth/token') {
        const form = new URLSearchParams(String(init.body)); st.tokenCalls.push(Object.fromEntries(form));
        if (form.get('grant_type') === 'refresh_token' && st.refreshFail) return { status: st.refreshFail, body: { error: 'invalid_grant' } };
        const at = `1.at-${st.nextAccess++}`; st.validAccess.add(at);
        return { body: { access_token: at, token_type: 'Bearer', expires_in: 3600, refresh_token: `1.rt-${st.nextAccess}` } };
      }
      const auth = (init.headers || {}).Authorization || '';
      if (p.startsWith('/v3/application/') && !st.validAccess.has(auth.replace('Bearer ', ''))) return { status: 401, body: { error: 'invalid_token' } };
      if (p === '/v3/application/users/me') return st.shop ? { body: { user_id: 1, shop_id: st.shop.shop_id } } : { status: 404, body: { error: 'no shop' } };
      if (/^\/v3\/application\/users\/\d+\/shops$/.test(p)) return st.shop ? { body: st.shop } : { status: 404, body: { error: 'no shop' } };
      if (p === `/v3/application/shops/555`) return { body: st.shop };
      let g;
      if ((g = p.match(/^\/v3\/application\/listings\/(\d+)$/))) return st.listings[g[1]] ? { body: st.listings[g[1]] } : { status: 404, body: { error: 'nope' } };
      if ((g = p.match(/^\/v3\/application\/listings\/(\d+)\/inventory$/))) {
        if (m === 'GET') return { body: st.inventory || { products: [{ product_id: 1, sku: '', is_deleted: false, property_values: [], offerings: [{ offering_id: 1, price: money(2500), quantity: 5, is_enabled: true }] }], price_on_property: [], quantity_on_property: [], sku_on_property: [] } };
        st.etsyWrites.push({ method: m, path: p, body: init.body && JSON.parse(init.body) }); return { body: {} };
      }
      if ((g = p.match(/^\/v3\/application\/shops\/555\/listings\/(\d+)$/)) && m === 'PATCH') { st.etsyWrites.push({ method: m, path: p, body: JSON.parse(init.body) }); return { body: { listing_id: Number(g[1]), state: 'active', ...JSON.parse(init.body) } }; }
      if (p === '/v3/application/shops/555/receipts') {
        const min = Number(u.searchParams.get('min_created') || 0); const off = Number(u.searchParams.get('offset') || 0); const lim = Number(u.searchParams.get('limit') || 25);
        const all = st.receipts.filter(r => r.created_timestamp >= min).sort((a, b) => a.created_timestamp - b.created_timestamp);
        return { body: { count: all.length, results: all.slice(off, off + lim) } };
      }
      if ((g = p.match(/^\/v3\/application\/shops\/555\/receipts\/(\d+)\/payments$/))) {
        const fee = st.fees[g[1]]; return fee === undefined ? { status: 403, body: { error: 'no' } } : { body: { count: 1, results: [{ payment_id: 1, amount_fees: money(fee) }] } };
      }
      return { status: 404, body: { error: `unhandled etsy ${m} ${p}` } };
    }
    if (u.host === 'api.printify.com') {
      const pp = p.replace('/v1', '');
      if (pp === '/shops.json') return { body: st.printifyShops };
      if (pp === '/shops/7/products/pf_1.json' && m === 'GET') return { body: st.product };
      if (pp === '/shops/7/products/pf_1.json' && m === 'PUT') { st.putCalls.push(JSON.parse(init.body)); return { body: st.product }; }
      if (pp === '/shops/7/products/pf_1/publish.json') { st.publishCalls.push(JSON.parse(init.body)); if (st.onPublish) st.onPublish(st); return { body: {} }; }
      return { status: 404, body: { error: `unhandled printify ${m} ${pp}` } };
    }
    return { status: 404, body: { error: 'unhandled host' } };
  });
  return { st, fetch: f };
}

/** Live-armed deps over the world. clock is mutable: world.clock.t (ms). */
function liveDeps(over = {}, env = {}) {
  const world = makeWorld(over);
  const clock = { t: Date.parse('2026-10-05T12:00:00Z') };
  const d = makeDeps({ ...LIVE_ENV, ...env }, { http: fastHttp(world.fetch), nowMs: () => clock.t, sleep: async () => {} });
  return { d, world, st: world.st, clock, calls: world.fetch.calls };
}

/** A connected Etsy store with sealed tokens, directly in the db. */
function connectStore(d, { shopId = '555', shopName = 'My Shop', status = 'connected', expiresAt } = {}) {
  const id = Number(d.db.prepare("INSERT INTO stores(platform,name,status,shop_id,shop_name,created_at) VALUES('etsy',?,?,?,?,?)").run(shopName, status, shopId, shopName, new Date().toISOString()).lastInsertRowid);
  d.etsyAuth.saveTokens(id, { accessToken: '1.at-1', refreshToken: '1.rt-1', expiresAt: expiresAt || Date.now() + 3600_000 * 24 });
  return id;
}

/** An approved product with a real-looking Printify id and a draft listing. */
function approvedProduct(d, { price = 3000, cost = 1337, source = 'printify_product', podId = 'pf_1', storeId = null } = {}) {
  const p = d.stages.createProduct({ brief: 'a fox', niche: 'cozy', listPriceCents: price });
  d.db.prepare("UPDATE products SET stage='approved', title='Fox tee', pod_external_id=?, pod_base_cost_cents=?, pod_cost_source=?, store_id=?, projected_margin_cents=900 WHERE id=?").run(podId, cost, source, storeId, p.id);
  d.db.prepare("INSERT INTO listings(product_id,platform,title,tags,description,price_cents,status,created_at) VALUES(?,'etsy','Fox tee',?,?,?,'draft',?)").run(p.id, JSON.stringify(['fox', 'cozy']), 'A cozy fox.', price, new Date().toISOString());
  return p.id;
}

module.exports = { fastHttp, makeWorld, liveDeps, connectStore, approvedProduct, money, KEY, SECRET, REDIRECT, LIVE_ENV };
