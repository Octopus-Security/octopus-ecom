'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../server/config');
const { createDeps } = require('../server/deps');

const SECRET = 'test-secret-0123456789abcdef';
const quiet = { log() {}, info() {}, warn() {}, error() {} };

function tmpDir(prefix = 'ecom-test-') { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

/** In-memory DB, temp data dir, dev auth, quiet logs. env overrides merge over a minimal env. */
function makeDeps(env = {}, opts = {}) {
  const dataDir = tmpDir();
  const full = { DATA_DIR: dataDir, ...env };
  const cfg = loadConfig(full);
  const deps = createDeps(cfg, { secret: SECRET, env: full, dbFile: ':memory:', out: quiet, ...opts });
  return { ...deps, dataDir, env: full };
}

module.exports = { makeDeps, tmpDir, SECRET, quiet };

// ---- M1 helpers: fake fetch + tiny PNG fixtures --------------------------------------------
const { encodePng } = require('../server/png');
const { makeHttp } = require('../server/adapters/http');

/** A deterministic gradient PNG (RGB) of the given size. */
function gradientPng(w, h) {
  const pixels = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (y * w + x) * 3; pixels[o] = (x * 255 / Math.max(1, w - 1)) | 0; pixels[o + 1] = (y * 255 / Math.max(1, h - 1)) | 0; pixels[o + 2] = 90; }
  return encodePng({ width: w, height: h, channels: 3, pixels });
}

/** fake fetch: responder(url, init) -> {status, body, headers}; records every call in .calls */
function fakeFetch(responder) {
  const calls = [];
  const fn = async (url, init = {}) => {
    let body; if (init.body) { try { body = JSON.parse(init.body); } catch { body = init.body; } } // form bodies stay strings
    calls.push({ url, method: init.method, headers: init.headers, body });
    const r = await responder(url, init, calls.length);
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return { status: r.status || 200, headers: { get: k => (r.headers || {})[k.toLowerCase()] ?? null }, text: async () => text };
  };
  fn.calls = calls;
  return fn;
}
const fakeHttp = f => makeHttp({ fetchImpl: f, sleep: async () => {}, random: () => 0.5 });

module.exports.gradientPng = gradientPng;
module.exports.fakeFetch = fakeFetch;
module.exports.fakeHttp = fakeHttp;
