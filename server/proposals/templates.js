'use strict';
/**
 * proposals/templates.js — deterministic proposals with no model and no network. This is what the stub LLM falls back to, so
 * dry-run and the tests work with no keys. Same inputs (date, seeds, signals, rejected-feedback) give the same output.
 * The words are generic and original: a subject the owner or a signal supplied, a made-up art style, a composition. There is no
 * brand, character or person anywhere in the vocabulary (a test runs every pool entry through the blocklist), and nothing here
 * reads a listing or an image.
 */
const { typeOf, TYPE_IDS } = require('./catalog');
const { clean, sigWords, jaccard, mulberry32, hash, titleCase } = require('./util');

// Used only when the owner gave no seeds and no signal produced a theme.
const EVERGREEN = ['houseplants', 'coffee mornings', 'hiking trails', 'backyard birds', 'sourdough baking', 'mountain sunrise', 'ocean waves', 'board game night', 'stargazing', 'camping under pines', 'bookworms', 'road trips', 'wildflower meadow', 'vinyl record nights', 'bicycle rides', 'lighthouse coast', 'mushroom forest', 'cozy cabin winter', 'garden herbs', 'desert cactus'];
const STYLES = [['retro sunset linocut', 'Retro Linocut'], ['minimalist single-line drawing', 'Minimalist Line Art'], ['soft watercolour wash', 'Watercolor'], ['vintage circular badge', 'Vintage Badge'], ['flat vector with a limited palette', 'Flat Vector'],
  ['folk-art pattern', 'Folk Art'], ['two-colour risograph print', 'Risograph Style'], ['cozy hand-drawn ink and marker', 'Hand Drawn'], ['geometric low-poly', 'Geometric'], ['art-nouveau border', 'Art Nouveau'],
  ['bold mid-century modern shapes', 'Mid Century Modern'], ['woodcut with chunky texture', 'Woodcut'], ['pastel kawaii, rounded shapes', 'Pastel Cute'], ['botanical engraving', 'Botanical Engraving'], ['psychedelic 70s swirl', 'Groovy 70s'], ['paper-cut layered look', 'Paper Cut']];
const COMPOSITIONS = ['a centred emblem', 'a circular badge with an empty ring for no text', 'a small scene on a plain background', 'a single focal subject in a frame', 'a repeating border around one focal subject', 'a stacked landscape in horizontal bands', 'a symmetrical mandala-like layout'];
const PALETTES = ['warm sunset oranges and deep teal', 'muted sage, cream and charcoal', 'navy, mustard and off-white', 'dusty rose, forest green and ivory', 'black and one bright accent colour', 'sky blue, sand and coral', 'plum, gold and cream'];
const FILLER_TAGS = ['gift idea', 'unique gift', 'original design', 'graphic design', 'hand drawn style', 'artsy gift', 'gift for her', 'gift for him', 'birthday gift', 'cute design', 'statement piece', 'everyday style', 'trendy design'];

/**
 * templateProposals({count, subjects[{term, source}], audiences[], types[], seasonIds[], seasonalPool[], windows{id: window}, today, avoid[]})
 * -> raw items in the same shape a model returns. `seasonIds` = the owner asked for these occasions (every proposal uses one);
 * `seasonalPool` = upcoming seasons still open, used for about a third of proposals when no occasion was requested.
 */
function templateProposals({ count, subjects = [], audiences = [], types = TYPE_IDS, seasonIds = [], seasonalPool = [], windows = {}, today, avoid = [] }) {
  const subs = subjects.length ? subjects : EVERGREEN.map(term => ({ term, source: 'evergreen' }));
  const typeList = (types && types.length ? types : TYPE_IDS).filter(t => typeOf(t));
  const seed = hash(`${today}|${subs.map(s => s.term).join(',')}|${audiences.join(',')}|${seasonIds.join(',')}|${typeList.join(',')}|${avoid.length}`);
  const rnd = mulberry32(seed);
  const off = Math.floor(rnd() * subs.length); const tOff = Math.floor(rnd() * typeList.length); const sOff = Math.floor(rnd() * STYLES.length);
  const sigs = avoid.map(a => sigWords(a));
  const out = [];
  for (let i = 0, guard = 0; out.length < count && guard < count * 12; i++, guard++) {
    const sub = subs[(off + i) % subs.length];
    const type = typeOf(typeList[(tOff + i) % typeList.length]);
    const [style, styleShort] = STYLES[(sOff + i * 5 + Math.floor(i / subs.length) * 3) % STYLES.length];
    const comp = COMPOSITIONS[(sOff + i * 3 + 1) % COMPOSITIONS.length];
    const palette = PALETTES[(sOff + i * 2) % PALETTES.length];
    const audience = audiences.length ? audiences[i % audiences.length] : null;
    const seasonId = seasonIds.length ? seasonIds[i % seasonIds.length] : (seasonalPool.length && i % 3 === 0 ? seasonalPool[Math.floor(i / 3) % seasonalPool.length] : null);
    const win = seasonId ? windows[seasonId] : null;
    const subject = clean(sub.term, 60);

    const concept = `${comp[0].toUpperCase()}${comp.slice(1)} celebrating ${subject}, drawn in a ${style} style${audience ? `, made for ${audience}` : ''}${win ? `, timed for ${win.name}` : ''}.`;
    const sw = sigWords(concept);
    if (sigs.some(s => jaccard(s, sw) >= 0.6)) continue;
    sigs.push(sw);

    const brief = `${concept} Palette: ${palette}. One clear focal subject, clean edges, no text, no lettering, no logos.`;
    const suffix = audience ? `Gift for ${titleCase(audience)}` : win ? `${win.name} Gift` : 'Gift Idea';
    const title = `${titleCase(subject)} ${styleShort} ${type.noun} ${suffix}`.replace(/\s+/g, ' ').slice(0, 140).trim();
    const tags = [subject, `${subject} gift`, `${subject} lover`, `${subject} ${type.noun.toLowerCase()}`, styleShort.toLowerCase(), `${type.noun.toLowerCase()} gift`,
      audience ? `gift for ${audience}` : null, win ? win.name.toLowerCase().replace(/[^a-z0-9' -]/g, '') : null, win ? `${win.name.toLowerCase().replace(/[^a-z0-9' -]/g, '')} gift` : null, ...FILLER_TAGS]
      .filter(t => t && t.length <= 20).filter((t, k, a) => a.indexOf(t) === k).slice(0, 13);
    const description = `An original design in a ${style} style on a ${type.label.toLowerCase()}: ${comp}, themed around ${subject}. Printed on demand and made to order. A thoughtful gift${audience ? ` for ${audience}` : ''}${win ? ` for ${win.name}` : ''}.`;
    const why = sub.source === 'seed' ? `your seed theme "${subject}"` : sub.source === 'evergreen' ? `an evergreen subject ("${subject}"), since no seed or signal gave a theme` : `the ${sub.source} signal "${subject}"`;
    const rationale = `Built from ${why}. ${win ? win.summary : 'Evergreen: no deadline, sells year-round.'}`;
    out.push({ concept, rationale, signalsUsed: sub.source === 'evergreen' ? [] : [subject], productType: type.id, season: seasonId || null, brief, title, tags, description, theme: subject,
      keywords: [subject, ...(audience ? [audience] : [])], originalityCheck: { ran: false, passes: null, concerns: 'built from a template: no model checked it' } });
  }
  return out;
}

module.exports = { templateProposals, EVERGREEN, STYLES, COMPOSITIONS, FILLER_TAGS };
