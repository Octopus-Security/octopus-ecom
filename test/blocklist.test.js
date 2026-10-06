'use strict';
// M4: the trademark/IP blocklist: seed, matching (and its false-positive guards), editing, and what a hit does.
const { test } = require('node:test');
const assert = require('node:assert');
const { makeDeps } = require('./helpers');
const bl = require('../server/domain/blocklist');
const { approvalSummary } = require('../server/domain/stages');
const { buildApp } = require('../server/app');

const hits = (d, ...texts) => bl.checkBlocklist(d.db, texts);

test('seeded once with a substantial list across kinds; reseeding is a no-op', () => {
  const d = makeDeps();
  const rows = bl.list(d.db);
  assert.ok(rows.length >= 1000, `only ${rows.length} terms`);
  const kinds = new Set(rows.map(r => r.kind));
  for (const k of ['brand', 'league', 'team', 'franchise', 'character', 'celebrity', 'phrase']) assert.ok(kinds.has(k), k);
  for (const t of ['nike', 'disney', 'lakers', 'star wars', 'pikachu', 'taylor swift', 'just do it', 'dallas cowboys', 'nfl']) assert.ok(rows.some(r => r.term === t), t);
  assert.equal(bl.seedBlocklist(d.db, d.settings), 0);
});

test('matches: case-insensitive, whole words, hyphen/space/joined variants, plurals, possessives, diacritics, phrases', () => {
  const d = makeDeps();
  assert.deepEqual(hits(d, 'Cool NIKE style shirt'), ['nike']);
  for (const t of ['Spider-Man web', 'spider man web', 'SPIDERMAN web', 'spider_man']) assert.deepEqual(hits(d, t), ['spider-man'], t);
  assert.deepEqual(hits(d, 'Star Wars fan'), ['star wars']); assert.deepEqual(hits(d, 'starwars fan'), ['star wars']);
  assert.deepEqual(hits(d, 'coca cola'), ['coca-cola']); assert.deepEqual(hits(d, 'cocacola'), ['coca-cola']);
  assert.deepEqual(hits(d, 'pokémon cards'), ['pokemon']);
  assert.deepEqual(hits(d, 'two Nikes'), ['nike']); assert.deepEqual(hits(d, "Nike's swoosh"), ['nike']); assert.deepEqual(hits(d, 'Nike’s swoosh'), ['nike']);
  assert.deepEqual(hits(d, "Levi's 501"), ['levis']); assert.deepEqual(hits(d, 'vintage levis'), ['levis']);
  assert.deepEqual(hits(d, "McDonald's fries"), ["mcdonald's"]); assert.deepEqual(hits(d, 'mcdonalds fries'), ["mcdonald's"]);
  assert.deepEqual(hits(d, 'Mickey Mouse ears').sort(), ['mickey mouse']);
  assert.deepEqual(hits(d, 'a tribute: Just Do It.'), ['just do it']);
  assert.ok(hits(d, 'Taylor Swift Eras tour').includes('taylor swift'));
  assert.ok(hits(d, 'los angeles lakers').includes('los angeles lakers'));
  assert.deepEqual(hits(d, 'a', null, undefined, ''), []);
});

test('false-positive guards: a term never matches inside a word, and common words are not listed alone', () => {
  const d = makeDeps();
  for (const t of ['nikephoros the general', 'unikely', 'legoland', 'a pineapple pattern', 'apple pie recipe', 'an apple orchard', 'supreme court gavel', 'supreme quality',
    'celtic knot', 'a celtic cross', 'nikola tesla portrait', 'a tesla coil', "potter's wheel pottery", 'marion', 'nfld', 'I marvel at nature', 'marvel at the stars',
    'cross stitch pattern', 'the yeti of the himalayas', 'mountain at sunset', 'a fox in a scarf', 'retro cat poster', 'jaguar in the jungle', 'puma in the rocks', 'a giant squid',
    'coach and horses', 'gap year', 'guess who', 'summer ice age', 'sonic boom', 'tangled vines', 'inside out sweater', 'amazon rainforest', 'a mustang horse', 'elsa the lioness']) {
    assert.deepEqual(hits(d, t), [], t);
  }
  // exceptions only remove the benign reading
  d.db.prepare("INSERT INTO blocklist(term,kind,added_at) VALUES('tesla','brand','x')").run();
  assert.deepEqual(hits(d, 'nikola tesla portrait'), []); assert.deepEqual(hits(d, 'tesla vs edison'), ['tesla']);
  // the reverse of a plural is NOT done: a listed plural is not matched by its singular
  d.db.prepare("INSERT INTO blocklist(term,kind,added_at) VALUES('widgets','brand','x')").run();
  assert.deepEqual(hits(d, 'a widget'), []); assert.deepEqual(hits(d, 'widgets'), ['widgets']);
});

test('documented limits: it is a text match, so obfuscation and misspelling are NOT caught', () => {
  const d = makeDeps();
  assert.deepEqual(hits(d, 'n1ke'), []); assert.deepEqual(hits(d, 'Nikee'), []); assert.deepEqual(hits(d, 'ni ke'), []);
});

test('fields: the result says where the term was found (brief, title, tags, description)', () => {
  const d = makeDeps();
  const r = bl.scanFields(d.db, { brief: 'a nike logo', title: 'Pikachu tee', tags: ['gift', 'disney'], description: 'plain' });
  assert.deepEqual(r.map(x => [x.term, x.fields]).sort(), [['disney', ['tags']], ['nike', ['brief']], ['pikachu', ['title']]]);
  assert.equal(bl.describeHits(r.filter(x => x.term === 'nike')), 'nike [brief]');
});

test('terms are validated: too short, empty, no letters, too long are refused', () => {
  const d = makeDeps();
  for (const bad of ['', '  ', 'ab', '!!!', 'x'.repeat(81), 'a b c d e f g h i']) assert.equal(bl.addTerm(d.db, bad).ok, false, bad);
  assert.equal(bl.addTerm(d.db, '  ACME   Rocket ').term, 'acme rocket');
  assert.equal(bl.addTerm(d.db, 'acme rocket').added, false);
});

test('a hit in the BRIEF flags at creation, before any spend; generation keeps the flag', async () => {
  const d = makeDeps();
  let imageCalls = 0; const g = d.adapters.imagegen.generate; d.adapters.imagegen.generate = async (...a) => { imageCalls++; return g(...a); };
  const p = d.pipeline.create({ brief: 'a Pikachu portrait', niche: 'cute', listPrice: 20 });
  assert.equal(imageCalls, 0); assert.equal(d.spend.summary().spend.totalCents, 0);
  const f = JSON.parse(p.flags).find(x => x.code === 'blocklist');
  assert.ok(f && /pikachu \[brief\]/.test(f.detail));
  assert.ok(d.db.prepare("SELECT 1 FROM events WHERE product_id = ? AND note LIKE '%blocklist hit in the brief%'").get(p.id));
  await d.pipeline.generateDesign(p.id);
  assert.ok(JSON.parse(d.stages.get(p.id).flags).some(x => x.code === 'blocklist'));
});

test('a hit in title, tags or description FLAGS; the text is kept, nothing is rewritten; approval summary lists the hits; the agent cannot approve', async () => {
  const d = makeDeps({ DRY_RUN: 'false' });
  d.adapters.listingcopy = { generate: async () => ({ title: 'Cute Hello Kitty cat', tags: ['gift', 'lakers fan'], description: 'A tee. Inspired by Star Wars.', costCents: 0, model: 'x' }), describe() {} };
  const p = d.pipeline.create({ brief: 'a plain cat', listPrice: 30 });
  await d.pipeline.selectPod(p.id, { blueprint: 'stub-tee', providerId: 'stub-pp' });
  await d.pipeline.generateDesign(p.id); await d.pipeline.createPodProduct(p.id); await d.pipeline.draftListing(p.id);
  const row = d.stages.get(p.id);
  const flag = JSON.parse(row.flags).find(x => x.code === 'blocklist');
  for (const s of ['hello kitty [title]', 'lakers [tags]', 'star wars [description]']) assert.ok(flag.detail.includes(s), `${s} in ${flag.detail}`);
  assert.equal(d.pipeline.detail(p.id).copy.title, 'Cute Hello Kitty cat');
  await d.pipeline.submit(p.id);
  const sum = approvalSummary(d.stages.get(p.id));
  assert.match(sum, /TRADEMARK\/IP BLOCKLIST HITS: .*hello kitty \[title\].*lakers \[tags\]/);
  const sid = Number(d.db.prepare("INSERT INTO stores(platform,name,autopublish,created_at) VALUES('etsy','s',1,?)").run(new Date().toISOString()).lastInsertRowid);
  d.db.prepare('UPDATE products SET store_id = ? WHERE id = ?').run(sid, p.id);
  await assert.rejects(d.pipeline.approve(p.id, { actor: 'agent' }), /flagged \(.*blocklist/);
  assert.equal((await d.pipeline.approve(p.id, { actor: 'human' })).stage, 'approved', 'a human may still approve, having seen the list');
});

test('editing over HTTP: list, add, remove, import; each re-scans the unfinished products', async () => {
  const d = makeDeps();
  const server = await new Promise(r => { const s = buildApp(d).listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const j = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json() }; };
  try {
    const list = await j('GET', '/api/blocklist');
    assert.ok(list.body.total >= 1000); assert.ok(list.body.kinds.includes('custom'));
    const p = d.pipeline.create({ brief: 'an acme rocket sled', listPrice: 20 });
    assert.deepEqual(JSON.parse(p.flags), []);
    const add = await j('POST', '/api/blocklist', { term: 'Acme Rocket', kind: 'brand' });
    assert.equal(add.status, 200); assert.equal(add.body.term, 'acme rocket'); assert.equal(add.body.rescan.flagged, 1);
    assert.ok(JSON.parse(d.stages.get(p.id).flags).some(f => f.code === 'blocklist'), 'the existing product is now flagged');
    assert.equal((await j('POST', '/api/blocklist', { term: 'x' })).status, 400);
    const del = await j('DELETE', '/api/blocklist?term=' + encodeURIComponent('acme rocket'));
    assert.equal(del.status, 200); assert.equal(del.body.rescan.cleared, 1);
    assert.deepEqual(JSON.parse(d.stages.get(p.id).flags), []);
    assert.equal((await j('DELETE', '/api/blocklist?term=nothing%20here')).status, 404);
    const imp = await j('POST', '/api/blocklist/import', { text: '# comment\nwidget corp\nGadget Inc | brand\nzz\n\nwidget corp\nfoo bar | celebrity' });
    assert.equal(imp.status, 200); assert.equal(imp.body.added, 3); assert.equal(imp.body.duplicates, 1); assert.equal(imp.body.invalid.length, 1);
    assert.equal(d.db.prepare("SELECT kind FROM blocklist WHERE term = 'foo bar'").get().kind, 'celebrity');
    assert.equal((await j('POST', '/api/blocklist/import', { text: '   ' })).status, 400);
    const chk = await j('POST', '/api/blocklist/check', { text: 'a widget corp mug' });
    assert.deepEqual(chk.body.hits.map(h => h.term), ['widget corp']);
    // a removed seed term stays removed when a later seed version tops the table up
    await j('DELETE', '/api/blocklist?term=nike');
    d.db.prepare("DELETE FROM settings WHERE key = 'blocklist_seed_version'").run();
    bl.seedBlocklist(d.db, d.settings);
    assert.equal(d.db.prepare("SELECT COUNT(*) n FROM blocklist WHERE term = 'nike'").get().n, 0);
    assert.equal(d.db.prepare("SELECT COUNT(*) n FROM blocklist WHERE term = 'adidas'").get().n, 1);
  } finally { server.close(); }
});

test('the watcher and the playbook checks use the same matcher (variants included)', () => {
  const d = makeDeps();
  const { CHECKS } = require('../server/playbooks/checks');
  const p = d.pipeline.create({ brief: 'Spider-Man’s web pattern', listPrice: 20 });
  const r = CHECKS.blocklist_clean({ db: d.db, product: d.stages.get(p.id) });
  assert.equal(r.status, 'fail'); assert.match(r.detail, /spider-man/);
});
