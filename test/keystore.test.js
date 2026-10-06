'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeDeps, SECRET } = require('./helpers');
const { makeKeystore } = require('../server/keystore');

const VALUE = 'sk-test-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1234';

test('list() and set() never return the value, only presence + fp + tail', () => {
  const { keystore } = makeDeps();
  const r = keystore.set('openai', VALUE);
  assert.deepEqual(Object.keys(r).sort(), ['fp', 'name', 'tail']);
  const listed = JSON.stringify(keystore.list());
  assert.ok(!listed.includes(VALUE) && !listed.includes('AAAAAAAA'));
  assert.equal(keystore.list().find(k => k.name === 'openai').tail, '1234');
});
test('the database holds only sealed text', () => {
  const { keystore, db } = makeDeps();
  keystore.set('printify', VALUE);
  const row = db.prepare('SELECT * FROM keys').get();
  assert.ok(!JSON.stringify(row).includes(VALUE));
  assert.match(row.sealed, /^v1\./);
});
test('get() returns the value server-side; remove() deletes it', () => {
  const { keystore } = makeDeps();
  keystore.set('openai', VALUE);
  assert.equal(keystore.get('openai'), VALUE);
  assert.equal(keystore.remove('openai'), true);
  assert.equal(keystore.get('openai'), '');
});
test('a tampered row is treated as absent, never returned', () => {
  const { keystore, db } = makeDeps();
  keystore.set('openai', VALUE);
  const r = db.prepare('SELECT sealed FROM keys').get();
  const parts = r.sealed.split('.'); parts[3] = (parts[3][0] === 'A' ? 'B' : 'A') + parts[3].slice(1);
  db.prepare('UPDATE keys SET sealed = ?').run(parts.join('.'));
  assert.equal(keystore.get('openai'), '');
  assert.deepEqual(keystore.allSecrets(), []);
});
test('a rotated secret cannot open old rows', () => {
  const { keystore, db } = makeDeps();
  keystore.set('openai', VALUE);
  assert.equal(makeKeystore(db, 'a-completely-different-secret').get('openai'), '');
  assert.equal(makeKeystore(db, SECRET).get('openai'), VALUE);
});
test('unknown names and empty values are refused', () => {
  const { keystore } = makeDeps();
  assert.throws(() => keystore.set('bitcoin', 'x'), /Cannot hold/);
  assert.throws(() => keystore.set('openai', '   '), /Empty/);
});
test('store OAuth tokens are sealed and fed to the redactor', () => {
  const { keystore, db, redactor, credentials } = makeDeps();
  const tok = 'oauth-refresh-token-abcdefghijklmnop';
  db.prepare("INSERT INTO stores(platform,name,oauth_sealed,created_at) VALUES('etsy','s',?,?)").run(keystore.sealJson({ refresh_token: tok }), new Date().toISOString());
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM stores').get()).includes(tok));
  assert.equal(redactor.redactText(`got ${tok} back`).includes(tok), false);
  assert.ok(credentials.allValues().includes(tok));
});
