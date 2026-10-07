'use strict';
/**
 * channels/state.js — per-product, per-channel listing state for MANUAL channels (table `channel_listings`).
 *
 *   not_listed -> uploaded -> live -> removed          not_listed = nothing on the channel
 *   uploaded -> not_listed (undo)                      uploaded   = the human has uploaded it; not yet confirmed visible
 *   removed -> uploaded | not_listed (re-upload)       live       = visible on the channel; the work URL is required
 *                                                      removed    = taken down (by us, or by the platform: see the takedown playbook)
 * The state never touches products.stage (only domain/stages.js writes that). Every change leaves a note event on the product.
 */
const { productEvent } = require('../events');
const { STATES } = require('./contract');

const TRANSITIONS = Object.freeze({
  not_listed: ['uploaded'],
  uploaded: ['live', 'not_listed'],
  live: ['removed'],
  removed: ['uploaded', 'not_listed'],
});

class ChannelError extends Error {
  constructor(message, status, code) { super(message); this.name = 'ChannelError'; this.status = status; this.code = code; }
}

/** A work URL must be https on redbubble.com (or a subdomain). Returns the normalised URL and the numeric work id when one is visible. */
function parseWorkUrl(raw, hostSuffix = 'redbubble.com') {
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw new ChannelError('That is not a valid URL', 400, 'bad_url'); }
  const h = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || !(h === hostSuffix || h.endsWith(`.${hostSuffix}`))) throw new ChannelError(`The link must be an https://…${hostSuffix} address`, 400, 'bad_url');
  if (String(raw).length > 500) throw new ChannelError('That URL is too long', 400, 'bad_url');
  // Assumed shape: .../i/<product>/<title>-by-<shop>/<work id>.<variant code>  (the id is the long number before the dot)
  const m = u.pathname.match(/\/(\d{5,})(?:\.[A-Za-z0-9]+)?\/?$/) || u.pathname.match(/\/(\d{5,})(?:[.\-\/]|$)/);
  return { url: `${u.origin}${u.pathname}`, workId: m ? m[1] : null };
}

function makeChannelState({ db, now = () => new Date() }) {
  const row = (productId, channel) => db.prepare('SELECT * FROM channel_listings WHERE product_id = ? AND channel = ?').get(Number(productId), channel);
  const view = r => (r ? { channel: r.channel, state: r.state, url: r.url, workId: r.work_id, title: r.work_title, uploadedAt: r.uploaded_at, liveAt: r.live_at, updatedAt: r.updated_at } : null);

  function get(productId, channel) { return view(row(productId, channel)) || { channel, state: 'not_listed', url: null, workId: null, title: null, uploadedAt: null, liveAt: null, updatedAt: null }; }

  /** set({productId, channel, to, url?, title?, actor}) -> the new state view. Throws ChannelError (400/404/409). */
  function set({ productId, channel, to, url, title, actor = 'human', requireDesign = true, hostSuffix }) {
    productId = Number(productId);
    if (!STATES.includes(to)) throw new ChannelError(`state must be one of ${STATES.join(', ')}`, 400, 'bad_state');
    const p = db.prepare('SELECT id, stage FROM products WHERE id = ?').get(productId);
    if (!p) throw new ChannelError('Not found', 404, 'not_found');
    const cur = row(productId, channel);
    const from = cur ? cur.state : 'not_listed';
    const sameState = from === to;
    if (!sameState && !(TRANSITIONS[from] || []).includes(to)) throw new ChannelError(`${channel}: ${from} cannot go to ${to} (allowed: ${(TRANSITIONS[from] || []).join(', ') || 'none'})`, 409, 'illegal_transition');
    if (!sameState && to === 'uploaded' && requireDesign && !db.prepare('SELECT 1 FROM designs WHERE product_id = ?').get(productId)) throw new ChannelError('This product has no design yet, so there is nothing to have uploaded', 409, 'no_design');
    let parsed = null;
    if (url !== undefined && url !== null && String(url).trim() !== '') parsed = parseWorkUrl(url, hostSuffix);
    if (to === 'live' && !parsed && !(cur && cur.url)) throw new ChannelError('Paste the work URL to mark it live (open the work on the site and copy the address)', 400, 'url_required');
    if (parsed && parsed.workId) {
      const other = db.prepare('SELECT product_id FROM channel_listings WHERE channel = ? AND work_id = ? AND product_id != ?').get(channel, parsed.workId, productId);
      if (other) throw new ChannelError(`That work is already recorded on product #${other.product_id}`, 409, 'url_in_use');
    }
    if (title !== undefined && title !== null && String(title).length > 300) throw new ChannelError('title is too long', 400, 'bad_title');
    const t = now().toISOString();
    const newTitle = title !== undefined && title !== null ? String(title).trim() || null : (cur ? cur.work_title : null);
    const newUrl = parsed ? parsed.url : (cur ? cur.url : null);
    const newWork = parsed ? parsed.workId : (cur ? cur.work_id : null);
    if (cur) {
      db.prepare('UPDATE channel_listings SET state=?, url=?, work_id=?, work_title=?, uploaded_at=COALESCE(uploaded_at, ?), live_at=?, updated_at=? WHERE id=?')
        .run(to, newUrl, newWork, newTitle, to === 'uploaded' ? t : null, to === 'live' ? (cur.live_at || t) : cur.live_at, t, cur.id);
    } else {
      db.prepare('INSERT INTO channel_listings(product_id,channel,state,url,work_id,work_title,uploaded_at,live_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(productId, channel, to, newUrl, newWork, newTitle, to === 'uploaded' ? t : null, to === 'live' ? t : null, t, t);
    }
    if (!sameState) productEvent(db, productId, { actor, note: `${channel}: ${from} -> ${to}${newUrl && to === 'live' ? ` (${newUrl})` : ''}` });
    return get(productId, channel);
  }

  /** product_id -> {channel: state} for the board, in one query. */
  function boardMap() {
    const out = new Map();
    for (const r of db.prepare('SELECT product_id, channel, state FROM channel_listings').all()) {
      if (!out.has(r.product_id)) out.set(r.product_id, {});
      out.get(r.product_id)[r.channel] = r.state;
    }
    return out;
  }

  return { get, set, boardMap };
}

module.exports = { TRANSITIONS, ChannelError, parseWorkUrl, makeChannelState };
