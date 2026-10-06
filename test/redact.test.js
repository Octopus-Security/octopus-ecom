'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeRedactor } = require('../server/redact');
const { createLogger, patchConsole } = require('../server/log');
const { makeDeps } = require('./helpers');

test('known token shapes are redacted', () => {
  const { redactText } = makeRedactor();
  const samples = [
    'ghp_' + 'a'.repeat(36), 'sk-ant-' + 'b'.repeat(30), 'sk-proj-' + 'c'.repeat(40), 'sk-' + 'd'.repeat(40),
    'AKIA' + 'E'.repeat(16), 'Bearer abcdefghijklmnop12345', 'eyJhbGciOiJI.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4fw',
    'xoxb-1234567890-abcdef',
  ];
  for (const s of samples) {
    const out = redactText(`before ${s} after`);
    assert.ok(!out.includes(s), `leaked: ${s}`);
    assert.match(out, /\[REDACTED/);
  }
});
test('PEM private key blocks are redacted', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----';
  assert.ok(!makeRedactor().redactText(`k: ${pem}`).includes('MIIEvQ'));
});
test('EXACT secret values are redacted whatever their shape, read at call time', () => {
  let secrets = [];
  const { redactText } = makeRedactor(() => secrets);
  const odd = 'plainwordsecret-no-prefix';
  assert.equal(redactText(`x ${odd} y`), `x ${odd} y`);
  secrets = [odd];
  assert.ok(!redactText(`x ${odd} y`).includes(odd));
});
test('short exact values are not redacted (would mangle ordinary words)', () => {
  assert.equal(makeRedactor(() => ['abc']).redactText('abc def'), 'abc def');
});
test('the logger redacts everything, including Error stacks and objects', () => {
  const lines = [];
  const out = { log: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) };
  const secret = 'my-printify-token-9f8e7d6c5b4a';
  const log = createLogger(makeRedactor(() => [secret]), out);
  log.info('token', secret);
  log.error(new Error(`boom ${secret}`));
  log.warn({ headers: { authorization: `Bearer ${secret}` } });
  assert.equal(lines.length, 3);
  for (const l of lines) assert.ok(!l.includes(secret), l);
});
test('credentials set at runtime (keystore and env) reach the redactor', () => {
  const env = { OPENAI_API_KEY: 'env-openai-key-VALUE-123456' };
  const d = makeDeps(env);
  d.keystore.set('printify', 'stored-printify-VALUE-654321');
  const t = d.redactor.redactText('a env-openai-key-VALUE-123456 b stored-printify-VALUE-654321 c');
  assert.ok(!t.includes('VALUE'));
});
test('patchConsole redacts stray console calls and can be undone', () => {
  const seen = [];
  const orig = console.log;
  console.log = (...a) => seen.push(a.join(' '));
  const undo = patchConsole(makeRedactor(() => ['super-secret-value-1234']));
  console.log('hello super-secret-value-1234');
  undo();
  console.log = orig;
  assert.ok(!seen[0].includes('super-secret'));
});
