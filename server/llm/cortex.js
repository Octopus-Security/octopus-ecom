'use strict';
/**
 * llm/cortex.js — model calls through octopus-cortex, billed to the account that asked.
 *
 * Contract (read from octopus-cortex server/routes/internal-llm.js, 2026-10-06):
 *   POST {CORTEX_URL}/api/internal/llm          header x-internal-secret
 *     { username, alias, system?, messages:[{role,content}], maxTokens?, context? }
 *     -> 200 { reply, model, service, inputTokens, outputTokens, funding }
 *   POST {CORTEX_URL}/api/internal/llm/stream   same body; 200 text/event-stream of
 *     data: {"text"} | {"error"} | {"done":true,funding,model,inputTokens,outputTokens} | [DONE]
 *   402 { error } = the account has no own key and no credits (refused BEFORE any byte of a stream);
 *   403 = wrong secret; 503 = cortex has no INTERNAL_SECRET; 500 = provider failure.
 * cortex takes an ALIAS, not a tier: cheap/standard/deep map to haiku/sonnet/opus below.
 * No JSON mode exists, so `json` is a system-prompt instruction and callers still parse defensively.
 * Cortex meters and bills these calls, so costCents is 0 here: they are logged but never counted
 * against ecom's own daily cap.
 */
const actor = require('./actor');

const DEFAULT_URL = 'http://octopus-cortex:3010';
// Aliases that exist in cortex's MODEL_ALIASES (router.js). Assumed mapping, not a benchmark.
const TIER_ALIASES = { cheap: 'haiku', standard: 'sonnet', deep: 'opus' };
const JSON_RULE = 'Respond with a single valid JSON value and nothing else: no prose, no code fences.';
const TIMEOUT_MS = 120000;
const STREAM_TIMEOUT_MS = 300000;

class CortexError extends Error {
  constructor(message, { status = 502, code = 'cortex_error' } = {}) { super(message); this.name = 'CortexError'; this.status = status; this.code = code; }
}

function createCortex({ url, secret, fallbackUser, fetchImpl, log = console }) {
  const base = (url || DEFAULT_URL).replace(/\/+$/, '');
  const doFetch = fetchImpl || ((...a) => fetch(...a));

  function who(user) {
    const u = user || actor.current() || fallbackUser;
    if (!u) throw new CortexError('No signed-in user to bill this model call to.', { status: 401, code: 'no_user' });
    return u;
  }

  async function post(path, body, timeoutMs) {
    if (!secret) throw new CortexError('INTERNAL_SECRET is not set: this app cannot reach cortex.', { status: 503, code: 'no_secret' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await doFetch(`${base}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-secret': secret },
        body: JSON.stringify(body), signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      throw new CortexError(`cortex is unreachable (${e.name === 'AbortError' ? 'timed out' : e.message}). Model calls run through it.`, { status: 502, code: 'unreachable' });
    }
    if (!res.ok) {
      clearTimeout(timer);
      let data = {}; try { data = await res.json(); } catch { /* not JSON */ }
      const msg = data && data.error ? String(data.error) : `cortex answered ${res.status}`;
      if (res.status === 402) throw new CortexError(msg, { status: 402, code: 'no_funding' });
      if (res.status === 403) throw new CortexError('cortex refused this app\'s INTERNAL_SECRET (it must equal cortex\'s value).', { status: 502, code: 'bad_secret' });
      if (res.status === 503) throw new CortexError(`cortex is not ready for internal calls: ${msg}`, { status: 502, code: 'cortex_unconfigured' });
      throw new CortexError(msg, { status: 502, code: 'cortex_error' });
    }
    return { res, done: () => clearTimeout(timer) };
  }

  const aliasFor = (tier) => TIER_ALIASES[tier] || TIER_ALIASES.standard;
  const note = (u, tier, r) => log.info(`[llm.cortex] user=${u} tier=${tier} model=${r.model || '?'} in=${r.inputTokens ?? '?'} out=${r.outputTokens ?? '?'} funding=${r.funding || '?'} (billed by cortex, not counted against the daily cap)`);

  return {
    implemented: true, name: 'cortex', streams: true,

    /** complete({system, prompt, tier, json}) -> {text, model, costCents:0}. */
    async complete({ system = '', prompt, tier = 'cheap', json = false, user }) {
      const u = who(user);
      const sys = json ? `${system}\n\n${JSON_RULE}`.trim() : system;
      const { res, done } = await post('/api/internal/llm', {
        username: u, alias: aliasFor(tier), system: sys || undefined,
        messages: [{ role: 'user', content: String(prompt) }], context: 'ecom',
      }, TIMEOUT_MS);
      let out; try { out = await res.json(); } finally { done(); }
      if (!out || typeof out.reply !== 'string' || !out.reply) throw new CortexError('cortex returned no reply.', { status: 502, code: 'empty' });
      note(u, tier, out);
      return { text: out.reply, model: out.model || aliasFor(tier), costCents: 0, billedBy: 'cortex', funding: out.funding };
    },

    /**
     * chat({system, messages, tier, user, onStart, onText}) -> {text, model, funding, ...usage}.
     * Streams. onStart fires once the response is accepted and before the first delta, so a
     * caller can commit its own headers only after every refusal (402 etc.) has been ruled out.
     */
    async chat({ system = '', messages, tier = 'standard', user, onStart, onText }) {
      const u = who(user);
      const { res, done } = await post('/api/internal/llm/stream', {
        username: u, alias: aliasFor(tier), system: system || undefined, messages, context: 'ecom-plan',
      }, STREAM_TIMEOUT_MS);
      if (onStart) onStart();
      let text = ''; let meta = null; let failure = null;
      const handle = (payload) => {
        if (payload === '[DONE]') return;
        let ev; try { ev = JSON.parse(payload); } catch { return; }
        if (typeof ev.text === 'string') { text += ev.text; if (onText) onText(ev.text); }
        else if (ev.error) failure = String(ev.error);
        else if (ev.done) meta = ev;
      };
      try {
        const dec = new TextDecoder(); let buf = '';
        for await (const chunk of res.body) {
          buf += typeof chunk === 'string' ? chunk : dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            for (const line of block.split('\n')) if (line.startsWith('data:')) handle(line.slice(5).trim());
          }
        }
        if (buf.trim().startsWith('data:')) handle(buf.trim().slice(5).trim());
      } catch (e) {
        throw new CortexError(`the connection to cortex dropped mid-answer (${e.message}).`, { status: 502, code: 'dropped' });
      } finally { done(); }
      if (failure) throw Object.assign(new CortexError(`cortex failed mid-answer: ${failure}`, { status: 502, code: 'stream_error' }), { partial: text });
      if (!text) throw new CortexError('cortex returned no reply.', { status: 502, code: 'empty' });
      const r = { text, model: (meta && meta.model) || aliasFor(tier), funding: meta && meta.funding, inputTokens: meta && meta.inputTokens, outputTokens: meta && meta.outputTokens };
      note(u, tier, r);
      return r;
    },
  };
}

module.exports = { createCortex, CortexError, TIER_ALIASES, DEFAULT_URL };
