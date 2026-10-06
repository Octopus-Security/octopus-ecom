'use strict';
/**
 * plan/routes.js — the planning chat. Mount at /api/plan (behind the app's owner auth).
 * Conversations are per user: another user's id answers 404, never 403. The chat takes no actions.
 * The model call is billed by cortex to req.user; it is not counted against the daily spend cap.
 */
const express = require('express');
const { buildPlanContext, PLAN_SYSTEM } = require('./context');
const { TIERS } = require('../llm');

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const MAX_MESSAGE = 4000;
const HISTORY_MESSAGES = 20;
const MAX_PER_CONVERSATION = 200;
const nowIso = () => new Date().toISOString();
const httpErr = (status, message) => Object.assign(new Error(message), { status });

function createPlanRouter(deps) {
  const { db, settings, spend, llm, log = console } = deps;
  const r = express.Router();
  r.use(express.json({ limit: '20kb' }));

  const me = (req) => { if (!req.user || !req.user.username) throw httpErr(401, 'Not authenticated'); return req.user.username; };
  // The ownership check IS the query: a row that is not yours is indistinguishable from one that does not exist.
  const mine = (req) => {
    const id = Number(req.params.id);
    const c = Number.isInteger(id) ? db.prepare('SELECT * FROM plan_conversations WHERE id = ? AND owner = ?').get(id, me(req)) : null;
    if (!c) throw httpErr(404, 'No such conversation');
    return c;
  };
  const view = (c) => ({ id: c.id, title: c.title, tier: c.tier, createdAt: c.created_at, updatedAt: c.updated_at });
  const tierOf = (t, fallback = 'standard') => { const v = t === undefined || t === null || t === '' ? fallback : t; if (!TIERS.includes(v)) throw httpErr(400, `tier must be one of ${TIERS.join(', ')}`); return v; };

  r.get('/', wrap(async (req, res) => {
    const rows = db.prepare('SELECT * FROM plan_conversations WHERE owner = ? ORDER BY updated_at DESC, id DESC LIMIT 50').all(me(req));
    const d = llm.describe();
    res.json({ conversations: rows.map(view), provider: d.provider, tiers: TIERS, billed: d.provider === 'cortex' ? 'cortex bills your account; not counted against the daily cap' : null });
  }));

  r.post('/', wrap(async (req, res) => {
    const t = nowIso();
    const info = db.prepare('INSERT INTO plan_conversations(owner,title,tier,created_at,updated_at) VALUES(?,?,?,?,?)').run(me(req), '', tierOf(req.body && req.body.tier), t, t);
    res.status(201).json({ conversation: view(db.prepare('SELECT * FROM plan_conversations WHERE id = ?').get(info.lastInsertRowid)) });
  }));

  r.get('/context', wrap(async (req, res) => { me(req); res.json({ context: buildPlanContext({ db, settings, spend }) }); }));

  r.get('/:id', wrap(async (req, res) => {
    const c = mine(req);
    const messages = db.prepare('SELECT id, role, content, model, tier, funding, created_at AS createdAt FROM plan_messages WHERE conversation_id = ? ORDER BY id').all(c.id);
    res.json({ conversation: view(c), messages });
  }));

  r.delete('/:id', wrap(async (req, res) => {
    const c = mine(req);
    db.prepare('DELETE FROM plan_messages WHERE conversation_id = ?').run(c.id);
    db.prepare('DELETE FROM plan_conversations WHERE id = ?').run(c.id);
    res.json({ ok: true });
  }));

  // POST /api/plan/:id/messages {content, tier?} -> text/event-stream of {text} ... {done,...} | {error}.
  // Every refusal that can be known before the first byte (no funding, cortex down) is a normal JSON status.
  r.post('/:id/messages', wrap(async (req, res) => {
    const user = me(req);
    const c = mine(req);
    const content = String((req.body && req.body.content) || '').trim();
    if (!content) throw httpErr(400, 'content is required');
    if (content.length > MAX_MESSAGE) throw httpErr(400, `message is too long (max ${MAX_MESSAGE} characters)`);
    const tier = tierOf(req.body && req.body.tier, c.tier);
    if (db.prepare('SELECT COUNT(*) AS n FROM plan_messages WHERE conversation_id = ?').get(c.id).n >= MAX_PER_CONVERSATION) throw httpErr(400, 'This conversation is full. Start a new one.');

    // History = this user's own conversation only, newest N, oldest first.
    const history = db.prepare('SELECT role, content FROM plan_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?').all(c.id, HISTORY_MESSAGES).reverse();
    const messages = [...history, { role: 'user', content }];
    const system = PLAN_SYSTEM + buildPlanContext({ db, settings, spend });

    let started = false;
    const send = (o) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(o)}\n\n`); };
    let out;
    try {
      out = await llm.chat({
        system, messages, tier, user,
        onStart: () => { started = true; res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); },
        onText: (text) => send({ text }),
      });
    } catch (e) {
      log.warn(`[plan] model call failed for conversation ${c.id}: ${e.code || ''} ${e.message}`);
      if (!started) return res.status(e.status && e.status >= 400 && e.status < 600 ? e.status : 502).json({ error: e.message, code: e.code || 'llm_error' });
      send({ error: e.message, code: e.code || 'llm_error' }); return res.end();
    }

    const t = nowIso();
    db.prepare('INSERT INTO plan_messages(conversation_id,role,content,tier,created_at) VALUES(?,?,?,?,?)').run(c.id, 'user', content, tier, t);
    db.prepare('INSERT INTO plan_messages(conversation_id,role,content,model,tier,funding,created_at) VALUES(?,?,?,?,?,?,?)').run(c.id, 'assistant', out.text, out.model || null, tier, out.funding || null, t);
    db.prepare('UPDATE plan_conversations SET updated_at = ?, tier = ?, title = CASE WHEN title = \'\' THEN ? ELSE title END WHERE id = ?').run(t, tier, content.replace(/\s+/g, ' ').slice(0, 60), c.id);
    send({ done: true, model: out.model, funding: out.funding || null, tier });
    res.end();
  }));

  return r;
}

module.exports = { createPlanRouter };
