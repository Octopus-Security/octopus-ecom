'use strict';
/**
 * adapters/http.js — the ONLY way a real adapter talks to the network.
 * Per-host token bucket, timeout, retry with exponential backoff + jitter on
 * 429/5xx honouring Retry-After, and redacted logging (method + host + path, no
 * query string, no headers, no bodies). fetch, sleep, clock and randomness are
 * injectable so tests need no network and no real waiting.
 *
 * Only GET/HEAD are retried on 5xx and network failure/timeout. Other methods
 * are retried only on 429 (the request was refused, not processed): a 5xx or a
 * timeout may mean the write happened, and a blind retry could double-create a
 * listing. Pass {idempotent:true} to opt in to full retries.
 */
class HttpError extends Error {
  constructor(message, { status = 0, body = '', host = '' } = {}) { super(message); this.name = 'HttpError'; this.status = status; this.body = body; this.host = host; }
}

const sleepReal = ms => new Promise(r => setTimeout(r, ms));

function parseRetryAfter(h, nowMs) {
  if (h === null || h === undefined || h === '') return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const t = Date.parse(h);
  return Number.isNaN(t) ? null : Math.max(0, t - nowMs);
}

function makeHttp({
  fetchImpl = (...a) => globalThis.fetch(...a),
  sleep = sleepReal, now = Date.now, random = Math.random,
  log = { info() {}, warn() {} },
  ratePerSec = 5, burst = 5, maxRetries = 4, baseDelayMs = 500, maxDelayMs = 30000, timeoutMs = 30000,
  // Per-host overrides: { 'api.example.com': { ratePerSec, perDay } }. A call's own ratePerSec still wins.
  // perDay is a LOCAL daily budget (rolling 24 h): once spent, requests to that host fail at once with a
  // 429-shaped HttpError instead of burning a provider quota we can see coming.
  hostLimits = {},
} = {}) {
  const buckets = new Map();
  const dayLog = new Map();
  function spendDaily(host) {
    const lim = hostLimits[host] && hostLimits[host].perDay;
    if (!lim) return;
    const t = now(); const arr = (dayLog.get(host) || []).filter(x => t - x < 86400000);
    if (arr.length >= lim) { dayLog.set(host, arr); throw new HttpError(`local daily request budget for ${host} is spent (${lim}/24h); try again later`, { status: 429, host }); }
    arr.push(t); dayLog.set(host, arr);
  }

  async function take(host, rps) {
    const cap = hostLimits[host] ? Math.min(burst, Math.max(1, Math.floor(rps))) : burst; // a limited host never bursts past one second's allowance
    let b = buckets.get(host);
    if (!b) { b = { tokens: cap, at: now() }; buckets.set(host, b); }
    for (;;) {
      const t = now();
      b.tokens = Math.min(cap, b.tokens + ((t - b.at) / 1000) * rps);
      b.at = t;
      if (b.tokens >= 1) { b.tokens -= 1; return; }
      await sleep(Math.ceil(((1 - b.tokens) / rps) * 1000));
    }
  }

  async function once(url, opts) {
    const ctl = new AbortController();
    let timer;
    const timedOut = new Promise((_, rej) => { timer = setTimeout(() => { rej(new HttpError(`timed out after ${opts.timeoutMs}ms`, { host: opts.host })); ctl.abort(); }, opts.timeoutMs); });
    try {
      const res = await Promise.race([fetchImpl(url, { method: opts.method, headers: opts.headers, body: opts.body, signal: ctl.signal }), timedOut]);
      const text = await Promise.race([res.text(), timedOut]);
      return { res, text };
    } finally { clearTimeout(timer); }
  }

  /** request(url, {method, headers, json, body, idempotent, ratePerSec, timeoutMs, maxRetries}) -> {status, ok, headers, text, json} */
  async function request(url, o = {}) {
    const u = new URL(url);
    const method = (o.method || 'GET').toUpperCase();
    const idempotent = o.idempotent ?? ['GET', 'HEAD'].includes(method);
    const headers = { ...(o.headers || {}) };
    let body = o.body;
    if (o.json !== undefined) { body = JSON.stringify(o.json); headers['Content-Type'] = headers['Content-Type'] || 'application/json'; }
    const retries = o.maxRetries ?? maxRetries;
    const opts = { method, headers, body, host: u.host, timeoutMs: o.timeoutMs ?? timeoutMs };
    const where = `${method} ${u.host}${u.pathname}`; // no query string: it can carry tokens

    for (let attempt = 0; ; attempt++) {
      spendDaily(u.host);
      await take(u.host, o.ratePerSec ?? (hostLimits[u.host] && hostLimits[u.host].ratePerSec) ?? ratePerSec);
      let out; let err = null;
      try { out = await once(url, opts); } catch (e) { err = e; }

      const status = out ? out.res.status : 0;
      const retryable = err
        ? idempotent
        : status === 429 || (status >= 500 && idempotent);
      if (!err && status < 400) {
        const text = out.text;
        return { status, ok: true, headers: out.res.headers, text, json: () => JSON.parse(text) };
      }
      if (!retryable || attempt >= retries) {
        log.warn(`[http] ${where} failed: ${err ? err.message : status} (attempt ${attempt + 1})`);
        throw err instanceof HttpError ? err : new HttpError(err ? `${where}: ${err.message}` : `${where} -> HTTP ${status}`, { status, body: out ? out.text.slice(0, 500) : '', host: u.host });
      }
      const ra = out ? parseRetryAfter(out.res.headers && out.res.headers.get && out.res.headers.get('retry-after'), now()) : null;
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt) * (0.5 + random() * 0.5);
      const delay = Math.min(maxDelayMs, ra !== null ? Math.max(ra, 0) : backoff);
      log.info(`[http] ${where} -> ${err ? err.message : status}; retry ${attempt + 1}/${retries} in ${delay}ms${ra !== null ? ' (Retry-After)' : ''}`);
      await sleep(delay);
    }
  }

  /** The local daily budget of a host: {perDay, used} (perDay null when the host has none). Read-only; lets a caller keep a reserve. */
  function budget(host) {
    const lim = hostLimits[host] && hostLimits[host].perDay;
    const t = now();
    return { perDay: lim || null, used: lim ? (dayLog.get(host) || []).filter(x => t - x < 86400000).length : 0 };
  }

  return { request, budget };
}

module.exports = { makeHttp, HttpError, parseRetryAfter };
