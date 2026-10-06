'use strict';
/**
 * keystore.js — sealed credentials. Only {fp, tail} ever leave the server; get()
 * and allSecrets() are SERVER-INTERNAL and must not cross an HTTP boundary.
 * Per-store OAuth tokens are sealed in stores.oauth_sealed (see sealJson/openJson).
 */
const { seal, open, fingerprint } = require('./crypto');

const KEY_NAMES = ['openai', 'printify', 'etsy_api_key', 'etsy_shared_secret'];

function makeKeystore(db, secret) {
  return {
    names: KEY_NAMES,
    /** Safe metadata for every nameable key; never values. */
    list() {
      const have = Object.fromEntries(db.prepare('SELECT name, fp, tail, added_at FROM keys').all().map(r => [r.name, r]));
      return KEY_NAMES.map(name => ({ name, present: Boolean(have[name]), ...(have[name] ? { fp: have[name].fp, tail: have[name].tail, addedAt: have[name].added_at } : {}) }));
    },
    set(name, value) {
      if (!KEY_NAMES.includes(name)) throw new Error(`Cannot hold a credential named ${name}`);
      const v = String(value || '').trim();
      if (!v) throw new Error('Empty credential');
      const { fp, tail } = fingerprint(v, secret);
      db.prepare(`INSERT INTO keys(name,sealed,fp,tail,added_at) VALUES(?,?,?,?,?)
                  ON CONFLICT(name) DO UPDATE SET sealed=excluded.sealed, fp=excluded.fp, tail=excluded.tail, added_at=excluded.added_at`)
        .run(name, seal(v, secret), fp, tail, new Date().toISOString());
      return { name, fp, tail };
    },
    remove(name) { return db.prepare('DELETE FROM keys WHERE name = ?').run(name).changes > 0; },
    /** SERVER-INTERNAL. Decrypted value or '' (an unopenable row is treated as absent). */
    get(name) {
      const r = db.prepare('SELECT sealed FROM keys WHERE name = ?').get(name);
      if (!r) return '';
      try { return open(r.sealed, secret); } catch { return ''; }
    },
    /** SERVER-INTERNAL. Every decrypted value, for the redactor only. */
    allSecrets() {
      const out = [];
      for (const r of db.prepare('SELECT sealed FROM keys').all()) { try { out.push(open(r.sealed, secret)); } catch { /* nothing to redact */ } }
      for (const r of db.prepare('SELECT oauth_sealed FROM stores WHERE oauth_sealed IS NOT NULL').all()) {
        try { const o = JSON.parse(open(r.oauth_sealed, secret)); for (const v of Object.values(o)) if (typeof v === 'string') out.push(v); } catch { /* skip */ }
      }
      return out;
    },
    sealJson: obj => seal(JSON.stringify(obj), secret),
    openJson: s => JSON.parse(open(s, secret)),
  };
}

module.exports = { makeKeystore, KEY_NAMES };
