'use strict';
/**
 * llm/chat.js — one OpenAI-style chat-completions client, shared by the `openai`
 * and `openai-compatible` providers (they differ only in base URL and key).
 *
 * POST {base}/chat/completions { model, messages, max_tokens?, response_format? }
 *   -> { choices: [{ message: { content } }], usage: { prompt_tokens, completion_tokens } }
 * API shape: assumed, unverified (the pricing page was read, the chat API reference was not).
 * `max_tokens` is sent (widely accepted by compatible servers); newer OpenAI models that only
 * accept max_completion_tokens would answer 400, which surfaces as a failed product with the
 * reason, not a crash. JSON mode is requested with response_format {type:'json_object'} and the
 * caller must still parse defensively.
 */
const { priceFor, costCents, estimateCents } = require('./pricing');

const MAX_OUT = 1200;

function createChat({ http, baseUrl, getKey, tiers, defaults, overrides = {}, price = {}, spend, name, log = console }) {
  const modelFor = (tier, routed) => overrides[tier] || routed || (tiers && tiers[tier] && tiers[tier].model) || defaults[tier];
  return {
    implemented: true,
    async complete({ system = '', prompt, tier = 'cheap', json = false, model }) {
      const m = modelFor(tier, model);
      const p = priceFor(m, price);
      if (spend) spend.assertCanSpend(estimateCents(p, system + prompt, MAX_OUT)); // BEFORE the call
      const headers = {}; const key = getKey();
      if (key) headers.Authorization = `Bearer ${key}`;
      const body = { model: m, messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }], max_tokens: MAX_OUT };
      if (json) body.response_format = { type: 'json_object' };
      const res = await http.request(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, { method: 'POST', headers, json: body, timeoutMs: 120000 });
      let out;
      try { out = res.json(); } catch { throw new Error(`${name}: non-JSON response`); }
      const text = out && out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content;
      if (typeof text !== 'string' || !text) throw new Error(`${name}: response had no message content`);
      const u = out.usage || {};
      const inT = Number.isFinite(u.prompt_tokens) ? u.prompt_tokens : Math.ceil((system + prompt).length / 4);
      const outT = Number.isFinite(u.completion_tokens) ? u.completion_tokens : Math.ceil(text.length / 4);
      if (p.assumed) log.warn(`[llm] no price known for model "${m}"; costed at a conservative worst case. Set LLM_PRICE_IN_PER_M/LLM_PRICE_OUT_PER_M.`);
      return { text, model: m, costCents: costCents(p, inT, outT), priceAssumed: p.assumed };
    },
  };
}
module.exports = { createChat, MAX_OUT };
