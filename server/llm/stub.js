'use strict';
/** Stub LLM provider: deterministic, free, offline. */
const crypto = require('node:crypto');

function createStub() {
  return {
    implemented: true,
    async complete({ prompt = '', tier = 'cheap', json = false }) {
      const h = crypto.createHash('sha256').update(`${tier}:${prompt}`).digest('hex').slice(0, 8);
      const text = json ? JSON.stringify({ stub: true, tier, echo: String(prompt).slice(0, 80), id: h }) : `[stub ${tier} ${h}] ${String(prompt).slice(0, 120)}`;
      return { text, model: 'stub-llm', costCents: 0 };
    },
  };
}
module.exports = { createStub };
