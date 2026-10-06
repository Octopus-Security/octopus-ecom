'use strict';
/**
 * auth.js — copied from octopus-business's pattern (slug "ecom").
 * sso: @octopus-security/auth-client (optionalDependency, required lazily; its
 *      absence in sso mode is a boot REFUSAL, never a silent "no auth").
 * dev: every request is DEV_USER; config.js refuses this in production and
 *      binds loopback only.
 * Owner gate: a valid estate login is not enough, the username must be in
 * OWNER_USERNAMES. APP_ACCESS_SLUG is an optional second gate that can only
 * take access away; it fails open on an unreachable auth (see octopus-business
 * for the reasoning: the owner gate already passed).
 */
const CACHE_TTL_MS = 60 * 1000;
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function buildAuth(cfg, { ssoFactory, loadAuthClient, fetchImpl, log = console } = {}) {
  let identify;
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const accessCache = new Map();

  async function appAccessAllows(req, user) {
    if (!cfg.appAccessSlug) return true;
    const hit = accessCache.get(user.username);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.allowed;
    const headers = {};
    if (req.get('cookie')) headers.Cookie = req.get('cookie');
    if (req.get('authorization')) headers.Authorization = req.get('authorization');
    try {
      const res = await doFetch(`${cfg.authUrl}/api/auth/apps/${encodeURIComponent(cfg.appAccessSlug)}/allowed`, { headers });
      if (res.status === 404) {
        log.warn(`[auth] APP_ACCESS_SLUG="${cfg.appAccessSlug}" is not an app the auth service knows - the gate is doing nothing.`);
        return true;
      }
      if (!res.ok) throw new Error(`auth answered ${res.status}`);
      const allowed = (await res.json()).allowed !== false;
      accessCache.set(user.username, { allowed, at: Date.now() });
      if (!allowed) log.warn(`[auth] "${user.username}" is an owner but the estate has revoked "${cfg.appAccessSlug}" for them`);
      return allowed;
    } catch (err) {
      log.warn(`[auth] could not check estate app access (${err.message}) - allowing, since the owner gate already passed`);
      return true;
    }
  }

  if (cfg.authMode === 'dev') {
    identify = (req, _res, next) => { req.user = { username: cfg.devUser, role: 'dev' }; next(); };
  } else {
    let factory = ssoFactory;
    if (!factory) {
      try {
        factory = (loadAuthClient || (() => require('@octopus-security/auth-client')))().createSSOMiddleware;
      } catch {
        throw new Error('Refusing to boot: AUTH_MODE=sso but @octopus-security/auth-client is not installed. '
          + 'Build with NPM_TOKEN (see Dockerfile), or use AUTH_MODE=dev locally.');
      }
    }
    identify = factory({
      baseUrl: cfg.authUrl,
      cacheTtlMs: 5 * 60 * 1000,
      onUser: (user) => ({ username: user.username, role: user.role }),
    });
  }

  async function requireOwner(req, res, next) {
    if (!req.user) {
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
      const back = encodeURIComponent(`${req.protocol}://${req.get('host')}${req.originalUrl}`);
      return res.redirect(`${cfg.authPublicUrl}/login?redirect=${back}`);
    }
    const refuse = (message) => (req.path.startsWith('/api/') ? res.status(403).json({ error: message }) : res.status(403).type('text').send(message));
    if (cfg.authMode === 'dev') return next();
    if (!cfg.owners.includes(req.user.username)) return refuse('You are signed in, but this console belongs to someone else.');
    if (!(await appAccessAllows(req, req.user))) return refuse('Your access to this app has been turned off. Ask the estate administrator.');
    return next();
  }

  // What /api/build reports as `gate`: the slug requireOwner actually checks
  // (null when none is set, or in dev mode, which skips every gate).
  const gateSlug = cfg.authMode === 'dev' ? null : (cfg.appAccessSlug || null);

  return { identify, requireOwner: wrap(requireOwner), gateSlug };
}

/** Same-origin check for state-changing requests (CSRF defence independent of cookie flags). */
function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin') || req.get('referer');
  if (!origin) return next(); // non-browser client; the session is still required
  try { if (new URL(origin).host === req.get('host')) return next(); } catch { /* fall through */ }
  return res.status(403).send('Cross-origin request refused');
}

module.exports = { buildAuth, sameOrigin, wrap };
