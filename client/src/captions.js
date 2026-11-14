/**
 * Short caption ideas from the product's own words. No model call and no image spend.
 * The operator edits the line before it is placed.
 */

const MAX_CAPTION = 48;

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clip(value) {
  const text = clean(value).replace(/^[,.:;\-]+|[,.:;\-]+$/g, '');
  if (text.length <= MAX_CAPTION) return text;
  const cut = text.slice(0, MAX_CAPTION);
  const space = cut.lastIndexOf(' ');
  return (space > 12 ? cut.slice(0, space) : cut).replace(/[,.:;\-\s]+$/g, '');
}

function titleCase(value) {
  return clean(value).replace(/\b([a-z])/g, (letter) => letter.toUpperCase());
}

function push(ideas, value) {
  const text = clip(value);
  if (text.length < 2) return;
  if (ideas.some((have) => have.toLowerCase() === text.toLowerCase())) return;
  ideas.push(text);
}

export function suggestCaptions({ brief = '', title = '', niche = '' } = {}) {
  const ideas = [];
  const raw = clean(brief) || clean(title) || clean(niche);
  if (!raw) {
    push(ideas, 'Made for someone');
    push(ideas, 'A small original');
    push(ideas, 'For the person who gets it');
    return ideas;
  }
  const bare = raw.replace(/^(a|an|the)\s+/i, '');
  const words = bare.split(' ').filter(Boolean);
  push(ideas, raw);
  push(ideas, titleCase(bare));
  const clause = bare.split(/[,.]|\s+-\s+|\s+and\s+|\s+with\s+/i)[0];
  push(ideas, titleCase(clause));
  if (words.length >= 3) push(ideas, titleCase(words.slice(-3).join(' ')));
  if (words.length >= 2) push(ideas, titleCase(words.slice(-2).join(' ')));
  const verbAt = words.findIndex((word) => /ing$/i.test(word));
  if (verbAt >= 0) push(ideas, titleCase(words.slice(Math.max(0, verbAt - 1), verbAt + 2).join(' ')));
  if (clean(title) && clean(title).toLowerCase() !== raw.toLowerCase()) push(ideas, title);
  if (clean(niche)) push(ideas, titleCase(niche));
  return ideas.slice(0, 6);
}

export { MAX_CAPTION };
