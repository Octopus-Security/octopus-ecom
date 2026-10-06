'use strict';
/**
 * stages.js — the product state machine (decision 7). The ONLY code that writes
 * products.stage (test/stages.test.js greps the tree to keep it that way).
 *
 *   idea -> design_generated -> mockup_ready -> listing_drafted
 *        -> PENDING_APPROVAL -> approved -> published -> live
 *   plus: rejected, failed (with reason), archived.
 *
 * Every change goes through transition(): validate against TRANSITIONS, then in
 * ONE transaction write the events row and update stage + updated_at.
 *
 * Gates enforced here (not in routes, so no caller can skip them):
 *   - published is reachable only from approved (the single publish guard).
 *   - approved by actor 'agent' only when its store has autopublish ON, DRY_RUN
 *     is OFF, and the product carries no flags. A human may approve a flagged
 *     product (the confirm summary lists the flags - see approvalSummary).
 *   - failed needs a reason and is reachable from any stage except
 *     failed/rejected/archived; failed -> idea is the retry.
 */
const { tx } = require('../db');

const S = Object.freeze({
  IDEA: 'idea', DESIGN: 'design_generated', MOCKUP: 'mockup_ready', DRAFTED: 'listing_drafted',
  PENDING: 'PENDING_APPROVAL', APPROVED: 'approved', PUBLISHED: 'published', LIVE: 'live',
  REJECTED: 'rejected', FAILED: 'failed', ARCHIVED: 'archived',
});
/** Board column order. */
const STAGES = [S.IDEA, S.DESIGN, S.MOCKUP, S.DRAFTED, S.PENDING, S.APPROVED, S.PUBLISHED, S.LIVE, S.REJECTED, S.FAILED, S.ARCHIVED];

const PRE_PUBLISH = [S.IDEA, S.DESIGN, S.MOCKUP, S.DRAFTED, S.PENDING, S.APPROVED];

const TRANSITIONS = {
  [S.IDEA]:      [S.DESIGN, S.REJECTED, S.ARCHIVED, S.FAILED],
  // regenerate design: later stages may step back to design_generated
  [S.DESIGN]:    [S.MOCKUP, S.REJECTED, S.ARCHIVED, S.FAILED],
  [S.MOCKUP]:    [S.DRAFTED, S.DESIGN, S.REJECTED, S.ARCHIVED, S.FAILED],
  [S.DRAFTED]:   [S.PENDING, S.DESIGN, S.REJECTED, S.ARCHIVED, S.FAILED],
  // edit copy -> back to drafted; regenerate design -> design_generated
  [S.PENDING]:   [S.APPROVED, S.DRAFTED, S.DESIGN, S.REJECTED, S.ARCHIVED, S.FAILED],
  // un-approve -> PENDING_APPROVAL
  [S.APPROVED]:  [S.PUBLISHED, S.PENDING, S.REJECTED, S.ARCHIVED, S.FAILED],
  [S.PUBLISHED]: [S.LIVE, S.FAILED],
  [S.LIVE]:      [S.ARCHIVED, S.FAILED],
  [S.REJECTED]:  [S.ARCHIVED],
  [S.FAILED]:    [S.IDEA, S.ARCHIVED],
  [S.ARCHIVED]:  [],
};

class StageError extends Error {
  constructor(message, code, extra = {}) { super(message); this.name = 'StageError'; this.code = code; Object.assign(this, extra); }
}

const ACTORS = ['human', 'agent'];
const now = () => new Date().toISOString();
const parseFlags = p => { try { return JSON.parse(p.flags || '[]'); } catch { return []; } };

function canTransition(from, to) { return (TRANSITIONS[from] || []).includes(to); }

/** What a human is being asked to approve; listed in the confirm summary. */
function approvalSummary(product) {
  const flags = parseFlags(product);
  const m = product.projected_margin_cents;
  const lines = [`Approve product #${product.id}${product.title ? ` "${product.title}"` : ''} for publishing.`];
  if (m !== null && m !== undefined) lines.push(`Projected unit margin: ${(m / 100).toFixed(2)} ${product.currency || 'USD'}.`);
  if (flags.length) lines.push(`FLAGGED: ${flags.map(f => f.code + (f.detail ? ` (${f.detail})` : '')).join('; ')}.`);
  lines.push('Publishing afterwards is irreversible by this app.');
  return lines.join(' ');
}

function makeStages({ db, isDryRun }) {
  const get = id => db.prepare('SELECT * FROM products WHERE id = ?').get(id);

  function createProduct({ brief = '', niche = '', storeId = null, blueprint = null, printProviderId = null, listPriceCents = null, shippingCents = 0, actor = 'human' } = {}) {
    if (!ACTORS.includes(actor)) throw new StageError(`Unknown actor "${actor}"`, 'bad_actor');
    return tx(db, () => {
      const t = now();
      const id = Number(db.prepare(`INSERT INTO products(stage,brief,niche,store_id,blueprint,print_provider_id,list_price_cents,shipping_cents,created_at,updated_at)
        VALUES('idea',?,?,?,?,?,?,?,?,?)`).run(brief, niche, storeId, blueprint, printProviderId, listPriceCents, shippingCents, t, t).lastInsertRowid);
      db.prepare("INSERT INTO events(product_id,kind,stage_from,stage_to,actor,note,ts) VALUES(?,'stage',NULL,'idea',?,?,?)").run(id, actor, 'created', t);
      return get(id);
    });
  }

  /** transition(productOrId, to, {actor, note}) -> the updated product row. */
  function transition(productOrId, to, { actor, note = '' } = {}) {
    if (!ACTORS.includes(actor)) throw new StageError(`Actor must be one of ${ACTORS.join('/')}`, 'bad_actor');
    if (!STAGES.includes(to)) throw new StageError(`Unknown stage "${to}"`, 'unknown_stage');
    const id = typeof productOrId === 'object' ? productOrId.id : productOrId;
    return tx(db, () => {
      const p = get(id); // fresh read inside the transaction; never trust a stale object
      if (!p) throw new StageError(`Product ${id} not found`, 'not_found');
      const from = p.stage;
      if (!canTransition(from, to)) throw new StageError(`Illegal transition ${from} -> ${to}`, 'illegal', { from, to });
      if (to === S.FAILED && !String(note).trim()) throw new StageError('A failed transition needs a reason (note)', 'reason_required');

      if (to === S.APPROVED && actor === 'agent') {
        const store = p.store_id ? db.prepare('SELECT * FROM stores WHERE id = ?').get(p.store_id) : null;
        const why = [];
        if (!store || !store.autopublish) why.push('store autopublish is off');
        if (isDryRun()) why.push('DRY_RUN is on');
        const flags = parseFlags(p);
        if (flags.length) why.push(`product is flagged (${flags.map(f => f.code).join(', ')})`);
        if (why.length) throw new StageError(`The agent may not approve: ${why.join('; ')}. A human must approve.`, 'approval_required', { from, to });
      }

      const t = now();
      if (to === S.FAILED) {
        db.prepare('UPDATE products SET stage = ?, failed_reason = ?, failed_from = ?, updated_at = ? WHERE id = ?').run(to, String(note), from, t, id);
      } else if (from === S.FAILED) {
        db.prepare('UPDATE products SET stage = ?, failed_reason = NULL, failed_from = NULL, updated_at = ? WHERE id = ?').run(to, t, id);
      } else {
        db.prepare('UPDATE products SET stage = ?, updated_at = ? WHERE id = ?').run(to, t, id);
      }
      db.prepare("INSERT INTO events(product_id,kind,stage_from,stage_to,actor,note,ts) VALUES(?,'stage',?,?,?,?,?)").run(id, from, to, actor, String(note), t);
      return get(id);
    });
  }

  return { createProduct, transition, get, canTransition };
}

module.exports = { makeStages, STAGES, S, TRANSITIONS, PRE_PUBLISH, StageError, canTransition, approvalSummary, parseFlags, ACTORS };
