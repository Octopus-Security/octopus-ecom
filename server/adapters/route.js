'use strict';
/**
 * adapters/route.js — picks real vs stub PER CALL (DRY_RUN can flip at runtime).
 * See contract.js for the read/write/spend rules. A real adapter that is a
 * scaffold (`implemented: false`) is never chosen.
 */
const { CONTRACTS, assertAdapter } = require('./contract');

function routeAdapter({ kind, real, stub, hasCredential, isDryRun, log = console }) {
  assertAdapter(kind, stub);
  const methods = CONTRACTS[kind];
  const usable = () => Boolean(real && real.implemented && hasCredential());
  // A real adapter that lacks a READ method (not yet built) falls back to the stub rather than throwing.
  // Writes/spend are never silently stubbed this way: a missing real write is a bug and should surface.
  const hasReal = (name, mode) => mode !== 'read' || typeof real[name] === 'function';
  const usesReal = (name, mode, dry) => usable() && hasReal(name, mode) && !(mode === 'write' && dry);
  const out = {};
  for (const [name, mode] of Object.entries(methods)) {
    out[name] = (...args) => {
      const dry = isDryRun();
      const useReal = usesReal(name, mode, dry);
      if (mode === 'write' && dry) log.info(`[adapter] DRY_RUN: ${kind}.${name} faked, nothing sent to the marketplace`);
      return (useReal ? real : stub)[name](...args);
    };
  }
  out.describe = () => {
    const dry = isDryRun();
    const why = !real ? 'no real adapter' : !real.implemented ? 'real adapter not implemented yet (scaffold)' : !hasCredential() ? 'no credential' : 'credential present';
    return {
      kind, reason: why, realReady: usable(),
      methods: Object.fromEntries(Object.entries(methods).map(([n, m]) => [n, usesReal(n, m, dry) ? 'real' : 'stub'])),
    };
  };
  return out;
}

module.exports = { routeAdapter };
