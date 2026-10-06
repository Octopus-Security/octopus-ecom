'use strict';
/**
 * etsy/service.js — the Etsy STORE: connect (OAuth), shop check, status, autopublish, disconnect.
 * One Etsy store row (platform 'etsy') is assumed, per the spec ("ONE connected shop under the aged account").
 * Nothing returned from here contains a token; the status shows only the access-token expiry timestamp.
 */
const { EtsyError } = require('./auth');
const { systemEvent } = require('../events');

const NO_SHOP = 'Open an Etsy shop first (Shop Manager → open shop), then reconnect.';

function makeEtsyService({ db, auth, adapters, credentials, log = console, now = Date.now }) {
  const row = id => db.prepare('SELECT * FROM stores WHERE id = ?').get(Number(id));
  const etsyStore = () => db.prepare("SELECT * FROM stores WHERE platform = 'etsy' ORDER BY id LIMIT 1").get();
  function ensureStore() {
    const s = etsyStore();
    if (s) return s;
    const id = Number(db.prepare("INSERT INTO stores(platform,name,status,created_at) VALUES('etsy','Etsy','disconnected',?)").run(new Date(now()).toISOString()).lastInsertRowid);
    return row(id);
  }

  /** What the UI may see. Never a token. */
  function publicStore(s) {
    const needsShop = s.status === 'no_shop';
    return {
      id: s.id, platform: s.platform, name: s.name, status: s.status, connected: s.status === 'connected' && Boolean(s.shop_id),
      message: needsShop ? NO_SHOP : s.status_detail || null, needsShop,
      shopId: s.shop_id, shopName: s.shop_name, shopUrl: s.shop_url, tokenExpiresAt: s.token_expires_at, refreshExpiresAt: s.refresh_expires_at,
      connectedAt: s.connected_at, autopublish: Boolean(s.autopublish), lastSalesSyncAt: s.last_sales_sync_at,
    };
  }

  function status() {
    const a = auth.app();
    const real = adapters.storefront.describe().realReady;
    const s = etsyStore();
    return {
      stub: !real,
      credentials: { apiKey: !a.missing.some(m => m.startsWith('etsy_api_key')), sharedSecret: !a.missing.some(m => m.startsWith('etsy_shared_secret')), redirectUri: Boolean(a.redirectUri) },
      scopes: auth.SCOPES,
      message: real ? (a.redirectUri ? null : 'ETSY_REDIRECT_URI is not set; Connect will refuse until it is.') : `No Etsy app credentials: ${a.missing.join(' and ')} not set. Etsy runs on stubs.`,
      stores: s ? [publicStore(s)] : [],
    };
  }

  /** Begin OAuth. Throws EtsyError('no_credentials') with the clear message when the app is not configured. */
  function connect() { const c = auth.start(); ensureStore(); return c; } // credentials are checked first: a refused connect leaves no store row

  /** Read the shop for a store and record it: connected (with shop) or no_shop. Never throws for "no shop". */
  async function applyShop(storeId) {
    let shop;
    try { shop = await adapters.storefront.getShop(storeId); }
    catch (e) {
      if (e && e.code === 'disconnected') throw e;
      const msg = `Connected to Etsy, but reading the shop failed: ${e.message}. Use "Check shop" to retry.`;
      db.prepare("UPDATE stores SET status = 'connected', status_detail = ?, shop_id = NULL WHERE id = ?").run(msg, storeId);
      return publicStore(row(storeId));
    }
    if (!shop || !shop.hasShop) {
      db.prepare("UPDATE stores SET status = 'no_shop', status_detail = ?, shop_id = NULL, shop_name = NULL, external_user_id = COALESCE(?, external_user_id) WHERE id = ?").run(NO_SHOP, shop && shop.userId || null, storeId);
    } else {
      db.prepare("UPDATE stores SET status = 'connected', status_detail = NULL, shop_id = ?, shop_name = ?, shop_url = ?, name = ?, external_user_id = COALESCE(?, external_user_id) WHERE id = ?")
        .run(shop.shopId, shop.shopName, shop.url, shop.shopName || 'Etsy', shop.userId, storeId);
    }
    return publicStore(row(storeId));
  }

  /** The browser comes back from Etsy here. Validates state (single use, expiring), exchanges the code, stores sealed tokens, reads the shop. */
  async function callback(q = {}) {
    if (q.error) {
      if (q.state) { try { auth.consume(String(q.state)); } catch { /* already burned or unknown */ } }
      throw new EtsyError(`Etsy did not authorise the connection: ${String(q.error_description || q.error).slice(0, 200)}`, 'denied', 400);
    }
    const verifier = auth.consume(q.state);
    if (!q.code || typeof q.code !== 'string') throw new EtsyError('Etsy sent no authorisation code.', 'no_code', 400);
    const t = await adapters.storefront.exchangeCode({ code: q.code, verifier });
    const s = ensureStore();
    auth.saveTokens(s.id, t);
    db.prepare("UPDATE stores SET connected_at = ?, status = 'connected', status_detail = NULL, external_user_id = ? WHERE id = ?").run(new Date(now()).toISOString(), t.userId || null, s.id);
    systemEvent(db, { actor: 'human', note: 'Etsy connected' });
    return applyShop(s.id);
  }

  /** Re-read the shop with the saved tokens (after the operator opened a shop). */
  async function recheck(storeId) {
    const s = row(storeId);
    if (!s || s.platform !== 'etsy') throw new EtsyError('No such Etsy store', 'not_found', 404);
    if (!s.oauth_sealed) throw new EtsyError('This store is disconnected: connect it first.', 'disconnected', 409);
    return applyShop(s.id);
  }

  /** Deletes the sealed tokens. Etsy-side access is revoked by the operator in their Etsy account (no revoke call is used). */
  function disconnect(storeId) {
    const s = row(storeId);
    if (!s) throw new EtsyError('No such store', 'not_found', 404);
    db.prepare("UPDATE stores SET oauth_sealed = NULL, token_expires_at = NULL, refresh_expires_at = NULL, status = 'disconnected', status_detail = 'Disconnected by you. Connect again to publish or read sales.', autopublish = 0 WHERE id = ?").run(s.id);
    systemEvent(db, { actor: 'human', note: `Etsy store ${s.id} disconnected; sealed tokens deleted; autopublish switched off` });
    return publicStore(row(s.id));
  }

  function setAutopublish(storeId, on) {
    const s = row(storeId);
    if (!s) throw new EtsyError('No such store', 'not_found', 404);
    db.prepare('UPDATE stores SET autopublish = ? WHERE id = ?').run(on ? 1 : 0, s.id);
    systemEvent(db, { actor: 'human', note: `autopublish ${on ? 'ENABLED' : 'disabled'} for store ${s.id}` });
    return publicStore(row(s.id));
  }

  return { row, etsyStore, ensureStore, publicStore, status, connect, callback, recheck, disconnect, setAutopublish, applyShop, NO_SHOP, log };
}

module.exports = { makeEtsyService, NO_SHOP };
