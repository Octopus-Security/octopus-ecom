'use strict';
// Deleting a design or an unpublished product. Archive remains the path that keeps the record.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeDeps, gradientPng } = require('./helpers');
const { buildApp } = require('../server/app');
const { ensureWatchSchema } = require('../server/watch/schema');
const { ensurePlaybookSchema } = require('../server/playbooks/schema');

const flags = (row) => JSON.parse(row.flags || '[]').map((f) => f.code);
const now = () => new Date().toISOString();

async function designed(d) {
  const p = d.pipeline.create({ brief: 'a fox in a scarf', listPrice: 20 });
  await d.pipeline.attachDesign(p.id, gradientPng(40, 50));
  return d.pipeline.need(p.id);
}

test('removeDesign unlinks the file, keeps the spend and the stage, and clears print flags only when it was the last design', async () => {
  const d = makeDeps({ IMAGE_UPSCALE: 'off' });
  const p = d.pipeline.create({ brief: 'a fox', listPrice: 20 });
  await d.pipeline.selectPod(p.id, { blueprint: 'stub-tee', providerId: 'stub-pp', variantIds: ['stub-tee-v1'] });
  await d.pipeline.attachDesign(p.id, gradientPng(40, 50));
  await d.pipeline.attachDesign(p.id, gradientPng(48, 60));
  d.pipeline.setFlag(p.id, 'blocklist', 'kept on purpose');
  d.spend.addCost({ productId: p.id, kind: 'image', amountCents: 3, note: 'earlier generation' });
  const rows = d.db.prepare('SELECT * FROM designs WHERE product_id = ? ORDER BY id').all(p.id);
  assert.equal(rows.length, 2);
  assert.ok(flags(d.pipeline.need(p.id)).includes('print_not_ready'));
  const file = path.join(d.dataDir, 'images', rows[0].image_path);
  assert.ok(fs.existsSync(file));
  const stage = d.pipeline.need(p.id).stage;
  await d.pipeline.removeDesign(p.id, rows[0].id);
  assert.equal(d.pipeline.need(p.id).stage, stage);
  assert.equal(fs.existsSync(file), false);
  assert.equal(d.db.prepare('SELECT COUNT(*) n FROM designs WHERE product_id = ?').get(p.id).n, 1);
  assert.equal(d.db.prepare('SELECT amount_cents AS c FROM costs WHERE product_id = ?').get(p.id).c, 3);
  const last = d.db.prepare('SELECT * FROM designs WHERE product_id = ?').get(p.id);
  const lastFile = path.join(d.dataDir, 'images', last.image_path);
  await d.pipeline.removeDesign(p.id, last.id);
  assert.equal(fs.existsSync(lastFile), false);
  const left = flags(d.pipeline.need(p.id));
  assert.equal(left.includes('print_not_ready'), false);
  assert.equal(left.includes('print_review'), false);
  assert.ok(left.includes('blocklist'));
  assert.equal(d.pipeline.need(p.id).stage, stage);
});

test('removeDesign 404s a design from another product and 409s a published or live product', async () => {
  const d = makeDeps({ IMAGE_UPSCALE: 'off' });
  const a = await designed(d);
  const b = await designed(d);
  const bDesign = d.db.prepare('SELECT id FROM designs WHERE product_id = ?').get(b.id).id;
  await assert.rejects(() => d.pipeline.removeDesign(a.id, bDesign), (e) => e.status === 404 && e.code === 'not_found');
  assert.equal(d.db.prepare('SELECT COUNT(*) n FROM designs WHERE product_id = ?').get(b.id).n, 1);
  d.db.prepare('UPDATE products SET stage = ? WHERE id = ?').run('published', a.id);
  const design = d.db.prepare('SELECT id, image_path FROM designs WHERE product_id = ?').get(a.id);
  await assert.rejects(() => d.pipeline.removeDesign(a.id, design.id), (e) => e.status === 409 && e.code === 'published');
  assert.ok(fs.existsSync(path.join(d.dataDir, 'images', design.image_path)));
  d.db.prepare('UPDATE products SET stage = ? WHERE id = ?').run('live', b.id);
  await assert.rejects(() => d.pipeline.removeDesign(b.id, bDesign), (e) => e.code === 'published');
});

test('removeProduct deletes the row and files, keeps the spend, and drops links that would block the delete', async () => {
  const d = makeDeps({ IMAGE_UPSCALE: 'off' });
  ensureWatchSchema(d.db);
  ensurePlaybookSchema(d.db);
  const p = await designed(d);
  const design = d.db.prepare('SELECT image_path FROM designs WHERE product_id = ?').get(p.id);
  const img = path.join(d.dataDir, 'images', design.image_path);
  const mockDir = path.join(d.dataDir, 'mockups');
  fs.mkdirSync(mockDir, { recursive: true });
  fs.writeFileSync(path.join(mockDir, 'keep-me.png'), Buffer.from('mock'));
  const t = now();
  d.db.prepare('INSERT INTO mockups(product_id, url, created_at, file) VALUES(?,?,?,?)').run(p.id, 'local:keep-me.png', t, 'keep-me.png');
  d.spend.addCost({ productId: p.id, kind: 'image', amountCents: 4, note: 'kept' });
  d.db.prepare('INSERT INTO proposals(concept, created_at, updated_at, product_id) VALUES(?,?,?,?)').run('fox', t, t, p.id);
  const batchId = Number(d.db.prepare('INSERT INTO batches(niche, requested_count, status, concurrency, created_at, updated_at) VALUES(?,?,?,?,?,?)').run('n', 1, 'done', 1, t, t).lastInsertRowid);
  d.db.prepare('INSERT INTO batch_items(batch_id, idx, concept, product_id, status, updated_at) VALUES(?,?,?,?,?,?)').run(batchId, 0, 'fox', p.id, 'done', t);
  d.db.prepare('INSERT INTO alerts(kind, product_id, message, created) VALUES(?,?,?,?)').run('note', p.id, 'hi', t);
  d.db.prepare('INSERT INTO playbook_ticks(playbook_id, step_id, product_id, updated_at) VALUES(?,?,?,?)').run('go', 'step', p.id, t);
  d.db.prepare('INSERT INTO playbook_ticks(playbook_id, step_id, product_id, updated_at) VALUES(?,?,?,?)').run('go', 'global', 0, t);
  assert.deepEqual(await d.pipeline.removeProduct(p.id), { ok: true, id: p.id });
  assert.equal(d.db.prepare('SELECT id FROM products WHERE id = ?').get(p.id), undefined);
  assert.equal(fs.existsSync(img), false);
  assert.equal(fs.existsSync(path.join(mockDir, 'keep-me.png')), false);
  const cost = d.db.prepare('SELECT product_id, amount_cents FROM costs').get();
  assert.equal(cost.product_id, null);
  assert.equal(cost.amount_cents, 4);
  assert.equal(d.db.prepare('SELECT product_id FROM proposals').get().product_id, null);
  assert.equal(d.db.prepare('SELECT product_id FROM batch_items').get().product_id, null);
  assert.equal(d.db.prepare('SELECT COUNT(*) n FROM alerts').get().n, 0);
  assert.equal(d.db.prepare('SELECT COUNT(*) n FROM playbook_ticks WHERE product_id = ?').get(p.id).n, 0);
  assert.equal(d.db.prepare('SELECT COUNT(*) n FROM playbook_ticks WHERE product_id = 0').get().n, 1);
  assert.match(d.db.prepare("SELECT note FROM events WHERE kind = 'system' ORDER BY id DESC LIMIT 1").get().note, new RegExp(`product ${p.id} deleted`));
});

test('removeProduct refuses anything already outside this app, and a stub print id can go', async () => {
  const d = makeDeps({ IMAGE_UPSCALE: 'off' });
  const t = now();
  const one = async () => (await designed(d)).id;
  const pub = await one();
  d.db.prepare('UPDATE products SET stage = ? WHERE id = ?').run('published', pub);
  await assert.rejects(() => d.pipeline.removeProduct(pub), (e) => e.code === 'published');
  const live = await one();
  d.db.prepare('UPDATE products SET stage = ? WHERE id = ?').run('live', live);
  await assert.rejects(() => d.pipeline.removeProduct(live), (e) => e.code === 'published');
  const sold = await one();
  d.db.prepare('INSERT INTO sales(product_id, gross_cents, net_cents, ts) VALUES(?,?,?,?)').run(sold, 100, 80, t);
  await assert.rejects(() => d.pipeline.removeProduct(sold), (e) => e.code === 'has_sales');
  const listed = await one();
  d.db.prepare('INSERT INTO listings(product_id, platform, external_id, tags, created_at) VALUES(?,?,?,?,?)').run(listed, 'etsy', 'etsy-1', '[]', t);
  await assert.rejects(() => d.pipeline.removeProduct(listed), (e) => e.code === 'has_listing');
  const pod = await one();
  d.db.prepare('UPDATE products SET pod_external_id = ? WHERE id = ?').run('printify-99', pod);
  await assert.rejects(() => d.pipeline.removeProduct(pod), (e) => e.code === 'has_pod');
  const ch = await one();
  d.db.prepare('INSERT INTO channel_listings(product_id, channel, state, created_at, updated_at) VALUES(?,?,?,?,?)').run(ch, 'redbubble', 'uploaded', t, t);
  await assert.rejects(() => d.pipeline.removeProduct(ch), (e) => e.code === 'has_channel');
  const liveCh = await one();
  d.db.prepare('INSERT INTO channel_listings(product_id, channel, state, created_at, updated_at) VALUES(?,?,?,?,?)').run(liveCh, 'redbubble', 'live', t, t);
  await assert.rejects(() => d.pipeline.removeProduct(liveCh), (e) => e.code === 'has_channel');
  for (const id of [pub, live, sold, listed, pod, ch, liveCh]) assert.ok(d.db.prepare('SELECT id FROM products WHERE id = ?').get(id));
  const blank = await one();
  d.db.prepare('INSERT INTO listings(product_id, platform, external_id, tags, created_at) VALUES(?,?,?,?,?)').run(blank, 'etsy', '  ', '[]', t);
  assert.equal((await d.pipeline.removeProduct(blank)).ok, true);
  const stub = await one();
  d.db.prepare('UPDATE products SET pod_external_id = ? WHERE id = ?').run('stub-prod-9', stub);
  assert.equal((await d.pipeline.removeProduct(stub)).ok, true);
  assert.equal(d.db.prepare('SELECT id FROM products WHERE id = ?').get(stub), undefined);
});

test('DELETE design then DELETE product over HTTP, then the product is gone', async () => {
  const d = makeDeps({ IMAGE_UPSCALE: 'off' });
  const server = await new Promise((r) => { const s = buildApp(d).listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const created = await (await fetch(`${base}/api/products`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brief: 'upload me' }) })).json();
    const id = created.product.id;
    const up = await fetch(`${base}/api/products/${id}/upload-design`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: gradientPng(20, 24) });
    assert.equal(up.status, 200);
    const det = await (await fetch(`${base}/api/products/${id}`)).json();
    const delD = await fetch(`${base}/api/products/${id}/designs/${det.designs[0].id}`, { method: 'DELETE' });
    assert.equal(delD.status, 200);
    const delP = await fetch(`${base}/api/products/${id}`, { method: 'DELETE' });
    assert.equal(delP.status, 200);
    assert.deepEqual(await delP.json(), { ok: true, id });
    assert.equal((await fetch(`${base}/api/products/${id}`)).status, 404);
  } finally { server.close(); }
});
