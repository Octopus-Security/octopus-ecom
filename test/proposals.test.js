'use strict';
// Proposals: generation (stub and a fake model), lint and risk surfaced, blocklist refusal, approve -> IDEA product, edit-and-approve,
// reject feedback, season windows and "too late", snooze, regenerate, the weekly digest (off by default), owner-only and cross-origin
// refusal on every mutating route, an additive migration, and the real entrypoint.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeDeps, tmpDir, quiet } = require('./helpers');
const { buildApp } = require('../server/app');
const { buildAuth } = require('../server/auth');
const { openDb } = require('../server/db');
const seasons = require('../server/domain/seasons');
const risk = require('../server/domain/proposal-risk');
const { makeProposals } = require('../server/proposals/service');
const { templateProposals, EVERGREEN, STYLES, COMPOSITIONS } = require('../server/proposals/templates');
const { scanFields } = require('../server/domain/blocklist');
const { GUARD } = require('../server/domain/prompts');
const { PLAYBOOKS } = require('../server/playbooks/definitions');
const { CHECKS } = require('../server/playbooks/checks');

const NOON = (iso) => () => new Date(`${iso}T16:00:00Z`);
let clock = new Date('2026-10-06T16:00:00Z');
const depsAt = (iso, env = {}) => makeDeps(env, { nowDate: NOON(iso) });
const svcWith = (d, llm, now = () => clock) => makeProposals({ db: d.db, settings: d.settings, spend: d.spend, llm, adapters: d.adapters, pipeline: d.pipeline, confirm: d.confirm, watch: d.watch, cfg: d.cfg, log: quiet, now });

/** A model that answers with canned JSON and records every call. */
function fakeLlm(respond) {
  const calls = [];
  return { calls, describe: () => ({ provider: 'openai', routing: {} }), async complete(a) { calls.push(a); const r = await respond(a, calls.length); return { model: 'fake-model', costCents: 0, ...r, text: typeof r.text === 'string' ? r.text : JSON.stringify(r.proposals ? { proposals: r.proposals } : r) }; } };
}
const good = (o = {}) => ({
  concept: 'A hand-drawn ink heron standing in reeds at dawn, calm and minimal.', rationale: 'Birdwatching is on your seed list.', signalsUsed: ['birdwatching'], productType: 'tshirt', season: null, theme: 'heron at dawn',
  keywords: ['heron', 'bird lover', 'nature gift'], brief: 'A single heron in tall reeds at dawn, ink and wash, muted teal and cream palette, centred composition, no text.',
  title: 'Heron At Dawn Bird Lover Tee Nature Gift', tags: ['heron', 'bird lover', 'nature gift', 'bird watching', 'heron tee', 'wading bird', 'nature tee', 'ink art', 'birder gift', 'reeds', 'dawn', 'calm', 'bird shirt'],
  description: 'A calm, hand-drawn heron at dawn, printed on demand. A gift for anyone who loves watching birds.', originalityCheck: { passes: true, concerns: '' }, ...o,
});

let server; let base; let d;
before(async () => {
  d = makeDeps({}, { nowDate: () => clock });
  server = await new Promise((r) => { const s = buildApp(d).listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
const j = async (method, url, body, headers = {}) => {
  const r = await fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// ---- seasons -------------------------------------------------------------------------------------------------------------
test('holiday dates are right for known years (calendar rules, not lookups)', () => {
  assert.equal(seasons.easter(2026), '2026-04-05'); assert.equal(seasons.easter(2027), '2027-03-28');
  const d26 = Object.fromEntries(seasons.HOLIDAYS.map(h => [h.id, h.rule(2026)]));
  assert.equal(d26['mothers-day'], '2026-05-10'); assert.equal(d26['fathers-day'], '2026-06-21'); assert.equal(d26.thanksgiving, '2026-11-26'); assert.equal(d26.christmas, '2026-12-25');
});

test('season window: last order = date - production - shipping - buffer, list by = last order - ramp, and the status follows today', () => {
  const w = seasons.windowFor('christmas', '2026-10-06');
  assert.equal(w.lastOrder, '2026-12-07'); assert.equal(w.listBy, '2026-11-16'); assert.equal(w.status, 'open'); assert.equal(w.tooLate, false);
  assert.equal(seasons.windowFor('christmas', '2026-11-20').status, 'tight');
  const late = seasons.windowFor('christmas', '2026-12-20');
  assert.equal(late.tooLate, true); assert.equal(late.status, 'too_late'); assert.equal(late.next.date, '2027-12-25'); assert.match(late.summary, /TOO LATE/);
  assert.equal(seasons.windowFor('christmas', '2026-12-26').tooLate, false, 'after the holiday the next occurrence is next year: open, not late');
  const custom = seasons.windowFor('christmas', '2026-10-06', seasons.resolveLead({ shippingDays: 20 }));
  assert.equal(custom.lastOrder, '2026-11-27');
  assert.throws(() => seasons.resolveLead({ shippingDays: -1 }), /shippingDays/); assert.throws(() => seasons.resolveLead({ nope: 1 }), /unknown/);
});

test('ET is the clock: 02:00 UTC on the 7th is still the 6th in New York', () => {
  assert.equal(seasons.etToday(new Date('2026-10-07T02:00:00Z')), '2026-10-06');
  assert.equal(seasons.etToday(new Date('2026-10-07T05:00:00Z')), '2026-10-07');
});

test('occasion text maps to holidays by whole-word alias and unknown text matches nothing', () => {
  assert.deepEqual(seasons.matchOccasion("Father's Day"), ['fathers-day']); assert.deepEqual(seasons.matchOccasion('xmas gifts'), ['christmas']);
  assert.deepEqual(seasons.matchOccasion('mouse'), []); assert.deepEqual(seasons.matchOccasion('camping trip'), []);
});

// ---- risk and copy -------------------------------------------------------------------------------------------------------
test('risk: blocklist hit, "inspired by" wording and a failed model self-check each BLOCK; lint errors and too-late only ask for a review', () => {
  assert.equal(risk.assess(d.db, { concept: 'a pikachu portrait' }).level, 'blocked');
  const ph = risk.assess(d.db, { concept: 'a mountain scene inspired by a popular shop' }); assert.equal(ph.level, 'blocked'); assert.equal(ph.phrases[0].phrase, 'inspired by');
  assert.equal(risk.assess(d.db, { concept: 'a quiet mountain' }, { modelCheck: { ran: true, passes: false, concerns: 'looks like a team logo' } }).level, 'blocked');
  assert.equal(risk.assess(d.db, { concept: 'a quiet mountain' }, { tooLate: true }).level, 'review');
  assert.equal(risk.assess(d.db, { concept: 'a quiet mountain' }, { lintErrors: 1 }).level, 'review');
  assert.equal(risk.assess(d.db, { concept: 'a quiet mountain' }).level, 'clear');
});

test('the originality self-check prompt names every refusal class', () => {
  const t = risk.originalityPrompt({ concept: 'c', brief: 'b', etsyTitle: 't', etsyTags: ['x'], etsyDescription: 'd' });
  for (const w of ['brand', 'character', 'celebrit', 'team', 'slogan', 'inspired by <seller or shop>', 'FAIL', 'PASS']) assert.match(t, new RegExp(w.replace(/[<>]/g, '.')), w);
});

test('the template vocabulary contains nothing on the blocklist', () => {
  for (const t of [...EVERGREEN, ...STYLES.flat(), ...COMPOSITIONS]) assert.deepEqual(scanFields(d.db, { t }), [], t);
});

// ---- generation with the stub --------------------------------------------------------------------------------------------
test('stub generation: N original proposals with every required field, deterministic, estimates labelled, no spend', async () => {
  const a = await depsAt('2026-10-06').proposals.generate({ count: 4, seeds: { themes: 'fishing, trout', occasions: 'halloween', audiences: 'dad' } });
  const b = await depsAt('2026-10-06').proposals.generate({ count: 4, seeds: { themes: 'fishing, trout', occasions: 'halloween', audiences: 'dad' } });
  assert.equal(a.proposals.length, 4);
  assert.deepEqual(a.proposals.map(p => p.concept), b.proposals.map(p => p.concept), 'same inputs, same proposals');
  assert.equal(new Set(a.proposals.map(p => p.concept)).size, 4);
  assert.equal(a.run.source, 'template'); assert.equal(a.run.costCents, 0);
  for (const p of a.proposals) {
    assert.equal(p.status, 'pending'); assert.ok(p.concept && p.rationale && p.brief && p.etsyDescription);
    assert.ok(p.productType); assert.ok(p.blueprintNote);
    assert.equal(p.etsyTags.length, 13); assert.ok(p.etsyTags.every(t => t.length <= 20)); assert.ok(p.etsyTitle.length <= 140);
    assert.ok(p.signals.some(s => s.source === 'seed'), 'names the signals it came from');
    assert.ok(p.imagePrompt.includes(GUARD), 'the image prompt reuses designPrompt/manualPrompt'); assert.match(p.imagePrompt, /Target: \d+x\d+ px/);
    assert.ok(p.rbTitle.length <= 60 && p.rbTags.length > 0); assert.ok(p.lint.etsy && p.lint.redbubble);
    assert.equal(p.estimate, true); assert.match(p.estimateNote, /ESTIMATE/); assert.ok(Number.isInteger(p.priceCents) && p.priceCents % 100 === 99);
    assert.ok(p.marginCents > 0 && p.marginBreakdown.feeLines.length); assert.ok(['assumed_table', 'catalog_median_estimate'].includes(p.baseCostSource));
    assert.equal(p.season, 'halloween'); assert.ok(p.seasonWindow.lastOrder); assert.equal(typeof p.tooLate, 'boolean');
    assert.match(p.risk.selfCheckPrompt, /FAIL/); assert.equal(p.riskLevel, 'clear');
  }
  assert.equal(a.proposals.find(p => p.productType === 'tshirt').blueprint, 'stub-tee', 'a tee matches the stub catalog by title');
});

test('with nothing seeded the stub still produces evergreen proposals, and the product-type filter is honoured', async () => {
  const r = await depsAt('2026-10-06').proposals.generate({ count: 3, productTypes: ['mug'] });
  assert.equal(r.proposals.length, 3); assert.ok(r.proposals.every(p => p.productType === 'mug' && p.blueprint === 'stub-mug'));
  assert.ok(r.proposals.every(p => p.signals.length === 0 || p.signals.every(s => s.source !== 'evergreen')));
  await assert.rejects(() => depsAt('2026-10-06').proposals.generate({ count: 2, productTypes: ['spaceship'] }), /unknown product type/);
  await assert.rejects(() => depsAt('2026-10-06').proposals.generate({ count: 999 }), /capped/);
});

test('a blocklisted theme, occasion or audience seed is REFUSED before anything is made or spent', async () => {
  const x = depsAt('2026-10-06');
  for (const seeds of [{ themes: 'nike running' }, { occasions: 'pokemon party' }, { audiences: 'mickey mouse fans' }]) {
    await assert.rejects(() => x.proposals.generate({ count: 2, seeds }), (e) => e.name === 'ProposalError' && e.status === 422 && e.code === 'seed_blocklisted');
  }
  assert.equal(x.db.prepare('SELECT COUNT(*) AS n FROM proposals').get().n, 0); assert.equal(x.db.prepare('SELECT COUNT(*) AS n FROM proposal_runs').get().n, 0);
  const r = await j('POST', '/api/proposals/generate', { count: 2, seeds: { themes: 'nike running' } });
  assert.equal(r.status, 422); assert.equal(r.body.code, 'seed_blocklisted');
});

// ---- a (fake) model: prompt, cost, lint and risk surfaced -------------------------------------------------------------------
test('model path: the prompt carries date, seasons, seeds and signals; cost is recorded under the cap; the tier is cheap or standard', async () => {
  const x = depsAt('2026-10-06');
  x.db.prepare("INSERT INTO watchlist(kind,term,notes,active,created_at,updated_at) VALUES('theme','birdwatching','my own note',1,'t','t')").run();
  x.db.prepare("INSERT INTO alerts(kind,severity,message,created,acknowledged) VALUES('trend_signal','info','birdwatching: interest rising in autumn',?,0)").run(new Date().toISOString());
  const llm = fakeLlm(() => ({ proposals: [good()], costCents: 3 }));
  const svc = svcWith(x, llm, NOON('2026-10-06'));
  const r = await svc.generate({ count: 1, seeds: { themes: 'herons', occasions: 'halloween', audiences: 'birders' } });
  const call = llm.calls[0];
  assert.ok(['cheap', 'standard'].includes(call.tier)); assert.equal(call.json, true);
  assert.match(call.prompt, /Today \(ET\): 2026-10-06/); assert.match(call.prompt, /halloween: Halloween 2026-10-31/); assert.match(call.prompt, /herons/);
  assert.match(call.prompt, /birdwatching: interest rising in autumn/, 'a stored trend_signal alert reaches the prompt'); assert.match(call.prompt, /\[watchlist\]/);
  assert.match(call.system, /FAIL|never output a proposal with passes=false/); assert.match(call.system, /brand/); assert.match(call.system, /inspired by/);
  assert.equal(r.run.source, 'llm'); assert.equal(r.run.model, 'fake-model'); assert.equal(r.run.costCents, 3);
  assert.equal(x.db.prepare("SELECT SUM(amount_cents) AS c FROM costs WHERE kind = 'llm'").get().c, 3, 'cost recorded through the existing spend tracking');
  assert.equal(r.proposals[0].signals.length, 1); assert.equal(r.proposals[0].signals[0].term, 'birdwatching'); assert.equal(r.proposals[0].signals[0].source, 'watchlist');
  assert.equal(r.proposals[0].source, 'llm'); assert.equal(r.proposals[0].model, 'fake-model');
});

test('model path: a spent daily cap refuses the call before it is made (429 through the shared handler)', async () => {
  const x = depsAt('2026-10-06');
  x.settings.set('daily_spend_cap_cents', 0);
  const llm = fakeLlm(() => ({ proposals: [good()] }));
  await assert.rejects(() => svcWith(x, llm, NOON('2026-10-06')).generate({ count: 1 }), (e) => e.name === 'SpendCapError');
  assert.equal(llm.calls.length, 0); assert.equal(x.db.prepare('SELECT COUNT(*) AS n FROM proposals').get().n, 0);
});

test('lint failures are surfaced, not hidden: repaired Etsy text becomes warnings, a Redbubble error needs a review', async () => {
  const x = depsAt('2026-10-06');
  const bad = good({ title: 'Heron 🦩 Tee 🦩 Gift & Gift & Gift', tags: ['heron', 'heron', 'a tag that is far too long for etsy', 'bird 🦩', ...Array.from({ length: 12 }, (_, i) => `tag number ${i}`)] });
  const r = await svcWith(x, fakeLlm(() => ({ proposals: [bad] })), NOON('2026-10-06')).generate({ count: 1 });
  const codes = r.proposals[0].lint.etsy.warnings.map(w => w.code);
  for (const c of ['repaired_chars_removed', 'repaired_dropped_duplicate', 'repaired_dropped_too_long', 'repaired_dropped_extra']) assert.ok(codes.includes(c), `${c} in ${codes}`);
  assert.equal(r.proposals[0].etsyTags.length, 13); assert.ok(!/🦩/.test(r.proposals[0].etsyTitle));
  const id = r.proposals[0].id;
  const p = await x.proposals.update(id, { rbTitle: 'x'.repeat(90) });
  assert.equal(p.lint.redbubble.ok, false); assert.ok(p.lint.redbubble.errors.some(e => e.code === 'title_too_long'));
  assert.equal(p.riskLevel, 'review'); assert.ok(p.risk.reasons.some(s => /listing-rule error/.test(s)));
  assert.equal(p.rbEdited, true);
  const back = await x.proposals.update(id, { rbEdited: false });
  assert.equal(back.lint.redbubble.ok, true, 're-deriving from the Etsy copy clears the Redbubble error');
});

test('model output that is branded, "inspired by", self-failed, duplicate or unusable is dropped and counted; nothing blocked is stored', async () => {
  const x = depsAt('2026-10-06');
  const items = [good(), good({ concept: 'A cute pikachu with a lightning bolt on a yellow background.', brief: 'pikachu on yellow, flat vector, centred, no text.', title: 'Cute Tee' }),
    good({ concept: 'A mountain sunrise inspired by a best-selling shop design with bold lines.', theme: 'mountain', title: 'Mountain Sunrise Tee' }),
    good({ concept: 'A tidy fern pattern with soft greens and a hand-printed feel.', theme: 'ferns', title: 'Fern Print Tee', originalityCheck: { passes: false, concerns: 'resembles a known logo' } }),
    good(), { concept: 'short' }, 'nonsense'];
  const r = await svcWith(x, fakeLlm((_a, n) => ({ proposals: n === 1 ? items : [] })), NOON('2026-10-06')).generate({ count: 7 });
  assert.equal(r.proposals.length, 1); assert.equal(r.run.droppedBlocklist, 3); assert.equal(r.run.droppedDuplicate, 1); assert.ok(r.run.droppedOther >= 2);
  assert.equal(x.db.prepare('SELECT COUNT(*) AS n FROM proposals').get().n, 1);
  assert.equal(r.proposals[0].riskLevel, 'clear');
});

test('a model that returns nothing usable stores nothing and says so (502), rather than faking proposals', async () => {
  const x = depsAt('2026-10-06');
  await assert.rejects(() => svcWith(x, fakeLlm(() => ({ text: 'sorry, I cannot' })), NOON('2026-10-06')).generate({ count: 2 }), (e) => e.name === 'ProposalError' && e.status === 502 && e.code === 'no_usable_proposals');
  assert.equal(x.db.prepare('SELECT COUNT(*) AS n FROM proposals').get().n, 0);
});

test('signals: a blocklisted watchlist term is dropped, a competitor-shaped live signal is rejected without crashing, the echo stub is not used', async () => {
  const x = depsAt('2026-10-06');
  x.db.prepare("INSERT INTO watchlist(kind,term,notes,active,created_at,updated_at) VALUES('keyword','pikachu',' ',1,'t','t'),('keyword','sailing',' ',1,'t','t')").run();
  const svc = svcWith(x, fakeLlm(() => ({ proposals: [] })), NOON('2026-10-06'));
  const sig = await svc.collectSignals({ themes: [], occasions: [], audiences: [] }, { liveSignals: false });
  assert.deepEqual(sig.signals.map(s => s.term), ['sailing']); assert.match(sig.notes.join(' '), /blocklisted/);
  const evil = { name: 'evil', check: async () => [{ message: 'hot', listing: 'https://competitor/x', price: 5 }] };
  const live = makeProposals({ db: x.db, settings: x.settings, spend: x.spend, llm: fakeLlm(() => ({})), adapters: x.adapters, pipeline: x.pipeline, confirm: x.confirm, watch: { trendSource: evil }, cfg: x.cfg, log: quiet, now: NOON('2026-10-06') });
  const out = await live.collectSignals({ themes: [], occasions: [], audiences: [] }, { liveSignals: true });
  assert.match(out.notes.join(' '), /rejected|failed/); assert.ok(!out.signals.some(s => s.message === 'hot'));
  const ok = { name: 'ok', check: async (e) => [{ message: `${e.term} is trending`, severity: 'warn' }] };
  const live2 = makeProposals({ db: x.db, settings: x.settings, spend: x.spend, llm: fakeLlm(() => ({})), adapters: x.adapters, pipeline: x.pipeline, confirm: x.confirm, watch: { trendSource: ok }, cfg: x.cfg, log: quiet, now: NOON('2026-10-06') });
  assert.ok((await live2.collectSignals({ themes: [], occasions: [], audiences: [] }, { liveSignals: true })).signals.some(s => s.message === 'sailing is trending' && s.source === 'trend-signal'));
});

// ---- the season "too late" flag ------------------------------------------------------------------------------------------------
test('too late: a proposal for a season whose last order date has passed is flagged, points at next year, and needs a review to approve', async () => {
  const x = depsAt('2026-12-20');
  const r = await x.proposals.generate({ count: 2, seeds: { themes: 'snow owls', occasions: 'christmas' } });
  for (const p of r.proposals) {
    assert.equal(p.season, 'christmas'); assert.equal(p.tooLate, true); assert.equal(p.seasonWindow.status, 'too_late'); assert.equal(p.seasonWindow.next.date, '2027-12-25');
    assert.equal(p.riskLevel, 'review'); assert.ok(p.risk.reasons.some(s => /season window/.test(s)));
  }
  assert.match(r.run.notes.join(' '), /TOO LATE/);
  const gate = await x.proposals.approve(r.proposals[0].id);
  assert.equal(gate.needsConfirm, true); assert.match(gate.summary, /season window/);
  assert.equal(x.db.prepare('SELECT status FROM proposals WHERE id = ?').get(r.proposals[0].id).status, 'pending', 'asking changed nothing');
  const done = await x.proposals.approve(r.proposals[0].id, { token: gate.token });
  assert.equal(done.product.stage, 'idea');
  assert.equal(depsAt('2026-10-06').proposals.config().seasons.find(s => s.holiday === 'christmas').status, 'open');
});

// ---- approve -> IDEA product -----------------------------------------------------------------------------------------------------
test('approve creates an IDEA-stage product through the existing pipeline with brief, keywords, blueprint, price and tags carried over', async () => {
  const x = depsAt('2026-10-06');
  const p = (await x.proposals.generate({ count: 1, productTypes: ['tshirt'], seeds: { themes: 'trail running', audiences: 'runners' } })).proposals[0];
  const out = await x.proposals.approve(p.id);
  assert.equal(out.needsConfirm, undefined, 'a clean proposal approves without a confirm');
  const prod = out.product;
  assert.equal(prod.stage, 'idea'); assert.equal(prod.brief, p.brief); assert.equal(prod.niche, p.theme);
  assert.deepEqual(JSON.parse(prod.keywords), p.keywords.slice(0, 30)); assert.equal(prod.blueprint, 'stub-tee'); assert.equal(prod.print_provider_id, 'stub-pp');
  assert.equal(prod.list_price_cents, p.priceCents); assert.ok(prod.print_spec, 'selectPod ran: the print area is known');
  const l = x.db.prepare("SELECT * FROM listings WHERE product_id = ? AND platform = 'etsy' AND status = 'draft'").get(prod.id);
  assert.deepEqual(JSON.parse(l.tags), p.etsyTags); assert.equal(l.title, p.etsyTitle); assert.equal(l.description, p.etsyDescription); assert.equal(prod.title, p.etsyTitle);
  const after = x.db.prepare('SELECT * FROM proposals WHERE id = ?').get(p.id);
  assert.equal(after.status, 'approved'); assert.equal(after.product_id, prod.id); assert.ok(after.decided_at);
  assert.ok(x.db.prepare("SELECT 1 FROM events WHERE product_id = ? AND kind = 'note' AND note LIKE ?").get(prod.id, `%proposal #${p.id}%`), 'a note on the product timeline');
  assert.ok(x.db.prepare("SELECT 1 FROM events WHERE kind = 'system' AND note LIKE ?").get(`%proposal #${p.id} approved%`), 'and a system event');
  assert.equal(x.db.prepare("SELECT stage_to FROM events WHERE product_id = ? AND kind = 'stage'").all(prod.id).map(r => r.stage_to).join(), 'idea', 'the stage was written by stages.js, once');
  await assert.rejects(() => x.proposals.approve(p.id), (e) => e.status === 409 && e.code === 'not_pending');
  assert.equal(x.db.prepare('SELECT COUNT(*) AS n FROM products').get().n, 1, 'never a second product');
});

test('edit then approve: inline edits are validated, re-derive the margin, prompt and Redbubble copy, and are what the product gets', async () => {
  const x = depsAt('2026-10-06');
  const p = (await x.proposals.generate({ count: 1, productTypes: ['tshirt'], seeds: { themes: 'sourdough' } })).proposals[0];
  const edited = await x.proposals.update(p.id, { brief: 'A loaf of sourdough with a wheat-stalk border, two-colour linocut, no text.', etsyTitle: 'Sourdough Baker Linocut Tee Gift For Bread Lovers', price: 31.5 });
  assert.equal(edited.priceCents, 3150); assert.notEqual(edited.marginCents, p.marginCents); assert.match(edited.imagePrompt, /wheat-stalk border/); assert.equal(edited.promptEdited, false);
  assert.equal(edited.rbTitle, 'Sourdough Baker Linocut Tee Gift For Bread Lovers'.slice(0, 60)); assert.equal(edited.baseCostSource, p.baseCostSource);
  await assert.rejects(() => x.proposals.update(p.id, { price: -3 }), /price must be dollars/); await assert.rejects(() => x.proposals.update(p.id, { status: 'approved' }), /unknown field/);
  await assert.rejects(() => x.proposals.update(p.id, { productType: 'spaceship' }), /productType/);
  const out = await x.proposals.approve(p.id, { edits: { etsyTags: 'sourdough, bread lover, baker gift, linocut tee', concept: 'A linocut loaf with a wheat border.' } });
  assert.equal(out.product.brief, edited.brief); assert.equal(out.product.list_price_cents, 3150); assert.equal(out.product.title, 'Sourdough Baker Linocut Tee Gift For Bread Lovers');
  assert.deepEqual(JSON.parse(x.db.prepare('SELECT tags FROM listings WHERE product_id = ?').get(out.product.id).tags), ['sourdough', 'bread lover', 'baker gift', 'linocut tee']);
  await assert.rejects(() => x.proposals.update(p.id, { concept: 'late edit' }), (e) => e.status === 409);
});

test('an edit that brings in a brand makes the proposal BLOCKED: approval is refused (422) until it is edited clean', async () => {
  const x = depsAt('2026-10-06');
  const p = (await x.proposals.generate({ count: 1, seeds: { themes: 'sailing' } })).proposals[0];
  const bad = await x.proposals.update(p.id, { etsyTitle: 'Nike Style Sailing Tee' });
  assert.equal(bad.riskLevel, 'blocked'); assert.ok(bad.risk.blocklist.some(h => h.term === 'nike'));
  await assert.rejects(() => x.proposals.approve(p.id), (e) => e.status === 422 && e.code === 'risk_blocked');
  assert.equal(x.db.prepare('SELECT COUNT(*) AS n FROM products').get().n, 0);
  await x.proposals.update(p.id, { etsyTitle: 'Sailing Boat Tee' });
  assert.equal((await x.proposals.approve(p.id)).product.stage, 'idea');
});

// ---- reject, snooze, regenerate ------------------------------------------------------------------------------------------------------
test('reject stores the reason and the NEXT generation is told "the owner didn\'t like" it; rejected ideas are not proposed again', async () => {
  const x = depsAt('2026-10-06');
  const first = (await x.proposals.generate({ count: 2, seeds: { themes: 'owls' } })).proposals;
  const r = x.proposals.reject(first[0].id, { reason: 'too cutesy, I want something moodier' });
  assert.equal(r.status, 'rejected'); assert.equal(r.rejectReason, 'too cutesy, I want something moodier');
  assert.equal(x.db.prepare('SELECT reject_reason FROM proposals WHERE id = ?').get(first[0].id).reject_reason, 'too cutesy, I want something moodier');
  assert.match(x.proposals.rejectionFeedback().join('\n'), /the owner didn't like: too cutesy, I want something moodier/);
  const llm = fakeLlm(() => ({ proposals: [good()] }));
  await svcWith(x, llm, NOON('2026-10-06')).generate({ count: 1, seeds: { themes: 'owls' } });
  assert.match(llm.calls[0].prompt, /OWNER FEEDBACK/); assert.match(llm.calls[0].prompt, /the owner didn't like: too cutesy, I want something moodier/); assert.ok(llm.calls[0].prompt.includes(first[0].concept.slice(0, 40)));
  const again = (await x.proposals.generate({ count: 3, seeds: { themes: 'owls' } })).proposals.map(p => p.concept);
  assert.ok(!again.includes(first[0].concept), 'the rejected concept does not come back');
  assert.throws(() => x.proposals.reject(first[0].id, {}), (e) => e.status === 409);
});

test('snooze hides a proposal until its date (ET), then it is pending again; bad dates are refused', async () => {
  let now = new Date('2026-10-06T16:00:00Z');
  const x = makeDeps({}, { nowDate: () => now });
  const p = (await x.proposals.generate({ count: 1, seeds: { themes: 'kayaks' } })).proposals[0];
  assert.throws(() => x.proposals.snooze(p.id, { until: '2026-10-06' }), /after today/); assert.throws(() => x.proposals.snooze(p.id, { until: 'tomorrow' }), /YYYY-MM-DD/);
  const s = x.proposals.snooze(p.id, { until: '2026-10-10' });
  assert.equal(s.status, 'snoozed'); assert.equal(x.proposals.list({ status: 'pending' }).proposals.length, 0); assert.equal(x.proposals.list({ status: 'snoozed' }).proposals.length, 1);
  now = new Date('2026-10-09T16:00:00Z'); assert.equal(x.proposals.list({ status: 'pending' }).proposals.length, 0);
  now = new Date('2026-10-10T16:00:00Z'); assert.equal(x.proposals.list({ status: 'pending' }).proposals.length, 1, 'woke on the date');
  assert.equal(x.proposals.snooze(p.id, { until: '2026-11-01' }).status, 'snoozed'); assert.equal(x.proposals.unsnooze(p.id).status, 'pending');
});

test('regenerate replaces one pending proposal in place (same id and product type) and refuses a decided one', async () => {
  const x = depsAt('2026-10-06');
  const [a, b] = (await x.proposals.generate({ count: 2, productTypes: ['mug'], seeds: { themes: 'lighthouses' } })).proposals;
  const n = await x.proposals.regenerate(a.id);
  assert.equal(n.id, a.id); assert.equal(n.status, 'pending'); assert.equal(n.productType, 'mug'); assert.notEqual(n.concept, a.concept); assert.notEqual(n.concept, b.concept);
  assert.equal(x.db.prepare('SELECT COUNT(*) AS n FROM proposals').get().n, 2);
  x.proposals.reject(b.id, {});
  await assert.rejects(() => x.proposals.regenerate(b.id), (e) => e.status === 409);
});

// ---- the weekly digest ------------------------------------------------------------------------------------------------------------------
test('weekly digest: OFF by default and does nothing; ON it generates once a week, never twice a day, and skips a backlog', async () => {
  let now = new Date('2026-10-06T16:00:00Z');
  const x = makeDeps({}, { nowDate: () => now });
  assert.equal(x.proposals.getSettings().weeklyEnabled, false); assert.equal(x.settings.get('proposals_weekly_enabled'), 'false');
  assert.deepEqual(await x.proposals.weeklyTick(), { skipped: 'disabled' }); assert.equal(x.db.prepare('SELECT COUNT(*) AS n FROM proposals').get().n, 0);
  x.proposals.setSettings({ weeklyEnabled: true, weeklyCount: 2, weeklySeeds: { themes: 'beekeeping' } });
  const t1 = await x.proposals.weeklyTick(); assert.equal(t1.ran, true); assert.equal(t1.produced, 2);
  assert.equal(x.db.prepare("SELECT trigger FROM proposal_runs").get().trigger, 'weekly');
  assert.ok(x.db.prepare('SELECT concept FROM proposals').all().some(r => /beekeeping/.test(r.concept)));
  assert.match((await x.proposals.weeklyTick()).skipped, /already tried today/);
  now = new Date('2026-10-09T16:00:00Z'); assert.match((await x.proposals.weeklyTick()).skipped, /last 7 days/);
  now = new Date('2026-10-14T16:00:00Z'); assert.equal((await x.proposals.weeklyTick()).ran, true);
  now = new Date('2026-10-21T16:00:00Z'); x.proposals.setSettings({ weeklyCount: 1 });
  for (let i = 0; i < 6; i++) x.db.prepare("INSERT INTO proposals(status,concept,created_at,updated_at) VALUES('pending','filler',?,?)").run(now.toISOString(), now.toISOString());
  assert.match((await x.proposals.weeklyTick()).skipped, /backlog/);
  assert.equal(x.proposals.digestInfo().enabled, true);
});

test('the digest route generates a fresh batch on demand from the saved settings; settings validate', async () => {
  assert.equal((await j('POST', '/api/proposals/settings', { weeklyCount: 0 })).status, 400);
  assert.equal((await j('POST', '/api/proposals/settings', { nope: 1 })).status, 400);
  assert.equal((await j('POST', '/api/proposals/settings', { leadTime: { shippingDays: -4 } })).status, 400);
  const s = await j('POST', '/api/proposals/settings', { weeklyCount: 2, weeklySeeds: { themes: 'kites' } });
  assert.equal(s.status, 200); assert.equal(s.body.settings.weeklyEnabled, false);
  const r = await j('POST', '/api/proposals/digest', {});
  assert.equal(r.status, 201); assert.equal(r.body.proposals.length, 2); assert.equal(r.body.run.trigger, 'digest'); assert.match(r.body.digest.text, /Weekly generation is OFF/);
  assert.equal((await j('GET', '/api/proposals/digest')).body.pending >= 2, true);
});

test('the weekly-proposals playbook exists, its check hook reads the queue, and docs/playbooks is in step', () => {
  const p = PLAYBOOKS.find(x => x.id === 'weekly-proposals'); assert.ok(p && p.steps.length >= 6); assert.match(p.background, /assumed, unverified/); assert.match(p.background, /OFF by default/);
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'docs', 'playbooks', 'weekly-proposals.md')));
  const db = openDb(':memory:'); const old = new Date(Date.now() - 9 * 86400000).toISOString();
  assert.equal(CHECKS.proposals_reviewed({ db }).status, 'pass');
  db.prepare("INSERT INTO proposals(status,created_at,updated_at) VALUES('pending',?,?)").run(old, old);
  assert.equal(CHECKS.proposals_reviewed({ db }).status, 'fail');
});

// ---- HTTP: shapes, owner-only, cross-origin ------------------------------------------------------------------------------------------------
test('HTTP round trip: generate, list, patch, snooze, reject, regenerate, approve with the confirm step', async () => {
  const g = await j('POST', '/api/proposals/generate', { count: 3, productTypes: ['tshirt'], seeds: { themes: 'kites, tide pools', occasions: 'christmas' } });
  assert.equal(g.status, 201); const ids = g.body.proposals.map(p => p.id);
  const l = await j('GET', '/api/proposals?status=pending'); assert.ok(l.body.proposals.length >= 3); assert.ok(l.body.counts.pending >= 3);
  assert.equal((await j('GET', '/api/proposals?status=bogus')).status, 400); assert.equal((await j('GET', '/api/proposals/999999')).status, 404);
  assert.equal((await j('PATCH', `/api/proposals/${ids[0]}`, { price: 22 })).body.proposal.priceCents, 2200);
  assert.equal((await j('PATCH', `/api/proposals/${ids[0]}`, { price: 'abc' })).status, 400);
  assert.equal((await j('POST', `/api/proposals/${ids[1]}/snooze`, { until: '2027-01-02' })).body.proposal.status, 'snoozed');
  assert.equal((await j('POST', `/api/proposals/${ids[1]}/snooze`, {})).status, 400);
  assert.equal((await j('POST', `/api/proposals/${ids[2]}/reject`, { reason: 'meh' })).body.proposal.rejectReason, 'meh');
  assert.equal((await j('POST', `/api/proposals/${ids[0]}/regenerate`, {})).body.proposal.id, ids[0]);
  const ap = await j('POST', `/api/proposals/${ids[0]}/approve`, {});
  assert.equal(ap.status, 201); assert.equal(ap.body.product.stage, 'idea');
  assert.equal((await j('POST', `/api/proposals/${ids[0]}/approve`, {})).status, 409);
  assert.equal((await j('POST', `/api/proposals/${ids[2]}/approve`, {})).status, 409, 'rejected');
  const cfg = await j('GET', '/api/proposals/config'); assert.equal(cfg.status, 200); assert.ok(cfg.body.seasons.length && cfg.body.productTypes.length); assert.equal(cfg.body.llm.stub, true);
});

test('approve over HTTP: a proposal that needs a review answers {needsConfirm, token, summary} and executes nothing; a wrong token is refused', async () => {
  clock = new Date('2026-12-20T16:00:00Z');
  try {
    const g = await j('POST', '/api/proposals/generate', { count: 1, seeds: { themes: 'owls', occasions: 'christmas' } });
    const id = g.body.proposals[0].id; assert.equal(g.body.proposals[0].tooLate, true);
    const first = await j('POST', `/api/proposals/${id}/approve`, {});
    assert.equal(first.status, 200); assert.equal(first.body.needsConfirm, true); assert.ok(first.body.token);
    const before = d.db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
    const bad = await j('POST', `/api/proposals/${id}/approve`, { token: 'nope' }); assert.equal(bad.status, 409);
    assert.equal(d.db.prepare('SELECT COUNT(*) AS n FROM products').get().n, before);
    const g2 = await j('POST', `/api/proposals/${id}/approve`, {}); const ok = await j('POST', `/api/proposals/${id}/approve`, { token: g2.body.token });
    assert.equal(ok.status, 201); assert.equal(ok.body.product.stage, 'idea');
  } finally { clock = new Date('2026-10-06T16:00:00Z'); }
});

const MUTATING = (id) => [
  ['POST', '/api/proposals/generate', { count: 1, seeds: { themes: 'owls' } }], ['POST', '/api/proposals/digest', {}], ['POST', '/api/proposals/settings', { weeklyCount: 3 }],
  ['PATCH', `/api/proposals/${id}`, { price: 20 }], ['POST', `/api/proposals/${id}/snooze`, { until: '2027-02-01' }], ['POST', `/api/proposals/${id}/unsnooze`, {}],
  ['POST', `/api/proposals/${id}/regenerate`, {}], ['POST', `/api/proposals/${id}/reject`, { reason: 'x' }], ['POST', `/api/proposals/${id}/approve`, {}],
];
const READS = ['/api/proposals', '/api/proposals/config', '/api/proposals/runs', '/api/proposals/settings', '/api/proposals/digest'];

test('every new route is owner-only: signed out 401, non-owner 403, owner passes (same codes as the existing routes); only the owner wrote anything', async () => {
  const cfgSso = { ...d.cfg, authMode: 'sso', owners: ['boss'] };
  const mk = (user) => buildAuth(cfgSso, { ssoFactory: () => (req, _res, next) => { if (user) req.user = user; next(); }, log: { warn() {} } });
  const writeCount = () => d.db.prepare('SELECT (SELECT COUNT(*) FROM proposals) + (SELECT COUNT(*) FROM proposal_runs) + (SELECT COUNT(*) FROM events) + (SELECT COUNT(*) FROM settings) AS n').get().n;
  for (const [user, want] of [[null, 401], [{ username: 'rando' }, 403], [{ username: 'boss' }, 'ok']]) {
    const mkId = Number(d.db.prepare("INSERT INTO proposals(status,concept,brief,etsy_title,created_at,updated_at) VALUES('pending','c','b','t',?,?)").run('t', 't').lastInsertRowid);
    const app = buildApp({ ...d, auth: mk(user) });
    const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
    const urls = READS.map(u => ['GET', u]).concat(MUTATING(mkId));
    const before = writeCount();
    for (const [method, url, body] of urls) {
      const res = await fetch(`http://127.0.0.1:${s.address().port}${url}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
      if (want === 'ok') assert.ok([200, 201, 409, 422].includes(res.status), `${method} ${url} as owner -> ${res.status}`);
      else assert.equal(res.status, want, `${method} ${url} as ${JSON.stringify(user)}`);
    }
    if (want !== 'ok') assert.equal(writeCount(), before, `nothing written for ${JSON.stringify(user)}`);
    s.close();
  }
});

test('cross-origin writes to every mutating proposals route are refused (403)', async () => {
  const id = Number(d.db.prepare("INSERT INTO proposals(status,concept,brief,etsy_title,created_at,updated_at) VALUES('pending','c','b','t',?,?)").run('t', 't').lastInsertRowid);
  const before = d.db.prepare('SELECT COUNT(*) AS n FROM proposals').get().n;
  for (const [method, url, body] of MUTATING(id)) {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify(body) });
    assert.equal(r.status, 403, `${method} ${url}`);
  }
  assert.equal(d.db.prepare('SELECT COUNT(*) AS n FROM proposals').get().n, before); assert.equal(d.db.prepare('SELECT status FROM proposals WHERE id = ?').get(id).status, 'pending');
});

// ---- migration, entrypoint, guardrails ---------------------------------------------------------------------------------------------------------
test('migration is additive and safe to rerun: old rows survive, the new tables appear once, proposals rows survive a reopen', () => {
  const file = path.join(tmpDir(), 'old.db');
  const db = openDb(file);
  db.prepare("INSERT INTO products(stage,brief,created_at,updated_at) VALUES('idea','keep me','t','t')").run();
  db.prepare("INSERT INTO proposals(status,concept,created_at,updated_at) VALUES('pending','keep me too','t','t')").run();
  const cols = db.prepare("SELECT name FROM pragma_table_info('proposals')").all().map(c => c.name);
  db.close();
  for (let i = 0; i < 3; i++) {
    const again = openDb(file);
    assert.equal(again.prepare('SELECT brief FROM products').get().brief, 'keep me');
    assert.equal(again.prepare('SELECT concept FROM proposals').get().concept, 'keep me too');
    assert.equal(again.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('proposals','proposal_runs')").get().n, 2);
    assert.deepEqual(again.prepare("SELECT name FROM pragma_table_info('proposals')").all().map(c => c.name), cols);
    again.close();
  }
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'db.js'), 'utf8');
  assert.ok(!/DROP\s+TABLE|DELETE\s+FROM\s+proposals|force:\s*true/i.test(src), 'db.js never drops or resets');
});

test('the entrypoint still loads, assembles an app that serves the proposals routes, and wires the weekly tick without starting it on require', async () => {
  const m = require('../server/index.js');
  const built = m.assemble({ DATA_DIR: tmpDir() }, { dbFile: ':memory:', warn() {}, out: quiet });
  assert.equal(typeof built.deps.proposals.weeklyTick, 'function');
  const s = await new Promise((r) => { const x = built.app.listen(0, '127.0.0.1', () => r(x)); });
  try {
    const res = await fetch(`http://127.0.0.1:${s.address().port}/api/proposals`);
    assert.equal(res.status, 200); assert.equal((await res.json()).counts.pending, 0);
    const gen = await fetch(`http://127.0.0.1:${s.address().port}/api/proposals/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: 2 }) });
    assert.equal(gen.status, 201);
  } finally { s.close(); }
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(src, /proposals\.weeklyTick/);
});

test('proposals code fetches nothing, drives no browser, and never writes products.stage', () => {
  const dir = path.join(__dirname, '..', 'server', 'proposals');
  for (const f of [...fs.readdirSync(dir).map(x => path.join(dir, x)), path.join(__dirname, '..', 'server', 'routes', 'proposals.js'), path.join(__dirname, '..', 'server', 'domain', 'proposal-risk.js'), path.join(__dirname, '..', 'server', 'domain', 'seasons.js')]) {
    const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/\bfetch\s*\(|require\(['"](?:node:)?https?['"]\)|puppeteer|playwright|\bhttp\.(?:get|request)|adapters\.http/.test(src), `${path.basename(f)} makes network calls`);
    assert.ok(!/UPDATE\s+products\s+SET[^;]*\bstage\b/i.test(src), `${path.basename(f)} writes products.stage`);
  }
});

test('the template generator is pure: no I/O, same arguments give the same output', () => {
  const args = { count: 5, subjects: [{ term: 'herons', source: 'seed' }], audiences: ['birders'], types: ['mug', 'tshirt'], seasonIds: [], seasonalPool: [], windows: {}, today: '2026-10-06', avoid: [] };
  assert.deepEqual(templateProposals(args), templateProposals(args));
  assert.equal(new Set(templateProposals(args).map(p => p.concept)).size, 5);
});
