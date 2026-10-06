'use strict';
/**
 * routes/m4.js — the trademark blocklist editor and the batch orchestrator. Mounted by routes/api.js, so it sits behind the same
 * owner auth + sameOrigin check as everything else and before the catch-all 404.
 */
const { wrap } = require('../auth');
const { systemEvent } = require('../events');
const bl = require('../domain/blocklist');

function mount(r, deps) {
  const { db, settings, pipeline, orchestrator } = deps;
  const actor = () => 'human';

  // ---- blocklist -----------------------------------------------------------------------------------------------------------
  r.get('/blocklist', wrap(async (_req, res) => {
    const terms = bl.list(db);
    res.json({ ok: true, total: terms.length, kinds: bl.KINDS, seedVersion: bl.SEED_VERSION, terms });
  }));
  // After any edit the unfinished products are re-scanned so a new term flags what is already on the board.
  const edited = (res, extra) => { const rescan = pipeline.rescanBlocklist(); res.json({ ok: true, ...extra, rescan }); };
  r.post('/blocklist', wrap(async (req, res) => {
    const { term, kind } = req.body || {};
    const out = bl.addTerm(db, term, kind);
    if (!out.ok) return res.status(400).json({ error: `That term cannot be added: ${out.reason}.` });
    if (out.added) systemEvent(db, { actor: actor(), note: `blocklist: added "${out.term}" (${out.kind})` });
    edited(res, out);
  }));
  // DELETE /api/blocklist?term=...   (terms contain spaces and slashes, so it is a query parameter)
  r.delete('/blocklist', wrap(async (req, res) => {
    const term = req.query.term || (req.body || {}).term;
    if (!term) return res.status(400).json({ error: 'term is required' });
    if (!bl.removeTerm(db, settings, term)) return res.status(404).json({ error: 'That term is not on the blocklist.' });
    systemEvent(db, { actor: actor(), note: `blocklist: removed "${bl.normalizeTerm(term)}"` });
    edited(res, { removed: bl.normalizeTerm(term) });
  }));
  // POST /api/blocklist/import {text, kind?}: one term per line, optional "term | kind", # comments.
  r.post('/blocklist/import', wrap(async (req, res) => {
    const { text, kind } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'text must be a non-empty newline-separated list' });
    if (text.length > 1_000_000) return res.status(400).json({ error: 'import is limited to 1 MB' });
    const out = bl.importList(db, text, kind);
    if (out.error) return res.status(400).json({ error: out.error });
    systemEvent(db, { actor: actor(), note: `blocklist import: ${out.added} added, ${out.duplicates} already listed, ${out.invalid.length} invalid` });
    edited(res, out);
  }));
  // POST /api/blocklist/check {text|fields} - what would match (a dry look; nothing is stored).
  r.post('/blocklist/check', wrap(async (req, res) => {
    const b = req.body || {};
    const hits = bl.scanFields(db, b.fields && typeof b.fields === 'object' ? b.fields : { text: String(b.text || '') });
    res.json({ ok: true, hits, summary: bl.describeHits(hits) });
  }));

  // ---- batch ---------------------------------------------------------------------------------------------------------------
  // POST /api/batch {niche, count, keywords?, blueprint, printProviderId, variantIds?, listPrice, shipping?, storeId?, concurrency?}
  r.post('/batch', wrap(async (req, res) => {
    const b = await orchestrator.start(req.body || {});
    res.status(202).json({ ok: true, batch: orchestrator.view(b.id), note: 'Running in the background; poll GET /api/batch/:id. It stops at PENDING_APPROVAL.' });
  }));
  r.get('/batch', wrap(async (req, res) => { res.json({ ok: true, batches: orchestrator.list(Number(req.query.limit) || 30) }); }));
  r.get('/batch/:id', wrap(async (req, res) => {
    const v = orchestrator.view(Number(req.params.id));
    if (!v) return res.status(404).json({ error: 'Batch not found' });
    res.json({ ok: true, batch: v });
  }));
  r.post('/batch/:id/cancel', wrap(async (req, res) => { orchestrator.cancel(Number(req.params.id)); res.json({ ok: true, batch: orchestrator.view(Number(req.params.id)) }); }));
  r.post('/batch/:id/resume', wrap(async (req, res) => { orchestrator.resume(Number(req.params.id)); res.json({ ok: true, batch: orchestrator.view(Number(req.params.id)) }); }));
}

module.exports = { mount };
