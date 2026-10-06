'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeDeps } = require('./helpers');
const { SpendCapError, etDay } = require('../server/spend');

test('addCost rolls up, and the daily cap blocks further spend', () => {
  const d = makeDeps({ DAILY_SPEND_CAP: '1.00' });
  assert.equal(d.spend.capCents(), 100);
  d.spend.addCost({ kind: 'image', amountCents: 60 });
  d.spend.assertCanSpend(40);
  assert.throws(() => d.spend.assertCanSpend(41), SpendCapError);
  d.spend.addCost({ kind: 'llm', amountCents: 40 });
  const s = d.spend.summary();
  assert.equal(s.spend.totalCents, 100); assert.equal(s.spend.capReached, true); assert.equal(s.spend.capPct, 100);
  assert.throws(() => d.spend.assertCanSpend(1), /cap reached/);
});
test('yesterday does not count against today', () => {
  const d = makeDeps({ DAILY_SPEND_CAP: '1.00' });
  d.db.prepare("INSERT INTO costs(kind,amount_cents,ts,day) VALUES('image',999,'2020-01-01T00:00:00Z','2020-01-01')").run();
  assert.equal(d.spend.todayCents(), 0);
  assert.equal(d.spend.summary().spend.totalCents, 999);
});
test('NET = sales after fees minus all costs, in integer cents', () => {
  const d = makeDeps();
  d.spend.addCost({ kind: 'image', amountCents: 30 });
  d.db.prepare("INSERT INTO sales(gross_cents,etsy_fees_cents,processing_fee_cents,net_cents,ts) VALUES(3000,200,100,2700,'x')").run();
  const s = d.spend.summary();
  assert.equal(s.revenue.grossCents, 3000); assert.equal(s.netCents, 2670);
});
test('rejects non-integer or negative amounts; ET day format', () => {
  const d = makeDeps();
  assert.throws(() => d.spend.addCost({ kind: 'image', amountCents: 1.5 }));
  assert.throws(() => d.spend.addCost({ kind: 'image', amountCents: -1 }));
  assert.match(etDay(), /^\d{4}-\d{2}-\d{2}$/);
});
