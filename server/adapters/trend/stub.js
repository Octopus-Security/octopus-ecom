'use strict';
/**
 * Stub TrendResearch: echoes the operator's typed brief. This is also the intended first
 * implementation (decision 11): NO scraping of competitor listing images or titles, ever.
 */
function createStub() {
  return {
    implemented: true,
    async suggest(niche) {
      const words = [...new Set(String(niche || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2))];
      return { keywords: words, themes: niche ? [String(niche).trim()] : [], demandNotes: 'Echoed from the operator brief. No market data is consulted.' };
    },
  };
}
module.exports = { createStub };
