'use strict';
/**
 * config.js — reads the environment once and refuses to boot on a bad one.
 * Pure: no filesystem. ECOM_SECRET resolution (which may read/write the dev
 * secret file) lives in secret.js.
 */
const path = require('node:path');

const OFF = new Set(['false', '0', 'off']);

function dollarsToCents(v, fallback, name, errors) {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) { errors.push(`${name} must be a non-negative number of dollars, got "${v}".`); return fallback; }
  return Math.round(n * 100);
}

function loadConfig(env = process.env) {
  const errors = [];
  const nodeEnv = env.NODE_ENV || 'development';
  const production = nodeEnv === 'production';
  const authMode = (env.AUTH_MODE || (production ? 'sso' : 'dev')).toLowerCase();
  const owners = (env.OWNER_USERNAMES || '').split(',').map(s => s.trim()).filter(Boolean);

  if (!['sso', 'dev'].includes(authMode)) errors.push(`AUTH_MODE must be "sso" or "dev", got "${authMode}".`);
  if (authMode === 'dev' && production) errors.push('AUTH_MODE=dev is refused when NODE_ENV=production: it would let anyone in unauthenticated.');
  if (authMode === 'sso' && owners.length === 0) errors.push('OWNER_USERNAMES is empty: in sso mode every estate account would count as the owner.');
  if (production) {
    const s = env.ECOM_SECRET || '';
    if (s.length < 16) errors.push('ECOM_SECRET is required in production (>=16 chars): it seals every stored credential.');
  } else if (env.ECOM_SECRET && env.ECOM_SECRET.length < 16) {
    errors.push('ECOM_SECRET is set but shorter than 16 chars.');
  }

  const port = env.PORT === undefined || env.PORT === '' ? 3050 : Number(env.PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) errors.push(`PORT must be 0-65535, got "${env.PORT}".`);

  const dailySpendCapCents = dollarsToCents(env.DAILY_SPEND_CAP, 500, 'DAILY_SPEND_CAP', errors);
  const marginFloorCents = dollarsToCents(env.MARGIN_FLOOR, 200, 'MARGIN_FLOOR', errors);

  // M4: print-readiness rule and batch limits. Bad values refuse to boot rather than silently weakening a safety check.
  const minCov = env.PRINT_MIN_COVERAGE === undefined || env.PRINT_MIN_COVERAGE === '' ? 1 : Number(env.PRINT_MIN_COVERAGE);
  if (!(minCov >= 0.1 && minCov <= 1)) errors.push(`PRINT_MIN_COVERAGE must be a number from 0.1 to 1 (1 = both print-area dimensions must be met), got "${env.PRINT_MIN_COVERAGE}".`);
  const printFit = (env.PRINT_FIT || 'cover').trim().toLowerCase();
  if (!['cover', 'contain'].includes(printFit)) errors.push(`PRINT_FIT must be "cover" or "contain", got "${env.PRINT_FIT}".`);
  const intIn = (name, def, lo, hi) => {
    if (env[name] === undefined || env[name] === '') return def;
    const n = Number(env[name]);
    if (!Number.isInteger(n) || n < lo || n > hi) { errors.push(`${name} must be an integer from ${lo} to ${hi}, got "${env[name]}".`); return def; }
    return n;
  };
  const batch = { concurrency: intIn('BATCH_CONCURRENCY', 1, 1, 2), maxCount: intIn('BATCH_MAX_COUNT', 25, 1, 100) };
  const refundLookbackDays = intIn('REFUND_LOOKBACK_DAYS', 30, 0, 365);

  if (errors.length) {
    const err = new Error('Refusing to boot:\n  - ' + errors.join('\n  - '));
    err.bootErrors = errors;
    throw err;
  }

  return {
    nodeEnv,
    production,
    authMode,
    owners,
    devUser: env.DEV_USER || 'owner',
    authUrl: env.AUTH_SERVICE_URL || 'http://octopus-auth:3002',
    authPublicUrl: env.AUTH_PUBLIC_URL || 'https://auth.octopustechnology.net',
    appAccessSlug: (env.APP_ACCESS_SLUG || '').trim(),
    port,
    // Dev mode is never reachable from another machine.
    host: authMode === 'dev' ? '127.0.0.1' : '0.0.0.0',
    dataDir: env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(__dirname, '..', 'data'),
    ecomSecret: env.ECOM_SECRET || '',
    // Seeds only: the settings table owns these after first boot.
    seed: {
      dryRun: !OFF.has(String(env.DRY_RUN === undefined ? 'true' : env.DRY_RUN).trim().toLowerCase()),
      dailySpendCapCents,
      marginFloorCents,
    },
    etsyRedirectUri: env.ETSY_REDIRECT_URI || '',
    print: { minCoverage: Number.isFinite(minCov) ? minCov : 1, fit: printFit },
    batch,
    refundLookbackDays,
    llm: {
      provider: (env.LLM_PROVIDER || '').trim().toLowerCase(),
      baseUrl: (env.LLM_BASE_URL || '').trim(),
      routerPath: (env.ROUTER_PATH || '').trim(),
      // Optional per-tier model overrides (win over the router table and the built-in defaults).
      models: { cheap: (env.LLM_MODEL_CHEAP || '').trim(), standard: (env.LLM_MODEL_STANDARD || '').trim(), deep: (env.LLM_MODEL_DEEP || '').trim() },
      // Optional price for models the built-in table does not know, in dollars per 1M tokens.
      priceInPerM: env.LLM_PRICE_IN_PER_M === undefined || env.LLM_PRICE_IN_PER_M === '' ? null : Number(env.LLM_PRICE_IN_PER_M),
      priceOutPerM: env.LLM_PRICE_OUT_PER_M === undefined || env.LLM_PRICE_OUT_PER_M === '' ? null : Number(env.LLM_PRICE_OUT_PER_M),
    },
    image: {
      model: (env.IMAGE_MODEL || 'gpt-image-1').trim(),
      quality: (env.IMAGE_QUALITY || 'high').trim().toLowerCase(),
      upscale: !OFF.has(String(env.IMAGE_UPSCALE === undefined ? 'true' : env.IMAGE_UPSCALE).trim().toLowerCase()),
    },
  };
}

module.exports = { loadConfig };
