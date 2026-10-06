'use strict';
/**
 * plan/context.js — the compact system prompt for the planning chat, built from this app's own data.
 * A few hundred tokens by design: the cost of a chat is mostly what is re-sent every turn.
 * Read-only. Nothing here carries credentials, store tokens, other conversations or full copy.
 *
 * Scope: products, sales and settings in this console are not partitioned per user (the console is
 * owner-gated and shared by its owners), so "the caller's data" is the console's data plus the
 * caller's OWN conversation, which the route supplies as messages. The username is not sent in the prompt.
 */
const { PLAYBOOKS } = require('../playbooks');
const { STAGES } = require('../domain/stages');

const MAX_CHARS = 2400;      // ~600 tokens hard ceiling
const RECENT = 8;
const usd = (c) => (c === null || c === undefined ? '?' : `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toFixed(2)}`);
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/**
 * THE ONE place the chat reads fee and margin settings. If fees become editable (settings-backed),
 * adapt this function only: return { listingFeeCents, transactionBps, processingBps, processingFixedCents, marginFloorCents }.
 */
function readFees({ settings }) {
  const f = require('../domain/fees');
  return {
    listingFeeCents: f.LISTING_FEE_CENTS, transactionBps: f.TRANSACTION_FEE_BPS,
    processingBps: f.PROCESSING_FEE_BPS, processingFixedCents: f.PROCESSING_FIXED_CENTS,
    marginFloorCents: settings.getInt('margin_floor_cents', 200),
  };
}

function buildPlanContext({ db, settings, spend, fees = readFees }) {
  const lines = [];
  let f = null; try { f = fees({ settings }); } catch { f = null; }
  if (f) lines.push(`Fees: listing ${usd(f.listingFeeCents)}, transaction ${(f.transactionBps / 100).toFixed(1)}%, processing ${(f.processingBps / 100).toFixed(1)}% + ${usd(f.processingFixedCents)}; margin floor ${usd(f.marginFloorCents)}. Margin = price - print cost - those fees (offsite ads, renewals not modelled).`);

  const counts = Object.fromEntries(db.prepare('SELECT stage, COUNT(*) AS n FROM products GROUP BY stage').all().map(r => [r.stage, r.n]));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  lines.push(`Products: ${total ? [...STAGES, ...Object.keys(counts).filter(s => !STAGES.includes(s))].filter(s => counts[s]).map(s => `${s} ${counts[s]}`).join(', ') : 'none yet'}.`);

  const recent = db.prepare('SELECT id, stage, title, brief, niche, list_price_cents, projected_margin_cents FROM products ORDER BY updated_at DESC, id DESC LIMIT ?').all(RECENT);
  if (recent.length) {
    lines.push('Recent products (stage | title | niche | price | projected margin):');
    for (const p of recent) lines.push(`- ${p.stage} | ${clip(p.title || p.brief, 50)} | ${clip(p.niche, 24) || '-'} | ${usd(p.list_price_cents)} | ${usd(p.projected_margin_cents)}`);
  }

  if (spend) {
    const s = spend.summary();
    lines.push(s.revenue.orders
      ? `Sales (real): ${s.revenue.orders} order line(s), gross ${usd(s.revenue.grossCents)}, NET after all costs ${usd(s.netCents)}.`
      : 'Sales: none yet (no real orders).');
  }
  lines.push(`Playbooks: ${PLAYBOOKS.map(p => p.title).join('; ')}.`);

  let text = lines.join('\n');
  if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS - 1)}…`;
  return text;
}

const PLAN_SYSTEM = `You are a business-planning adviser for a small print-on-demand shop (original designs, Printify production, sold on Etsy). Help with niches, pricing, margins and what to make next. Be concrete and brief. Use the shop data below; say so when it is thin rather than inventing numbers. Never suggest copying another seller's listings, images or brands. You cannot take actions: you cannot publish, spend money or change settings, so give recommendations the owner can act on.

SHOP DATA (read at the time of this message)
`;

module.exports = { buildPlanContext, readFees, PLAN_SYSTEM, MAX_CHARS };
