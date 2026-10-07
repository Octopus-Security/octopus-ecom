'use strict';
/** prompts.js — the image prompt sent to the generator: the operator's brief plus fixed print-on-demand guard rails. */
const GUARD = 'Original artwork only. A single centred graphic on a plain solid background, clean edges, suitable for printing on apparel or a poster. '
  + 'No text unless the brief asks for specific words, no logos, no brand names, no trademarked characters, no watermarks.';

function designPrompt({ brief, niche }) {
  return `${String(brief).trim()}${niche ? ` (theme: ${String(niche).trim()})` : ''}. ${GUARD}`;
}

const MANUAL_EXTRA = 'Transparent background (PNG with alpha) if your tool can; otherwise a plain solid background. No text unless the brief asks for specific words. '
  + 'No trademarks, no characters, no brand names.';
const gcd = (a, b) => (b ? gcd(b, a % b) : a);

/** What to paste into an external image tool: the exact pipeline prompt plus the target size/aspect and the extra guard rails. */
function manualPrompt(product, area) {
  const prompt = designPrompt(product);
  const g = gcd(area.width, area.height) || 1;
  const aspect = `${area.width / g}:${area.height / g}`;
  const sizeLine = `Target: ${area.width}x${area.height} px (aspect ${aspect}${area.position ? `, print area "${area.position}"` : ''}). Export as PNG at the largest size the tool allows, same aspect ratio.`;
  return { prompt, width: area.width, height: area.height, aspect, position: area.position || null, extra: MANUAL_EXTRA, text: `${prompt}\n\n${sizeLine}\n${MANUAL_EXTRA}` };
}
module.exports = { designPrompt, manualPrompt, GUARD, MANUAL_EXTRA };
