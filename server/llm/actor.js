'use strict';
/**
 * llm/actor.js — who is asking, for the duration of one request.
 *
 * cortex bills the account named in each call, so the provider needs the signed-in username
 * without every adapter signature growing a `user` argument. app.js enters the store after the
 * auth middleware has set req.user; async continuations (a batch started by a request) keep it.
 * Work with no request behind it (boot recovery, the daily batch tick, watchers) has no actor.
 */
const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();

const run = (username, fn) => als.run({ username: username || null }, fn);
const current = () => { const s = als.getStore(); return (s && s.username) || null; };

/** Express middleware: put req.user.username in scope for the rest of the request. */
function actorMiddleware(req, _res, next) { run(req.user && req.user.username, next); }

module.exports = { run, current, actorMiddleware };
