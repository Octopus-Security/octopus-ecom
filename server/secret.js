'use strict';
/**
 * secret.js — where ECOM_SECRET comes from.
 * Production: the env var, validated by config.js. Dev with none set: generate
 * a random one into DATA_DIR/.dev-secret (0600), warn once, reuse it later.
 * Never a hardcoded default.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function resolveSecret(cfg, warn = console.warn) {
  if (cfg.ecomSecret) return { secret: cfg.ecomSecret, source: 'env' };
  if (cfg.production) throw new Error('Refusing to boot: ECOM_SECRET is required in production.');
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const file = path.join(cfg.dataDir, '.dev-secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 16) return { secret: existing, source: 'dev-file' };
  } catch { /* none yet */ }
  const secret = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(file, secret + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  warn(`[secret] WARNING: ECOM_SECRET is not set. Generated a development secret at ${file} (mode 0600). `
    + 'Fine for local use; set ECOM_SECRET explicitly anywhere real credentials live.');
  return { secret, source: 'dev-file-generated' };
}

module.exports = { resolveSecret };
