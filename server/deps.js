'use strict';
/** deps.js — wires every collaborator. Tests call this with ':memory:'; index.js with the real data dir. */
const path = require('node:path');
const { openDb } = require('./db');
const { makeKeystore } = require('./keystore');
const { makeCredentials } = require('./credentials');
const { makeSettings, seedSettings } = require('./settings');
const { makeConfirm } = require('./confirm');
const { makeDryRun } = require('./dryrun');
const { makeSpend } = require('./spend');
const { makeStages } = require('./domain/stages');
const { seedBlocklist } = require('./domain/blocklist');
const { makeRedactor } = require('./redact');
const { createLogger } = require('./log');
const { buildAuth } = require('./auth');
const { buildAdapters } = require('./adapters');
const { makeLlm } = require('./llm');

function createDeps(cfg, { secret, env = process.env, dbFile, out, authOptions, http, requireFn, now } = {}) {
  const db = openDb(dbFile || path.join(cfg.dataDir, 'ecom.db'));
  const keystore = makeKeystore(db, secret);
  const credentials = makeCredentials({ keystore, env, secret });
  const redactor = makeRedactor(() => credentials.allValues());
  const log = createLogger(redactor, out);
  const settings = makeSettings(db);
  seedSettings(settings, cfg);
  seedBlocklist(db);
  const confirm = makeConfirm({ now });
  const dryRun = makeDryRun({ db, settings, confirm });
  const spend = makeSpend({ db, settings });
  const stages = makeStages({ db, isDryRun: dryRun.isOn });
  const auth = buildAuth(cfg, { log, ...(authOptions || {}) });
  const llm = makeLlm({ cfg, credentials, log, env, requireFn });
  const adapters = buildAdapters({ cfg, credentials, keystore, isDryRun: dryRun.isOn, log, llm, http });
  return { cfg, db, keystore, credentials, redactor, log, settings, confirm, dryRun, spend, stages, auth, llm, adapters };
}

module.exports = { createDeps };
