'use strict';
// TODO(M1): OpenAI-compatible endpoint (LLM_BASE_URL + optional LLM_API_KEY). Covers a router's /v1
// shim or any local server without importing it. API shape: assumed, unverified.
function createCompatible(/* { http, baseUrl, apiKey, tiers, log } */) {
  return { implemented: false, async complete() { throw new Error('llm.openai-compatible is not implemented yet (M1)'); } };
}
module.exports = { createCompatible };
