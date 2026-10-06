'use strict';
/**
 * crypto.js — credentials are sealed with AES-256-GCM before they touch disk.
 * Pattern lifted from octopus-router's keystore (same design, own secret and salt).
 *
 * There is deliberately NO default secret: a default would mean every install
 * shares one key and "encrypted at rest" would be theatre. deriveKey throws when
 * the secret is missing or short; index.js turns that into a boot refusal.
 * GCM authenticates as well as encrypts, so a tampered ciphertext fails to open
 * rather than decrypting to rubbish that is then sent to a provider as a key.
 */
const crypto = require('node:crypto');

const ALGO = 'aes-256-gcm';
const SALT = 'octopus-ecom.keystore.v1';
const MIN_SECRET = 16;
const keyCache = new Map();

function deriveKey(secret = process.env.ECOM_SECRET) {
  if (!secret || String(secret).length < MIN_SECRET) {
    throw new Error(`ECOM_SECRET is missing or too short (need >=${MIN_SECRET} chars) - refusing to run a keystore encrypted with nothing`);
  }
  const s = String(secret);
  // Fixed salt on purpose: the same secret must derive the same key across
  // restarts or nothing already stored could be opened. The secret is the secret.
  if (!keyCache.has(s)) keyCache.set(s, crypto.scryptSync(s, SALT, 32));
  return keyCache.get(s);
}

/** Seal a string -> compact `v1.iv.tag.ciphertext`, base64url parts. */
function seal(plaintext, secret) {
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

/** Open a sealed string. Throws on tampering or a wrong secret. */
function open(sealed, secret) {
  const [v, ivB, tagB, ctB] = String(sealed).split('.');
  if (v !== 'v1' || !ivB || !tagB || !ctB) throw new Error('Not a sealed value');
  const d = crypto.createDecipheriv(ALGO, deriveKey(secret), Buffer.from(ivB, 'base64url'));
  d.setAuthTag(Buffer.from(tagB, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ctB, 'base64url')), d.final()]).toString('utf8');
}

/** Stable non-reversible fingerprint + last 4 chars: safe to show and log. */
function fingerprint(plaintext, secret) {
  const mac = crypto.createHmac('sha256', deriveKey(secret)).update(String(plaintext)).digest('hex');
  return { fp: mac.slice(0, 12), tail: String(plaintext).slice(-4) };
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

module.exports = { seal, open, fingerprint, deriveKey, safeEqual, MIN_SECRET };
