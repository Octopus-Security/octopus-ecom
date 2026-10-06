'use strict';
/**
 * llm/index.js — complete({system, prompt, tier, json}) -> {text, model, costCents}.
 * Providers: stub (default), openai (BYOK), openai-compatible (LLM_BASE_URL + optional LLM_API_KEY),
 * cortex (INTERNAL_SECRET set, or LLM_PROVIDER=cortex: billed by cortex to the signed-in user, never counted against the daily cap).
 * Auto-selection order when LLM_PROVIDER is unset: cortex (secret set) > openai (key) > openai-compatible > stub.
 * The provider is resolved PER CALL, so a key saved in the panel takes effect without a restart.
 * The daily cap is checked inside the real providers BEFORE each call; the caller records costCents.
 * Model per tier: LLM_MODEL_<TIER> > ROUTER_PATH table (read-only) > built-in defaults (pricing.js).
 */
const { loadRouterTiers } = require('./router-path');
const { createStub } = require('./stub');
const { createOpenAi } = require('./openai');
const { createCompatible } = require('./compatible');
const { createCortex } = require('./cortex');

const TIERS = ['cheap', 'standard', 'deep'];

function makeLlm({ cfg, credentials, http, spend, log = console, requireFn = require, env = process.env, fetchImpl }) {
  const routing = loadRouterTiers({ routerPath: cfg.llm.routerPath, requireFn, log });
  const overrides = Object.fromEntries(Object.entries(cfg.llm.models || {}).filter(([, v]) => v));
  const stub = createStub();
  const cache = {};
  const build = {
    openai: () => createOpenAi({ http, credentials, tiers: routing.tiers, overrides, spend, log }),
    'openai-compatible': () => createCompatible({ http, baseUrl: cfg.llm.baseUrl, apiKey: env.LLM_API_KEY || '', tiers: routing.tiers, overrides, price: { priceInPerM: cfg.llm.priceInPerM, priceOutPerM: cfg.llm.priceOutPerM }, spend, log }),
    cortex: () => createCortex({ url: cfg.llm.cortex && cfg.llm.cortex.url, secret: cfg.llm.cortex && cfg.llm.cortex.secret, fallbackUser: (cfg.owners && cfg.owners[0]) || cfg.devUser, fetchImpl, log }),
  };
  const hasCortex = () => Boolean(cfg.llm.cortex && cfg.llm.cortex.secret);
  let lastNote;

  function resolve() {
    const wanted = cfg.llm.provider || (hasCortex() ? 'cortex' : credentials.has('openai') ? 'openai' : cfg.llm.baseUrl ? 'openai-compatible' : 'stub');
    let name = wanted; let note = null;
    if (name !== 'stub' && !build[name]) { note = `unknown LLM_PROVIDER "${name}"`; name = 'stub'; }
    else if (name === 'openai' && !credentials.has('openai')) { note = 'openai selected but no key'; name = 'stub'; }
    else if (name === 'cortex' && !hasCortex()) { note = 'cortex selected but INTERNAL_SECRET is unset'; name = 'stub'; }
    else if (name === 'openai-compatible' && !cfg.llm.baseUrl) { note = 'openai-compatible selected but LLM_BASE_URL is unset'; name = 'stub'; }
    if (note !== lastNote || lastNote === undefined) { lastNote = note; log.info(note ? `[llm] ${note}; using the stub provider` : `[llm] provider: ${name}`); }
    const impl = name === 'stub' ? stub : (cache[name] || (cache[name] = build[name]()));
    return { name, wanted, note, impl };
  }
  resolve(); // log the path taken at boot

  return {
    async complete({ system = '', prompt, tier = 'cheap', json = false, user }) {
      if (!TIERS.includes(tier)) throw new Error(`Unknown tier "${tier}"`);
      if (typeof prompt !== 'string' || !prompt) throw new Error('prompt is required');
      const { impl } = resolve();
      return impl.complete({ system, prompt, tier, json, user, model: routing.tiers && routing.tiers[tier] ? routing.tiers[tier].model : undefined });
    },
    /**
     * Multi-turn chat for the planning tab: {system, messages, tier, user, onStart, onText}.
     * Only cortex (billed to the user, streams) and the offline stub answer; a BYOK/compatible
     * provider is refused rather than spending the shop's own key on an open-ended conversation.
     */
    async chat({ system = '', messages, tier = 'standard', user, onStart, onText }) {
      if (!TIERS.includes(tier)) throw new Error(`Unknown tier "${tier}"`);
      if (!Array.isArray(messages) || !messages.length) throw new Error('messages are required');
      const { name, impl } = resolve();
      if (name === 'cortex') return impl.chat({ system, messages, tier, user, onStart, onText });
      if (name === 'stub') {
        const last = messages[messages.length - 1].content;
        const text = `[stub ${tier}] No model is connected (set INTERNAL_SECRET to use cortex). You said: ${String(last).slice(0, 120)}`;
        if (onStart) onStart();
        if (onText) onText(text);
        return { text, model: 'stub-llm', funding: null };
      }
      const e = new Error('The planning chat runs through cortex only. Set INTERNAL_SECRET (and CORTEX_URL) to enable it.');
      e.status = 503; e.code = 'chat_needs_cortex';
      throw e;
    },
    describe() { const r = resolve(); return { provider: r.name, requested: r.wanted, note: r.note, routing: { path: routing.path, reason: routing.reason } }; },
  };
}

module.exports = { makeLlm, TIERS };
