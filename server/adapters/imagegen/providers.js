'use strict';
/** imagegen/providers.js — the selectable image providers, their credential names and model choices (one table, used by routing AND Settings). */
const { GEMINI_MODELS, XAI_MODELS } = require('./pricing');
const { NOUS_MODELS, DEFAULT_MODEL } = require('./nous');

const PROVIDERS = {
  nous:       { label: 'Nous Portal (subscription images)', credential: 'nous', models: NOUS_MODELS, defaultModel: DEFAULT_MODEL, freeText: false, resolutions: [] },
  gemini:     { label: 'Google Gemini (Nano Banana)', credential: 'gemini', models: Object.keys(GEMINI_MODELS), defaultModel: 'gemini-3.1-flash-image', freeText: false, resolutions: ['1K', '2K', '4K'] },
  xai:        { label: 'xAI (Grok Imagine)', credential: 'xai', models: Object.keys(XAI_MODELS), defaultModel: 'grok-imagine-image-2.0', freeText: false, resolutions: ['1k', '2k'] },
  openrouter: { label: 'OpenRouter', credential: 'openrouter', models: [], defaultModel: '', freeText: true, resolutions: [] },
};
const PROVIDER_IDS = Object.keys(PROVIDERS);

module.exports = { PROVIDERS, PROVIDER_IDS };
