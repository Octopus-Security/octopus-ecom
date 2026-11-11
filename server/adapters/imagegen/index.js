'use strict';
const { routeAdapter } = require('../route');
const { createStub } = require('./stub');
const { createOpenAiImages } = require('./openai');
const { createGeminiImages } = require('./gemini');
const { createXaiImages } = require('./xai');
const { createOpenRouterImages } = require('./openrouter');
const { PROVIDERS, PROVIDER_IDS } = require('./providers');
const { bilinearUpscale } = require('../../upscale');

/** The provider/model/resolution in force NOW: Settings (DB) over env over the built-in default (openai, as before). */
function resolveSelection({ cfg, settings }) {
  const get = k => (settings ? settings.get(k, '') : '') || '';
  const stored = get('image_provider');
  const provider = PROVIDER_IDS.includes(stored) ? stored : (PROVIDER_IDS.includes(cfg.image.provider) ? cfg.image.provider : 'openai');
  const modelStored = get(`image_model_${provider}`);
  const model = modelStored || (provider === 'openai' ? cfg.image.model : PROVIDERS[provider].defaultModel);
  const resolution = get('image_resolution') || '';
  const maxCents = Number(get('image_max_cents')) || cfg.image.maxCents || undefined;
  return { provider, model, resolution, maxCents };
}

function create({ cfg, credentials, isDryRun, http, log, spend, upscale, settings }) {
  const hook = upscale !== undefined ? upscale : (cfg.image.upscale ? bilinearUpscale : null);
  const common = { http, credentials, log, dataDir: cfg.dataDir, spend, upscale: hook };
  // One real adapter per call: the selection can change in Settings at runtime. A chosen provider with no key FAILS (below);
  // it never falls back to another paid provider. Only the default (openai, no key) keeps the old stub behaviour.
  const build = () => {
    const sel = resolveSelection({ cfg, settings });
    switch (sel.provider) {
      case 'gemini': return createGeminiImages({ ...common, model: sel.model, resolution: sel.resolution });
      case 'xai': return createXaiImages({ ...common, model: sel.model, resolution: sel.resolution });
      case 'openrouter': return createOpenRouterImages({ ...common, model: sel.model, ceilingCents: sel.maxCents });
      default: return createOpenAiImages({ ...common, model: sel.model, quality: cfg.image.quality });
    }
  };
  const real = {
    implemented: true,
    estimate: (...a) => build().estimate(...a),
    generate: (...a) => build().generate(...a),
  };
  // Generation is spend, not a marketplace write: real whenever a key exists, even in DRY_RUN.
  // The daily cap is enforced INSIDE each real adapter (a refusal, not a silent fall back to a stub image).
  return routeAdapter({
    kind: 'imagegen', stub: createStub({ dataDir: cfg.dataDir }), real,
    hasCredential: () => {
      const { provider } = resolveSelection({ cfg, settings });
      return provider === 'openai' ? credentials.has('openai') : true; // non-default choice: go real and fail loudly if keyless
    },
    isDryRun, log,
  });
}
module.exports = { create, resolveSelection };
