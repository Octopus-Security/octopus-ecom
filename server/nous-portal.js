'use strict';
/**
 * nous-portal.js — the FAL image gateway wants a Nous Portal OAuth access token,
 * sent as Authorization: Key. The chat inference key (NOUS_API_KEY on the
 * inference API, usually an sk- key) is a different credential. A live Generate
 * on 2026-11-13 returned HTTP 401 with that key. No generation was repeated.
 *
 * Hermes (hermes_cli/auth_nous.py, read 2026-11-13) logs in with the public
 * device-code client id "hermes-cli" and refreshes at
 * POST https://portal.nousresearch.com/api/oauth/token
 * with header x-nous-refresh-token. Refresh tokens are single-use. This shop
 * keeps its own login. It does not read ~/.hermes/auth.json, because refreshing
 * Hermes's token here would revoke that session.
 *
 * A pasted value is accepted only when it is an unexpired access JWT. Anything
 * else is the chat key and is refused before any gateway call.
 */
const PORTAL_ORIGIN = 'https://portal.nousresearch.com';
const CLIENT_ID = 'hermes-cli';
const SKEW_SECONDS = 120;

const CHAT_KEY_ERROR = 'The saved nous value is the chat inference key. The image gateway does not accept it. In Settings, Credentials, use Sign in to Nous Portal. That login is separate from the chat key.';

let chain = Promise.resolve();
function locked(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});
  return run;
}

function looksLikeJwt(value) {
  const parts = String(value || '').split('.');
  if (parts.length !== 3 || !parts[0].startsWith('eyJ')) return false;
  return parts.every((p) => p.length > 0 && /^[A-Za-z0-9_-]+$/.test(p));
}

function jwtExp(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch { return null; }
}

function parseStored(raw) {
  const s = String(raw || '').trim();
  if (!s) return { kind: 'missing' };
  if (s.startsWith('{')) {
    try {
      const o = JSON.parse(s);
      if (o && o.v === 1 && typeof o.refresh_token === 'string' && o.refresh_token && typeof o.access_token === 'string' && o.access_token) {
        return { kind: 'session', access_token: o.access_token, refresh_token: o.refresh_token, expires_at: typeof o.expires_at === 'string' ? o.expires_at : '' };
      }
    } catch { /* not a session */ }
  }
  if (looksLikeJwt(s)) return { kind: 'jwt', access_token: s };
  return { kind: 'api_key' };
}

function stillValid(token, expiresAtIso, nowSec) {
  const exp = jwtExp(token);
  const fromIso = expiresAtIso ? Date.parse(expiresAtIso) / 1000 : NaN;
  const when = exp != null ? exp : (Number.isFinite(fromIso) ? fromIso : null);
  if (when == null) return looksLikeJwt(token);
  return when > nowSec + SKEW_SECONDS;
}

/** Error string when a pasted credential must be refused, or '' when it may be stored. */
function pasteError(value) {
  const parsed = parseStored(value);
  if (parsed.kind === 'jwt') {
    if (!stillValid(parsed.access_token, '', Math.floor(Date.now() / 1000))) {
      return 'That Nous Portal token has expired. In Settings, Credentials, use Sign in to Nous Portal.';
    }
    return '';
  }
  return CHAT_KEY_ERROR;
}

function portalUrlOk(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'portal.nousresearch.com';
  } catch { return false; }
}

function statusError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function portalPost(http, path, { form, headers }) {
  let res;
  try {
    res = await http.request(`${PORTAL_ORIGIN}${path}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', ...(headers || {}) },
      body: new URLSearchParams(form).toString(),
      redirect: 'manual',
      timeoutMs: 20000,
      maxRetries: 0,
    });
  } catch (e) {
    let payload = null;
    try { payload = JSON.parse(e.body || ''); } catch { /* HTML or empty */ }
    if (payload && payload.error) {
      const err = new Error(String(payload.error_description || payload.error));
      err.oauth = String(payload.error);
      err.status = e.status || 400;
      throw err;
    }
    if (e.status === 403 || e.status === 429) throw statusError('Nous Portal blocked this request from the shop server. Try again in a minute.', 400);
    throw statusError('Could not reach Nous Portal.', 400);
  }
  try { return res.json(); } catch { throw statusError('Nous Portal returned a non-JSON response.', 400); }
}

function envelope(accessToken, refreshToken, expiresIn) {
  const ttl = Number(expiresIn) > 0 ? Number(expiresIn) : 3600;
  return JSON.stringify({
    v: 1,
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
  });
}

/**
 * The Key the image gateway will accept. Re-reads inside a process lock so two
 * Generates share one refresh. The rotated refresh token is stored before the
 * access token is returned.
 */
async function gatewayAccessToken({ read, http, save, forget, now = () => Math.floor(Date.now() / 1000) } = {}) {
  return locked(async () => {
    const parsed = parseStored(read());
    if (parsed.kind === 'missing') {
      throw new Error('Image provider "nous" is selected but no Nous sign-in is stored. In Settings, Credentials, use Sign in to Nous Portal (or set NOUS_API_KEY to a Portal access token).');
    }
    if (parsed.kind === 'api_key') throw new Error(CHAT_KEY_ERROR);
    if (parsed.kind === 'jwt') {
      if (!stillValid(parsed.access_token, '', now())) {
        throw new Error('The pasted Nous Portal token has expired. In Settings, Credentials, use Sign in to Nous Portal.');
      }
      return parsed.access_token;
    }
    if (stillValid(parsed.access_token, parsed.expires_at, now())) return parsed.access_token;
    let refreshed;
    try {
      refreshed = await portalPost(http, '/api/oauth/token', {
        form: { grant_type: 'refresh_token', client_id: CLIENT_ID },
        headers: { 'x-nous-refresh-token': parsed.refresh_token },
      });
    } catch (e) {
      if (e.oauth === 'invalid_grant' || e.oauth === 'refresh_token_reused') {
        if (forget) forget();
        throw new Error('Nous Portal sign-in expired. In Settings, Credentials, use Sign in to Nous Portal again.');
      }
      throw e.oauth ? statusError('Nous Portal did not refresh the sign-in. Try again, or sign in under Settings, Credentials.', 400) : e;
    }
    const access = refreshed && refreshed.access_token;
    const refresh = (refreshed && refreshed.refresh_token) || parsed.refresh_token;
    if (typeof access !== 'string' || !access || typeof refresh !== 'string' || !refresh) {
      throw new Error('Nous Portal refresh returned no access token. Sign in again under Settings, Credentials.');
    }
    const stored = envelope(access, refresh, refreshed.expires_in);
    try {
      if (!save) throw new Error('no store');
      save(stored);
    } catch {
      if (forget) forget();
      throw new Error('Nous Portal rotated the sign-in and this shop could not store the new token. Sign in again under Settings, Credentials.');
    }
    return access;
  });
}

function makeNousLogin({ http, keystore, now = Date.now } = {}) {
  let pending = null;
  return {
    async start() {
      const data = await portalPost(http, '/api/oauth/device/code', {
        form: { client_id: CLIENT_ID, scope: 'inference:invoke' },
      });
      const deviceCode = data && data.device_code;
      const userCode = data && data.user_code;
      const verify = (data && (data.verification_uri_complete || data.verification_uri)) || '';
      const expiresIn = Number(data && data.expires_in) > 0 ? Number(data.expires_in) : 600;
      const interval = Math.max(5, Number(data && data.interval) || 5);
      if (typeof deviceCode !== 'string' || !deviceCode || typeof userCode !== 'string' || !userCode || !portalUrlOk(verify)) {
        throw statusError('Nous Portal did not return a sign-in code.', 400);
      }
      pending = { deviceCode, interval, deadline: now() + expiresIn * 1000 };
      return { userCode, verificationUrl: verify, expiresIn, interval };
    },
    async poll() {
      if (!pending) throw statusError('Start sign-in first.', 400);
      if (now() > pending.deadline) { pending = null; throw statusError('That sign-in code expired. Start again.', 400); }
      let data;
      try {
        data = await portalPost(http, '/api/oauth/token', {
          form: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: CLIENT_ID, device_code: pending.deviceCode },
        });
      } catch (e) {
        if (e.oauth === 'authorization_pending' || e.oauth === 'slow_down') {
          const interval = e.oauth === 'slow_down' ? Math.max(5, pending.interval + 5) : pending.interval;
          pending = { ...pending, interval };
          return { pending: true, interval };
        }
        pending = null;
        if (e.oauth === 'access_denied') throw statusError('Nous Portal sign-in was denied.', 400);
        if (e.oauth === 'expired_token') throw statusError('That sign-in code expired. Start again.', 400);
        throw e.oauth ? statusError('Nous Portal did not finish sign-in. Start again.', 400) : e;
      }
      const access = data && data.access_token;
      const refresh = data && data.refresh_token;
      if (typeof access !== 'string' || !access || typeof refresh !== 'string' || !refresh) {
        pending = null;
        throw statusError('Nous Portal sign-in returned no token. Start again.', 400);
      }
      const saved = keystore.set('nous', envelope(access, refresh, data.expires_in));
      pending = null;
      return { ok: true, name: 'nous', present: true, fp: saved.fp, tail: saved.tail, source: 'keystore' };
    },
  };
}

module.exports = {
  PORTAL_ORIGIN, CLIENT_ID, CHAT_KEY_ERROR, looksLikeJwt, parseStored, pasteError, gatewayAccessToken, makeNousLogin,
};
