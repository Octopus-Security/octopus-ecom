'use strict';
/**
 * credentials.js — decision 4: a credential comes from the keystore (sealed,
 * set in the panel) or, failing that, from env. Env values are never written to
 * the DB. The API only ever sees {present, fp, tail, source}.
 */
const { fingerprint } = require('./crypto');

const ENV_NAMES = {
  openai: 'OPENAI_API_KEY',
  printify: 'PRINTIFY_API_TOKEN',
  etsy_api_key: 'ETSY_API_KEY',
  etsy_shared_secret: 'ETSY_SHARED_SECRET',
};
// Env-only secrets (not keystore-able) that must still be redacted from logs.
const EXTRA_REDACT_ENV = ['LLM_API_KEY', 'ECOM_SECRET'];

function makeCredentials({ keystore, env = process.env, secret }) {
  const fromEnv = name => String(env[ENV_NAMES[name]] || '').trim();
  return {
    names: keystore.names,
    /** SERVER-INTERNAL: the value, or ''. Keystore first, then env. */
    get(name) { return keystore.get(name) || fromEnv(name); },
    has(name) { return Boolean(this.get(name)); },
    /** Safe to return over HTTP. */
    status() {
      const sealed = Object.fromEntries(keystore.list().map(r => [r.name, r]));
      return keystore.names.map(name => {
        if (sealed[name].present) return { name, present: true, fp: sealed[name].fp, tail: sealed[name].tail, source: 'keystore', envVar: ENV_NAMES[name] };
        const v = fromEnv(name);
        if (v) { const { fp, tail } = fingerprint(v, secret); return { name, present: true, fp, tail, source: 'env', envVar: ENV_NAMES[name] }; }
        return { name, present: false, source: null, envVar: ENV_NAMES[name] };
      });
    },
    /** Exact values for the redactor: sealed, plus every credential env var. */
    allValues() {
      const out = [...keystore.allSecrets()];
      for (const e of [...Object.values(ENV_NAMES), ...EXTRA_REDACT_ENV]) if (env[e]) out.push(String(env[e]));
      return out;
    },
  };
}

module.exports = { makeCredentials, ENV_NAMES };
