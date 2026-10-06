'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeDeps } = require('./helpers');
const { STAGES, S, TRANSITIONS, StageError, approvalSummary } = require('../server/domain/stages');

const fresh = (env) => { const d = makeDeps(env); return { ...d, make: (o) => d.stages.createProduct(o) }; };

// Move a product to `stage` along the shortest legal path, as a human.
const PATH = [S.IDEA, S.DESIGN, S.MOCKUP, S.DRAFTED, S.PENDING, S.APPROVED, S.PUBLISHED, S.LIVE];
function put(d, p, stage) {
  if (stage === S.FAILED) return d.stages.transition(p.id, S.FAILED, { actor: 'agent', note: 'x' });
  if (stage === S.REJECTED) return d.stages.transition(p.id, S.REJECTED, { actor: 'human' });
  if (stage === S.ARCHIVED) return d.stages.transition(p.id, S.ARCHIVED, { actor: 'human' });
  for (const s of PATH.slice(1, PATH.indexOf(stage) + 1)) p = d.stages.transition(p.id, s, { actor: 'human' });
  return p;
}

test('the table covers every stage and only references known stages', () => {
  assert.deepEqual(Object.keys(TRANSITIONS).sort(), [...STAGES].sort());
  for (const tos of Object.values(TRANSITIONS)) for (const t of tos) assert.ok(STAGES.includes(t));
});

test('every legal transition succeeds and writes an events row', () => {
  for (const from of STAGES) for (const to of TRANSITIONS[from]) {
    const d = fresh();
    const p = put(d, d.make({ brief: 'b' }), from);
    assert.equal(p.stage, from);
    const before = d.db.prepare('SELECT COUNT(*) AS n FROM events WHERE product_id = ?').get(p.id).n;
    const out = d.stages.transition(p.id, to, { actor: 'human', note: to === S.FAILED ? 'boom' : 'n' });
    assert.equal(out.stage, to, `${from} -> ${to}`);
    const ev = d.db.prepare('SELECT * FROM events WHERE product_id = ? ORDER BY id DESC LIMIT 1').get(p.id);
    assert.equal(ev.stage_from, from); assert.equal(ev.stage_to, to); assert.equal(ev.actor, 'human');
    assert.equal(d.db.prepare('SELECT COUNT(*) AS n FROM events WHERE product_id = ?').get(p.id).n, before + 1);
  }
});

test('every illegal transition throws and leaves the product and events untouched', () => {
  for (const from of STAGES) for (const to of STAGES) {
    if (TRANSITIONS[from].includes(to)) continue;
    const d = fresh();
    const p = put(d, d.make({}), from);
    const n = d.db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
    assert.throws(() => d.stages.transition(p.id, to, { actor: 'human', note: 'x' }), (e) => e instanceof StageError && e.code === 'illegal', `${from} -> ${to}`);
    assert.equal(d.stages.get(p.id).stage, from);
    assert.equal(d.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, n);
  }
});

test('publish requires approved: from PENDING_APPROVAL (even with DRY_RUN on) it throws', () => {
  const d = fresh();
  const p = put(d, d.make({}), S.PENDING);
  assert.equal(d.dryRun.isOn(), true);
  assert.throws(() => d.stages.transition(p.id, S.PUBLISHED, { actor: 'human' }), /Illegal transition PENDING_APPROVAL -> published/);
  for (const from of [S.IDEA, S.DESIGN, S.MOCKUP, S.DRAFTED]) {
    const q = put(d, d.make({}), from);
    assert.throws(() => d.stages.transition(q.id, S.PUBLISHED, { actor: 'agent' }), StageError);
  }
  // and the only way in is through approved
  const a = d.stages.transition(p.id, S.APPROVED, { actor: 'human' });
  assert.equal(d.stages.transition(a.id, S.PUBLISHED, { actor: 'human' }).stage, S.PUBLISHED);
});

test('failed needs a reason, records it, and failed -> idea is the retry', () => {
  const d = fresh();
  const p = put(d, d.make({}), S.DESIGN);
  assert.throws(() => d.stages.transition(p.id, S.FAILED, { actor: 'agent', note: '  ' }), /reason/);
  const f = d.stages.transition(p.id, S.FAILED, { actor: 'agent', note: 'image API 500' });
  assert.equal(f.failed_reason, 'image API 500'); assert.equal(f.failed_from, S.DESIGN);
  const r = d.stages.transition(p.id, S.IDEA, { actor: 'human', note: 'retry' });
  assert.equal(r.failed_reason, null);
});

test('bad actor and unknown product/stage are rejected', () => {
  const d = fresh();
  const p = d.make({});
  assert.throws(() => d.stages.transition(p.id, S.DESIGN, { actor: 'robot' }), /Actor/);
  assert.throws(() => d.stages.transition(p.id, 'nope', { actor: 'human' }), /Unknown stage/);
  assert.throws(() => d.stages.transition(999, S.DESIGN, { actor: 'human' }), /not found/);
});

// ---- approval rules for the agent ----
function pendingWith(d, { autopublish, flags }) {
  const storeId = Number(d.db.prepare("INSERT INTO stores(platform,name,autopublish,created_at) VALUES('etsy','s',?,?)").run(autopublish ? 1 : 0, new Date().toISOString()).lastInsertRowid);
  const p = put(d, d.make({ storeId }), S.PENDING);
  if (flags) d.db.prepare('UPDATE products SET flags = ? WHERE id = ?').run(JSON.stringify(flags), p.id);
  return p;
}

test('agent cannot approve while DRY_RUN is on, even with autopublish and no flags', () => {
  const d = fresh();
  const p = pendingWith(d, { autopublish: true });
  assert.throws(() => d.stages.transition(p.id, S.APPROVED, { actor: 'agent' }), (e) => e.code === 'approval_required' && /DRY_RUN is on/.test(e.message));
});

test('agent cannot approve without store autopublish, or with no store', () => {
  const d = fresh({ DRY_RUN: 'false' });
  const p = pendingWith(d, { autopublish: false });
  assert.throws(() => d.stages.transition(p.id, S.APPROVED, { actor: 'agent' }), /autopublish is off/);
  const q = put(d, d.make({}), S.PENDING);
  assert.throws(() => d.stages.transition(q.id, S.APPROVED, { actor: 'agent' }), /autopublish is off/);
});

test('agent cannot approve a flagged product; a human can', () => {
  const d = fresh({ DRY_RUN: 'false' });
  const p = pendingWith(d, { autopublish: true, flags: [{ code: 'blocklist_hit', detail: 'nike' }] });
  assert.throws(() => d.stages.transition(p.id, S.APPROVED, { actor: 'agent' }), /flagged \(blocklist_hit\)/);
  assert.equal(d.stages.transition(p.id, S.APPROVED, { actor: 'human' }).stage, S.APPROVED);
  assert.match(approvalSummary(d.stages.get(p.id)), /FLAGGED: blocklist_hit \(nike\)/);
});

test('agent MAY approve only when autopublish && !dryRun && no flags', () => {
  const d = fresh({ DRY_RUN: 'false' });
  assert.equal(d.dryRun.isOn(), false);
  const p = pendingWith(d, { autopublish: true });
  const out = d.stages.transition(p.id, S.APPROVED, { actor: 'agent', note: 'autopublish' });
  assert.equal(out.stage, S.APPROVED);
  assert.equal(d.db.prepare('SELECT actor FROM events WHERE product_id = ? ORDER BY id DESC LIMIT 1').get(p.id).actor, 'agent');
});

test('the agent can always move a draft to PENDING_APPROVAL (batch stops there)', () => {
  const d = fresh();
  const p = put(d, d.make({}), S.DRAFTED);
  assert.equal(d.stages.transition(p.id, S.PENDING, { actor: 'agent' }).stage, S.PENDING);
});

test('nothing outside domain/stages.js writes products.stage', () => {
  const root = path.join(__dirname, '..', 'server');
  const offenders = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.js') && path.relative(root, f) !== path.join('domain', 'stages.js')) {
        const src = fs.readFileSync(f, 'utf8');
        if (/UPDATE\s+products\s+SET[^;`'"]*\bstage\s*=/i.test(src) || /INSERT\s+INTO\s+products\s*\([^)]*\bstage\b/i.test(src)) offenders.push(path.relative(root, f));
      }
    }
  })(root);
  assert.deepEqual(offenders, []);
});
