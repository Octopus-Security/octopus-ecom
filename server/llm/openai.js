'use strict';
// TODO(M1): OpenAI chat completions, BYOK, through ../adapters/http.js. Model per tier from
// router-path.js when available, else a small built-in table. API shape: assumed, unverified.
function createOpenAi(/* { http, credentials, tiers, log } */) {
  return { implemented: false, async complete() { throw new Error('llm.openai is not implemented yet (M1)'); } };
}
module.exports = { createOpenAi };
