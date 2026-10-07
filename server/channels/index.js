'use strict';
/** channels/index.js — the channel registry (Etsy: api, Redbubble: manual) and the services behind the manual one. */
const { assertChannel } = require('./contract');
const { makeChannelState } = require('./state');
const { makeRedbubble } = require('./redbubble');
const { makeRedbubbleSales } = require('./redbubble-sales');

function makeChannels({ db, dataDir, upscale = null, log = console }) {
  const state = makeChannelState({ db });
  const redbubbleSales = makeRedbubbleSales({ db, log });
  const redbubble = makeRedbubble({ db, dataDir, upscale, log, channelState: state });

  const etsy = assertChannel({
    id: 'etsy', label: 'Etsy', capability: 'api',
    automated: ['publish through Printify (behind approval, the confirm modal and DRY_RUN)', 'sales and refund sync', 'listing edits', 'view counts'],
    manual: ['approve the listing', 'Etsy-side settings (shipping profile, AI/"designed by" fields)', 'ads'],
    playbooks: ['launch-pod-etsy', 'margin-fell', 'views-no-sales', 'seasonal-prep', 'ip-complaint'],
  });
  const rb = assertChannel({
    id: 'redbubble', label: 'Redbubble', capability: 'manual',
    automated: ['upload pack: sized PNG, adapted and linted copy, markup, product types, checklist', 'listing state and work URL tracking', 'sales CSV import (assumed headers) or manual entry', 'attribution into NET'],
    manual: ['sign in and upload', 'copy the fields from the pack into the form', 'paste the work URL back', 'download the sales CSV from the Sales History page', 'payment and tax settings', 'answer IP notices'],
    playbooks: ['redbubble-revive', 'redbubble-publish', 'redbubble-weekly', 'redbubble-takedown', 'redbubble-game-plan'],
    prepare: (id, o) => redbubble.pack(id, o), importSales: (text, o) => redbubbleSales.importCsv(text, o),
  });
  const registry = { etsy, redbubble: rb };

  /** The listing state of a product on every channel. Etsy's is derived from the stage; it is never stored here. */
  function statesFor(p) {
    const etsyState = p.stage === 'live' ? 'live' : p.stage === 'published' ? 'uploaded' : 'not_listed';
    return { etsy: { channel: 'etsy', state: etsyState, derivedFrom: 'stage' }, redbubble: state.get(p.id, 'redbubble') };
  }

  /** Revenue per channel for one product (or all, productId null). Lines are real receipts only; simulated ones are excluded. */
  function salesByChannel(productId = null) {
    const rows = db.prepare(`SELECT channel, COUNT(*) AS lines, COALESCE(SUM(gross_cents),0) AS gross, COALESCE(SUM(net_cents),0) AS net, COALESCE(SUM(refund_cents),0) AS refunded, COALESCE(SUM(cogs_cents),0) AS cogs
      FROM sales WHERE source != 'stub' AND (? IS NULL OR product_id = ?) GROUP BY channel`).all(productId, productId);
    const out = {};
    for (const r of rows) out[r.channel] = { lines: r.lines, grossCents: r.gross, netAfterFeesCents: r.net, refundedCents: r.refunded, cogsCents: r.cogs };
    return out;
  }

  const describe = () => Object.values(registry).map(c => ({ id: c.id, label: c.label, capability: c.capability, automated: c.automated, manual: c.manual, playbooks: c.playbooks }));
  return { registry, describe, state, redbubble, redbubbleSales, statesFor, salesByChannel };
}

module.exports = { makeChannels };
