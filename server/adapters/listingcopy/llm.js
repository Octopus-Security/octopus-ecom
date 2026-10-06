'use strict';
// TODO(M1): LLM-backed listing copy via server/llm (tiered). Title <=140, <=13 tags of <=20 chars.
const { NotImplemented } = require('../contract');

function createLlmCopy(/* { llm } */) {
  return { implemented: false, async generate() { throw new NotImplemented('listingcopy.llm (M1)'); } };
}
module.exports = { createLlmCopy };
