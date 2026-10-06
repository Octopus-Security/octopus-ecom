'use strict';
/** spend.js — cost rows, ET-day roll-ups, the daily cap, and the headline summary. */

/** ET ("America/New_York") calendar date, YYYY-MM-DD. ET is the only clock. */
function etDay(date = new Date()) {
  return date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

class SpendCapError extends Error {
  constructor(message, info) { super(message); this.name = 'SpendCapError'; Object.assign(this, info); }
}

function makeSpend({ db, settings, now = () => new Date() }) {
  const q = (sql, ...a) => db.prepare(sql).get(...a);
  const capCents = () => settings.getInt('daily_spend_cap_cents', 500);
  // The daily cap governs GENERATION spend (image/llm/ad). Per-sale COGS ('pod') is the cost of goods sold, and the
  // Etsy listing fee ('listing_fee') is a marketplace charge for something the operator already approved: neither can
  // be "paused", and counting them would let a busy sales day stop image generation.
  const todayCents = () => q("SELECT COALESCE(SUM(amount_cents),0) AS v FROM costs WHERE day = ? AND kind NOT IN ('pod','listing_fee')", etDay(now())).v;
  return {
    capCents, todayCents,
    addCost({ productId = null, kind, amountCents, note = null }) {
      if (!Number.isInteger(amountCents) || amountCents < 0) throw new Error('amountCents must be a non-negative integer');
      const d = now();
      db.prepare('INSERT INTO costs(product_id,kind,amount_cents,note,ts,day) VALUES(?,?,?,?,?,?)')
        .run(productId, kind, amountCents, note, d.toISOString(), etDay(d));
    },
    /** Throws SpendCapError if spending `estimateCents` more would pass the cap. A cap of 0 means "no spending". */
    assertCanSpend(estimateCents = 0) {
      const cap = capCents(); const today = todayCents();
      if (today + estimateCents > cap) {
        throw new SpendCapError(`Daily spend cap reached (${today}c spent of ${cap}c today, ET). Generation is paused until tomorrow or the cap is raised.`,
          { capCents: cap, todayCents: today, estimateCents });
      }
    },
    summary() {
      const total = q('SELECT COALESCE(SUM(amount_cents),0) AS v FROM costs').v;
      // Real receipts only: simulated (stub) sales never reach NET; they are reported separately.
      const s = q("SELECT COALESCE(SUM(gross_cents),0) AS gross, COALESCE(SUM(net_cents),0) AS net, COALESCE(SUM(refund_cents),0) AS refunded, COUNT(*) AS n FROM sales WHERE source != 'stub'");
      const sim = q("SELECT COALESCE(SUM(gross_cents),0) AS gross, COALESCE(SUM(net_cents),0) AS net, COUNT(*) AS n FROM sales WHERE source = 'stub'");
      const cogs = q("SELECT COALESCE(SUM(amount_cents),0) AS v FROM costs WHERE kind = 'pod'").v;
      const fees = q("SELECT COALESCE(SUM(amount_cents),0) AS v FROM costs WHERE kind = 'listing_fee'").v;
      const cap = capCents(); const today = todayCents();
      return {
        currency: 'USD',
        spend: { totalCents: total, todayCents: today, dailyCapCents: cap, capReached: today >= cap, capPct: cap > 0 ? Math.min(100, Math.round((today / cap) * 100)) : 100 },
        revenue: { grossCents: s.gross, refundedCents: s.refunded, afterFeesCents: s.net, orders: s.n, cogsCents: cogs, listingFeesCents: fees },
        simulated: { grossCents: sim.gross, afterFeesCents: sim.net, orders: sim.n },
        // NET = what the (real) receipts left after Etsy + processing fees and refunds, minus every cost we incurred (image, llm, listing fees, per-sale COGS).
        netCents: s.net - total,
      };
    },
  };
}

module.exports = { makeSpend, SpendCapError, etDay };
