'use strict';
/**
 * llm/index.js — complete({system, prompt, tier, json}) -> {text, model, costCents}.
 * Providers: stub (default), openai, openai-compatible. The real two are M1 scaffolds
 * (implemented:false), so in M0 anything selected falls back to the stub with a log line.
 */
const { loadRouterTiers } = require('./router-path');
const { createStub } = require('./stub');
const { createOpenAi } = require('./openai');
const { createCompatible } = require('./compatible');

const TIERS = ['cheap', 'standard', 'deep'];

function makeLlm({ cfg, credentials, http, log = console, requireFn = require, env = process.env }) {
  const routing = loadRouterTiers({ routerPath: cfg.llm.routerPath, requireFn, log });
  const wanted = cfg.llm.provider || (credentials.has('openai') ? 'openai' : cfg.llm.baseUrl ? 'openai-compatible' : 'stub');
  const candidates = {
    stub: () => createStub(),
    openai: () => createOpenAi({ http, credentials, tiers: routing.tiers, log }),
    'openai-compatible': () => createCompatible({ http, baseUrl: cfg.llm.baseUrl, apiKey: env.LLM_API_KEY || '', tiers: routing.tiers, log }),
  };
  let name = wanted;
  let impl = (candidates[name] || candidates.stub)();
  let note = null;
  if (!candidates[name]) { note = `unknown LLM_PROVIDER "${name}"`; name = 'stub'; impl = candidates.stub(); }
  else if (!impl.implemented) { note = `${name} is not implemented yet (M1)`; name = 'stub'; impl = candidates.stub(); }
  else if (name === 'openai' && !credentials.has('openai')) { note = 'openai selected but no key'; name = 'stub'; impl = candidates.stub(); }
  if (note) log.info(`[llm] ${note}; using the stub provider`);
  else log.info(`[llm] provider: ${name}`);

  return {
    async complete({ system = '', prompt, tier = 'cheap', json = false }) {
      if (!TIERS.includes(tier)) throw new Error(`Unknown tier "${tier}"`);
      if (typeof prompt !== 'string' || !prompt) throw new Error('prompt is required');
      return impl.complete({ system, prompt, tier, json, model: routing.tiers && routing.tiers[tier] ? routing.tiers[tier].model : undefined });
    },
    describe: () => ({ provider: name, requested: wanted, note, routing: { path: routing.path, reason: routing.reason } }),
  };
}

module.exports = { makeLlm, TIERS };
