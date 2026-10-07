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
const { bilinearUpscale } = require('./upscale');
const { makeHttp } = require('./adapters/http');

const { makeLlm } = require('./llm');
const { makePipeline } = require('./pipeline');
const { makeWatchService } = require('./watch');
const { makeEtsyAuth } = require('./etsy/auth');
const { makeEtsyService } = require('./etsy/service');
const { makePublisher } = require('./etsy/publish');
const { makeSales } = require('./etsy/sales');
const { makeOrchestrator } = require('./orchestrator');

function createDeps(cfg, opts = {}) {
  const { secret, env = process.env, dbFile, out, authOptions, requireFn, now, upscale } = opts;
  let { http } = opts;
  const db = openDb(dbFile || path.join(cfg.dataDir, 'ecom.db'));
  const keystore = makeKeystore(db, secret);
  const credentials = makeCredentials({ keystore, env, secret });
  const redactor = makeRedactor(() => credentials.allValues());
  const log = createLogger(redactor, out);
  // Etsy's QPS/QPD are per API key and not published in the docs; these are conservative LOCAL ceilings (assumed, unverified).
  const qps = Number(env.ETSY_QPS) > 0 ? Number(env.ETSY_QPS) : 4;
  const qpd = Number(env.ETSY_QPD) > 0 ? Number(env.ETSY_QPD) : 4000;
  http = http || makeHttp({ log, hostLimits: { 'api.etsy.com': { ratePerSec: qps, perDay: qpd } } });
  const settings = makeSettings(db);
  seedSettings(settings, cfg);
  seedBlocklist(db, settings);
  const confirm = makeConfirm({ now });
  const dryRun = makeDryRun({ db, settings, confirm });
  const spend = makeSpend({ db, settings });
  const stages = makeStages({ db, isDryRun: dryRun.isOn });
  const auth = buildAuth(cfg, { log, ...(authOptions || {}) });
  const llm = makeLlm({ cfg, credentials, http, spend, log, env, requireFn, fetchImpl: opts.fetchImpl });
  const etsyAuth = makeEtsyAuth({ db, keystore, credentials, http, cfg, log, now: opts.nowMs });
  const adapters = buildAdapters({ cfg, env, credentials, keystore, isDryRun: dryRun.isOn, log, llm, http, spend, upscale, etsyAuth });
  const pipeline = makePipeline({ db, stages, adapters, spend, settings, dataDir: cfg.dataDir, isDryRun: dryRun.isOn, log, printDefaults: cfg.print, upscale: upscale !== undefined ? upscale : (cfg.image.upscale ? bilinearUpscale : null) });
  const etsy = makeEtsyService({ db, auth: etsyAuth, adapters, credentials, log, now: opts.nowMs });
  const publisher = makePublisher({ db, settings, stages, adapters, pipeline, spend, dryRun, etsy, log, env, sleep: opts.sleep });
  const sales = makeSales({ db, settings, adapters, spend, etsy, log, now: opts.nowMs, lookbackDays: cfg.refundLookbackDays });
  const orchestrator = makeOrchestrator({ db, pipeline, stages, adapters, llm, spend, settings, publisher, dryRun, cfg, log, now: opts.nowDate });
  const watch = makeWatchService({ db, settings, adapters, log, env, hooks: { reconcile: () => publisher.reconcileAll({ actor: 'agent' }), syncSales: () => sales.sync({ actor: 'agent', auto: true }) } });
  return { orchestrator, etsyAuth, etsy, publisher, sales, watch, pipeline, http, cfg, db, keystore, credentials, redactor, log, settings, confirm, dryRun, spend, stages, auth, llm, adapters };
}

module.exports = { createDeps };
