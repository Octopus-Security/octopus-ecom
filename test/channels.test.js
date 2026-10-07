'use strict';
// Channels: Redbubble upload pack and limits, tag linter, listing state, sales import/entry into NET, owner-only routes, entrypoint.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { makeDeps, tmpDir, quiet } = require('./helpers');
const { buildApp } = require('../server/app');
const { buildAuth } = require('../server/auth');
const { openDb } = require('../server/db');
const { solidPng, readPngSize } = require('../server/png');
const { makeZip, crc32 } = require('../server/zip');
const rules = require('../server/domain/redbubble-rules');
const { assertChannel } = require('../server/channels/contract');
const { parseWorkUrl, TRANSITIONS } = require('../server/channels/state');
const { parseReport, parseMoney, parseDate } = require('../server/channels/redbubble-sales');
const { makeChannels } = require('../server/channels');
const { PLAYBOOKS } = require('../server/playbooks/definitions');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'redbubble-sales-ASSUMED-HEADERS.csv'), 'utf8');
const NOW = new Date().toISOString();

/** A tiny zip reader for the tests: checks every CRC and returns {name: Buffer}. */
function readZip(buf) {
  const out = {}; let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8); const crc = buf.readUInt32LE(i + 14); const size = buf.readUInt32LE(i + 18);
    const nl = buf.readUInt16LE(i + 26); const el = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nl).toString('utf8'); const start = i + 30 + nl + el;
    let data = buf.subarray(start, start + size); if (method === 8) data = zlib.inflateRawSync(data);
    assert.equal(crc32(data), crc, `crc of ${name}`);
    out[name] = data; i = start + size;
  }
  assert.equal(buf.readUInt32LE(i), 0x02014b50, 'central directory follows the entries');
  return out;
}

let server; let base; let d;
before(async () => {
  d = makeDeps({ IMAGE_UPSCALE: 'off' });
  server = await new Promise((r) => { const s = buildApp(d).listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
const j = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};

/** A product with a stored design of the given size and (optionally) Etsy copy. */
function seedProduct({ w = 800, h = 600, title = 'Fishing Is My Love Language', copy = true, native = null, extra = {} } = {}, deps = d) {
  const id = Number(deps.db.prepare('INSERT INTO products(stage,brief,title,keywords,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run('design_generated', 'a bass in a heart', title, JSON.stringify(['fishing gift']), NOW, NOW).lastInsertRowid);
  const dir = path.join(deps.dataDir, 'images'); fs.mkdirSync(dir, { recursive: true });
  const file = `t-${id}.png`; fs.writeFileSync(path.join(dir, file), solidPng(w, h));
  deps.db.prepare('INSERT INTO designs(product_id,image_path,prompt,width,height,cost_cents,model,created_at,native_width,native_height,source) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, file, 'p', w, h, 0, 'manual', NOW, native ? native[0] : null, native ? native[1] : null, 'manual');
  if (copy) deps.db.prepare("INSERT INTO listings(product_id,platform,title,tags,description,status,created_at) VALUES(?,'etsy',?,?,?,'draft',?)").run(id,
    'Fishing Is My Love Language Funny Fisherman Gift for Dad Bass Fishing Shirt Sticker Lover Humor Tee',
    JSON.stringify(['fishing gift', 'bass fishing', 'fisherman', 'fishing dad', 'funny fishing', 'angler gift', 'lake life', 'fishing shirt', 'outdoors', 'dad gift', 'fishing humor', 'catch and release', 'reel love']),
    'A funny bass-in-a-heart design for anglers who say it with fish.\nShips from the production partner in 3 to 5 days.\nReturns accepted on Etsy within 30 days.\nPrinted by Printify.', NOW);
  return id;
}

// ---- limits, adaptation, linter ---------------------------------------------------------------------------------------------
test('adaptCopy: title cut to 60 on a word boundary, <=15 tags of <=50 chars, Etsy wording dropped, description <=250', () => {
  const long = 'x'.repeat(300);
  const c = rules.adaptCopy({
    etsy: { title: 'Fishing Is My Love Language Funny Fisherman Gift for Dad Bass Fishing Shirt Sticker', tags: Array.from({ length: 13 }, (_, i) => `fishing tag ${i}`), description: `Great design for anglers.\nShips in 3 days from Etsy.\nReturns welcome.\n${long}` },
    keywords: ['lake life', 'lake life', 'Bass, Fishing'], brief: 'b',
  });
  assert.ok(c.title.length <= 60 && c.title.length > 20, c.title);
  assert.ok(!c.title.endsWith(' '));
  assert.ok(c.tags.length <= rules.LIMITS.maxTags && c.tags.every(t => t.length <= rules.LIMITS.maxTagLen + 30 && t.length <= 50));
  assert.equal(new Set(c.tags).size, c.tags.length, 'no duplicate tags');
  assert.ok(c.tags.every(t => !/[,;]/.test(t)), 'no separators inside a tag');
  assert.equal(c.mainTag, c.tags[0]); assert.deepEqual(c.supportingTags, c.tags.slice(1));
  assert.ok(c.description.length <= rules.LIMITS.descSafe);
  assert.ok(!/etsy|ships|returns/i.test(c.description), c.description);
  assert.ok(c.repairs.some(r => r.code === 'truncated_rb'));
  assert.ok(rules.lintCopy(c).ok, JSON.stringify(rules.lintCopy(c)));
});

test('adaptCopy with no Etsy copy falls back to title, brief and keywords and says so', () => {
  const c = rules.adaptCopy({ etsy: null, keywords: ['cat mom'], brief: 'a cat on a moon', productTitle: 'Moon Cat' });
  assert.equal(c.title, 'Moon Cat'); assert.ok(c.tags.includes('cat mom') && c.tags.includes('moon'));
  assert.ok(c.repairs.some(r => r.code === 'no_etsy_copy'));
  assert.equal(c.description, 'a cat on a moon');
});

test('lintCopy: every limit is an error or warning with a code', () => {
  const codes = (copy, o) => { const r = rules.lintCopy(copy, o); return { err: r.errors.map(e => e.code), warn: r.warnings.map(w => w.code), ok: r.ok }; };
  const good = { title: 'Fishing Love', tags: Array.from({ length: 12 }, (_, i) => `tag ${i}`), description: 'short' };
  assert.deepEqual(codes(good), { err: [], warn: [], ok: true });
  assert.ok(codes({ ...good, title: '' }).err.includes('title_empty'));
  assert.ok(codes({ ...good, title: 'x'.repeat(61) }).err.includes('title_too_long'));
  assert.ok(!codes({ ...good, title: 'x'.repeat(60) }).err.includes('title_too_long'));
  assert.ok(codes({ ...good, tags: [] }).err.includes('tags_empty'));
  assert.ok(codes({ ...good, tags: Array.from({ length: 16 }, (_, i) => `t${i}`) }).err.includes('tags_too_many'));
  assert.ok(!codes({ ...good, tags: Array.from({ length: 15 }, (_, i) => `t${i}`) }).err.includes('tags_too_many'));
  assert.ok(codes({ ...good, tags: ['a'.repeat(51)] }).err.includes('tag_too_long'));
  assert.ok(!codes({ ...good, tags: ['a'.repeat(50), 'b', 'c', 'd', 'e', 'f', 'g', 'h'] }).err.includes('tag_too_long'));
  assert.ok(codes({ ...good, tags: ['dup', 'DUP'] }).err.includes('tag_duplicate'));
  assert.ok(codes({ ...good, tags: ['a, b'] }).err.includes('tag_separator'));
  assert.ok(codes({ ...good, tags: ['a', 'b'] }).warn.includes('tags_few'));
  assert.ok(codes({ ...good, description: 'y'.repeat(300) }).warn.includes('description_long'));
  assert.ok(codes({ ...good, description: 'y'.repeat(501) }).err.includes('description_too_long'));
  assert.ok(codes({ ...good, description: 'Free shipping on Etsy' }).warn.includes('etsy_wording'));
  assert.ok(codes({ ...good, title: 'Fish 🎣' }).warn.includes('title_emoji'));
});

test('lintCopy: a blocklist hit is an error (same standard as Etsy)', () => {
  const brand = d.db.prepare("SELECT term FROM blocklist WHERE kind = 'brand' LIMIT 1").get().term;
  const r = rules.lintCopy({ title: `${brand} fan shirt`, tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], description: 'x' }, { db: d.db });
  assert.ok(r.errors.some(e => e.code === 'blocklist'), JSON.stringify(r));
});

test('product-type advice follows aspect ratio and real resolution; large format is judged on native pixels', () => {
  const by = (list, id) => list.find(a => a.id === id).status;
  const tall = rules.advise({ width: 3600, height: 5400 });
  assert.equal(by(tall, 'tshirt'), 'enable'); assert.equal(by(tall, 'sticker'), 'enable'); assert.equal(by(tall, 'phonecase'), 'enable');
  assert.equal(by(tall, 'mug'), 'disable', 'a portrait design does not suit a mug');
  assert.equal(by(tall, 'square'), 'disable', 'square products need a squarish design');
  const big = rules.advise({ width: 7632, height: 6480 });
  assert.equal(by(big, 'large'), 'enable'); assert.equal(by(big, 'square'), 'enable');
  const fake = rules.advise({ width: 7632, height: 6480, nativeWidth: 1536, nativeHeight: 1024 });
  assert.equal(by(fake, 'large'), 'disable', 'upscaled pixels do not count for large format');
  const tiny = rules.advise({ width: 500, height: 500 });
  assert.ok(tiny.every(a => a.status !== 'enable'), 'a 500px image enables nothing');
});

test('plannedSize never claims an upscale it cannot do', () => {
  assert.deepEqual(rules.plannedSize({ width: 800, height: 600, upscaleAvailable: false }), { width: 800, height: 600, upscaled: false });
  assert.deepEqual(rules.plannedSize({ width: 3600, height: 5400, upscaleAvailable: true }), { width: 4320, height: 6480, upscaled: true });
  assert.deepEqual(rules.plannedSize({ width: 8000, height: 7000, upscaleAvailable: true }), { width: 8000, height: 7000, upscaled: false });
});

// ---- zip ------------------------------------------------------------------------------------------------------------------
test('zip: round trip with valid CRCs; unsafe or duplicate names refused', () => {
  const z = readZip(makeZip([{ name: 'a.txt', data: 'héllo' }, { name: 'b.bin', data: Buffer.from([0, 1, 2, 255]) }]));
  assert.equal(z['a.txt'].toString('utf8'), 'héllo'); assert.deepEqual([...z['b.bin']], [0, 1, 2, 255]);
  assert.throws(() => makeZip([{ name: '../x', data: '' }]), /unsafe/);
  assert.throws(() => makeZip([{ name: '/x', data: '' }]), /unsafe/);
  assert.throws(() => makeZip([{ name: 'a', data: '' }, { name: 'a', data: '' }]), /duplicate/);
});

// ---- channel contract -----------------------------------------------------------------------------------------------------
test('capability flag: Etsy is api, Redbubble is manual; a manual channel must implement prepare and importSales', async () => {
  const reg = (await j('GET', '/api/channels')).body;
  const cap = Object.fromEntries(reg.channels.map(c => [c.id, c.capability]));
  assert.deepEqual(cap, { etsy: 'api', redbubble: 'manual' });
  for (const c of reg.channels) { assert.ok(c.automated.length && c.manual.length, c.id); for (const p of c.playbooks) assert.ok(PLAYBOOKS.some(x => x.id === p), `${c.id} links missing playbook ${p}`); }
  assert.throws(() => assertChannel({ id: 'x', label: 'X', capability: 'manual', automated: [], manual: [], playbooks: [] }), /prepare/);
  assert.throws(() => assertChannel({ id: 'x', label: 'X', capability: 'magic', automated: [], manual: [], playbooks: [] }), /capability/);
});

// ---- the pack ------------------------------------------------------------------------------------------------------------
test('pack JSON: adapted copy, lint, honest sizes, product types, markup 20, checklist, folder-view files', async () => {
  const id = seedProduct({ w: 3600, h: 5400 });
  const r = await j('GET', `/api/products/${id}/redbubble/pack`);
  assert.equal(r.status, 200);
  const p = r.body;
  assert.equal(p.capability, 'manual'); assert.equal(p.markupPct, 20);
  assert.ok(p.copy.title.length <= 60); assert.ok(p.copy.tags.length <= 15);
  assert.equal(p.lint.ok, true, JSON.stringify(p.lint));
  assert.deepEqual(p.image.stored, { width: 3600, height: 5400 });
  assert.equal(p.image.planned.upscaled, false, 'no upscaler configured in this app, so no claim of one');
  assert.ok(p.notes.some(n => /below Redbubble's recommended/.test(n)));
  assert.ok(p.productTypes.some(t => t.status === 'enable') && p.productTypes.some(t => t.status === 'disable'));
  assert.ok(p.checklist.length >= 10 && p.checklist.some(s => /Copy settings/.test(s.text)));
  assert.deepEqual(p.files.map(f => f.name).sort(), ['checklist.md', 'description.txt', 'markup.txt', 'product-types.txt', 'tags.txt', 'title.txt']);
  assert.equal(p.files.find(f => f.name === 'title.txt').text, p.copy.title);
  assert.equal(p.limits.maxTags, 15); assert.match(p.sources.tags, /corroborated/); assert.match(p.sources.title, /assumed/);
  assert.equal((await j('GET', `/api/products/${id}/redbubble/pack?markup=35`)).body.markupPct, 35);
});

test('pack JSON flags a lint error when the copy has a blocklist hit', async () => {
  const brand = d.db.prepare("SELECT term FROM blocklist WHERE kind = 'brand' LIMIT 1").get().term;
  const id = seedProduct({ title: `${brand} shirt`, copy: false });
  const p = (await j('GET', `/api/products/${id}/redbubble/pack`)).body;
  assert.equal(p.lint.ok, false); assert.ok(p.lint.errors.some(e => e.code === 'blocklist'));
  assert.ok(p.checklist.some(s => s.id === 'fix'));
});

test('pack zip: PNG + text files + pack.json, with the REAL pixel size', async () => {
  const id = seedProduct({ w: 640, h: 480 });
  const res = await fetch(`${base}/api/products/${id}/redbubble/pack.zip`);
  assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /zip/); assert.match(res.headers.get('content-disposition'), /redbubble-pack-\d+\.zip/);
  const z = readZip(Buffer.from(await res.arrayBuffer()));
  const names = Object.keys(z).sort();
  assert.ok(names.includes('pack.json') && names.includes('title.txt') && names.includes('tags.txt') && names.includes('description.txt') && names.includes('markup.txt') && names.includes('product-types.txt') && names.includes('checklist.md'));
  const png = names.find(n => n.endsWith('.png'));
  assert.ok(png, 'a PNG is in the pack');
  const sz = readPngSize(z[png]);
  assert.deepEqual([sz.width, sz.height], [640, 480]);
  assert.equal(png, `redbubble-${id}-640x480.png`, 'the file name carries the real size');
  const man = JSON.parse(z['pack.json'].toString());
  assert.deepEqual([man.image.width, man.image.height], [640, 480]); assert.equal(man.image.upscaled, false);
  assert.match(z['checklist.md'].toString(), new RegExp(png));
  assert.match(z['tags.txt'].toString(), /MAIN TAG/);
});

test('pack zip: an upscale is reported by what the hook REALLY produced, never by the plan', async () => {
  const dd = makeDeps({}, { upscale: async ({ png }) => { const s = readPngSize(png); return { png: solidPng(s.width * 2, s.height * 2), width: 99999, height: 99999, method: 'fake x2' }; } });
  const id = seedProduct({ w: 400, h: 300 }, dd);
  const ch = makeChannels({ db: dd.db, dataDir: dd.dataDir, upscale: async ({ png }) => { const s = readPngSize(png); return { png: solidPng(s.width * 2, s.height * 2), width: 99999, height: 99999, method: 'fake x2' }; }, log: quiet });
  assert.equal(ch.redbubble.pack(id).image.planned.upscaled, true);
  const z = await ch.redbubble.zip(id);
  const files = readZip(z.buffer);
  const png = Object.keys(files).find(n => n.endsWith('.png'));
  assert.equal(png, `redbubble-${id}-800x600.png`);
  assert.deepEqual([z.manifest.image.width, z.manifest.image.height], [800, 600]);
  assert.equal(z.manifest.image.upscaled, true); assert.equal(z.manifest.image.storedWidth, 400);
  assert.equal(z.manifest.image.detailWidth, 400, 'the detail that really exists is the stored size');
  // cached: a second call is identical and does not call the hook again
  const again = await ch.redbubble.image(id); assert.equal(again.width, 800);
});

test('pack: product with no design is 409; unknown product is 404', async () => {
  const id = Number(d.db.prepare('INSERT INTO products(stage,brief,created_at,updated_at) VALUES(?,?,?,?)').run('idea', 'b', NOW, NOW).lastInsertRowid);
  assert.equal((await j('GET', `/api/products/${id}/redbubble/pack`)).status, 409);
  assert.equal((await fetch(`${base}/api/products/${id}/redbubble/pack.zip`)).status, 409);
  assert.equal((await j('GET', '/api/products/99999/redbubble/pack')).status, 404);
});

// ---- listing state ---------------------------------------------------------------------------------------------------------
test('state transitions: not_listed -> uploaded -> live -> removed, with a URL for live and a note each time', async () => {
  const WORK = 'https://www.redbubble.com/i/sticker/State-Test-by-ExampleShop/22222222.EJUG5';
  const id = seedProduct();
  const st = async (state, extra = {}) => j('POST', `/api/products/${id}/channels/redbubble/state`, { state, ...extra });
  assert.equal((await j('GET', `/api/products/${id}/channels`)).body.states.redbubble.state, 'not_listed');
  assert.equal((await st('live', { url: WORK })).status, 409, 'cannot skip uploaded');
  assert.equal((await st('uploaded')).body.listing.state, 'uploaded');
  assert.equal((await st('live')).status, 400, 'live needs the URL');
  assert.equal((await st('live', { url: 'http://www.redbubble.com/i/x/1.2' })).status, 400, 'https only');
  assert.equal((await st('live', { url: 'https://evil.example/redbubble.com/11111111' })).status, 400, 'host must be redbubble.com');
  assert.equal((await st('live', { url: 'https://notredbubble.com/i/x/11111111.A' })).status, 400, 'a look-alike host is refused');
  const live = (await st('live', { url: WORK, title: 'Fishing Is My Love Language' })).body;
  assert.equal(live.listing.state, 'live'); assert.equal(live.listing.workId, '22222222'); assert.equal(live.listing.url, WORK);
  assert.equal((await st('uploaded')).status, 409, 'live cannot step back to uploaded');
  assert.equal((await st('removed')).body.listing.state, 'removed');
  assert.equal((await st('uploaded')).body.listing.state, 'uploaded', 're-upload after removal');
  assert.equal((await st('bogus')).status, 400);
  const notes = d.db.prepare("SELECT note FROM events WHERE product_id = ? AND kind = 'note'").all(id).map(e => e.note);
  assert.ok(notes.some(n => /redbubble: not_listed -> uploaded/.test(n)) && notes.some(n => /uploaded -> live/.test(n)) && notes.some(n => /live -> removed/.test(n)));
  assert.equal(d.db.prepare('SELECT stage FROM products WHERE id = ?').get(id).stage, 'design_generated', 'channel state never touches products.stage');
  const other = seedProduct();
  await j('POST', `/api/products/${other}/channels/redbubble/state`, { state: 'uploaded' });
  const clash = await j('POST', `/api/products/${other}/channels/redbubble/state`, { state: 'live', url: WORK });
  assert.equal(clash.status, 409); assert.equal(clash.body.code, 'url_in_use');
  assert.deepEqual(Object.keys(TRANSITIONS).sort(), ['live', 'not_listed', 'removed', 'uploaded']);
});

test('state: needs a design; Etsy is derived, not settable; unknown channel/product 404', async () => {
  const bare = Number(d.db.prepare('INSERT INTO products(stage,brief,created_at,updated_at) VALUES(?,?,?,?)').run('idea', 'b', NOW, NOW).lastInsertRowid);
  assert.equal((await j('POST', `/api/products/${bare}/channels/redbubble/state`, { state: 'uploaded' })).status, 409);
  const id = seedProduct();
  assert.equal((await j('POST', `/api/products/${id}/channels/etsy/state`, { state: 'live' })).status, 400);
  assert.equal((await j('POST', `/api/products/${id}/channels/teepublic/state`, { state: 'live' })).status, 404);
  assert.equal((await j('POST', '/api/products/99999/channels/redbubble/state', { state: 'uploaded' })).status, 404);
  assert.equal((await j('POST', `/api/products/${id}/channels/constructor/state`, { state: 'uploaded' })).status, 404, 'prototype keys are not channels');
  d.db.prepare("UPDATE products SET stage = 'live' WHERE id = ?").run(id);
  assert.equal((await j('GET', `/api/products/${id}/channels`)).body.states.etsy.state, 'live', 'Etsy state follows the stage');
});

test('board cards and product detail carry per-channel state', async () => {
  const id = seedProduct();
  await j('POST', `/api/products/${id}/channels/redbubble/state`, { state: 'uploaded' });
  const board = (await j('GET', '/api/products')).body;
  const card = Object.values(board.columns).flat().find(p => p.id === id);
  assert.deepEqual(card.channels, { etsy: 'not_listed', redbubble: 'uploaded' });
  const det = (await j('GET', `/api/products/${id}`)).body;
  assert.equal(det.channels.redbubble.state, 'uploaded'); assert.ok(det.salesByChannel);
});

test('parseWorkUrl accepts redbubble.com and its subdomains only', () => {
  assert.equal(parseWorkUrl('https://www.redbubble.com/i/t-shirt/X-by-Y/12345678.1YYVU?x=1#h').workId, '12345678');
  assert.equal(parseWorkUrl('https://redbubble.com/people/psychedapparel/works/12345678-title').workId, '12345678');
  assert.throws(() => parseWorkUrl('https://redbubble.com.evil.example/a'), /redbubble\.com/);
  assert.throws(() => parseWorkUrl('javascript:alert(1)'), /valid URL|https/);
});

// ---- sales -----------------------------------------------------------------------------------------------------------------
test('money, dates and CSV header mapping', () => {
  assert.equal(parseMoney('$1.23').cents, 123); assert.equal(parseMoney('US$ 1,234.50').cents, 123450); assert.equal(parseMoney('(1.23)').cents, -123);
  assert.equal(parseMoney('-0.5').cents, -50); assert.equal(parseMoney('1,23').cents, 123); assert.equal(parseMoney('£0.80').currency, 'GBP');
  assert.equal(parseMoney('abc').cents, null); assert.equal(parseMoney('').cents, null);
  assert.equal(parseDate('2026-09-03'), '2026-09-03'); assert.equal(parseDate('9/12/2026'), '2026-09-12'); assert.equal(parseDate('Sep 3, 2026'), '2026-09-03');
  assert.equal(parseDate('2026-02-31'), null); assert.equal(parseDate('nope'), null);
  const p = parseReport(FIXTURE);
  assert.equal(p.assumedHeaders, true, 'headers are always reported as assumed');
  assert.deepEqual(p.headerMap, { date: 'Order Date', orderId: 'Order Number', title: 'Work Title', productType: 'Product', quantity: 'Quantity', margin: 'Artist Margin', currency: 'Currency', workUrl: 'Work URL' });
  assert.equal(p.rows.length, 4);
  assert.deepEqual(p.skipped.map(s => s.line), [6, 7, 8]);
  assert.match(p.skipped[0].reason, /GBP/); assert.match(p.skipped[1].reason, /date/); assert.match(p.skipped[2].reason, /margin/);
  assert.equal(p.rows[2].title, 'Cozy Cabin, Winter Edition', 'quoted comma survives'); assert.equal(p.rows[2].marginCents, 100050);
  const bad = parseReport('foo,bar\n1,2\n'); assert.ok(bad.fatal && /date and margin/.test(bad.fatal));
  assert.ok(parseReport('Sale Date;Artist Margin\n2026-01-01;$1.00\n').rows.length === 1, 'semicolon delimiter');
});

const WORK = 'https://www.redbubble.com/i/sticker/Fishing-Is-My-Love-Language-by-ExampleShop/11111111.EJUG5';
test('import: preview writes nothing; import attributes to the redbubble channel and reaches NET and per-product figures', async () => {
  const id = seedProduct();
  await j('POST', `/api/products/${id}/channels/redbubble/state`, { state: 'uploaded' });
  await j('POST', `/api/products/${id}/channels/redbubble/state`, { state: 'live', url: WORK, title: 'Fishing Is My Love Language' });
  const before = (await j('GET', '/api/summary')).body;
  const pre = await j('POST', '/api/sales/redbubble/import', { csv: FIXTURE, preview: true });
  assert.equal(pre.status, 200); assert.equal(pre.body.preview, true); assert.equal(pre.body.assumedHeaders, true);
  assert.equal(pre.body.parsed, 4); assert.equal(pre.body.skipped.length, 3); assert.equal(pre.body.wouldMatch, 2);
  assert.equal(d.db.prepare("SELECT COUNT(*) AS n FROM sales WHERE channel = 'redbubble'").get().n, 0, 'preview wrote nothing');
  const run = await j('POST', '/api/sales/redbubble/import', { csv: FIXTURE });
  assert.equal(run.status, 200); assert.equal(run.body.imported, 4); assert.equal(run.body.duplicates, 0); assert.equal(run.body.matched, 2); assert.equal(run.body.unmatched, 2);
  assert.equal(run.body.totalCents, 96 + 240 + 100050 + 110);
  const after = (await j('GET', '/api/summary')).body;
  assert.equal(after.netCents - before.netCents, 96 + 240 + 100050 + 110, 'every imported line reaches NET');
  assert.equal(after.revenue.grossCents - before.revenue.grossCents, 96 + 240 + 100050 + 110);
  assert.equal(after.channels.redbubble.orders, 4); assert.equal(after.channels.redbubble.afterFeesCents, 100496);
  const det = (await j('GET', `/api/products/${id}`)).body;
  assert.equal(det.salesByChannel.redbubble.netAfterFeesCents, 336, 'per-product figure, attributed to the channel');
  assert.equal(det.salesByChannel.etsy, undefined);
  const row = d.db.prepare("SELECT * FROM sales WHERE channel = 'redbubble' AND product_id = ? ORDER BY id").get(id);
  assert.equal(row.source, 'redbubble'); assert.equal(row.gross_cents, row.net_cents); assert.equal(row.etsy_fees_cents, 0); assert.equal(row.cogs_cents, null); assert.equal(row.external_listing_id, '11111111');
  assert.equal(d.db.prepare("SELECT COUNT(*) AS n FROM costs WHERE note LIKE '%R-100%'").get().n, 0, 'no COGS is invented');
  const list = (await j('GET', '/api/sales')).body;
  assert.ok(list.sales.some(s => s.channel === 'redbubble' && s.productId === id));
});

test('import is idempotent: the same file, or an overlapping one, adds nothing twice', async () => {
  const again = (await j('POST', '/api/sales/redbubble/import', { csv: FIXTURE })).body;
  assert.equal(again.imported, 0); assert.equal(again.duplicates, 4);
  const noIds = 'Date,Title,Artist Margin\n2026-10-01,Some Work,$1.00\n2026-10-01,Some Work,$1.00\n';
  const first = (await j('POST', '/api/sales/redbubble/import', { csv: noIds })).body;
  assert.equal(first.imported, 2, 'two identical lines without an order id are two sales');
  const second = (await j('POST', '/api/sales/redbubble/import', { csv: noIds })).body;
  assert.equal(second.imported, 0); assert.equal(second.duplicates, 2);
  const grown = (await j('POST', '/api/sales/redbubble/import', { csv: `${noIds}2026-10-01,Some Work,$1.00\n` })).body;
  assert.equal(grown.imported, 1, 'a third identical line in a later export is new');
});

test('import: unusable files and bad input are 400, nothing is stored', async () => {
  const n = () => d.db.prepare('SELECT COUNT(*) AS n FROM sales').get().n; const c = n();
  assert.equal((await j('POST', '/api/sales/redbubble/import', {})).status, 400);
  assert.equal((await j('POST', '/api/sales/redbubble/import', { csv: '' })).status, 400);
  const r = await j('POST', '/api/sales/redbubble/import', { csv: 'a,b\n1,2' });
  assert.equal(r.status, 400); assert.equal(r.body.code, 'unreadable_csv'); assert.deepEqual(r.body.unmatchedHeaders, ['a', 'b']);
  assert.equal(n(), c);
});

test('manual entry: feeds NET against the product, validates, and refuses a repeated order id', async () => {
  const id = seedProduct({ title: 'Entry Product' });
  const before = (await j('GET', '/api/summary')).body.netCents;
  const ok = await j('POST', '/api/sales/redbubble/entry', { productId: id, date: '2026-10-05', margin: '$2.50', orderId: 'M-1' });
  assert.equal(ok.status, 201); assert.equal(ok.body.marginCents, 250);
  assert.equal((await j('GET', '/api/summary')).body.netCents - before, 250);
  assert.equal((await j('GET', `/api/products/${id}`)).body.salesByChannel.redbubble.netAfterFeesCents, 250);
  assert.equal((await j('POST', '/api/sales/redbubble/entry', { productId: id, date: '2026-10-05', margin: 2.5, orderId: 'M-1' })).status, 409);
  const byTitle = await j('POST', '/api/sales/redbubble/entry', { title: 'entry product', date: '2026-10-06', margin: 1 });
  assert.equal(byTitle.body.productId, id, 'matched by title');
  assert.equal((await j('POST', '/api/sales/redbubble/entry', { productId: id, date: 'tomorrow', margin: 1 })).status, 400);
  assert.equal((await j('POST', '/api/sales/redbubble/entry', { productId: id, date: '2026-10-05', margin: 'lots' })).status, 400);
  assert.equal((await j('POST', '/api/sales/redbubble/entry', { productId: id, date: '2026-10-05' })).status, 400);
  assert.equal((await j('POST', '/api/sales/redbubble/entry', { productId: id, date: '2026-10-05', margin: 1, quantity: 0 })).status, 400);
  assert.equal((await j('POST', '/api/sales/redbubble/entry', { productId: 99999, date: '2026-10-05', margin: 1 })).status, 404);
  const neg = await j('POST', '/api/sales/redbubble/entry', { productId: id, date: '2026-10-05', margin: -1, orderId: 'M-ADJ' });
  assert.equal(neg.status, 201, 'an adjustment may be negative');
});

test('Etsy sales are untouched: they keep channel etsy, and simulated lines stay out of channel revenue', async () => {
  d.db.prepare("INSERT INTO sales(external_order_id,transaction_id,gross_cents,net_cents,source,ts) VALUES('sim','1',999,900,'stub',?)").run(NOW);
  const s = (await j('GET', '/api/summary')).body;
  assert.ok(s.simulated.orders > 0);
  assert.equal(s.channels.etsy, undefined, 'stub (simulated) Etsy lines never enter real channel revenue');
  assert.equal(d.db.prepare("SELECT channel FROM sales WHERE external_order_id = 'sim'").get().channel, 'etsy', 'old and new Etsy lines default to the etsy channel');
});

// ---- owner-only ------------------------------------------------------------------------------------------------------------
test('every new route is owner-only: signed out 401, non-owner 403, owner passes (same codes as the existing routes)', async () => {
  const cfgSso = { ...d.cfg, authMode: 'sso', owners: ['boss'] };
  const id = seedProduct();
  const mk = (user) => buildAuth(cfgSso, { ssoFactory: () => (req, _res, next) => { if (user) req.user = user; next(); }, log: { warn() {} } });
  const routes = [
    ['GET', '/api/channels'], ['GET', `/api/products/${id}/channels`],
    ['POST', `/api/products/${id}/channels/redbubble/state`, { state: 'uploaded' }],
    ['GET', `/api/products/${id}/redbubble/pack`], ['GET', `/api/products/${id}/redbubble/pack.zip`], ['GET', `/api/products/${id}/redbubble/design.png`],
    ['POST', '/api/sales/redbubble/import', { csv: 'Date,Artist Margin\n2026-01-01,$1\n', preview: true }],
    ['POST', '/api/sales/redbubble/entry', { productId: id, date: '2026-10-05', margin: 1 }],
  ];
  const writes = []; const dbg = { ...d, db: d.db };
  for (const [user, want] of [[null, 401], [{ username: 'rando' }, 403], [{ username: 'boss' }, 200]]) {
    const app = buildApp({ ...dbg, auth: mk(user) });
    const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
    for (const [method, url, body] of routes) {
      const res = await fetch(`http://127.0.0.1:${s.address().port}${url}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
      if (want === 200) assert.ok(res.status === 200 || res.status === 201, `${method} ${url} as owner -> ${res.status}`);
      else assert.equal(res.status, want, `${method} ${url} as ${JSON.stringify(user)}`);
      writes.push(res.status);
    }
    s.close();
  }
  assert.equal(d.db.prepare("SELECT state FROM channel_listings WHERE product_id = ?").all(id).length, 1, 'only the owner run wrote anything');
  assert.equal(d.db.prepare("SELECT COUNT(*) AS n FROM sales WHERE channel = 'redbubble' AND product_id = ? AND source = 'redbubble'").get(id).n, 1);
});

test('cross-origin writes to the new routes are refused', async () => {
  const id = seedProduct();
  for (const [url, body] of [[`/api/products/${id}/channels/redbubble/state`, { state: 'uploaded' }], ['/api/sales/redbubble/entry', { productId: id, date: '2026-10-05', margin: 1 }], ['/api/sales/redbubble/import', { csv: 'x' }]]) {
    const r = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify(body) });
    assert.equal(r.status, 403, url);
  }
});

// ---- migration and entrypoint --------------------------------------------------------------------------------------------
test('migration is additive and safe to rerun: existing rows survive, columns and table appear once', () => {
  const file = path.join(tmpDir(), 'old.db');
  const db = openDb(file);
  db.prepare("INSERT INTO products(stage,brief,created_at,updated_at) VALUES('idea','keep me',?,?)").run(NOW, NOW);
  db.prepare("INSERT INTO sales(external_order_id,transaction_id,gross_cents,net_cents,ts) VALUES('o','t',500,450,?)").run(NOW);
  db.close();
  for (let i = 0; i < 3; i++) {
    const again = openDb(file);
    assert.equal(again.prepare('SELECT brief FROM products').get().brief, 'keep me');
    assert.equal(again.prepare('SELECT channel FROM sales').get().channel, 'etsy', 'old rows default to etsy');
    assert.equal(again.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('sales') WHERE name = 'channel'").get().n, 1);
    assert.ok(again.prepare("SELECT 1 FROM sqlite_master WHERE name = 'channel_listings'").get());
    again.close();
  }
});

test('the entrypoint still loads and assembles an app that serves the channel routes', async () => {
  const m = require('../server/index.js');
  assert.equal(typeof m.assemble, 'function');
  const { app } = m.assemble({ DATA_DIR: tmpDir() }, { dbFile: ':memory:', warn() {}, out: quiet });
  const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  try {
    const res = await fetch(`http://127.0.0.1:${s.address().port}/api/channels`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).channels.length, 2);
  } finally { s.close(); }
});

test('playbooks: the five Redbubble playbooks exist, are unique, and say assumed where nothing was read', () => {
  const ids = ['redbubble-revive', 'redbubble-publish', 'redbubble-weekly', 'redbubble-takedown', 'redbubble-game-plan'];
  for (const id of ids) { const p = PLAYBOOKS.find(x => x.id === id); assert.ok(p, id); assert.ok(p.steps.length >= 8, id); assert.match(p.background, /assumed, unverified/, id); assert.ok(fs.existsSync(path.join(__dirname, '..', 'docs', 'playbooks', `${id}.md`))); }
  assert.match(PLAYBOOKS.find(x => x.id === 'redbubble-game-plan').background, /Day 30/);
  assert.match(PLAYBOOKS.find(x => x.id === 'redbubble-game-plan').background, /Day 90/);
});

test('no Redbubble code logs in, drives a browser or fetches redbubble.com (terms forbid automation)', () => {
  const files = ['server/channels/redbubble.js', 'server/channels/redbubble-sales.js', 'server/channels/state.js', 'server/channels/index.js', 'server/routes/channels.js', 'server/domain/redbubble-rules.js'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/\bfetch\s*\(|require\(['"](?:node:)?https?['"]\)|puppeteer|playwright|selenium|\bhttp\.(?:get|request)/.test(src), `${f} makes network calls or drives a browser`);
  }
});
