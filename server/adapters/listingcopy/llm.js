'use strict';
/**
 * listingcopy/llm.js — Etsy listing copy through the LLM interface (tier 'standard': copy is what
 * sells, so it is not on the cheapest tier). Returns the model's copy RAW ({title, tags, description,
 * costCents, model}); the pipeline enforces the Etsy rules in code (domain/etsy-rules.js), so nothing
 * here is trusted to obey them even though the prompt states them.
 */
const SYSTEM = [
  'You write Etsy listing copy for original print-on-demand products.',
  'Reply with ONLY a JSON object: {"title": string, "tags": string[], "description": string}.',
  'Rules: title at most 140 characters; at most 13 tags, each at most 20 characters, lowercase words/phrases only (letters, digits, spaces, hyphens);',
  'write the way a buyer would search (natural phrases like "retro cat poster", gift occasions, styles), front-load the strongest phrase in the title;',
  'NO keyword stuffing (do not repeat a phrase or list synonyms), NO brand names, trademarks, franchise, character, team or celebrity names, no claims of being "official" or "licensed";',
  'the description is 80-200 words of plain honest prose about the design and the product; no emoji.',
].join(' ');

function extractJson(text) {
  const t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(t); } catch { /* fall through to a brace scan */ }
  const a = t.indexOf('{'); const b = t.lastIndexOf('}');
  if (a !== -1 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* below */ } }
  throw new Error('listing copy: the model did not return parseable JSON');
}

function createLlmCopy({ llm } = {}) {
  return {
    implemented: true,
    async generate(design = {}, niche = '', keywords = []) {
      const prompt = [
        `Niche / theme: ${niche || '(none given)'}`,
        `Design brief: ${design.brief || design.prompt || '(none given)'}`,
        `Operator keywords (themes, not mandatory): ${keywords.length ? keywords.join(', ') : '(none)'}`,
        'Write the listing now.',
      ].join('\n');
      const out = await llm.complete({ system: SYSTEM, prompt, tier: 'standard', json: true });
      const j = extractJson(out.text);
      if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('listing copy: JSON was not an object');
      return { title: j.title, tags: j.tags, description: j.description, costCents: out.costCents || 0, model: out.model };
    },
  };
}
module.exports = { createLlmCopy, extractJson, SYSTEM };
