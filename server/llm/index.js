'use strict';
/**
 * llm/index.js — complete({system, prompt, tier, json}) -> {text, model, costCents}.
 * Providers: stub (default), openai (BYOK), openai-compatible (LLM_BASE_URL + optional LLM_API_KEY).
 * The provider is resolved PER CALL, so a key saved in the panel takes effect without a restart.
 * The daily cap is checked inside the real providers BEFORE each call; the caller records costCents.
 * Model per tier: LLM_MODEL_<TIER> > ROUTER_PATH table (read-only) > built-in defaults (pricing.js).
 */
const { loadRouterTiers } = require('./router-path');
const { createStub } = require('./stub');
const { createOpenAi } = require('./openai');
const { createCompatible } = require('./compatible');

const TIERS = ['cheap', 'standard', 'deep'];

function makeLlm({ cfg, credentials, http, spend, log = console, requireFn = require, env = process.env }) {
  const routing = loadRouterTiers({ routerPath: cfg.llm.routerPath, requireFn, log });
  const overrides = Object.fromEntries(Object.entries(cfg.llm.models || {}).filter(([, v]) => v));
  const stub = createStub();
  const cache = {};
  const build = {
    openai: () => createOpenAi({ http, credentials, tiers: routing.tiers, overrides, spend, log }),
    'openai-compatible': () => createCompatible({ http, baseUrl: cfg.llm.baseUrl, apiKey: env.LLM_API_KEY || '', tiers: routing.tiers, overrides, price: { priceInPerM: cfg.llm.priceInPerM, priceOutPerM: cfg.llm.priceOutPerM }, spend, log }),
  };
  let lastNote;

  function resolve() {
    const wanted = cfg.llm.provider || (credentials.has('openai') ? 'openai' : cfg.llm.baseUrl ? 'openai-compatible' : 'stub');
    let name = wanted; let note = null;
    if (name !== 'stub' && !build[name]) { note = `unknown LLM_PROVIDER "${name}"`; name = 'stub'; }
    else if (name === 'openai' && !credentials.has('openai')) { note = 'openai selected but no key'; name = 'stub'; }
    else if (name === 'openai-compatible' && !cfg.llm.baseUrl) { note = 'openai-compatible selected but LLM_BASE_URL is unset'; name = 'stub'; }
    if (note !== lastNote || lastNote === undefined) { lastNote = note; log.info(note ? `[llm] ${note}; using the stub provider` : `[llm] provider: ${name}`); }
    const impl = name === 'stub' ? stub : (cache[name] || (cache[name] = build[name]()));
    return { name, wanted, note, impl };
  }
  resolve(); // log the path taken at boot

  return {
    async complete({ system = '', prompt, tier = 'cheap', json = false }) {
      if (!TIERS.includes(tier)) throw new Error(`Unknown tier "${tier}"`);
      if (typeof prompt !== 'string' || !prompt) throw new Error('prompt is required');
      const { impl } = resolve();
      return impl.complete({ system, prompt, tier, json, model: routing.tiers && routing.tiers[tier] ? routing.tiers[tier].model : undefined });
    },
    describe() { const r = resolve(); return { provider: r.name, requested: r.wanted, note: r.note, routing: { path: routing.path, reason: routing.reason } }; },
  };
}

module.exports = { makeLlm, TIERS };
