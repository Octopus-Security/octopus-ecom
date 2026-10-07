'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { openDb } = require('../server/db');
const { makeSettings } = require('../server/settings');
const { seedBlocklist } = require('../server/domain/blocklist');
const { ensureWatchSchema } = require('../server/watch/schema');
const { PLAYBOOKS, byId } = require('../server/playbooks/definitions');
const { CHECKS, runCheck } = require('../server/playbooks/checks');
const { createPlaybookRouter } = require('../server/playbooks/routes');
const { files } = require('../server/playbooks/render-md');

const NOW = new Date().toISOString();
const REQUIRED = ['redbubble-revive', 'redbubble-publish', 'redbubble-weekly', 'redbubble-takedown', 'redbubble-game-plan', 'launch-pod-etsy', 'out-of-stock', 'margin-fell', 'misprint-return-refund', 'views-no-sales', 'seasonal-prep', 'ip-complaint', 'dropshipping', 'weekly-trend-review'];

test('required playbooks exist, with unique step ids and valid check names', () => {
  for (const id of REQUIRED) assert.ok(byId(id), id);
  for (const p of PLAYBOOKS) {
    assert.ok(p.title && p.whenToUse && p.steps.length >= 4, p.id);
    const ids = p.steps.map(s => s.id);
    assert.equal(new Set(ids).size, ids.length, `${p.id} duplicate step id`);
    for (const s of p.steps) if (s.check) assert.ok(CHECKS[s.check], `${p.id}.${s.id} unknown check ${s.check}`);
  }
});

test('alert-linked playbook ids in the watchers exist', () => {
  const dir = path.join(__dirname, '..', 'server', 'watch');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
    for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/playbookId:\s*(?:[^'\n]*\?\s*)?'([a-z-]+)'/g)) assert.ok(byId(m[1]), `${f} links missing playbook ${m[1]}`);
  }
});

test('docs/playbooks/*.md match the definitions (run render-md.js after editing)', () => {
  const dir = path.join(__dirname, '..', 'docs', 'playbooks');
  for (const [name, text] of Object.entries(files())) assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), text, `${name} is stale`);
});

test('every policy claim is dated verified-with-url or assumed; nothing is claimed verified without a url', () => {
  const all = PLAYBOOKS.map(p => p.background + p.steps.map(s => s.detail || '').join('\n')).join('\n');
  for (const m of all.matchAll(/(?<!un)verified[^\n]{0,40}/g)) {
    assert.match(m[0], /verified 20\d\d-\d\d-\d\d - https:\/\//, m[0]);
  }
  const drop = byId('dropshipping').background;
  assert.match(drop, /ftc\.gov/); assert.match(drop, /assumed, unverified/);
  assert.match(drop, /not built|does NOT implement/i);
});

function setup() {
  const db = openDb(':memory:'); seedBlocklist(db); ensureWatchSchema(db);
  const settings = makeSettings(db);
  settings.set('margin_floor_cents', 200);
  const mk = (o = {}) => Number(db.prepare('INSERT INTO products(stage,title,brief,blueprint,print_provider_id,projected_margin_cents,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(o.stage || 'listing_drafted', o.title || 'T', o.brief || '', o.bp ?? 'bp', o.pp ?? 'pp', o.margin ?? 500, NOW, NOW).lastInsertRowid);
  return { db, settings, mk };
}

test('check hooks read live state; unknown is never pass', () => {
  const { db, settings, mk } = setup();
  const good = db.prepare('SELECT * FROM products WHERE id=?').get(mk({ margin: 500 }));
  const bad = db.prepare('SELECT * FROM products WHERE id=?').get(mk({ margin: 100, brief: 'a pokemon cat' }));
  assert.equal(runCheck('margin_above_floor', { db, settings, product: good }).status, 'pass');
  assert.equal(runCheck('margin_above_floor', { db, settings, product: bad }).status, 'fail');
  assert.equal(runCheck('margin_above_floor', { db, settings, product: null }).status, 'unknown');
  assert.equal(runCheck('blocklist_clean', { db, settings, product: bad }).status, 'fail');
  assert.equal(runCheck('blocklist_clean', { db, settings, product: good }).status, 'pass');
  assert.equal(runCheck('no_such_check', { db, settings, product: good }).status, 'unknown');
  assert.equal(runCheck('etsy_tag_rules', { db, settings, product: good }).status, 'unknown', 'no listing yet');
  db.prepare("INSERT INTO listings(product_id,platform,title,tags,created_at) VALUES(?,?,?,?,?)").run(good.id, 'etsy', 't', JSON.stringify(Array(14).fill('tag')), NOW);
  assert.equal(runCheck('etsy_tag_rules', { db, settings, product: good }).status, 'fail');
  assert.equal(runCheck('has_pod_provider', { product: good }).status, 'pass');
});

async function withApp(fn) {
  const t = setup();
  const app = express(); app.use('/api/playbooks', createPlaybookRouter({ db: t.db, settings: t.settings }));
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/playbooks`;
  const j = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
  try { await fn(j, t); } finally { server.close(); }
}

test('routes: list, detail with live checks, per-product and global tick state persisted', async () => {
  await withApp(async (j, t) => {
    const list = (await j('GET', '/')).body.playbooks;
    assert.equal(list.length, PLAYBOOKS.length);
    assert.equal((await j('GET', '/nope')).status, 404);
    const pid = t.mk({ margin: 50 });
    const global = (await j('GET', '/margin-fell')).body;
    assert.equal(global.productId, 0);
    assert.equal(global.steps.find(s => s.id === 'see').checkResult.status, 'unknown');
    const scoped = (await j('GET', `/margin-fell?productId=${pid}`)).body;
    assert.equal(scoped.steps.find(s => s.id === 'see').checkResult.status, 'fail');

    assert.equal((await j('POST', '/margin-fell/steps/verify/tick', { checked: 'yes' })).status, 400);
    assert.equal((await j('POST', '/margin-fell/steps/zzz/tick', { checked: true })).status, 404);
    assert.equal((await j('POST', '/margin-fell/steps/verify/tick', { checked: true, productId: 9999 })).status, 404);
    assert.equal((await j('POST', '/margin-fell/steps/verify/tick', { checked: true, productId: pid })).status, 200);
    assert.equal((await j('POST', '/margin-fell/steps/ack/tick', { checked: true })).status, 200);

    const s2 = (await j('GET', `/margin-fell?productId=${pid}`)).body;
    assert.equal(s2.steps.find(s => s.id === 'verify').checked, true);
    assert.equal(s2.steps.find(s => s.id === 'ack').checked, false, 'global tick does not leak into product scope');
    assert.equal(s2.done, 1);
    const g2 = (await j('GET', '/margin-fell')).body;
    assert.equal(g2.steps.find(s => s.id === 'ack').checked, true);

    assert.equal((await j('POST', '/margin-fell/steps/verify/tick', { checked: false, productId: pid })).status, 200);
    assert.equal((await j('GET', `/margin-fell?productId=${pid}`)).body.done, 0);
    assert.equal((await j('POST', '/margin-fell/reset', {})).body.cleared, 1);
  });
});
