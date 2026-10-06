'use strict';
/**
 * etsy/publish.js — publish a product Printify -> Etsy, reconcile it to `live`, and edit a live listing.
 *
 * Preconditions for a LIVE publish (each one is a named refusal, none is silent):
 *   stage approved (route, 409 not_approved) · DRY_RUN off · a real Printify product (not a DRY_RUN stub) ·
 *   base cost not an estimate · a list price · an Etsy store that is connected AND has a shop · the Printify shop
 *   is linked to Etsy and is that shop. Under DRY_RUN the same checks are computed and reported as `liveBlockers`,
 *   but only a simulated publish happens (stage unchanged).
 *
 * The stage moves ONLY through stages.transition(): approved -> published when Printify accepts the publish call,
 * published -> live when Etsy shows the listing active (reconcile). The Etsy listing fee is written to `costs` once,
 * at the moment the Etsy listing id is first known (normally inside the publish call itself, else at the first
 * reconcile): a fee is only real once a listing exists, so it is not charged on a publish that never materialised.
 */
const { S, parseFlags } = require('../domain/stages');
const { projectMargin } = require('../domain/fees');
const { loadSchedule } = require('../domain/fee-schedule');
const { enforceCopy } = require('../domain/etsy-rules');
const { checkBlocklist } = require('../domain/blocklist');
const { PipelineError } = require('../pipeline');
const { productEvent } = require('../events');
const { tx } = require('../db');

const usd = c => `$${(c / 100).toFixed(2)}`;
const isStubId = id => !id || String(id).startsWith('stub-');

function makePublisher({ db, settings = null, stages, adapters, pipeline, spend, dryRun, etsy, log = console, env = process.env, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const pollAttempts = Number(env.PUBLISH_POLL_ATTEMPTS) >= 0 && env.PUBLISH_POLL_ATTEMPTS !== undefined ? Number(env.PUBLISH_POLL_ATTEMPTS) : 3;
  const pollMs = Number(env.PUBLISH_POLL_MS) >= 0 && env.PUBLISH_POLL_MS !== undefined ? Number(env.PUBLISH_POLL_MS) : 2000;
  const listingFee = () => loadSchedule(settings).listingFeeCents;
  const get = id => db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  const listingOf = id => db.prepare("SELECT * FROM listings WHERE product_id = ? AND platform = 'etsy' ORDER BY id DESC LIMIT 1").get(id);
  const storeFor = p => (p.store_id ? etsy.row(p.store_id) : null) || etsy.etsyStore();
  const parseTags = l => { try { return JSON.parse(l.tags || '[]'); } catch { return []; } };

  /** Every reason a LIVE publish would be refused right now: [{code, message}]. Empty = ready. */
  async function blockers(p) {
    const b = [];
    if (isStubId(p.pod_external_id)) b.push({ code: 'no_pod_product', message: 'This product has no real Printify product (it only exists as a DRY_RUN stub). Arm live writes and re-run "create POD product".' });
    if (p.pod_cost_source === 'estimate') b.push({ code: 'estimated_cost', message: 'The POD base cost is an ESTIMATE. Re-run "create POD product" with live writes armed so the real Printify cost is read and the margin recomputed; that voids this approval and the product must be approved again.' });
    if (!Number.isInteger(p.list_price_cents) || p.list_price_cents <= 0) b.push({ code: 'no_price', message: 'Set a list price first.' });
    const l = listingOf(p.id);
    if (!l || !l.title) b.push({ code: 'no_copy', message: 'There is no listing copy to publish.' });
    const store = storeFor(p);
    if (!store) b.push({ code: 'no_store', message: 'No Etsy store is connected. Connect Etsy in Settings → Stores.' });
    else if (store.status === 'no_shop') b.push({ code: 'no_shop', message: etsy.NO_SHOP });
    else if (store.status !== 'connected' || !store.oauth_sealed) b.push({ code: 'store_disconnected', message: store.status_detail || 'The Etsy store is disconnected. Reconnect it in Settings → Stores.' });
    else if (!store.shop_id) b.push({ code: 'no_shop', message: store.status_detail || 'The Etsy shop has not been read yet. Use "Check shop" in Settings → Stores.' });
    if (store && store.shop_id) {
      try {
        const ps = await adapters.pod.getShopInfo();
        if (ps.salesChannel !== 'etsy') b.push({ code: 'printify_not_linked', message: `The Printify shop "${ps.title || ps.id}" is connected to "${ps.salesChannel || 'nothing'}", not Etsy. Connect it to your Etsy shop in Printify first.` });
        else if (store.shop_name && ps.title && String(ps.title).trim().toLowerCase() !== String(store.shop_name).trim().toLowerCase() && env.ETSY_SKIP_PRINTIFY_SHOP_MATCH !== '1') {
          b.push({ code: 'printify_shop_mismatch', message: `The Printify shop is named "${ps.title}" but the connected Etsy shop is "${store.shop_name}". Printify does not say which Etsy shop it is linked to, so the names must match (set ETSY_SKIP_PRINTIFY_SHOP_MATCH=1 only if you are sure they are the same shop).` });
        }
      } catch (e) { b.push({ code: 'printify_unreadable', message: `Could not read the Printify shop to confirm the link: ${e.message}` }); }
    }
    return b;
  }

  /** Human summary for the confirm modal: shop, price, fee, flags, and that this is the real marketplace. */
  function summary(p, bl, { dry }) {
    const store = storeFor(p); const l = listingOf(p.id); const flags = parseFlags(p);
    const parts = [`Publish product #${p.id}${l && l.title ? ` "${l.title}"` : ''}.`];
    parts.push(`Shop: ${store && store.shop_name ? `Etsy shop "${store.shop_name}"` : 'no connected Etsy shop'}.`);
    parts.push(`List price ${Number.isInteger(p.list_price_cents) ? usd(p.list_price_cents) : 'unset'}; Etsy listing fee ${usd(listingFee())} is charged by Etsy when the listing is created.`);
    if (Number.isInteger(p.projected_margin_cents)) parts.push(`Projected unit margin ${usd(p.projected_margin_cents)}${p.pod_cost_source === 'estimate' ? ' (on an ESTIMATED base cost)' : ''}.`);
    if (flags.length) parts.push(`FLAGS: ${flags.map(f => f.code + (f.detail ? ` (${f.detail})` : '')).join('; ')}.`);
    if (dry) parts.push(`DRY_RUN is on: this is only SIMULATED. Nothing reaches Printify or Etsy and the stage will not change.${bl.length ? ` A live publish would currently be refused: ${bl.map(x => x.code).join(', ')}.` : ''}`);
    else parts.push('This sends the product to Printify, which publishes it to the REAL Etsy marketplace. It is irreversible by this app: unpublishing or deleting is done in Etsy/Printify.');
    return parts.join(' ');
  }

  async function prepare(p) {
    const bl = await blockers(p);
    return { blockers: bl, summary: summary(p, bl, { dry: dryRun.isOn() }) };
  }

  /** Record the Etsy listing id and the one-time listing fee. */
  function adoptExternalId(p, l, externalId, store) {
    tx(db, () => {
      db.prepare('UPDATE listings SET external_id = ?, store_id = ?, status = CASE WHEN status = \'publishing\' THEN \'pending\' ELSE status END WHERE id = ?').run(String(externalId), store.id, l.id);
      if (!l.fee_recorded) {
        spend.addCost({ productId: p.id, kind: 'listing_fee', amountCents: listingFee(), note: `Etsy listing fee, listing ${externalId}` });
        db.prepare('UPDATE listings SET fee_recorded = 1 WHERE id = ?').run(l.id);
      }
    });
    productEvent(db, p.id, { actor: 'human', note: `Etsy listing id ${externalId} known; ${usd(listingFee())} listing fee recorded` });
  }

  /**
   * Bring a published/live product up to date from Printify and Etsy. Returns {status, ...}; throws only on adapter errors
   * the caller wants to see (reconcileAll catches per product).
   */
  async function reconcile(id, { actor = 'human' } = {}) {
    let p = get(Number(id));
    if (!p) throw new PipelineError(`Product ${id} not found`, 404, 'not_found');
    if (![S.PUBLISHED, S.LIVE].includes(p.stage)) return { status: 'skipped', reason: `product is ${p.stage}` };
    let l = listingOf(p.id);
    const store = storeFor(p);
    if (!l || !store) return { status: 'skipped', reason: 'no listing or store' };
    if (!l.external_id) {
      if (isStubId(p.pod_external_id)) return { status: 'skipped', reason: 'a stub product has no Printify record' };
      const st = await adapters.pod.getPublishState(p.pod_external_id);
      if (!st.externalId) return { status: 'publishing', detail: st.isLocked ? 'Printify is still publishing (product locked)' : 'Printify has not reported an Etsy listing id yet' };
      adoptExternalId(p, l, st.externalId, store);
      l = listingOf(p.id);
    }
    const e = await adapters.storefront.getListing(store.id, l.external_id);
    if (!e) { productEvent(db, p.id, { actor, note: `Etsy has no listing ${l.external_id} (yet)` }); return { status: 'not_found_on_etsy' }; }
    db.prepare('UPDATE listings SET status = ?, url = COALESCE(?, url), views = ?, checked_at = ?, store_id = ? WHERE id = ?').run(e.state || 'unknown', e.url, e.views ?? null, new Date().toISOString(), store.id, l.id);
    if (e.shopId && store.shop_id && String(e.shopId) !== String(store.shop_id)) {
      const flags = parseFlags(p).filter(f => f.code !== 'etsy_shop_mismatch');
      flags.push({ code: 'etsy_shop_mismatch', detail: `listing ${l.external_id} is in Etsy shop ${e.shopId}, not the connected shop ${store.shop_id}`, source: 'publish' });
      db.prepare('UPDATE products SET flags = ? WHERE id = ?').run(JSON.stringify(flags), p.id);
      productEvent(db, p.id, { actor, note: `WARNING: the published listing is in a different Etsy shop (${e.shopId}) than the connected one (${store.shop_id})` });
    }
    if (e.state === 'active' && p.stage === S.PUBLISHED) {
      p = stages.transition(p.id, S.LIVE, { actor, note: `Etsy shows listing ${l.external_id} active` });
      return { status: 'live', stage: p.stage, url: e.url };
    }
    return { status: e.state, stage: p.stage, url: e.url };
  }

  /** Reconcile every published product; one failure does not stop the rest. Used by the watcher schedule. */
  async function reconcileAll({ actor = 'agent' } = {}) {
    const ids = db.prepare("SELECT id FROM products WHERE stage IN ('published') ORDER BY id").all().map(r => r.id);
    let live = 0; let pending = 0; const errors = [];
    for (const id of ids) {
      try { const r = await reconcile(id, { actor }); if (r.status === 'live') live++; else pending++; }
      catch (e) { errors.push(`#${id}: ${e.message}`); log.warn(`[publish] reconcile #${id} failed: ${e.message}`); }
    }
    return { checked: ids.length, live, pending, errors };
  }

  /**
   * Really publish. The route has already run the human confirm (or the caller is the agent, in which case the
   * autopublish rules are enforced here). Throws PipelineError with a code on any refusal.
   */
  function publish(id, { actor = 'human' } = {}) {
    id = Number(id);
    return pipeline.exclusive(id, async () => {
      const p = pipeline.need(id);
      if (p.stage !== S.APPROVED) throw new PipelineError(`Only an approved product can be published; this one is ${p.stage}`, 409, 'not_approved');
      if (dryRun.isOn()) throw new PipelineError('DRY_RUN is on: nothing can be published.', 409, 'dry_run');
      const bl = await blockers(p);
      if (bl.length) throw new PipelineError(bl[0].message, 409, bl[0].code, { blockers: bl });
      const store = storeFor(p);
      if (actor === 'agent') {
        const why = [];
        if (!store.autopublish) why.push('store autopublish is off');
        const flags = parseFlags(p); if (flags.length) why.push(`product is flagged (${flags.map(f => f.code).join(', ')})`);
        if (why.length) throw new PipelineError(`The agent may not publish: ${why.join('; ')}.`, 409, 'approval_required');
      }
      const l = listingOf(p.id);
      const copy = { title: l.title, description: l.description || p.brief, tags: parseTags(l) };
      db.prepare('UPDATE products SET store_id = ? WHERE id = ?').run(store.id, p.id);
      try { await adapters.pod.publish(p.pod_external_id, copy); }
      catch (e) {
        productEvent(db, p.id, { actor, note: `publish call failed: ${e.message}. The stage is unchanged; if this was a timeout, check Printify before retrying.` });
        throw new PipelineError(`Printify publish failed: ${e.message}`, 502, 'publish_failed');
      }
      db.prepare("UPDATE listings SET status = 'publishing', store_id = ?, price_cents = ? WHERE id = ?").run(store.id, p.list_price_cents, l.id);
      stages.transition(p.id, S.PUBLISHED, { actor, note: `publish requested through Printify to Etsy shop ${store.shop_name || store.shop_id}` });
      // Printify publishes to Etsy asynchronously: look for the Etsy listing id a few times, then leave it to reconcile.
      let r = { status: 'publishing' };
      for (let i = 0; i <= pollAttempts; i++) {
        try { r = await reconcile(p.id, { actor }); } catch (e) { r = { status: 'error', detail: e.message }; log.warn(`[publish] read-back #${p.id}: ${e.message}`); }
        if (r.status !== 'publishing' && r.status !== 'error') break;
        if (i < pollAttempts) await sleep(pollMs);
      }
      return { product: get(p.id), readBack: r };
    });
  }

  /** Dry-run publish: only the faked adapter call and a note. Stage unchanged. */
  async function simulate(p, { actor = 'human' } = {}) {
    const bl = await blockers(p);
    const out = await adapters.pod.publish(p.pod_external_id, {}); // the router fakes it
    productEvent(db, p.id, { actor, note: `publish simulated (DRY_RUN): nothing went live, stage unchanged${bl.length ? `; a live publish would be refused: ${bl.map(x => x.code).join(', ')}` : ''}` });
    return { result: out, liveBlockers: bl };
  }

  // ---- direct edits of a published listing ----------------------------------------------------------------
  /** Validate an edit WITHOUT sending it: {changes, summary, priceChange}. Etsy text rules are enforced, the blocklist is checked. */
  function planEdit(p, body = {}) {
    if (![S.PUBLISHED, S.LIVE].includes(p.stage)) throw new PipelineError(`A listing can be edited once published; this product is ${p.stage}`, 409, 'illegal_stage');
    const l = listingOf(p.id);
    if (!l || !l.external_id) throw new PipelineError('The Etsy listing id is not known yet; refresh the status first.', 409, 'no_external_id');
    const changes = {}; const repairs = [];
    if (body.title !== undefined || body.tags !== undefined) {
      const c = enforceCopy({ title: body.title !== undefined ? body.title : l.title, tags: body.tags !== undefined ? body.tags : parseTags(l), description: l.description || '.' });
      if (body.title !== undefined) { if (!c.title) throw new PipelineError('the title is empty after enforcing Etsy rules', 422, 'empty_title'); changes.title = c.title; }
      if (body.tags !== undefined) changes.tags = c.tags;
      repairs.push(...c.repairs.filter(r => r.field !== 'description'));
      const hits = checkBlocklist(db, [changes.title, (changes.tags || []).join(' ')]);
      if (hits.length) throw new PipelineError(`Blocked: the new text contains a brand/trademark term (${hits.join(', ')}).`, 422, 'blocklist');
    }
    let priceChange = null;
    if (body.price !== undefined) {
      const n = Number(body.price);
      if (!Number.isFinite(n) || n <= 0 || n > 10000) throw new PipelineError('price must be dollars between 0 and 10000', 400, 'bad_price');
      const cents = Math.round(n * 100);
      if (cents !== p.list_price_cents) { changes.priceCents = cents; priceChange = { fromCents: p.list_price_cents, toCents: cents }; }
    }
    if (!Object.keys(changes).length) throw new PipelineError('Nothing to change.', 400, 'no_change');
    const store = storeFor(p);
    const sum = [`Edit the LIVE Etsy listing ${l.external_id}${store && store.shop_name ? ` in shop "${store.shop_name}"` : ''} for product #${p.id}.`];
    if (changes.title) sum.push(`Title becomes "${changes.title}".`);
    if (changes.tags) sum.push(`Tags become: ${changes.tags.join(', ')}.`);
    if (priceChange) {
      sum.push(`Price changes from ${priceChange.fromCents === null ? 'unset' : usd(priceChange.fromCents)} to ${usd(priceChange.toCents)}.`);
      if (Number.isInteger(p.pod_base_cost_cents)) sum.push(`Projected unit margin at the new price: ${usd(projectMargin({ listPriceCents: priceChange.toCents, shippingCents: p.shipping_cents || 0, podBaseCostCents: p.pod_base_cost_cents }, loadSchedule(settings)).marginCents)}.`);
      sum.push('The price is changed on Etsy; Printify may overwrite it if the product is published again.');
    }
    sum.push(dryRun.isOn() ? 'DRY_RUN is on: simulated only, nothing is sent.' : 'This changes the real marketplace listing.');
    return { changes, repairs, priceChange, summary: sum.join(' '), listing: l, store };
  }

  async function applyEdit(p, plan, { actor = 'human' } = {}) {
    const { changes, listing: l, store } = plan;
    if (dryRun.isOn()) {
      await adapters.storefront.updateListing(store ? store.id : null, l.external_id, changes); // faked by the router
      productEvent(db, p.id, { actor, note: `listing edit simulated (DRY_RUN): ${Object.keys(changes).join(', ')}; nothing sent, nothing changed locally` });
      return { faked: true, applied: false, changes, product: get(p.id) };
    }
    if (!store || store.status !== 'connected' || !store.oauth_sealed) throw new PipelineError(store && store.status_detail || 'The Etsy store is disconnected.', 409, 'store_disconnected');
    try { await adapters.storefront.updateListing(store.id, l.external_id, changes); }
    catch (e) { productEvent(db, p.id, { actor, note: `listing edit failed: ${e.message}` }); throw new PipelineError(`Etsy refused the edit: ${e.message}`, 502, 'etsy_edit_failed'); }
    if (changes.title || changes.tags) {
      db.prepare('UPDATE listings SET title = COALESCE(?, title), tags = COALESCE(?, tags) WHERE id = ?').run(changes.title || null, changes.tags ? JSON.stringify(changes.tags) : null, l.id);
      if (changes.title) db.prepare('UPDATE products SET title = ? WHERE id = ?').run(changes.title, p.id);
    }
    if (changes.priceCents !== undefined) {
      db.prepare('UPDATE listings SET price_cents = ? WHERE id = ?').run(changes.priceCents, l.id);
      db.prepare('UPDATE products SET list_price_cents = ? WHERE id = ?').run(changes.priceCents, p.id);
      pipeline.applyMargin(p.id);
    }
    db.prepare('UPDATE products SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), p.id);
    productEvent(db, p.id, { actor, note: `Etsy listing edited: ${Object.keys(changes).join(', ')}` });
    return { faked: false, applied: true, changes, product: get(p.id) };
  }

  return { blockers, prepare, summary, publish, simulate, reconcile, reconcileAll, planEdit, applyEdit, listingOf, storeFor, adoptExternalId };
}

module.exports = { makePublisher };
