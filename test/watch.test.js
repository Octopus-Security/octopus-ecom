'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { openDb } = require('../server/db');
const { seedBlocklist } = require('../server/domain/blocklist');
const { makeSettings } = require('../server/settings');
const { ensureWatchSchema } = require('../server/watch/schema');
const { makeWatchService } = require('../server/watch/service');
const { createWatchRouter } = require('../server/watch/routes');
const { startWatchers, intervalMs } = require('../server/watch/scheduler');
const { validateSignals, createManualTrendSource } = require('../server/watch/trend');
const { makeReaders } = require('../server/watch/readers');

const quiet = { info() {}, warn() {}, error() {} };
const NOW = new Date().toISOString();

function setup({ costs, availability, stats, floorCents = 200, env = {} } = {}) {
  const db = openDb(':memory:');
  seedBlocklist(db);
  const settings = makeSettings(db);
  settings.set('margin_floor_cents', floorCents);
  const state = { costs: costs || 1000, availability: availability || [{ id: 'v1', title: 'M', inStock: true }], stats: stats || { views: 0, favorites: 0, sales: 0 } };
  const calls = { costs: 0, avail: 0, stats: 0 };
  const adapters = {
    pod: {
      async getVariantCosts() { calls.costs++; if (state.fail) throw new Error('printify 500'); return { variants: [{ id: 'v1', costCents: state.costs }, { id: 'v2', costCents: state.costs - 100 }] }; },
      async getAvailability() { calls.avail++; return { variants: state.availability }; },
    },
    storefront: { async getListingStats() { calls.stats++; return state.stats; } },
  };
  const deps = { db, settings, adapters, log: quiet, env };
  const svc = makeWatchService(deps);
  const addProduct = (o = {}) => Number(db.prepare(`INSERT INTO products(stage, title, blueprint, print_provider_id, list_price_cents, shipping_cents, pod_base_cost_cents, created_at, updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(o.stage || 'listing_drafted', o.title || 'Cat tee', 'bp', 'pp', o.price ?? 2500, 0, 1000, NOW, NOW).lastInsertRowid);
  return { db, state, calls, svc, deps, addProduct, settings };
}
const flagsOf = (db, id) => JSON.parse(db.prepare('SELECT flags FROM products WHERE id=?').get(id).flags);

test('schema is additive and idempotent', () => {
  const db = openDb(':memory:');
  ensureWatchSchema(db); ensureWatchSchema(db);
  db.prepare('INSERT INTO alerts(kind,message,created) VALUES(?,?,?)').run('x', 'm', NOW);
  ensureWatchSchema(db);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM alerts').get().n, 1);
});

test('cost rise below floor: flag added, margin recomputed, alert links margin-fell playbook', async () => {
  const t = setup({ costs: 1000 });
  const id = t.addProduct();
  await t.svc.runAll({ trigger: 'manual', only: ['supplier'] });
  assert.deepEqual(flagsOf(t.db, id), [], 'healthy margin: no flag');
  t.state.costs = 2300; // max variant cost 2300 vs price 2500 -> margin <= 0
  const r = await t.svc.runAll({ trigger: 'manual', only: ['supplier'] });
  assert.equal(r.runs[0].status, 'ok');
  const flags = flagsOf(t.db, id);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].code, 'margin_non_positive');
  const p = t.db.prepare('SELECT * FROM products WHERE id=?').get(id);
  assert.equal(p.pod_base_cost_cents, 2300);
  assert.ok(p.projected_margin_cents <= 0);
  assert.equal(p.stage, 'listing_drafted', 'watcher never moves stage');
  const a = t.svc.alerts.list();
  assert.ok(a.find(x => x.kind === 'margin_fell' && x.playbookId === 'margin-fell' && x.productId === id && x.severity === 'critical'));
  assert.ok(a.find(x => x.kind === 'cost_changed'));
});

test('below-floor (not negative) margin flags margin_below_floor; recovery clears the watcher flag', async () => {
  const t = setup({ costs: 1000, floorCents: 1500 });
  const id = t.addProduct({ price: 2500 });
  await t.svc.runAll({ only: ['supplier'] });
  const first = flagsOf(t.db, id);
  assert.equal(first[0].code, 'margin_below_floor', 'floor 15.00 vs margin 12.17');
  t.state.costs = 300;
  await t.svc.runAll({ only: ['supplier'] });
  assert.deepEqual(flagsOf(t.db, id), []);
});

test('other flags are preserved when margin flags change', async () => {
  const t = setup({ costs: 1000 });
  const id = t.addProduct();
  t.db.prepare('UPDATE products SET flags=? WHERE id=?').run(JSON.stringify([{ code: 'blocklist', detail: 'nike' }]), id);
  t.state.costs = 2400;
  await t.svc.runAll({ only: ['supplier'] });
  assert.deepEqual(flagsOf(t.db, id).map(f => f.code).sort(), ['blocklist', 'margin_non_positive']);
});

test('alerts dedupe while open, and reappear after acknowledge', async () => {
  const t = setup({ costs: 2400 });
  t.addProduct();
  await t.svc.runAll({ only: ['supplier'] });
  await t.svc.runAll({ only: ['supplier'] });
  assert.equal(t.svc.alerts.list().filter(a => a.kind === 'margin_fell').length, 1);
  for (const a of t.svc.alerts.list()) t.svc.alerts.acknowledge(a.id);
  await t.svc.runAll({ only: ['supplier'] });
  assert.equal(t.svc.alerts.list().filter(a => a.kind === 'margin_fell').length, 1);
});

test('out of stock raises an alert linking the playbook; all-out is critical', async () => {
  const t = setup({ availability: [{ id: 'v1', title: 'M', inStock: false }, { id: 'v2', title: 'L', inStock: true }] });
  const id = t.addProduct();
  await t.svc.runAll({ only: ['supplier'] });
  let a = t.svc.alerts.list().find(x => x.kind === 'out_of_stock');
  assert.equal(a.playbookId, 'out-of-stock'); assert.equal(a.severity, 'warn'); assert.equal(a.productId, id);
  t.state.availability = [{ id: 'v1', title: 'M', inStock: false }];
  await t.svc.runAll({ only: ['supplier'] });
  a = t.svc.alerts.list().find(x => x.kind === 'out_of_stock' && x.severity === 'critical');
  assert.ok(a);
});

test('terminal-stage and unconfigured products are not watched', async () => {
  const t = setup();
  t.addProduct({ stage: 'archived' });
  t.db.prepare("INSERT INTO products(stage,created_at,updated_at) VALUES('idea',?,?)").run(NOW, NOW);
  const r = await t.svc.runAll({ only: ['supplier'] });
  assert.equal(t.calls.costs, 0);
  assert.match(r.runs[0].summary, /checked 0/);
});

test('a read failure is recorded, does not throw, and other products still run', async () => {
  const t = setup(); t.addProduct();
  t.state.fail = true;
  const r = await t.svc.runAll({ only: ['supplier'] });
  assert.equal(r.runs[0].status, 'ok');
  assert.match(r.runs[0].summary, /read errors 1/);
});

test('a watcher that throws is recorded as error and never crashes runAll', async () => {
  const t = setup();
  t.db.exec('DROP TABLE watchlist'); // simulate a broken watcher; test DB only
  const r = await t.svc.runAll({ trigger: 'manual', only: ['keywords'] });
  assert.equal(r.runs[0].status, 'error');
  const run = t.svc.listRuns()[0];
  assert.equal(run.status, 'error'); assert.ok(run.error); assert.ok(run.finishedAt);
});

test('every run is recorded; concurrent runAll is refused', async () => {
  const t = setup();
  const [a, b] = await Promise.all([t.svc.runAll(), t.svc.runAll()]);
  assert.ok(a.skipped !== b.skipped);
  assert.equal(t.svc.listRuns().length, 3);
});

test('performance: zero sales after N views, and a sudden view drop; own listings only', async () => {
  const t = setup({ stats: { views: 150, favorites: 3, sales: 0 } });
  const id = t.addProduct({ stage: 'live' });
  t.db.prepare("INSERT INTO listings(product_id, external_id, platform, title, created_at) VALUES(?,?,?,?,?)").run(id, 'E1', 'etsy', 'Cat tee', NOW);
  await t.svc.runAll({ only: ['performance'] });
  assert.ok(t.svc.alerts.list().find(a => a.kind === 'views_no_sales' && a.playbookId === 'views-no-sales'));
  t.state.stats = { views: 200, favorites: 3, sales: 0 }; // +50 (prev delta null)
  await t.svc.runAll({ only: ['performance'] });
  t.state.stats = { views: 210, favorites: 3, sales: 0 }; // +10, down 80% from 50
  await t.svc.runAll({ only: ['performance'] });
  assert.ok(t.svc.alerts.list().find(a => a.kind === 'view_drop'));
  // draft products' listings are not read
  const d = t.addProduct({ stage: 'listing_drafted' });
  t.db.prepare("INSERT INTO listings(product_id, external_id, platform, created_at) VALUES(?,?,?,?)").run(d, 'E2', 'etsy', NOW);
  const before = t.calls.stats;
  await t.svc.runAll({ only: ['performance'] });
  assert.equal(t.calls.stats, before + 1);
});

test('performance: a sale suppresses the zero-sales alert', async () => {
  const t = setup({ stats: { views: 500, favorites: 9, sales: 2 } });
  const id = t.addProduct({ stage: 'live' });
  t.db.prepare("INSERT INTO listings(product_id, external_id, platform, created_at) VALUES(?,?,?,?)").run(id, 'E1', 'etsy', NOW);
  await t.svc.runAll({ only: ['performance'] });
  assert.equal(t.svc.alerts.list().length, 0);
});

test('readers fall back to stubs, labelled as such, when the routed adapter lacks the method', async () => {
  const rd = makeReaders({ pod: {}, storefront: {} });
  assert.equal((await rd.getAvailability('stub-tee', 'x')).source, 'stub');
  assert.equal((await rd.getListingStats('abc')).source, 'stub');
  assert.equal((await rd.getVariantCosts('stub-tee', 'x')).source, 'stub');
});

test('trend signals: competitor-shaped fields are rejected; manual source yields nothing', async () => {
  assert.throws(() => validateSignals([{ message: 'x', title: 'Some competitor listing' }]), /competitor-data shaped/);
  assert.throws(() => validateSignals([{ message: 'x', imageUrl: 'http://a' }]), /unexpected field/);
  assert.deepEqual(validateSignals([{ message: 'ok', severity: 'warn' }]), [{ message: 'ok', severity: 'warn' }]);
  assert.deepEqual(await createManualTrendSource().check({ term: 'cats' }), []);
});

test('keywords: a bad TrendSource is contained; blocklisted watchlist terms alert', async () => {
  const t = setup();
  t.db.prepare("INSERT INTO watchlist(kind,term,notes,created_at,updated_at) VALUES('keyword','pokemon cats','',?,?)").run(NOW, NOW);
  t.db.prepare("INSERT INTO watchlist(kind,term,notes,created_at,updated_at) VALUES('theme','garden',' ',?,?)").run(NOW, NOW);
  const svc = makeWatchService({ ...t.deps, trendSource: { name: 'evil', describe: () => '', async check() { return [{ message: 'm', listings: ['a'] }]; } } });
  const r = await svc.runAll({ only: ['keywords'] });
  assert.equal(r.runs[0].status, 'ok');
  assert.match(r.runs[0].summary, /errors 2/);
  assert.ok(svc.alerts.list().find(a => a.kind === 'watchlist_blocklist'));
  assert.equal(svc.alerts.list().filter(a => a.kind === 'trend_signal').length, 0);
});

test('scheduler: disabled under NODE_ENV=test, env interval, jitter, stop', async () => {
  const t = setup();
  assert.equal(intervalMs({}), 360 * 60000);
  assert.equal(intervalMs({ WATCH_INTERVAL_MINUTES: '30' }), 30 * 60000);
  assert.equal(intervalMs({ WATCH_INTERVAL_MINUTES: 'junk' }), 360 * 60000);
  const timers = [];
  const fakeSet = (fn, ms) => { const h = { fn, ms, unref() {} }; timers.push(h); return h; };
  const off = startWatchers({ ...t.deps, env: { NODE_ENV: 'test' } }, { setTimeoutFn: fakeSet });
  assert.equal(timers.length, 0); off();
  const stop = startWatchers({ ...t.deps, env: { WATCH_INTERVAL_MINUTES: '10' } }, { setTimeoutFn: fakeSet, clearTimeoutFn() {}, random: () => 0 });
  assert.equal(timers.length, 1); assert.equal(timers[0].ms, Math.round(10 * 60000 * 0.9));
  await timers[0].fn();
  assert.equal(timers.length, 2, 'rescheduled after a tick');
  assert.equal(t.svc.listRuns().length, 3, 'tick ran all three watchers');
  stop(); await timers[1].fn();
  assert.equal(timers.length, 2, 'no reschedule after stop');
});

async function withApp(t, fn) {
  const app = express(); app.use('/api/watch', createWatchRouter(t.deps));
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/watch`;
  const j = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
  try { await fn(j); } finally { server.close(); }
}

test('routes: run-now, alerts, ack, count, runs', async () => {
  const t = setup({ costs: 2400 }); t.addProduct();
  await withApp(t, async (j) => {
    assert.equal((await j('POST', '/run', { watcher: 'nope' })).status, 400);
    const run = await j('POST', '/run', { watcher: 'supplier' });
    assert.equal(run.status, 200); assert.equal(run.body.runs[0].status, 'ok');
    const list = (await j('GET', '/alerts')).body;
    assert.ok(list.open >= 1); assert.ok(list.bySeverity.critical >= 1);
    const id = list.alerts[0].id;
    assert.equal((await j('POST', `/alerts/${id}/ack`)).status, 200);
    assert.equal((await j('POST', `/alerts/${id}/ack`)).status, 404, 'already acknowledged');
    assert.equal((await j('GET', '/alerts?all=1')).body.alerts.length, list.alerts.length);
    assert.equal((await j('GET', '/alerts/count')).body.open, list.open - 1);
    assert.equal((await j('POST', '/alerts/ack-all')).body.ok, true);
    assert.equal((await j('GET', '/alerts/count')).body.open, 0);
    const runs = (await j('GET', '/runs')).body;
    assert.equal(runs.runs[0].trigger, 'manual'); assert.match(runs.trendSource, /Manual/);
  });
});

test('routes: watchlist CRUD with validation and duplicate refusal', async () => {
  const t = setup();
  await withApp(t, async (j) => {
    assert.equal((await j('POST', '/watchlist', { term: '' })).status, 400);
    assert.equal((await j('POST', '/watchlist', { term: 'x', kind: 'weird' })).status, 400);
    const c = await j('POST', '/watchlist', { term: '  Cottagecore  ', kind: 'theme', notes: 'spring' });
    assert.equal(c.status, 201); assert.equal(c.body.entry.term, 'cottagecore');
    assert.equal((await j('POST', '/watchlist', { term: 'cottagecore', kind: 'theme' })).status, 409);
    const id = c.body.entry.id;
    const u = await j('PATCH', `/watchlist/${id}`, { notes: 'summer', active: false });
    assert.equal(u.body.entry.notes, 'summer'); assert.equal(u.body.entry.active, false);
    assert.equal((await j('PATCH', '/watchlist/999', { notes: 'x' })).status, 404);
    assert.equal((await j('GET', '/watchlist')).body.entries.length, 1);
    assert.equal((await j('DELETE', `/watchlist/${id}`)).status, 200);
    assert.equal((await j('DELETE', `/watchlist/${id}`)).status, 404);
  });
});

test('no watcher source fetches competitor data or does external writes', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const dir = path.join(__dirname, '..', 'server', 'watch');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.ok(!/\bfetch\s*\(|require\(['"]node:https?['"]\)/.test(src), `${f} must not do its own network I/O`);
    assert.ok(!/\.(createProduct|publish|createListing|updateListing)\s*\(/.test(src), `${f} must not call write methods`);
    assert.ok(!/UPDATE products SET stage|SET stage\s*=/.test(src), `${f} must not write products.stage`);
  }
});
