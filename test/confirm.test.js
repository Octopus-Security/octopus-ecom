'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeConfirm, ConfirmError } = require('../server/confirm');

const spec = { action: 'publish', subject: '7', summary: 'Publish #7 (irreversible)' };

test('first call issues a token and executes nothing', () => {
  const c = makeConfirm();
  const r = c.check(spec);
  assert.equal(r.needsConfirm, true);
  assert.ok(r.token.length >= 20);
  assert.equal(r.summary, spec.summary);
});

test('second call with the token passes, exactly once', () => {
  const c = makeConfirm();
  const { token } = c.check(spec);
  assert.deepEqual(c.check(spec, token), { ok: true });
  assert.throws(() => c.check(spec, token), ConfirmError);
});

test('tokens expire after 5 minutes', () => {
  let t = 1_000_000;
  const c = makeConfirm({ now: () => t });
  const { token } = c.check(spec);
  t += 5 * 60 * 1000 + 1;
  assert.throws(() => c.check(spec, token), (e) => e instanceof ConfirmError);
});

test('a token still works just inside the window', () => {
  let t = 1_000_000;
  const c = makeConfirm({ now: () => t });
  const { token } = c.check(spec);
  t += 5 * 60 * 1000 - 1;
  assert.equal(c.check(spec, token).ok, true);
});

test('a token is bound to its action and subject, and is burned by a mismatch', () => {
  const c = makeConfirm();
  const { token } = c.check(spec);
  assert.throws(() => c.check({ ...spec, subject: '8' }, token), (e) => e.code === 'mismatch');
  assert.throws(() => c.check(spec, token), ConfirmError, 'burned: cannot be retried after a mismatch');
  const t2 = c.check(spec).token;
  assert.throws(() => c.check({ ...spec, action: 'dryrun.disarm' }, t2), ConfirmError);
});

test('unknown tokens throw rather than silently re-issuing', () => {
  assert.throws(() => makeConfirm().check(spec, 'garbage'), ConfirmError);
});
