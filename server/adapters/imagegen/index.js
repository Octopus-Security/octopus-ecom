'use strict';
const { routeAdapter } = require('../route');
const { createStub } = require('./stub');
const { createOpenAiImages } = require('./openai');
const { bilinearUpscale } = require('../../upscale');

function create({ cfg, credentials, isDryRun, http, log, spend, upscale }) {
  const hook = upscale !== undefined ? upscale : (cfg.image.upscale ? bilinearUpscale : null);
  // Generation is spend, not a marketplace write: real whenever a key exists, even in DRY_RUN.
  // The daily cap is enforced INSIDE the real adapter (a refusal, not a silent fall back to a stub
  // image: a stub standing in for a paid image would hide that generation is paused).
  return routeAdapter({
    kind: 'imagegen', stub: createStub({ dataDir: cfg.dataDir }),
    real: createOpenAiImages({ http, credentials, log, dataDir: cfg.dataDir, spend, upscale: hook, model: cfg.image.model, quality: cfg.image.quality }),
    hasCredential: () => credentials.has('openai'), isDryRun, log,
  });
}
module.exports = { create };
