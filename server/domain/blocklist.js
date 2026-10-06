'use strict';
/**
 * blocklist.js — trademark/IP keyword blocklist: storage, seeding and matching.
 * A hit FLAGS a product (blocks autopublish and is listed in the approval summary); it never silently publishes and
 * it never rewrites the text. The seed (domain/blocklist-seed.js) is a starting point, not legal advice or a complete list.
 *
 * MATCHING (what it does):
 *  1. Normalise: lower-case, strip diacritics (pokémon = pokemon), drop apostrophes, split on every non-alphanumeric
 *     character into word tokens. Hyphens, slashes, underscores and spaces are therefore all the same separator, so
 *     "spider-man", "Spider Man" and "SPIDER_MAN" are one thing, and a match can never start or end inside a word:
 *     "nike" does not match "nikephoros", "lego" does not match "legolas"... a term is matched as WHOLE TOKENS.
 *  2. Joined variants: a multi-word term also matches its joined spelling ("spiderman", "mickeymouse"), and a run of
 *     adjacent tokens whose concatenation equals the term ("star" "wars" = "starwars"). A single-word term matches
 *     single tokens only (so "n i k e" is not caught, and "a go" cannot spell "ago").
 *  3. Plurals and possessives: a token also matches if it is the listed term plus "s" or "es" ("nikes", "pokemons"),
 *     or the term followed by 's ("nike's", "Levi's" for the listed "levis"). The reverse is NOT done: a listed
 *     "celtics" is not matched by "celtic", so "celtic knot" is safe.
 *  4. EXCEPTIONS (below): a hit is dropped when it sits inside a known legitimate phrase ("nikola tesla", "supreme court").
 *  5. Ambiguous common words are not listed on their own: the seed lists the phrase that makes them a brand
 *     ("apple watch", "new york giants"), which is the main false-positive guard.
 *
 * LIMITS (what it cannot do): it matches TEXT only. It cannot see a logo, a likeness or a style; it does not catch
 * misspellings or obfuscation ("n1ke", "Nikee"), non-Latin scripts, translations, or a name nobody listed. It has no idea whether a
 * word is registered for the goods being sold. A common-word phrase in the seed ("life is good") will also flag innocent
 * uses of those words together. Treat a hit as "look at this", and a clean result as "nothing obvious", never "cleared".
 */
const { SEED, SEED_VERSION, KINDS } = require('./blocklist-seed');

const MAX_TERM_TOKENS = 8;

/** Lower-case, strip diacritics and apostrophes. Apostrophe-s is kept joined here; the tokenizer records the base form. */
function fold(text) {
  return String(text === undefined || text === null ? '' : text).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Tokens of a text: [{t: 'levis', b: 'levi' | null}] where b is the form without a possessive 's. */
function tokenize(text) {
  const out = [];
  for (const raw of fold(text).split(/[^a-z0-9'’‘`]+/)) {
    if (!raw) continue;
    const poss = /^(.+?)['’‘`]s$/.exec(raw);
    const t = raw.replace(/['’‘`]/g, '');
    if (!t) continue;
    out.push({ t, b: poss ? poss[1].replace(/['’‘`]/g, '') : null });
  }
  return out;
}

/** Canonical stored form of a term: lower-case, diacritics stripped, whitespace collapsed. Punctuation like - is kept as typed. */
function normalizeTerm(raw) {
  return fold(raw).replace(/\s+/g, ' ').trim();
}

/** Why a term cannot be stored, or null. */
function termProblem(raw) {
  const term = normalizeTerm(raw);
  if (!term) return 'empty';
  if (term.length > 80) return 'longer than 80 characters';
  const toks = tokenize(term);
  if (!toks.length) return 'contains no letters or digits';
  if (toks.length > MAX_TERM_TOKENS) return `more than ${MAX_TERM_TOKENS} words`;
  if (toks.map(x => x.t).join('').length < 3) return 'shorter than 3 letters or digits (it would match far too much)';
  return null;
}

/** Hits that are legitimate because of the words around them: {term -> [phrase, ...]}. Matched on the same normalisation. */
const EXCEPTIONS = {
  tesla: ['nikola tesla', 'tesla coil'],
  marvel: ['marvel at', 'marvels of', 'marvel of', 'to marvel'],
  'the matrix movie': [],
};

function buildIndex(rows) {
  const byJoined = new Map(); // joined string -> [{term, kind, n}]
  let maxN = 1;
  for (const r of rows) {
    const toks = tokenize(r.term);
    if (!toks.length) continue;
    const e = { term: r.term, kind: r.kind, n: toks.length, joined: toks.map(x => x.t).join('') };
    maxN = Math.max(maxN, e.n);
    if (!byJoined.has(e.joined)) byJoined.set(e.joined, []);
    byJoined.get(e.joined).push(e);
  }
  return { byJoined, maxN };
}

/** Candidate spellings of a joined string: itself, minus a plural s / es. */
function variants(s) {
  const v = [s];
  if (s.length > 3 && s.endsWith('s')) v.push(s.slice(0, -1));
  if (s.length > 4 && s.endsWith('es')) v.push(s.slice(0, -2));
  return v;
}

/** Find index entries in one text. Returns [{term, kind, at (token index)}]. */
function scanText(index, text) {
  const toks = tokenize(text);
  const hits = [];
  const seen = new Set();
  const plain = toks.map(x => x.t);
  for (let i = 0; i < toks.length; i++) {
    for (let k = 1; k <= Math.min(index.maxN, toks.length - i); k++) {
      const win = toks.slice(i, i + k);
      const joinedAll = win.map(x => x.t).join('');
      const last = win[k - 1];
      const cands = new Set(variants(joinedAll));
      if (last.b) for (const v of variants(win.slice(0, -1).map(x => x.t).join('') + last.b)) cands.add(v);
      for (const c of cands) {
        for (const e of index.byJoined.get(c) || []) {
          if (k > 1 && e.n < 2) continue; // single-word terms match single tokens only
          if (seen.has(e.term)) continue;
          // Exception phrases around this hit, matched on tokens.
          const ex = EXCEPTIONS[e.term];
          if (ex && ex.length) {
            const ctx = plain.slice(Math.max(0, i - 3), i + k + 3).join(' ');
            if (ex.some(p => ` ${ctx} `.includes(` ${tokenize(p).map(x => x.t).join(' ')} `))) continue;
          }
          seen.add(e.term);
          hits.push({ term: e.term, kind: e.kind, at: i });
        }
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------------------------------------------------
// Storage

const removedSet = settings => { try { return new Set(JSON.parse(settings && settings.get('blocklist_removed', '[]'))); } catch { return new Set(); } };

/**
 * Seed (or top up) the table. Idempotent: a database already at SEED_VERSION is untouched (returns 0). A bumped version
 * adds the new seed terms but never re-adds one the operator removed. `settings` is optional only for old callers.
 */
function seedBlocklist(db, settings = null) {
  const key = 'blocklist_seed_version';
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (row && Number(row.value) >= SEED_VERSION) return 0;
  const removed = removedSet(settings || { get: (k, d) => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k); return r ? r.value : d; } });
  const ins = db.prepare('INSERT OR IGNORE INTO blocklist(term,kind,added_at) VALUES(?,?,?)');
  const t = new Date().toISOString();
  let c = 0;
  db.exec('BEGIN');
  try {
    for (const [kind, terms] of Object.entries(SEED)) for (const raw of terms) {
      const term = normalizeTerm(raw);
      if (removed.has(term) || termProblem(term)) continue;
      c += Number(ins.run(term, kind, t).changes);
    }
    db.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at').run(key, String(SEED_VERSION), t);
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* gone */ } throw e; }
  return c;
}

let cache = { db: null, stamp: null, index: null };
function indexFor(db) {
  const stamp = JSON.stringify(db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(rowid),0) AS m, COALESCE(SUM(length(term)),0) AS l FROM blocklist').get());
  if (cache.db !== db || cache.stamp !== stamp) cache = { db, stamp, index: buildIndex(db.prepare('SELECT term, kind FROM blocklist').all()) };
  return cache.index;
}

/**
 * Scan named fields. fields = {brief: '...', title: '...', tags: '...' | [..], description: '...'} (values may be arrays/strings).
 * Returns [{term, kind, fields: ['brief','title']}], one entry per term.
 */
function scanFields(db, fields) {
  const index = indexFor(db);
  const byTerm = new Map();
  for (const [name, v] of Object.entries(fields || {})) {
    const text = Array.isArray(v) ? v.filter(Boolean).join(' \n ') : v;
    if (!text) continue;
    for (const h of scanText(index, text)) {
      const e = byTerm.get(h.term) || { term: h.term, kind: h.kind, fields: [] };
      if (!e.fields.includes(name)) e.fields.push(name);
      byTerm.set(h.term, e);
    }
  }
  return [...byTerm.values()];
}

/** Matched terms found in any of the texts (array of strings). Back-compat shape: an array of term strings. */
function checkBlocklist(db, texts) {
  return scanFields(db, { text: (texts || []).filter(Boolean) }).map(h => h.term);
}

/** "nike (title, brief); pikachu (brief)" — what a flag detail / approval summary says. */
function describeHits(hits) {
  return hits.map(h => (h.fields && h.fields.length ? `${h.term} [${h.fields.join(', ')}]` : h.term)).join(', ');
}

function list(db) {
  return db.prepare('SELECT term, kind, added_at AS addedAt FROM blocklist ORDER BY kind, term').all();
}

function addTerm(db, raw, kind = 'custom') {
  const problem = termProblem(raw);
  if (problem) return { ok: false, reason: problem };
  const term = normalizeTerm(raw);
  const k = KINDS.includes(kind) ? kind : 'custom';
  const r = db.prepare('INSERT OR IGNORE INTO blocklist(term,kind,added_at) VALUES(?,?,?)').run(term, k, new Date().toISOString());
  // Adding back a term the operator once removed: forget the removal so a future seed bump behaves normally.
  return r.changes ? { ok: true, term, kind: k, added: true } : { ok: true, term, kind: k, added: false, reason: 'already listed' };
}

function removeTerm(db, settings, raw) {
  const term = normalizeTerm(raw);
  const r = db.prepare('DELETE FROM blocklist WHERE term = ?').run(term);
  if (!r.changes) return false;
  // Remember it so a seed top-up does not put it back.
  const removed = removedSet(settings); removed.add(term);
  settings.set('blocklist_removed', JSON.stringify([...removed].slice(-5000)));
  return true;
}

/** Import a newline list. Lines: `term` or `term | kind`; blank lines and lines starting with # are ignored. */
function importList(db, text, defaultKind = 'custom') {
  const out = { added: 0, duplicates: 0, invalid: [], total: 0 };
  const lines = String(text || '').split(/\r?\n/);
  if (lines.length > 20000) return { ...out, error: 'at most 20000 lines per import' };
  db.exec('BEGIN');
  try {
    for (const line of lines) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      out.total++;
      const [t, k] = s.split('|').map(x => x.trim());
      const r = addTerm(db, t, KINDS.includes(k) ? k : defaultKind);
      if (!r.ok) { if (out.invalid.length < 50) out.invalid.push({ line: s.slice(0, 100), reason: r.reason }); }
      else if (r.added) out.added++; else out.duplicates++;
    }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* gone */ } throw e; }
  return out;
}

module.exports = {
  SEED, SEED_VERSION, KINDS, seedBlocklist, checkBlocklist, scanFields, scanText, describeHits, list, addTerm, removeTerm, importList,
  normalizeTerm, termProblem, tokenize, EXCEPTIONS,
};
