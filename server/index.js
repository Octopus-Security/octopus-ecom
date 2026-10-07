'use strict';
/**
 * index.js — config, boot refusals, listen. Requiring this file has no side
 * effects beyond defining things (test/boots.test.js evaluates it); it listens
 * only when run directly. Exit code 1 means "deliberately refusing to boot".
 */
const { loadConfig } = require('./config');
const { resolveSecret } = require('./secret');
const { createDeps } = require('./deps');
const { buildApp } = require('./app');
const { patchConsole } = require('./log');
const { startWatchers } = require('./watch');
const { startTrendSchedule } = require('./trends/scheduler');

/** Build everything or throw. Used by main() and by tests that want a live server. */
function assemble(env = process.env, opts = {}) {
  const cfg = loadConfig(env);
  const { secret, source } = resolveSecret(cfg, opts.warn);
  const deps = createDeps(cfg, { secret, env, ...opts });
  return { cfg, deps, app: buildApp(deps), secretSource: source };
}

function main(env = process.env) {
  let built;
  try {
    built = assemble(env, { warn: (m) => console.warn(m) });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const { cfg, deps, app } = built;
  patchConsole(deps.redactor);
  const server = app.listen(cfg.port, cfg.host, () => {
    const addr = server.address();
    console.log(`[ecom] listening on http://${addr.address}:${addr.port}  auth=${cfg.authMode}  DRY_RUN=${deps.dryRun.isOn() ? 'ON' : 'OFF'}`);
  });
  const stopWatchers = startWatchers(deps, { service: deps.watch });
  const stopTrends = startTrendSchedule(deps); // weekly trend run: OFF unless the owner turns it on (setting trend_weekly_enabled)
  // Batches: pick up what a restart cut off, and resume cap-paused batches when the ET day changes.
  const rec = deps.orchestrator.recover();
  if (rec.interrupted || rec.ideating) console.log(`[batch] recovered after restart: ${rec.retried} retried, ${rec.failed} failed, ${rec.ideating} re-ideating`);
  const batchTick = setInterval(() => { try { deps.orchestrator.tick(); } catch (e) { console.warn(`[batch] tick failed: ${e.message}`); } }, 60_000);
  batchTick.unref();
  // Weekly proposals digest: a no-op unless the owner turned it on in the Proposals tab (OFF by default). Never throws.
  const proposalsTick = setInterval(() => { deps.proposals.weeklyTick(); }, 60 * 60 * 1000);
  proposalsTick.unref();
  setTimeout(() => { deps.proposals.weeklyTick(); }, 30_000).unref();
  let closing = false;
  const shutdown = (sig) => {
    if (closing) return; closing = true;
    console.log(`[ecom] ${sig}: stopping`);
    stopWatchers(); stopTrends();
    clearInterval(batchTick); clearInterval(proposalsTick); deps.orchestrator.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  server.on('error', (err) => { console.error(`[ecom] cannot listen: ${err.message}`); process.exit(75); });
  return server;
}

if (require.main === module) main();

module.exports = { assemble, main, buildApp };
