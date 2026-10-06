'use strict';
/**
 * blocklist.js — trademark/brand keyword blocklist (editable; seeded once).
 * A hit FLAGS a product (blocks autopublish); it never silently publishes.
 * The seed is a starting point, not legal advice or a complete list.
 */
const SEED = {
  brand: ['nike', 'adidas', 'gucci', 'supreme', 'disney', 'pixar', 'marvel', 'lego', 'apple', 'starbucks', 'coca-cola', 'tesla', 'harley-davidson'],
  franchise: ['pokemon', 'star wars', 'harry potter', 'hello kitty', 'barbie', 'minecraft', 'nintendo', 'mickey mouse', 'taylor swift'],
  character: ['spider-man', 'batman', 'superman', 'mario', 'pikachu', 'snoopy', 'baby yoda', 'elsa'],
  team: ['lakers', 'yankees', 'dallas cowboys', 'nfl', 'nba', 'mlb', 'fifa'],
};

function seedBlocklist(db) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM blocklist').get().n;
  if (n > 0) return 0;
  const ins = db.prepare('INSERT OR IGNORE INTO blocklist(term,kind,added_at) VALUES(?,?,?)');
  const t = new Date().toISOString();
  let c = 0;
  for (const [kind, terms] of Object.entries(SEED)) for (const term of terms) { ins.run(term, kind, t); c++; }
  return c;
}

/** Returns the matched terms found in any of the texts (whole-word, case-insensitive). */
function checkBlocklist(db, texts) {
  const hay = ` ${texts.filter(Boolean).join(' \n ').toLowerCase().replace(/[^a-z0-9\-\s]/g, ' ')} `;
  return db.prepare('SELECT term FROM blocklist').all().map(r => r.term).filter(term => hay.includes(` ${term} `));
}

module.exports = { seedBlocklist, checkBlocklist, SEED };
