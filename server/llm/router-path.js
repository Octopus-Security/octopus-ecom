'use strict';
/**
 * router-path.js — OPTIONAL read of an octopus-router checkout's tier table.
 *
 * If ROUTER_PATH is set and `${ROUTER_PATH}/server/router.js` can be required, we read
 * ONLY its `TIERS` (tier name -> alias name) and `ALIASES` (alias -> {provider, model, cost})
 * exports to choose a model per tier ('cheap' | 'standard' | 'deep'). Read 2026-10-05:
 * router.js's module-load work is declaring constants (they read process.env) and requiring
 * ./providers; it starts no server or timers, so requiring it is side-effect free.
 * Nothing else it exports is used. Everything is wrapped: unset, missing, throwing or
 * unexpectedly-shaped -> {path:'fallback', tiers:null, reason}. Never required to run.
 */
const fs = require('node:fs');
const path = require('node:path');

const TIER_NAMES = ['cheap', 'standard', 'deep'];

function loadRouterTiers({ routerPath, requireFn = require, log = { info() {}, warn() {} } } = {}) {
  const fallback = reason => { log.info(`[llm] router tier table not used (${reason}); using built-in defaults`); return { path: 'fallback', tiers: null, reason }; };
  if (!routerPath) return fallback('ROUTER_PATH unset');
  const file = path.join(routerPath, 'server', 'router.js');
  try {
    if (!fs.existsSync(file)) return fallback(`${file} not found`);
    const mod = requireFn(file);
    if (!mod || typeof mod.TIERS !== 'object' || typeof mod.ALIASES !== 'object' || !mod.TIERS || !mod.ALIASES) return fallback('router.js does not export TIERS and ALIASES');
    const tiers = {};
    for (const t of TIER_NAMES) {
      const alias = mod.TIERS[t];
      const a = alias && mod.ALIASES[alias];
      if (!a || typeof a.model !== 'string') return fallback(`tier "${t}" does not resolve to an alias with a model`);
      tiers[t] = { alias, model: a.model, provider: a.provider || null, cost: a.cost || null };
    }
    log.info('[llm] using router tier table from ROUTER_PATH (read-only: TIERS + ALIASES)');
    return { path: 'router', tiers, reason: 'loaded' };
  } catch (e) {
    return fallback(`require failed: ${e.message}`);
  }
}

module.exports = { loadRouterTiers, TIER_NAMES };
