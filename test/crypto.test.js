'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const c = require('../server/crypto');

const S = 'a-long-enough-secret-123';

test('seal/open round-trips and never contains the plaintext', () => {
  const sealed = c.seal('sk-very-secret-value', S);
  assert.ok(!sealed.includes('sk-very-secret-value'));
  assert.match(sealed, /^v1\./);
  assert.equal(c.open(sealed, S), 'sk-very-secret-value');
});
test('the same plaintext seals differently each time (random IV)', () => {
  assert.notEqual(c.seal('x'.repeat(8), S), c.seal('x'.repeat(8), S));
});
test('tampered ciphertext, tag or wrong secret fails to open', () => {
  const [v, iv, tag, ct] = c.seal('hello world', S).split('.');
  const flip = (s) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
  assert.throws(() => c.open([v, iv, tag, flip(ct)].join('.'), S));
  assert.throws(() => c.open([v, iv, flip(tag), ct].join('.'), S));
  assert.throws(() => c.open([v, flip(iv), tag, ct].join('.'), S));
  assert.throws(() => c.open(c.seal('hello', S), 'a-different-secret-xxxx'));
  assert.throws(() => c.open('not-sealed', S));
});
test('there is no default secret: missing or short secrets throw', () => {
  const saved = process.env.ECOM_SECRET; delete process.env.ECOM_SECRET;
  try {
    assert.throws(() => c.seal('x'), /ECOM_SECRET/);
    assert.throws(() => c.seal('x', 'short'), /ECOM_SECRET/);
  } finally { if (saved !== undefined) process.env.ECOM_SECRET = saved; }
});
test('fingerprint is stable, short, non-reversible and keyed by the secret', () => {
  const a = c.fingerprint('sk-abcdef123456', S);
  assert.deepEqual(a, c.fingerprint('sk-abcdef123456', S));
  assert.equal(a.tail, '3456');
  assert.notEqual(a.fp, c.fingerprint('sk-abcdef123456', 'another-secret-value-0000').fp);
  assert.ok(!JSON.stringify(a).includes('abcdef'));
});
