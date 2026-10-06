'use strict';
// Estate rule: every Node service evaluates its entrypoint under test.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tmpDir } = require('./helpers');

const ENTRY = path.join(__dirname, '..', 'server', 'index.js');
const baseEnv = () => ({ PATH: process.env.PATH, DATA_DIR: tmpDir('ecom-boot-') });
const run = (env) => spawnSync(process.execPath, [ENTRY], { env, timeout: 20000, encoding: 'utf8' });

test('index.js loads and exports the app builder (no listen on require)', () => {
  const m = require('../server/index.js');
  assert.equal(typeof m.main, 'function');
  assert.equal(typeof m.assemble, 'function');
  assert.equal(typeof m.buildApp, 'function');
});

test('assemble() builds a working app with nothing set (dev, generated secret)', () => {
  const { assemble } = require('../server/index.js');
  const warnings = [];
  const { app, cfg, secretSource } = assemble({ DATA_DIR: tmpDir() }, { dbFile: ':memory:', warn: (m) => warnings.push(m), out: { log() {}, info() {}, warn() {}, error() {} } });
  assert.equal(typeof app, 'function');
  assert.equal(cfg.authMode, 'dev');
  assert.equal(cfg.host, '127.0.0.1', 'dev mode binds loopback only');
  assert.equal(secretSource, 'dev-file-generated');
  assert.match(warnings.join('\n'), /ECOM_SECRET is not set/);
});

test('the generated dev secret is reused on the next boot', () => {
  const { resolveSecret } = require('../server/secret');
  const { loadConfig } = require('../server/config');
  const dir = tmpDir();
  const cfg = loadConfig({ DATA_DIR: dir });
  const a = resolveSecret(cfg, () => {});
  const b = resolveSecret(cfg, () => {});
  assert.equal(a.secret, b.secret);
  assert.equal(b.source, 'dev-file');
  assert.equal(require('node:fs').statSync(path.join(dir, '.dev-secret')).mode & 0o777, 0o600);
});

test('production without ECOM_SECRET exits 1 with a clear refusal', () => {
  const r = run({ ...baseEnv(), NODE_ENV: 'production', AUTH_MODE: 'sso', OWNER_USERNAMES: 'someone' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Refusing to boot/);
  assert.match(r.stderr, /ECOM_SECRET/);
});

test('production with a short ECOM_SECRET is refused', () => {
  const r = run({ ...baseEnv(), NODE_ENV: 'production', ECOM_SECRET: 'short', AUTH_MODE: 'sso', OWNER_USERNAMES: 'someone' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ECOM_SECRET/);
});

test('production with AUTH_MODE=dev is refused', () => {
  const r = run({ ...baseEnv(), NODE_ENV: 'production', ECOM_SECRET: 'x'.repeat(20), AUTH_MODE: 'dev' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /AUTH_MODE=dev is refused/);
});

test('production sso with empty OWNER_USERNAMES is refused', () => {
  const r = run({ ...baseEnv(), NODE_ENV: 'production', ECOM_SECRET: 'x'.repeat(20) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /OWNER_USERNAMES/);
});

test('sso without @octopus-security/auth-client refuses to boot (injected loader)', () => {
  const { assemble } = require('../server/index.js');
  assert.throws(() => assemble({ DATA_DIR: tmpDir(), AUTH_MODE: 'sso', OWNER_USERNAMES: 'a', ECOM_SECRET: 'x'.repeat(20) },
    { dbFile: ':memory:', out: { log() {}, info() {}, warn() {}, error() {} }, authOptions: { loadAuthClient: () => { throw new Error('MODULE_NOT_FOUND'); } } }),
  /auth-client is not installed/);
});

test('sso refusal also holds in a real process when the package is absent', (t) => {
  try { require.resolve('@octopus-security/auth-client'); t.skip('auth-client is installed on this machine'); return; } catch { /* absent: good */ }
  const r = run({ ...baseEnv(), AUTH_MODE: 'sso', OWNER_USERNAMES: 'someone', ECOM_SECRET: 'x'.repeat(20) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /auth-client is not installed/);
});

test('a bad PORT is refused', () => {
  const r = run({ ...baseEnv(), PORT: 'banana' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /PORT/);
});
