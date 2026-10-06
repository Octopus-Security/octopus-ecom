'use strict';
/**
 * confirm.js — the two-step gate for irreversible actions (decision 6).
 *
 *   check({action, subject, summary}, token?)
 *     no token -> { needsConfirm: true, token, summary, expiresAt }   (nothing executed)
 *     token    -> { ok: true }   and the token is burned (single use, 5 min)
 *
 * A token is bound to its action AND subject, so a token issued to "delete the
 * openai credential" cannot confirm "disarm DRY_RUN". Anything wrong with a
 * presented token throws ConfirmError (HTTP layer maps it to 409): it never
 * silently re-issues, so a stale UI cannot accidentally confirm.
 */
const crypto = require('node:crypto');

const TTL_MS = 5 * 60 * 1000;

class ConfirmError extends Error {
  constructor(message, code) { super(message); this.name = 'ConfirmError'; this.code = code; }
}

function makeConfirm({ now = Date.now, ttlMs = TTL_MS } = {}) {
  const pending = new Map();
  const sweep = () => { for (const [t, v] of pending) if (v.exp <= now()) pending.delete(t); };
  return {
    check({ action, subject = '', summary }, token) {
      sweep();
      if (!token) {
        const t = crypto.randomBytes(24).toString('base64url');
        const exp = now() + ttlMs;
        pending.set(t, { action, subject: String(subject), exp });
        return { needsConfirm: true, token: t, summary, expiresAt: new Date(exp).toISOString() };
      }
      const p = pending.get(token);
      if (!p) throw new ConfirmError('Confirmation token is unknown, expired or already used.', 'bad_token');
      pending.delete(token); // single use, even on mismatch
      if (p.exp <= now()) throw new ConfirmError('Confirmation token expired.', 'expired');
      if (p.action !== action || p.subject !== String(subject)) throw new ConfirmError('Confirmation token was issued for a different action.', 'mismatch');
      return { ok: true };
    },
    pendingCount: () => { sweep(); return pending.size; },
  };
}

module.exports = { makeConfirm, ConfirmError, TTL_MS };
