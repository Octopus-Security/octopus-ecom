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
