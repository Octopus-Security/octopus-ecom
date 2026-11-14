'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert');

let suggestCaptions;
let MAX_CAPTION;
before(async () => {
  ({ suggestCaptions, MAX_CAPTION } = await import('../client/src/captions.js'));
});

test('caption ideas come from the brief and stay short', () => {
  const ideas = suggestCaptions({ brief: 'a frog writing code', title: 'Desk frog', niche: 'programmer gift' });
  assert.ok(ideas.length >= 3 && ideas.length <= 6);
  assert.ok(ideas.some((line) => /frog/i.test(line)));
  assert.ok(ideas.some((line) => /writing code/i.test(line)));
  assert.ok(ideas.every((line) => line.length <= MAX_CAPTION));
  assert.equal(new Set(ideas.map((line) => line.toLowerCase())).size, ideas.length);
});

test('a caption idea does not invent a claim the brief did not make', () => {
  const ideas = suggestCaptions({ brief: 'a frog writing code' });
  assert.ok(ideas.every((line) => !/official|licensed|crisp|handmade|best/i.test(line)));
});

test('an empty brief still offers a few lines to edit', () => {
  const ideas = suggestCaptions({});
  assert.ok(ideas.length >= 3);
  assert.ok(ideas.every((line) => line.length >= 2));
});
