'use strict';
/**
 * proposal-risk.js — the originality / IP risk check on a proposal. Three layers, none of which is "cleared":
 *   1. the trademark blocklist (domain/blocklist.js) over every text field, TEXT ONLY: it cannot see a logo or a likeness;
 *   2. a deterministic phrase check for wording that says the idea leans on someone else's work ("inspired by", "in the style
 *      of", "fan art", "official", "parody of" ...). A regular expression, so it misses paraphrase: it is a tripwire;
 *   3. the model's own originality self-check, returned with each proposal, and a ready-to-paste prompt that asks any model to
 *      re-check the concept (originalityPrompt), for a second opinion from a tool the owner chooses.
 * Levels: `blocked` (a blocklist hit, a phrase hit, or the model said its own idea fails) cannot be approved until edited clean;
 * `review` (lint errors, a too-late season) needs the confirm step; `clear` means "nothing obvious", never "cleared".
 * A proposal is never derived from a specific competitor listing or image: nothing here fetches or accepts one.
 */
const { scanFields, describeHits } = require('./blocklist');

const PHRASES = Object.freeze([
  ['inspired by', /\binspired\s+by\b/i],
  ['in the style of', /\bin\s+the\s+style\s+of\b/i],
  ['parody of', /\bparod(?:y|ies)\s+of\b/i],
  ['fan art', /\bfan[\s-]?art\b/i],
  ['official / licensed', /\b(?:officially|official|licen[cs]ed|authorized|authorised)\b/i],
  ['unofficial', /\bunofficial\b/i],
  ['tribute to', /\btribute\s+to\b/i],
  ['homage to', /\bhomage\s+to\b/i],
  ['lookalike / knock-off', /\b(?:look[\s-]?alike|knock[\s-]?off|dupe|clone|rip[\s-]?off)\b/i],
  ['as seen on', /\bas\s+seen\s+(?:on|in)\b/i],
  ['copy of / copied', /\b(?:copy|copied|copies)\s+(?:of|from)\b/i],
  ['reminiscent of', /\breminiscent\s+of\b/i],
  ['similar to', /\b(?:similar\s+to|same\s+as|like\s+the)\s+(?:the\s+)?(?:best[\s-]?selling|top[\s-]?selling|popular|viral|famous)\b/i],
  ['best-seller reference', /\b(?:best|top)[\s-]?sell(?:er|ing)\b/i],
  ['seller reference', /\b(?:another|that|this|a\s+competitor'?s?|their)\s+(?:seller|shop|store|listing)\b/i],
]);

/** [{phrase, field}] for every field that contains one of the tripwire phrases. */
function scanPhrases(fields) {
  const out = [];
  for (const [field, v] of Object.entries(fields || {})) {
    const text = Array.isArray(v) ? v.join(' ') : String(v || '');
    if (!text) continue;
    for (const [phrase, re] of PHRASES) if (re.test(text)) out.push({ phrase, field });
  }
  return out;
}

/**
 * assess(db, fields, {modelCheck, tooLate, lintErrors}) -> {level, blocklist[], phrases[], modelCheck, reasons[]}.
 * `fields` = every text field of the proposal, named, so a hit says where it is.
 */
function assess(db, fields, { modelCheck = null, tooLate = false, lintErrors = 0 } = {}) {
  const blocklist = scanFields(db, fields);
  const phrases = scanPhrases(fields);
  const reasons = [];
  if (blocklist.length) reasons.push(`blocklist: ${describeHits(blocklist)}`);
  if (phrases.length) reasons.push(`wording that leans on someone else's work: ${phrases.map(p => `"${p.phrase}" [${p.field}]`).join(', ')}`);
  const modelFailed = !!modelCheck && modelCheck.passes === false;
  if (modelFailed) reasons.push(`the model's own originality check failed${modelCheck.concerns ? `: ${modelCheck.concerns}` : ''}`);
  const blocked = blocklist.length > 0 || phrases.length > 0 || modelFailed;
  const review = [];
  if (tooLate) review.push('the season window for this year has passed');
  if (lintErrors) review.push(`${lintErrors} listing-rule error(s)`);
  return { level: blocked ? 'blocked' : review.length ? 'review' : 'clear', blocklist, phrases, modelCheck, reasons: reasons.concat(review), blocklistSummary: describeHits(blocklist) };
}

const RULES = [
  'Refuse (answer FAIL) if the concept, brief, title, tags or description uses or evokes ANY of: a brand, trademark, logo or product name; a franchise, film, TV show, game, book, song or band;',
  'a fictional or cartoon character; a celebrity, athlete, influencer or any real person; a sports team, league, school or university name or colours-and-mascot combination;',
  'a slogan, catchphrase, lyric or quote that is protected or famous; an artist, designer or illustrator named as a style to imitate;',
  'or any phrase of the form "inspired by <seller or shop>", "in the style of <name>", "like the best-seller", "parody of", "fan art", "official" or "licensed".',
  'Also FAIL if the idea would only make sense as a copy of one specific existing listing or image.',
].join(' ');

/** A ready-to-paste prompt: asks any model to audit this proposal and answer PASS or FAIL with the reason. */
function originalityPrompt(p) {
  const tags = Array.isArray(p.etsyTags) ? p.etsyTags.join(', ') : '';
  return [
    'You are an intellectual-property reviewer for a print-on-demand shop. Audit the product proposal below for ORIGINALITY and IP risk.',
    RULES,
    'Answer on the first line with exactly PASS or FAIL, then one short paragraph naming each problem (or "none found"). A PASS is not legal clearance: say what you could not check (logos and likenesses in the finished image).',
    '',
    `Concept: ${p.concept || ''}`,
    `Design brief: ${p.brief || ''}`,
    `Etsy title: ${p.etsyTitle || ''}`,
    `Tags: ${tags}`,
    `Description: ${p.etsyDescription || ''}`,
  ].join('\n');
}

module.exports = { PHRASES, RULES, scanPhrases, assess, originalityPrompt };
