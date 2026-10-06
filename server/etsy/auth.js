'use strict';
/**
 * etsy/auth.js — Etsy OAuth2 (Authorization Code + PKCE) and the per-store token lifecycle.
 *
 * Provenance (read 2026-10-05):
 *  - Authorize URL https://www.etsy.com/oauth/connect with response_type=code, client_id (the API KEYSTRING
 *    alone), redirect_uri, scope (space separated), state, code_challenge, code_challenge_method=S256.
 *    verified 2026-10-05 — https://developers.etsy.com/documentation/essentials/authentication
 *  - Token endpoint POST https://api.etsy.com/v3/public/oauth/token (form body): grant_type=authorization_code with
 *    client_id, redirect_uri, code, code_verifier; grant_type=refresh_token with client_id, refresh_token.
 *    verified 2026-10-05 — same page
 *  - Access token lifetime 3600 s; refresh token lifetime 90 days; a refresh response carries a NEW refresh token
 *    and the old one stops working ("previous tokens become invalid upon use" in the page as summarised). So the
 *    new pair is persisted BEFORE anything else happens, and refreshes are single-flight per store.
 *    verified 2026-10-05 — same page
 *  - Code verifier: 43-128 chars of high entropy. verified 2026-10-05 — same page
 *  - Scopes exist as listed there: address_r address_w email_r listings_d listings_r listings_w profile_r profile_w
 *    shops_r shops_w transactions_r transactions_w. This app asks for exactly four (SCOPES below). Per the OpenAPI
 *    document https://www.etsy.com/openapi/generated/oas/3.0.0.json (read 2026-10-05): getMe needs shops_r;
 *    receipts, transactions, payments and ledger entries need transactions_r; updateListing and
 *    updateListingInventory need listings_w; getListingInventory needs listings_r; getListing, getShop and
 *    getShopByOwnerUserId need only the API key. No other scope is needed for anything this app calls.
 *    Publishing from Printify to Etsy runs under Printify's own Etsy connection, not these tokens.
 *  - x-api-key header is `keystring:shared_secret` (not the bare keystring).
 *    verified 2026-10-05 — https://developers.etsy.com/documentation/essentials/authentication
 *  - A redirect URI over plain http: assumed, unverified, to be accepted only for localhost; use https in production.
 *
 * Tokens live ONLY sealed in stores.oauth_sealed. Nothing here returns them across HTTP; stores.token_expires_at
 * (plain, a timestamp) is what the UI shows.
 */
const crypto = require('node:crypto');

const AUTHORIZE_URL = 'https://www.etsy.com/oauth/connect';
const TOKEN_URL = 'https://api.etsy.com/v3/public/oauth/token';
const SCOPES = ['listings_r', 'listings_w', 'transactions_r', 'shops_r'];
const STATE_TTL_MS = 10 * 60 * 1000;
const REFRESH_MARGIN_MS = 120 * 1000;           // refresh this long before the access token expires
const REFRESH_LIFETIME_MS = 90 * 24 * 3600 * 1000;

class EtsyError extends Error {
  constructor(message, code = 'etsy_error', status = 400, extra = {}) { super(message); this.name = 'EtsyError'; this.code = code; this.status = status; Object.assign(this, extra); }
}

const b64url = buf => Buffer.from(buf).toString('base64url');
/** RFC 7636 S256: BASE64URL(SHA256(verifier)), no padding. */
const challengeOf = verifier => b64url(crypto.createHash('sha256').update(verifier).digest());
const newVerifier = (rand = crypto.randomBytes) => b64url(rand(64)); // 64 bytes -> 86 chars, inside 43..128

function makeEtsyAuth({ db, keystore, credentials, http, cfg = {}, log = console, now = Date.now, rand = crypto.randomBytes }) {
  /** The app credentials as Etsy wants them. `etsy_api_key` may be pasted as `key:secret`; both halves are handled. */
  function app() {
    let key = credentials.get('etsy_api_key'); let secret = credentials.get('etsy_shared_secret');
    if (key.includes(':')) { const [k, s] = key.split(':'); key = k; secret = secret || s; }
    const missing = [];
    if (!key) missing.push('etsy_api_key (ETSY_API_KEY)');
    if (!secret) missing.push('etsy_shared_secret (ETSY_SHARED_SECRET)');
    return { keystring: key, secret, header: key && secret ? `${key}:${secret}` : '', redirectUri: cfg.etsyRedirectUri || '', missing };
  }
  function requireApp({ needRedirect = false } = {}) {
    const a = app();
    if (a.missing.length) throw new EtsyError(`No Etsy app credentials: ${a.missing.join(' and ')} not set. Register an Etsy app, then add the keystring and shared secret in Settings (or env). Etsy runs on stubs until then.`, 'no_credentials', 400);
    if (needRedirect && !a.redirectUri) throw new EtsyError('ETSY_REDIRECT_URI is not set. It must exactly match the redirect URI registered on the Etsy app (https://<this host>/api/etsy/callback).', 'no_redirect_uri', 400);
    return a;
  }

  // ---- PKCE + state (server-side, single use, short expiry) ---------------------------------------------
  function start() {
    const a = requireApp({ needRedirect: true });
    const verifier = newVerifier(rand);
    const state = b64url(rand(32));
    const t = now();
    db.prepare('DELETE FROM oauth_pending WHERE expires_at <= ?').run(new Date(t).toISOString());
    db.prepare('INSERT INTO oauth_pending(state, verifier_sealed, created_at, expires_at) VALUES(?,?,?,?)')
      .run(state, keystore.sealJson({ verifier }), new Date(t).toISOString(), new Date(t + STATE_TTL_MS).toISOString());
    const q = new URLSearchParams({ response_type: 'code', client_id: a.keystring, redirect_uri: a.redirectUri, scope: SCOPES.join(' '), state, code_challenge: challengeOf(verifier), code_challenge_method: 'S256' });
    return { url: `${AUTHORIZE_URL}?${q}`, state, expiresAt: new Date(t + STATE_TTL_MS).toISOString(), scopes: SCOPES };
  }
  /** Returns the verifier and burns the state. Unknown, expired and reused states all look the same to the caller. */
  function consume(state) {
    if (!state || typeof state !== 'string') throw new EtsyError('Missing state: this sign-in was not started here.', 'invalid_state', 400);
    db.exec('BEGIN IMMEDIATE');
    let row;
    try {
      row = db.prepare('SELECT * FROM oauth_pending WHERE state = ?').get(state);
      if (row) db.prepare('DELETE FROM oauth_pending WHERE state = ?').run(state);
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch { /* gone */ } throw e; }
    if (!row) throw new EtsyError('Unknown or already used state: start the connection again.', 'invalid_state', 400);
    if (Date.parse(row.expires_at) <= now()) throw new EtsyError('The connection attempt expired (10 minutes): start again.', 'state_expired', 400);
    return keystore.openJson(row.verifier_sealed).verifier;
  }

  // ---- token endpoint ------------------------------------------------------------------------------------
  async function tokenRequest(form) {
    const a = requireApp();
    const body = new URLSearchParams({ client_id: a.keystring, ...form }).toString();
    const res = await http.request(TOKEN_URL, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } });
    const j = res.json();
    if (!j || !j.access_token || !j.refresh_token) throw new EtsyError('Etsy returned no token pair.', 'bad_token_response', 502);
    const expiresIn = Number(j.expires_in) > 0 ? Number(j.expires_in) : 3600;
    return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: now() + expiresIn * 1000, userId: String(j.access_token).split('.')[0] };
  }
  const exchangeCode = ({ code, verifier, redirectUri }) => tokenRequest({ grant_type: 'authorization_code', redirect_uri: redirectUri || app().redirectUri, code, code_verifier: verifier });
  const refreshWith = refreshToken => tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });

  // ---- stored tokens -------------------------------------------------------------------------------------
  const storeRow = id => db.prepare('SELECT * FROM stores WHERE id = ?').get(id);
  function saveTokens(storeId, t) {
    db.prepare('UPDATE stores SET oauth_sealed = ?, token_expires_at = ?, refresh_expires_at = ? WHERE id = ?')
      .run(keystore.sealJson({ access_token: t.accessToken, refresh_token: t.refreshToken }), new Date(t.expiresAt).toISOString(), new Date(now() + REFRESH_LIFETIME_MS).toISOString(), storeId);
  }
  function readTokens(storeId) {
    const r = storeRow(storeId);
    if (!r || !r.oauth_sealed) return null;
    try { const o = keystore.openJson(r.oauth_sealed); return { accessToken: o.access_token, refreshToken: o.refresh_token, expiresAt: Date.parse(r.token_expires_at) || 0 }; } catch { return null; }
  }
  function markDisconnected(storeId, detail) {
    db.prepare("UPDATE stores SET status = 'disconnected', status_detail = ?, oauth_sealed = NULL, token_expires_at = NULL WHERE id = ?").run(detail, storeId);
    log.warn(`[etsy] store ${storeId} marked disconnected: ${detail}`);
  }

  const inflight = new Map();
  /** Single-flight refresh: concurrent callers share one request (the refresh token is single use). */
  function refresh(storeId, { staleAccessToken } = {}) {
    if (inflight.has(storeId)) return inflight.get(storeId);
    const p = (async () => {
      const cur = readTokens(storeId);
      if (!cur) throw new EtsyError('This Etsy store is disconnected. Reconnect it in Settings → Stores.', 'disconnected', 409);
      // Someone else already refreshed while we queued: use that token rather than spending the refresh token again.
      if (staleAccessToken && cur.accessToken !== staleAccessToken && cur.expiresAt - now() > REFRESH_MARGIN_MS) return cur.accessToken;
      try {
        const t = await refreshWith(cur.refreshToken);
        saveTokens(storeId, t); // persist the rotated pair first
        return t.accessToken;
      } catch (e) {
        // A refused refresh token (400/401/403) is final: reconnecting is the only fix. A transient failure is not.
        if (e && [400, 401, 403].includes(e.status)) {
          const detail = 'Etsy refused the saved refresh token (it expired, was revoked or was already used). Reconnect Etsy in Settings → Stores.';
          markDisconnected(storeId, detail);
          throw new EtsyError(detail, 'disconnected', 409);
        }
        throw e;
      }
    })().finally(() => inflight.delete(storeId));
    inflight.set(storeId, p);
    return p;
  }
  /** A usable access token, refreshing first when it is about to expire. */
  async function accessToken(storeId) {
    const cur = readTokens(storeId);
    if (!cur) throw new EtsyError('This Etsy store is disconnected. Reconnect it in Settings → Stores.', 'disconnected', 409);
    if (cur.expiresAt - now() > REFRESH_MARGIN_MS) return cur.accessToken;
    return refresh(storeId);
  }

  const shopIdOf = storeId => { const r = storeRow(storeId); return r && r.shop_id ? r.shop_id : null; };
  /** The one Etsy store that can make API calls (connected, with a shop), or null. */
  const defaultStoreId = () => { const r = db.prepare("SELECT id FROM stores WHERE platform = 'etsy' AND status = 'connected' AND shop_id IS NOT NULL AND oauth_sealed IS NOT NULL ORDER BY id LIMIT 1").get(); return r ? r.id : null; };

  return { shopIdOf, defaultStoreId, app, requireApp, start, consume, exchangeCode, refresh, accessToken, saveTokens, readTokens, markDisconnected, challengeOf, newVerifier, SCOPES, AUTHORIZE_URL, TOKEN_URL, STATE_TTL_MS };
}

module.exports = { makeEtsyAuth, EtsyError, challengeOf, newVerifier, SCOPES, AUTHORIZE_URL, TOKEN_URL, REFRESH_MARGIN_MS };
