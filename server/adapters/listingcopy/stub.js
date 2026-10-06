'use strict';
/** Stub ListingCopy: deterministic copy that satisfies the Etsy text rules. */
const { clampTitle, normalizeTags } = require('../../domain/etsy-rules');

function createStub() {
  return {
    implemented: true,
    async generate(design, niche, keywords = []) {
      const kw = [...new Set((keywords.length ? keywords : String(niche || '').toLowerCase().split(/\s+/)).filter(Boolean))];
      const title = clampTitle(`${niche || 'Original design'} ${kw.slice(0, 6).join(' ')} - original print on demand design`.replace(/\s+/g, ' '));
      const tags = normalizeTags([...kw, 'original design', 'print on demand', 'gift idea', 'unique gift', 'custom art']);
      const description = `${niche || 'An original design'}.\n\nOriginal artwork, printed on demand.\n(Placeholder copy from the stub generator.)`;
      return { title, tags, description, costCents: 0, model: 'stub-copy' };
    },
  };
}
module.exports = { createStub };
