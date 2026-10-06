'use strict';
/** OpenAI chat completions, BYOK (keystore 'openai' or OPENAI_API_KEY). Tier -> model: see pricing.js. */
const { createChat } = require('./chat');
const { DEFAULT_TIERS } = require('./pricing');

function createOpenAi({ http, credentials, tiers, overrides, spend, log }) {
  return createChat({ http, baseUrl: 'https://api.openai.com/v1', getKey: () => credentials.get('openai'), tiers, defaults: DEFAULT_TIERS, overrides, spend, name: 'llm.openai', log });
}
module.exports = { createOpenAi };
