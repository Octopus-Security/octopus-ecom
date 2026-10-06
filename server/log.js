'use strict';
/** log.js — every line goes through the redactor; console can be wrapped too. */
const util = require('node:util');

function format(args) {
  return args.map(a => (typeof a === 'string' ? a : a instanceof Error ? (a.stack || a.message) : util.inspect(a, { depth: 4, breakLength: Infinity }))).join(' ');
}

function createLogger(redactor, out = console) {
  const emit = (level) => (...args) => out[level](redactor.redactText(format(args)));
  return { info: emit('log'), warn: emit('warn'), error: emit('error'), debug: emit('log') };
}

/** Replace console.log/info/warn/error so even stray calls are redacted. Returns an undo. */
function patchConsole(redactor) {
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...args) => orig[k].call(console, redactor.redactText(format(args)));
  return () => Object.assign(console, orig);
}

module.exports = { createLogger, patchConsole, format };
