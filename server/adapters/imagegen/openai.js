'use strict';
// TODO(M1): OpenAI Images (gpt-image-1), BYOK, through ../http.js. Must request print-grade
// resolution and report cost in cents. Pluggable: leave room for local SDXL/ComfyUI.
// External API shape: assumed, unverified (not read this session). Until implemented,
// route.js never selects this (implemented: false).
const { NotImplemented } = require('../contract');

function createOpenAiImages(/* { http, credentials, log } */) {
  return {
    implemented: false,
    async generate() { throw new NotImplemented('imagegen.openai (M1)'); },
  };
}
module.exports = { createOpenAiImages };
