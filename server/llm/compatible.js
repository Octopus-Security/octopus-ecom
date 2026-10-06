'use strict';
/**
 * OpenAI-compatible endpoint: LLM_BASE_URL (must include the version path, e.g. https://host/v1)
 * + optional LLM_API_KEY. Covers a router's /v1 shim or any local server without importing it.
 * With no router table and no LLM_MODEL_<TIER> there is no model name we can safely guess for
 * someone else's server, so the built-in OpenAI names are used as a last resort only.
 */
const { createChat } = require('./chat');
const { DEFAULT_TIERS } = require('./pricing');

function createCompatible({ http, baseUrl, apiKey, tiers, overrides, price, spend, log }) {
  if (!baseUrl) throw new Error('LLM_BASE_URL is required for openai-compatible');
  return createChat({ http, baseUrl, getKey: () => apiKey, tiers, defaults: DEFAULT_TIERS, overrides, price, spend, name: 'llm.openai-compatible', log });
}
module.exports = { createCompatible };
