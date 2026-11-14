'use strict';
/**
 * next-sale.js — the one next step between this shop and a real Etsy sale.
 *
 * Read only. nextSale() writes nothing, and loadNextSale() only SELECTs.
 * The home poll must not call Printify or Etsy: a shop-link mismatch is named
 * later, on the card's Publish confirm, which already runs those checks.
 * Dry run stays on until a person types the phrase in the top bar. This module
 * has no disarm path.
 */
const { loadSchedule } = require('./fee-schedule');

const RANK = {
  live: 80, published: 70, approved: 60, PENDING_APPROVAL: 50, listing_drafted: 40,
  mockup_ready: 30, design_generated: 20, idea: 10, failed: 5,
};

function flagsOf(p) {
  if (Array.isArray(p.flags)) return p.flags;
  try { const v = JSON.parse(p.flags || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

function usd(cents) { return `$${(cents / 100).toFixed(2)}`; }

function stageName(s) {
  if (s === 'PENDING_APPROVAL') return 'pending approval';
  return String(s || '').replace(/_/g, ' ');
}

function label(p) {
  const t = String(p.title || p.listingTitle || p.brief || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `Product #${p.id}${t ? ` (${t})` : ''}.`;
}

function step(code, title, detail, extra = {}) {
  return {
    code, title, detail, writes: false,
    open: extra.open || null,
    productId: extra.productId || null,
    notes: extra.notes || [],
  };
}

function feePhrase(ctx) {
  return Number.isInteger(ctx.listingFeeCents) ? `the listing fee (${usd(ctx.listingFeeCents)})` : 'the listing fee';
}

function reviewNotes(p) {
  const flags = flagsOf(p);
  const notes = [];
  if (flags.some(f => f.code === 'print_review')) notes.push('print_review is on this card: look at the mockup before you publish.');
  if (flags.some(f => f.code === 'single_variant')) notes.push('single_variant: only the first size and colour would be sold until you pick variants.');
  if (p.pod_cost_source === 'estimate' || flags.some(f => f.code === 'pod_cost_estimated')) notes.push('The base cost is still an estimate.');
  return notes;
}

function noteSuffix(notes) { return notes.length ? ` ${notes.join(' ')}` : ''; }

/** Local publish refusals. Same codes as etsy/publish.js blockers(), without the Printify shop read. */
function localBlockers(p) {
  const b = [];
  const id = p.pod_external_id;
  if (!id || String(id).startsWith('stub-')) b.push({ code: 'no_pod_product', message: 'There is no real Printify product yet. On the card, press Create POD product + mockups. That uploads the saved PNG and reads the real base cost. It does not generate a new image. It voids an earlier approval, so approve again afterwards.' });
  if (p.pod_cost_source === 'estimate' || flagsOf(p).some(f => f.code === 'pod_cost_estimated')) b.push({ code: 'estimated_cost', message: 'The base cost is still an estimate. On the card, press Create POD product + mockups with live writes on so the Printify price is read. That does not generate a new image. It voids the earlier approval.' });
  if (!Number.isInteger(p.list_price_cents) || p.list_price_cents <= 0) b.push({ code: 'no_price', message: 'Set a list price on the card first.' });
  if (!p.listingTitle) b.push({ code: 'no_copy', message: 'There is no listing title to publish. Write one in Listing copy and press Save copy.' });
  return b;
}

function productStep(p, ctx) {
  const dry = ctx.dryRun !== false;
  const flags = flagsOf(p);
  const pn = flags.find(f => f.code === 'print_not_ready');
  if (pn) {
    return step('print_not_ready', 'The design does not cover the print area',
      `${label(p)} ${pn.detail || 'The file is kept.'} Upload a PNG that already fills the print area. Do not lower the coverage rule, and do not press Generate to force it through.`,
      { productId: p.id, open: 'product' });
  }
  if (p.stage === 'failed') {
    return step('product_failed', 'This product failed',
      `${label(p)} ${p.failed_reason || 'Open the card and read the reason.'} The saved PNG can be reused. Do not press Generate unless you want a new image.`,
      { productId: p.id, open: 'product' });
  }
  if (p.stage === 'published' || p.stage === 'live') {
    if (ctx.saleCount > 0) {
      return step('check_money', 'Check the first sale',
        `${label(p)} A sale is recorded. Open Sales and confirm NET is the Etsy payout minus Etsy's fees and the Printify cost. AI disclosure and Designed by stay on the Etsy listing. This app does not write them.`,
        { productId: p.id, open: 'sales' });
    }
    return step('disclose', 'Add the disclosure on Etsy',
      `${label(p)} The listing is ${stageName(p.stage)}. On Etsy, add the AI disclosure, tick the AI checkbox, and set Designed by. Check the shipping time against the printer. This app does not write those. After the first order, open Sales and press Sync.`,
      { productId: p.id, open: 'product' });
  }
  if (!p.blueprint || !p.print_provider_id) {
    return step('need_blank', 'Pick an ornament or a sticker',
      `${label(p)} New product is where the blank is chosen. Pick an ornament or a sticker, then Upload your PNG. A square ornament file about 2000 pixels on a side is the safer first product. Do not press Generate.`,
      { productId: p.id, open: 'composer' });
  }
  if (p.stage === 'idea' || p.stage === 'design_generated') {
    return step('create_pod', 'Create the print-provider product',
      `${label(p)} Open the card and press Create POD product + mockups. It reuses the saved PNG and does not generate a new image. ${dry ? 'Dry run is on, so the base cost will be an estimate and nothing is listed.' : 'Live writes are on, so this creates a real Printify product and reads the real base cost. It does not publish the listing.'}`,
      { productId: p.id, open: 'product' });
  }
  if (p.stage === 'mockup_ready') {
    return step('draft_listing', 'Draft the listing',
      `${label(p)} Open the card and press Draft listing + margin. Read the title as a buyer. Copy is not an image spend.`,
      { productId: p.id, open: 'product' });
  }

  const notes = reviewNotes(p);
  if (!p.listingTitle) {
    return step('need_copy', 'Write the listing title',
      `${label(p)} Open the card, write the title in Listing copy, and press Save copy. That is not an image spend.`,
      { productId: p.id, open: 'product' });
  }
  if (!Number.isInteger(p.list_price_cents) || p.list_price_cents <= 0) {
    return step('need_price', 'Set a list price',
      `${label(p)} Set the list price on the card before submitting it.`,
      { productId: p.id, open: 'product' });
  }
  const floor = Number.isInteger(ctx.marginFloorCents) ? ctx.marginFloorCents : 200;
  if (Number.isInteger(p.projected_margin_cents) && p.projected_margin_cents < floor) {
    return step('margin_below_floor', 'The margin is under the floor',
      `${label(p)} Projected margin is ${usd(p.projected_margin_cents)}. The floor is ${usd(floor)}. Raise the price or pick a cheaper blank before approving.`,
      { productId: p.id, open: 'product' });
  }
  if (p.stage === 'listing_drafted') {
    return step('submit', 'Submit it for approval',
      `${label(p)} Open the card and press Submit for approval. ${dry ? 'Dry run stays on. Submitting does not list it and does not charge a fee.' : 'Live writes are on. Submitting still does not publish.'}${noteSuffix(notes)}`,
      { productId: p.id, open: 'product', notes });
  }
  if (dry && (p.stage === 'PENDING_APPROVAL' || p.stage === 'approved')) {
    const where = p.stage === 'PENDING_APPROVAL' ? 'pending approval' : 'approved';
    return step('dry_run_ready', 'Dry run looks ready',
      `${label(p)} It is ${where}. Turn dry run off from the top bar only when you want Etsy to charge ${feePhrase(ctx)}. Then, on the card, press Create POD product + mockups so the base cost is a real Printify price, approve again, and publish. This card does not turn dry run off.${noteSuffix(notes)}`,
      { productId: p.id, open: 'product', notes });
  }
  if (p.stage === 'PENDING_APPROVAL') {
    return step('need_approval', 'Approve the product',
      `${label(p)} Read the price, the margin, and the flags, then press Approve. Publishing is a separate step.${noteSuffix(notes)}`,
      { productId: p.id, open: 'product', notes });
  }
  const blockers = Array.isArray(ctx.liveBlockers) ? ctx.liveBlockers : localBlockers(p);
  if (blockers.length) {
    return step(blockers[0].code, 'A live publish would be refused',
      `${label(p)} ${blockers[0].message}`,
      { productId: p.id, open: 'product' });
  }
  return step('ready_to_publish', 'Publish when you mean to list it',
    `${label(p)} Approved, with a price and a connected shop. Press Publish on the card when you want it listed. The confirm names the shop. If Printify is not linked to that Etsy shop, Publish refuses and says why. Afterwards, add the AI disclosure and Designed by on Etsy. This app does not write those.${noteSuffix(notes)}`,
    { productId: p.id, open: 'product', notes });
}

/**
 * @param {object} ctx
 * @param {object} ctx.has printify, etsy_api_key, etsy_shared_secret booleans
 * @param {object|null} ctx.store status, shop_id, oauth_sealed (boolean, never the token)
 * @param {boolean} ctx.dryRun
 * @param {object[]} ctx.products rows that are not archived or rejected
 * @param {number} ctx.saleCount sales whose source is not stub
 * @param {object[]} [ctx.liveBlockers] optional publish refusals already computed by the caller
 */
function nextSale(ctx) {
  const has = ctx.has || {};
  const dry = ctx.dryRun !== false;
  if (!has.printify) {
    return { ...step('need_printify', 'Add the Printify token',
      'Settings, Credentials, printify. This is the Printify API token. Printify bills the blank when someone buys. This card does not save a token.',
      { open: 'settings' }), dryRun: dry };
  }
  if (!has.etsy_api_key || !has.etsy_shared_secret) {
    const missing = [!has.etsy_api_key && 'etsy_api_key', !has.etsy_shared_secret && 'etsy_shared_secret'].filter(Boolean);
    return { ...step('need_etsy_keys', 'Add the Etsy app keys',
      `Settings, Credentials. Still missing: ${missing.join(' and ')}. The Etsy app redirect is https://ecom.octopustechnology.net/api/etsy/callback.`,
      { open: 'settings' }), dryRun: dry };
  }
  const store = ctx.store || null;
  if (!store) {
    return { ...step('need_etsy_store', 'Connect the Etsy shop',
      'Settings, Stores, Connect Etsy. Approve listings_r, listings_w, transactions_r, and shops_r. Open the Etsy shop and add the bank first if that is not done.',
      { open: 'settings' }), dryRun: dry };
  }
  if (store.status === 'no_shop') {
    return { ...step('need_etsy_shop', 'Finish opening the Etsy shop',
      'Etsy connected, but this account has no shop. Open the shop in Etsy Shop Manager, then Settings, Stores, Check shop.',
      { open: 'settings' }), dryRun: dry };
  }
  if (!store.shop_id) {
    return { ...step('need_etsy_shop', 'Read the Etsy shop',
      store.status_detail || 'Settings, Stores, Check shop. The connection has no shop id yet.',
      { open: 'settings' }), dryRun: dry };
  }
  if (store.status !== 'connected' || !store.oauth_sealed) {
    return { ...step('etsy_disconnected', 'Reconnect Etsy',
      store.status_detail || 'Settings, Stores. The shop is not connected.',
      { open: 'settings' }), dryRun: dry };
  }

  const products = (ctx.products || []).filter(p => p && !['archived', 'rejected'].includes(p.stage));
  const withDesign = products.filter(p => Number(p.designCount) > 0);
  if (!withDesign.length) {
    const existing = products.slice().sort((a, b) => b.id - a.id)[0];
    const who = existing ? `${label(existing)} ` : '';
    return { ...step('need_design', 'Upload a print-ready PNG',
      `${who}New product, then Upload your PNG. Use an ornament or a sticker that already fills the print area. A square ornament file about 2000 pixels on a side is the safer first product. Upload costs nothing and becomes the print file. Do not press Generate.`,
      { open: existing ? 'product' : 'composer', productId: existing ? existing.id : null }), dryRun: dry };
  }
  const pool = withDesign.slice().sort((a, b) => (RANK[b.stage] || 0) - (RANK[a.stage] || 0) || b.id - a.id);
  return { ...productStep(pool[0], ctx), dryRun: dry };
}

function loadNextSale({ db, credentials, dryRun, settings }) {
  const store = db.prepare(`
    SELECT id, status, shop_id, shop_name, status_detail,
           CASE WHEN oauth_sealed IS NOT NULL AND length(oauth_sealed) > 0 THEN 1 ELSE 0 END AS linked
    FROM stores
    WHERE platform = 'etsy'
    ORDER BY CASE WHEN status = 'connected' AND shop_id IS NOT NULL AND oauth_sealed IS NOT NULL AND length(oauth_sealed) > 0 THEN 0 ELSE 1 END, id
    LIMIT 1
  `).get() || null;
  const products = db.prepare(`
    SELECT p.id, p.stage, p.title, p.brief, p.flags, p.list_price_cents, p.projected_margin_cents,
           p.pod_external_id, p.pod_cost_source, p.blueprint, p.print_provider_id, p.failed_reason,
           (SELECT COUNT(*) FROM designs d WHERE d.product_id = p.id) AS designCount,
           (SELECT title FROM listings l WHERE l.product_id = p.id AND platform = 'etsy' ORDER BY id DESC LIMIT 1) AS listingTitle
    FROM products p
    WHERE p.stage NOT IN ('archived', 'rejected')
  `).all();
  const saleCount = db.prepare("SELECT COUNT(*) AS n FROM sales WHERE COALESCE(source, 'etsy') != 'stub'").get().n;
  return {
    has: {
      printify: credentials.has('printify'),
      etsy_api_key: credentials.has('etsy_api_key'),
      etsy_shared_secret: credentials.has('etsy_shared_secret'),
    },
    store: store ? {
      id: store.id,
      status: store.status,
      shop_id: store.shop_id,
      shop_name: store.shop_name,
      oauth_sealed: Boolean(store.linked),
      status_detail: store.status_detail || '',
    } : null,
    dryRun: dryRun.isOn(),
    marginFloorCents: settings.getInt('margin_floor_cents', 200),
    listingFeeCents: loadSchedule(settings).listingFeeCents,
    products,
    saleCount,
  };
}

module.exports = { nextSale, loadNextSale, localBlockers };
