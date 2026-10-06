'use strict';
/** prompts.js — the image prompt sent to the generator: the operator's brief plus fixed print-on-demand guard rails. */
const GUARD = 'Original artwork only. A single centred graphic on a plain solid background, clean edges, suitable for printing on apparel or a poster. '
  + 'No text unless the brief asks for specific words, no logos, no brand names, no trademarked characters, no watermarks.';

function designPrompt({ brief, niche }) {
  return `${String(brief).trim()}${niche ? ` (theme: ${String(niche).trim()})` : ''}. ${GUARD}`;
}
module.exports = { designPrompt, GUARD };
