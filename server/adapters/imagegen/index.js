'use strict';
const { routeAdapter } = require('../route');
const { createStub } = require('./stub');
const { createNousImages } = require('./nous');
const { createGeminiImages } = require('./gemini');
const { createXaiImages } = require('./xai');
const { createOpenRouterImages } = require('./openrouter');
const { PROVIDERS, PROVIDER_IDS } = require('./providers');
const { bilinearUpscale } = require('../../upscale');

/** The provider/model/resolution in force NOW: Settings (DB) over env over the built-in default (nous). */
function resolveSelection({ cfg, settings }) {
  const get = k => (settings ? settings.get(k, '') : '') || '';
  const stored = get('image_provider');
  const provider = PROVIDER_IDS.includes(stored) ? stored : (PROVIDER_IDS.includes(cfg.image.provider) ? cfg.image.provider : 'nous');
  const known = PROVIDERS[provider];
  const modelStored = get(`image_model_${provider}`);
  const envModel = (cfg.image && cfg.image.model) || '';
  const envOk = envModel && (known.freeText || known.models.includes(envModel));
  const model = modelStored || (envOk ? envModel : known.defaultModel) || '';
  const resolution = get('image_resolution') || '';
  const maxCents = Number(get('image_max_cents')) || cfg.image.maxCents || undefined;
  return { provider, model, resolution, maxCents };
}

function create({ cfg, credentials, isDryRun, http, log, spend, upscale, settings }) {
  const hook = upscale !== undefined ? upscale : (cfg.image.upscale ? bilinearUpscale : null);
  const common = { http, credentials, log, dataDir: cfg.dataDir, spend, upscale: hook };
  // One real adapter per call: the selection can change in Settings at runtime. A chosen provider with no key FAILS (below);
  // it never falls back to another paid provider. Only the default (nous, no key) keeps the free stub.
  // openai.js stays in the tree for its own tests; it is not a selectable image provider. Listing copy still
  // falls back to OPENAI_API_KEY through the LLM, which is a different credential path.
  const build = () => {
    const sel = resolveSelection({ cfg, settings });
    switch (sel.provider) {
      case 'gemini': return createGeminiImages({ ...common, model: sel.model, resolution: sel.resolution });
      case 'xai': return createXaiImages({ ...common, model: sel.model, resolution: sel.resolution });
      case 'openrouter': return createOpenRouterImages({ ...common, model: sel.model, ceilingCents: sel.maxCents });
      default: return createNousImages({ ...common, model: sel.model });
    }
  };
  const real = {
    implemented: true,
    estimate: (...a) => build().estimate(...a),
    generate: (...a) => build().generate(...a),
    edit: async (...a) => {
      const sel = resolveSelection({ cfg, settings });
      if (sel.provider !== 'nous') throw new Error('Redraw uses Nous Portal klein edit. Switch the image provider to Nous under Settings.');
      const impl = build();
      if (typeof impl.edit !== 'function') throw new Error('Redraw uses Nous Portal klein edit. This provider cannot edit a region.');
      return impl.edit(...a);
    },
  };
  // Generation is spend, not a marketplace write: real whenever a key exists, even in DRY_RUN.
  // The daily cap is enforced INSIDE each real adapter (a refusal, not a silent fall back to a stub image).
  return routeAdapter({
    kind: 'imagegen', stub: createStub({ dataDir: cfg.dataDir }), real,
    hasCredential: () => {
      const { provider } = resolveSelection({ cfg, settings });
      return provider === 'nous' ? credentials.has('nous') : true; // non-default choice: go real and fail loudly if keyless
    },
    isDryRun, log,
  });
}
module.exports = { create, resolveSelection };
