'use strict';
// No native alert()/confirm()/prompt() in client code: dialogs are octopus-kit's themed ones
// (or the app's own ConfirmModal, which runs an async server-confirmed action).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'client', 'src');
const NATIVE = /(?<![\w.$])(?:window\.)?(?:alert|confirm|prompt)\(/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.(jsx?|tsx?)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('client code has no native alert/confirm/prompt', () => {
  const hits = [];
  for (const f of walk(SRC)) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (NATIVE.test(line.replace(/\/\/.*$/, ''))) hits.push(`${path.relative(SRC, f)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepStrictEqual(hits, []);
});
