'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeDeps } = require('./helpers');
const { PHRASE } = require('../server/dryrun');

test('DRY_RUN defaults ON, and only the literal false/0/off turn the seed off', () => {
  assert.equal(makeDeps().dryRun.isOn(), true);
  for (const v of ['true', '1', 'yes', 'no', '', 'nope']) assert.equal(makeDeps({ DRY_RUN: v }).dryRun.isOn(), true, v);
  for (const v of ['false', '0', 'off', 'FALSE', ' Off ']) assert.equal(makeDeps({ DRY_RUN: v }).dryRun.isOn(), false, v);
});
test('disarm step 1 returns a confirm token and changes nothing', () => {
  const d = makeDeps();
  const r = d.dryRun.disarm({ actor: 'human' });
  assert.equal(r.needsConfirm, true);
  assert.match(r.summary, /irreversible|not reversible|REAL/i);
  assert.equal(d.dryRun.isOn(), true);
});
test('disarm needs the token AND the exact phrase', () => {
  const d = makeDeps();
  const { token } = d.dryRun.disarm({ actor: 'human' });
  assert.throws(() => d.dryRun.disarm({ actor: 'human', token, phrase: 'yes please' }), /exactly/);
  assert.equal(d.dryRun.isOn(), true);
  // the failed phrase did not burn the token, but a wrong/absent token fails
  assert.throws(() => d.dryRun.disarm({ actor: 'human', token: 'bogus', phrase: PHRASE }), /token/i);
  assert.equal(d.dryRun.isOn(), true);
  assert.equal(d.dryRun.disarm({ actor: 'human', token, phrase: PHRASE }).dryRun, false);
  assert.equal(d.dryRun.isOn(), false);
});
test('disarm records a system event; the token cannot be replayed', () => {
  const d = makeDeps();
  const { token } = d.dryRun.disarm({ actor: 'human' });
  d.dryRun.disarm({ actor: 'human', token, phrase: PHRASE });
  const ev = d.db.prepare("SELECT * FROM events WHERE kind='system'").get();
  assert.equal(ev.actor, 'human'); assert.match(ev.note, /OFF/); assert.equal(ev.product_id, null);
  d.dryRun.enable({ actor: 'human' });
  const again = d.dryRun.disarm({ actor: 'human' });
  assert.equal(again.needsConfirm, true, 're-arming needs a fresh confirm');
  assert.throws(() => d.dryRun.disarm({ actor: 'human', token, phrase: PHRASE }));
});
test('turning DRY_RUN back ON needs no confirm', () => {
  const d = makeDeps({ DRY_RUN: 'false' });
  assert.equal(d.dryRun.enable({ actor: 'human' }).dryRun, true);
  assert.equal(d.dryRun.isOn(), true);
});
test('under DRY_RUN adapter writes are faked, reads can still be real; scaffolds are never chosen', async () => {
  const { routeAdapter } = require('../server/adapters/route');
  const calls = [];
  const mk = (tag) => ({ implemented: true, listBlueprints: async () => calls.push(`${tag}.read`), listPrintProviders: async () => 0, getVariantCosts: async () => 0, createProduct: async () => calls.push(`${tag}.write`), getMockups: async () => 0, publish: async () => 0 });
  let dry = true;
  const a = routeAdapter({ kind: 'pod', stub: mk('stub'), real: mk('real'), hasCredential: () => true, isDryRun: () => dry, log: { info() {} } });
  await a.listBlueprints(); await a.createProduct();
  dry = false;
  await a.createProduct();
  assert.deepEqual(calls, ['real.read', 'stub.write', 'real.write']);
  const scaffold = { ...mk('real'), implemented: false };
  const b = routeAdapter({ kind: 'pod', stub: mk('stub'), real: scaffold, hasCredential: () => true, isDryRun: () => false, log: { info() {} } });
  calls.length = 0; await b.listBlueprints();
  assert.deepEqual(calls, ['stub.read']);
});
