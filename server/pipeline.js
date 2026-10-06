'use strict';
/**
 * pipeline.js — create product (idea) -> generate design -> [M2] create POD product + mockups + base cost
 * (mockup_ready) -> copy + projected margin (listing_drafted) -> submit (PENDING_APPROVAL) -> approve.
 *
 * M2 money decision: the POD base cost is a per-unit COGS paid when a unit SELLS, not a spend at draft
 * time. No `costs` row is written for it and it never counts toward the daily cap; it feeds projected
 * margin only. (kind 'pod' in `costs` is reserved for per-sale COGS ingested in M3; 'listing_fee' is
 * charged at publish, M3.) Where the cost came from is recorded in products.pod_cost_source:
 *   printify_product  read back from the real product (the only place Printify exposes it)
 *   catalog           a real read of per-variant costs (not offered by the catalog; kept for providers that do)
 *   estimate          a stub figure (DRY_RUN fakes the product create); flagged `pod_cost_estimated`
 *
 * Stage writes go ONLY through stages.transition(). Choices worth knowing:
 *  - Draft copy lives in a `listings` row (platform 'etsy', status 'draft', one per product) and the
 *    title is mirrored on products.title for the board. The product STAYS at design_generated until
 *    M2 creates mockups; the board shows "copy drafted" via the title.
 *  - Money: the daily cap is checked BEFORE each paid call (inside the real adapters/providers, from a
 *    price estimate) and the ACTUAL cost is recorded in `costs` right after the call returns, even if
 *    a later step fails (the money was spent).
 *  - Any failure moves the product to `failed` with a reason. EXCEPT a spend-cap refusal: that is a
 *    pause, not a product failure, so the stage is unchanged and a note event is recorded; the caller
 *    gets a 'spend_cap' error and may retry after the cap resets or is raised.
 *  - Regenerate keeps history: every design is a new `designs` row; nothing is deleted.
 *  - One operation per product at a time (an in-flight set): a double click must not buy two images.
 */
const path = require('node:path');
const { S, parseFlags } = require('./domain/stages');
const { scanFields, describeHits } = require('./domain/blocklist');
const printReadiness = require('./domain/print-readiness');
const { enforceCopy } = require('./domain/etsy-rules');
const { designPrompt } = require('./domain/prompts');
const { productEvent } = require('./events');
const { projectMargin, marginFlags, snapshot } = require('./domain/fees');
const { loadSchedule } = require('./domain/fee-schedule');

const PRINT_W = 4500; const PRINT_H = 5400; // default print area until a blueprint says otherwise (M2)

class PipelineError extends Error {
  constructor(message, status = 400, code = 'bad_request', extra = {}) { super(message); this.name = 'PipelineError'; this.status = status; this.code = code; Object.assign(this, extra); }
}

const clean = (v, max, name) => {
  const s = v === undefined || v === null ? '' : String(v).trim();
  if (s.length > max) throw new PipelineError(`${name} must be at most ${max} characters`);
  return s;
};

function validateInput(b = {}, { partial = false } = {}) {
  const out = {};
  if (!partial || b.brief !== undefined) { out.brief = clean(b.brief, 2000, 'brief'); if (!out.brief) throw new PipelineError('brief is required'); }
  if (!partial || b.niche !== undefined) out.niche = clean(b.niche, 200, 'niche');
  if (b.keywords !== undefined) {
    const arr = Array.isArray(b.keywords) ? b.keywords : String(b.keywords).split(',');
    if (arr.length > 30) throw new PipelineError('at most 30 keywords');
    out.keywords = [...new Set(arr.map(k => clean(k, 60, 'keyword')).filter(Boolean))];
  }
  if (b.listPrice !== undefined && b.listPrice !== null && b.listPrice !== '') {
    const n = Number(b.listPrice);
    if (!Number.isFinite(n) || n < 0 || n > 10000) throw new PipelineError('listPrice must be dollars between 0 and 10000');
    out.listPriceCents = Math.round(n * 100);
  }
  if (b.shipping !== undefined && b.shipping !== null && b.shipping !== '') {
    const n = Number(b.shipping);
    if (!Number.isFinite(n) || n < 0 || n > 10000) throw new PipelineError('shipping must be dollars between 0 and 10000');
    out.shippingCents = Math.round(n * 100);
  }
  if (b.blueprint !== undefined) out.blueprint = clean(b.blueprint, 100, 'blueprint') || null;
  if (b.printProviderId !== undefined) out.printProviderId = clean(b.printProviderId, 100, 'printProviderId') || null;
  return out;
}

const parse = (t, d) => { try { return JSON.parse(t); } catch { return d; } };
/** The print area the design is generated for: the blueprint's first position when known, else the M1 default. */
function primaryArea(p) {
  const spec = parse(p.print_spec, null);
  const a = spec && spec.positions && spec.positions[0];
  return a && a.width > 0 && a.height > 0 ? { width: a.width, height: a.height, position: a.position } : { width: PRINT_W, height: PRINT_H, position: 'front' };
}
const baseTitle = p => (p.title || p.brief || `Product ${p.id}`).slice(0, 120);

function makePipeline({ db, stages, adapters, spend, settings, dataDir, isDryRun = () => true, log = console, printDefaults = {} }) {
  const busy = new Set();
  const get = id => db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  const need = id => { const p = get(Number(id)); if (!p) throw new PipelineError(`Product ${id} not found`, 404, 'not_found'); return p; };
  const kw = p => { try { return JSON.parse(p.keywords || '[]'); } catch { return []; } };

  async function exclusive(id, fn) {
    if (busy.has(id)) throw new PipelineError(`Product ${id} is already being worked on`, 409, 'busy');
    busy.add(id);
    try { return await fn(); } finally { busy.delete(id); }
  }

  /** Replace this source's flag (e.g. 'blocklist') and keep every other flag. */
  function setFlag(productId, code, detail /* null clears */) {
    const p = get(productId);
    const flags = parseFlags(p).filter(f => f.code !== code);
    if (detail) flags.push({ code, detail });
    db.prepare('UPDATE products SET flags = ? WHERE id = ?').run(JSON.stringify(flags), productId);
  }

  // ---- M4: print-readiness -------------------------------------------------------------------------------
  /** The active rule: a panel override (settings) wins over the env defaults handed in by deps (PRINT_MIN_COVERAGE, PRINT_FIT). */
  function printRule() {
    const mc = settings ? Number(settings.get('print_min_coverage', '')) : NaN;
    const fit = settings ? settings.get('print_fit', '') : '';
    return {
      minCoverage: printReadiness.validMinCoverage(mc) ? mc : (printReadiness.validMinCoverage(printDefaults.minCoverage) ? printDefaults.minCoverage : printReadiness.DEFAULT_MIN_COVERAGE),
      fit: printReadiness.validFit(fit) ? fit : (printReadiness.validFit(printDefaults.fit) ? printDefaults.fit : 'cover'),
    };
  }
  /** Measure the latest design's true pixels (PNG header) against the product's print_spec. */
  function checkPrint(id) { return printReadiness.checkProduct({ db, dataDir, product: need(id), ...printRule() }); }
  const printFlagDetail = r => String(r.reason || 'not print-ready').slice(0, 400);
  /** At design time: flag early when the answer is definitive (the spec is known and the file readable). Never refuses here. */
  function earlyPrintFlag(id) {
    try {
      const p = get(id);
      if (!p.print_spec) return;
      const r = checkPrint(id);
      if (r.unknown) return;
      setFlag(id, 'print_not_ready', r.ok ? null : printFlagDetail(r));
    } catch (e) { log.warn(`[pipeline] print-readiness check failed for product ${id}: ${e.message}`); }
  }

  /** Add flags, never remove: an existing flag with the same code is kept as it is. Used by the batch QA pass. */
  function addFlags(id, flags) {
    const p = get(id);
    const cur = parseFlags(p);
    const have = new Set(cur.map(f => f.code));
    const next = cur.concat(flags.filter(f => f && f.code && !have.has(f.code)).map(f => ({ code: f.code, detail: f.detail, ...(f.source ? { source: f.source } : {}) })));
    if (next.length !== cur.length) db.prepare('UPDATE products SET flags = ? WHERE id = ?').run(JSON.stringify(next), id);
    return next;
  }

  /** Re-run the blocklist over every product that is not finished (after the list was edited). Returns {checked, flagged, cleared}. */
  function rescanBlocklist() {
    const rows = db.prepare("SELECT * FROM products WHERE stage NOT IN ('published','live','rejected','archived')").all();
    let flagged = 0; let cleared = 0;
    for (const p of rows) {
      const l = db.prepare("SELECT title, tags, description FROM listings WHERE product_id = ? AND platform = 'etsy' ORDER BY id DESC LIMIT 1").get(p.id);
      let tags = []; try { tags = JSON.parse((l && l.tags) || '[]'); } catch { tags = []; }
      const found = scanFields(db, { brief: p.brief, niche: p.niche, keywords: kw(p), title: l && l.title, tags, description: l && l.description });
      const had = parseFlags(p).some(f => f.code === 'blocklist');
      setFlag(p.id, 'blocklist', found.length ? describeHits(found) : null);
      if (found.length && !had) flagged++;
      if (!found.length && had) cleared++;
    }
    return { checked: rows.length, flagged, cleared };
  }

  /** The failure path: spend-cap -> a pause (no stage change); anything else -> `failed` with the reason. */
  function failure(p, err, actor, what) {
    if (err && err.name === 'SpendCapError') {
      productEvent(db, p.id, { actor, note: `${what} paused: ${err.message}` });
      return new PipelineError(err.message, 429, 'spend_cap', { capCents: err.capCents, todayCents: err.todayCents });
    }
    const reason = `${what} failed: ${err && err.message ? err.message : String(err)}`.slice(0, 500);
    log.warn(`[pipeline] product ${p.id}: ${reason}`);
    try { stages.transition(p.id, S.FAILED, { actor, note: reason }); }
    catch (e) { productEvent(db, p.id, { actor, note: reason }); log.warn(`[pipeline] could not mark product ${p.id} failed: ${e.message}`); }
    return new PipelineError(reason, 502, 'failed', { failed: true });
  }

  function create(input, { actor = 'human' } = {}) {
    const v = validateInput(input);
    let storeId = null;
    if (input && input.storeId !== undefined && input.storeId !== null && input.storeId !== '') {
      storeId = Number(input.storeId);
      if (!Number.isInteger(storeId) || !db.prepare('SELECT 1 FROM stores WHERE id = ?').get(storeId)) throw new PipelineError('storeId does not match a store', 400, 'bad_store');
    }
    const p = stages.createProduct({ brief: v.brief, niche: v.niche, storeId, blueprint: v.blueprint || null, printProviderId: v.printProviderId || null, listPriceCents: v.listPriceCents ?? null, shippingCents: v.shippingCents ?? 0, actor });
    if (v.keywords) db.prepare('UPDATE products SET keywords = ? WHERE id = ?').run(JSON.stringify(v.keywords), p.id);
    // Flag BEFORE any spend: the brief is checked the moment the product exists.
    const hits = scanFields(db, { brief: v.brief, niche: v.niche, keywords: v.keywords || [] });
    if (hits.length) { setFlag(p.id, 'blocklist', describeHits(hits)); productEvent(db, p.id, { actor, note: `trademark blocklist hit in the brief: ${describeHits(hits)}` }); }
    return get(p.id);
  }

  /** Generate (or regenerate) the design. `brief` given = the operator edited it. */
  function generateDesign(id, { brief, actor = 'human' } = {}) {
    id = Number(id);
    return exclusive(id, async () => {
      let p = need(id);
      if (![S.IDEA, S.DESIGN, S.MOCKUP, S.DRAFTED, S.PENDING, S.FAILED].includes(p.stage)) throw new PipelineError(`A design cannot be generated while the product is ${p.stage}`, 409, 'illegal_stage');
      if (brief !== undefined) {
        const nb = clean(brief, 2000, 'brief'); if (!nb) throw new PipelineError('brief cannot be empty');
        if (nb !== p.brief) { db.prepare('UPDATE products SET brief = ?, updated_at = ? WHERE id = ?').run(nb, new Date().toISOString(), id); productEvent(db, id, { actor, note: 'brief edited' }); p = get(id); }
      }
      if (!p.brief) throw new PipelineError('The product has no brief');
      const hits = scanFields(db, { brief: p.brief, niche: p.niche, keywords: kw(p) });
      setFlag(id, 'blocklist', hits.length ? describeHits(hits) : null);
      if (p.stage === S.FAILED) p = stages.transition(id, S.IDEA, { actor, note: 'retry' });

      const prompt = designPrompt(p);
      let gen;
      const dim = primaryArea(p);
      try { gen = await adapters.imagegen.generate(prompt, { width: dim.width, height: dim.height, count: 1 }); }
      catch (e) { throw failure(p, e, actor, 'image generation'); }

      // Money first: it is spent whatever happens next.
      if (gen.costCents > 0) spend.addCost({ productId: id, kind: 'image', amountCents: gen.costCents, note: gen.model });
      try {
        const img = gen.images[0];
        const real = img.width && img.height ? { width: img.width, height: img.height } : null;
        const t = new Date().toISOString();
        db.prepare(`INSERT INTO designs(product_id,image_path,prompt,width,height,cost_cents,model,created_at,native_width,native_height,upscale_method)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
          .run(id, img.file, prompt, real.width, real.height, gen.costCents, gen.model, t, img.nativeWidth ?? real.width, img.nativeHeight ?? real.height, img.upscaled ? (img.upscaleMethod || 'upscaled') : null);
        db.prepare('UPDATE products SET model_used = ? WHERE id = ?').run(gen.model, id);
        earlyPrintFlag(id);
        if (p.stage === S.DESIGN) { productEvent(db, id, { actor, note: `design regenerated (${gen.model}, ${real.width}x${real.height})` }); return get(id); }
        return stages.transition(id, S.DESIGN, { actor, note: `design generated (${gen.model}, ${real.width}x${real.height})` });
      } catch (e) { throw failure(p, e, actor, 'saving the design'); }
    });
  }

  /** Draft Etsy copy for the latest design; stores/updates the draft listing; enforces rules + blocklist. */
  function draftCopy(id, { actor = 'human' } = {}) {
    id = Number(id);
    return exclusive(id, async () => {
      const p = need(id);
      if (![S.DESIGN, S.MOCKUP].includes(p.stage)) throw new PipelineError(`Copy is drafted from design_generated or mockup_ready; the product is ${p.stage}`, 409, 'illegal_stage');
      const design = db.prepare('SELECT * FROM designs WHERE product_id = ? ORDER BY id DESC LIMIT 1').get(id);
      if (!design) throw new PipelineError('The product has no design yet', 409, 'no_design');
      let raw;
      try { raw = await adapters.listingcopy.generate({ brief: p.brief, prompt: design.prompt }, p.niche, kw(p)); }
      catch (e) { throw failure(p, e, actor, 'listing copy'); }
      if (raw.costCents > 0) spend.addCost({ productId: id, kind: 'llm', amountCents: raw.costCents, note: raw.model });
      try {
        const out = saveCopy(id, raw, { model: raw.model, actor, via: 'drafted' });
        db.prepare('UPDATE products SET model_used = COALESCE(model_used, ?) WHERE id = ?').run(raw.model, id);
        return out;
      } catch (e) { throw failure(p, e, actor, 'listing copy'); }
    });
  }

  /** Enforce + blocklist + persist as the draft listing. Throws PipelineError if the title is unusable. */
  function saveCopy(id, raw, { model = null, actor, via }) {
    const c = enforceCopy(raw);
    if (!c.title) throw new PipelineError('the title is empty after enforcing Etsy rules', 422, 'empty_title');
    const p = get(id);
    const found = scanFields(db, { brief: p.brief, title: c.title, tags: c.tags, description: c.description });
    const hits = found.map(h => h.term);
    setFlag(id, 'blocklist', found.length ? describeHits(found) : null);
    const t = new Date().toISOString();
    const row = db.prepare("SELECT id FROM listings WHERE product_id = ? AND platform = 'etsy' AND status = 'draft'").get(id);
    if (row) db.prepare('UPDATE listings SET title=?, tags=?, description=?, repairs=?, model=?, price_cents=?, updated_at=? WHERE id=?')
      .run(c.title, JSON.stringify(c.tags), c.description, JSON.stringify(c.repairs), model, p.list_price_cents, t, row.id);
    else db.prepare("INSERT INTO listings(product_id,platform,title,tags,description,price_cents,status,created_at,updated_at,repairs,model) VALUES(?,'etsy',?,?,?,?,'draft',?,?,?,?)")
      .run(id, c.title, JSON.stringify(c.tags), c.description, p.list_price_cents, t, t, JSON.stringify(c.repairs), model);
    db.prepare('UPDATE products SET title = ?, updated_at = ? WHERE id = ?').run(c.title, t, id);
    productEvent(db, id, { actor, note: `copy ${via}${c.repairs.length ? ` (${c.repairs.length} repair${c.repairs.length === 1 ? '' : 's'})` : ''}${found.length ? `; blocklist hit: ${describeHits(found)}` : ''}` });
    return { product: get(id), repairs: c.repairs, blocklistHits: hits, blocklistDetail: found };
  }

  /** Manual edit: rules re-enforced, blocklist re-run. PENDING_APPROVAL steps back to listing_drafted. */
  function editCopy(id, body = {}, { actor = 'human' } = {}) {
    id = Number(id);
    return exclusive(id, async () => {
      const p = need(id);
      if (![S.DESIGN, S.MOCKUP, S.DRAFTED, S.PENDING].includes(p.stage)) throw new PipelineError(`Copy cannot be edited while the product is ${p.stage}`, 409, 'illegal_stage');
      const cur = db.prepare("SELECT * FROM listings WHERE product_id = ? AND platform = 'etsy' AND status = 'draft'").get(id);
      const raw = {
        title: body.title !== undefined ? body.title : cur && cur.title,
        tags: body.tags !== undefined ? body.tags : cur && JSON.parse(cur.tags || '[]'),
        description: body.description !== undefined ? body.description : cur && cur.description,
      };
      if (typeof raw.title === 'string' && raw.title.length > 2000) throw new PipelineError('title is far too long');
      if (typeof raw.description === 'string' && raw.description.length > 20000) throw new PipelineError('description is too long');
      const out = saveCopy(id, raw, { model: cur ? cur.model : null, actor, via: 'edited by hand' });
      if (p.stage === S.PENDING) out.product = stages.transition(id, S.DRAFTED, { actor, note: 'copy edited; approval must be re-requested' });
      return out;
    });
  }


  // ---- M2: POD product, mockups, base cost, margin, approval ------------------------------------------
  const guardStage = (p, allowed, what) => { if (!allowed.includes(p.stage)) throw new PipelineError(`${what} is not possible while the product is ${p.stage}`, 409, 'illegal_stage'); };
  const podReal = m => { try { return adapters.pod.describe().methods[m] === 'real'; } catch { return false; } };

  /** Replace flags that came from `prefix*` codes, keep every other flag. */
  function replaceFlags(id, prefix, next) {
    const p = get(id);
    const flags = parseFlags(p).filter(f => !String(f.code).startsWith(prefix)).concat(next);
    db.prepare('UPDATE products SET flags = ? WHERE id = ?').run(JSON.stringify(flags), id);
  }

  /** Recompute projected margin + margin/estimate flags from list price, shipping and base cost. Same functions as the supplier watcher. */
  function applyMargin(id) {
    const p = get(id);
    const floor = settings ? settings.getInt('margin_floor_cents', 200) : 200;
    replaceFlags(id, 'pod_cost_', p.pod_cost_source === 'estimate' ? [{ code: 'pod_cost_estimated', detail: 'base cost is a stub estimate, not a Printify price', source: 'pipeline' }] : []);
    if (Number.isInteger(p.list_price_cents) && Number.isInteger(p.pod_base_cost_cents)) {
      const m = projectMargin({ listPriceCents: p.list_price_cents, shippingCents: p.shipping_cents || 0, podBaseCostCents: p.pod_base_cost_cents }, loadSchedule(settings));
      replaceFlags(id, 'margin_', marginFlags(m.marginCents, floor).map(f => ({ ...f, source: 'pipeline' })));
      db.prepare('UPDATE products SET projected_margin_cents = ?, margin_breakdown = ? WHERE id = ?').run(m.marginCents, snapshot(m), id);
      return m;
    }
    replaceFlags(id, 'margin_', []);
    db.prepare('UPDATE products SET projected_margin_cents = NULL, margin_breakdown = NULL WHERE id = ?').run(id);
    return null;
  }

  /** Pure preview for the composer: no product needed. */
  function marginPreview({ listPriceCents, shippingCents = 0, podBaseCostCents }) {
    const floor = settings ? settings.getInt('margin_floor_cents', 200) : 200;
    const ints = [listPriceCents, shippingCents, podBaseCostCents];
    if (!ints.every(n => Number.isInteger(n) && n >= 0)) throw new PipelineError('listPriceCents, shippingCents and podBaseCostCents must be non-negative integers');
    const m = projectMargin({ listPriceCents, shippingCents, podBaseCostCents }, loadSchedule(settings));
    return { ...m, floorCents: floor, flags: marginFlags(m.marginCents, floor) };
  }

  /** Choose blueprint + provider + variants; reads the catalog and records the print-area pixels M4 will check against. */
  function selectPod(id, { blueprint, providerId, variantIds } = {}) {
    id = Number(id);
    return exclusive(id, async () => {
      const p = need(id);
      guardStage(p, [S.IDEA, S.DESIGN, S.MOCKUP, S.DRAFTED, S.PENDING, S.FAILED], 'Choosing a blueprint');
      const bp = clean(blueprint, 100, 'blueprint'); const pp = clean(providerId, 100, 'printProviderId');
      if (!bp || !pp) throw new PipelineError('blueprint and printProviderId are required');
      let cat;
      try { cat = await adapters.pod.listVariants(bp, pp); }
      catch (e) { throw new PipelineError(`could not read the print provider's variants: ${e.message}`, 502, 'pod_read_failed'); }
      const all = cat.variants || [];
      if (!all.length) throw new PipelineError('that blueprint/provider offers no variants', 422, 'no_variants');
      const want = (Array.isArray(variantIds) && variantIds.length ? variantIds : [all[0].id]).map(String);
      const chosen = all.filter(v => want.includes(String(v.id)));
      if (chosen.length !== new Set(want).size) throw new PipelineError('one or more variants do not belong to that blueprint/provider', 422, 'bad_variant');
      const positions = new Map();
      for (const v of chosen) for (const ph of v.placeholders || []) {
        const cur = positions.get(ph.position);
        positions.set(ph.position, { position: ph.position, width: Math.max(cur ? cur.width : 0, ph.width), height: Math.max(cur ? cur.height : 0, ph.height) });
      }
      const spec = { blueprint: bp, providerId: pp, positions: [...positions.values()], source: cat.source || 'unknown', fetchedAt: new Date().toISOString() };
      db.prepare('UPDATE products SET blueprint = ?, print_provider_id = ?, pod_variant_ids = ?, print_spec = ?, updated_at = ? WHERE id = ?')
        .run(bp, pp, JSON.stringify(chosen.map(v => v.id)), JSON.stringify(spec), new Date().toISOString(), id);
      productEvent(db, id, { actor: 'human', note: `POD chosen: blueprint ${bp}, provider ${pp}, ${chosen.length} variant(s); print area ${spec.positions.map(a => `${a.position} ${a.width}x${a.height}px`).join(', ') || 'unknown'} (${spec.source})` });
      return get(id);
    });
  }

  function storeMockups(id, mockups) {
    db.prepare('DELETE FROM mockups WHERE product_id = ?').run(id); // mockups are derived data: replaced on each read-back
    const t = new Date().toISOString();
    for (const m of mockups) db.prepare('INSERT INTO mockups(product_id,url,placement,created_at,file,is_default,variant_ids) VALUES(?,?,?,?,?,?,?)')
      .run(id, m.file ? `local:${m.file}` : m.url, m.placement || null, t, m.file || null, m.isDefault ? 1 : 0, JSON.stringify(m.variantIds || []));
  }

  /** design_generated -> mockup_ready: create the POD product (a WRITE: faked under DRY_RUN), read mockups + base cost. */
  function createPodProduct(id, { actor = 'human' } = {}) {
    id = Number(id);
    return exclusive(id, async () => {
      let p = need(id);
      // An ESTIMATED base cost may be replaced from any pre-publish stage (M3: publishing refuses estimates, and the
      // operator re-runs this with live writes armed). Any other re-run is only for the early stages.
      const reprice = p.pod_cost_source === 'estimate' && [S.DRAFTED, S.PENDING, S.APPROVED].includes(p.stage);
      if (!reprice) guardStage(p, [S.DESIGN, S.MOCKUP, S.FAILED], 'Creating the POD product');
      if (!p.blueprint || !p.print_provider_id) throw new PipelineError('Choose a blueprint and print provider first', 409, 'no_blueprint');
      if (!Number.isInteger(p.list_price_cents) || p.list_price_cents <= 0) throw new PipelineError('Set a list price first (Printify needs one per variant)', 409, 'no_price');
      const design = db.prepare('SELECT * FROM designs WHERE product_id = ? ORDER BY id DESC LIMIT 1').get(id);
      if (!design || !design.image_path) throw new PipelineError('The product has no design yet', 409, 'no_design');
      const variantIds = parse(p.pod_variant_ids, []);
      if (!variantIds.length) throw new PipelineError('Choose at least one variant', 409, 'no_variants');
      // M4: a design that is too small for the print area cannot reach mockup_ready. Refuse BEFORE anything is created or paid for.
      const pr = checkPrint(id);
      setFlag(id, 'print_not_ready', pr.ok ? null : printFlagDetail(pr));
      if (!pr.ok) {
        productEvent(db, id, { actor, note: `print-readiness refused the POD step: ${pr.reason}` });
        throw new PipelineError(`Not print-ready: ${pr.reason}.`, 422, 'print_not_ready', { readiness: pr });
      }
      // Retry from `failed` keeps the design already paid for: failed -> idea -> design_generated, then on.
      if (p.stage === S.FAILED) { stages.transition(id, S.IDEA, { actor, note: 'retry' }); p = stages.transition(id, S.DESIGN, { actor, note: 'retry POD product creation with the existing design' }); }
      const area = primaryArea(p);
      let res;
      try {
        res = await adapters.pod.createProduct({
          blueprintId: p.blueprint, providerId: p.print_provider_id, variantIds, listPriceCents: p.list_price_cents,
          title: baseTitle(p), description: p.brief, imagePath: path.resolve(dataDir || '.', 'images', design.image_path),
          imageWidth: design.width, imageHeight: design.height, position: area.position, placeholder: { width: area.width, height: area.height },
        });
      } catch (e) {
        if (reprice) throw new PipelineError(`POD product re-creation failed: ${e.message}. The product keeps its stage.`, 502, 'pod_failed'); // do not fail an approved product over a retryable read
        throw failure(p, e, actor, 'POD product creation');
      }

      try {
        // Base cost: the product read-back is the only real source; then a real catalog read; else the stub estimate.
        const sel = new Set(variantIds.map(String));
        const live = !res.faked && (res.variants || []).filter(v => sel.has(String(v.id)) && Number.isInteger(v.costCents)).map(v => v.costCents);
        let cost = null; let source = null;
        if (live && live.length) { cost = Math.max(...live); source = 'printify_product'; }
        else {
          let cat = null;
          try { cat = podReal('getVariantCosts') ? await adapters.pod.getVariantCosts(p.blueprint, p.print_provider_id) : null; } catch { cat = null; }
          const c = cat ? (cat.variants || []).filter(v => sel.has(String(v.id)) && Number.isInteger(v.costCents)).map(v => v.costCents) : [];
          if (c.length) { cost = Math.max(...c); source = 'catalog'; }
          else if (Number.isInteger(res.baseCostCents)) { cost = res.baseCostCents; source = res.faked || res.estimated ? 'estimate' : 'printify_product'; }
        }
        if (cost === null) throw new Error('no base cost available from the provider');
        const old = p.pod_external_id;
        db.prepare('UPDATE products SET pod_external_id = ?, pod_base_cost_cents = ?, pod_cost_source = ?, updated_at = ? WHERE id = ?').run(res.externalId, cost, source, new Date().toISOString(), id);
        let mockups = res.mockups || [];
        storeMockups(id, mockups);
        applyMargin(id);
        productEvent(db, id, { actor, note: `POD product ${res.faked ? '(faked, DRY_RUN) ' : ''}${res.externalId}: base cost ${(cost / 100).toFixed(2)} (${source}), ${mockups.length} mockup(s)${old && !String(old).startsWith('stub-') ? `; the earlier Printify product ${old} was left in the shop` : ''}${mockups.length ? '' : '; mockups not ready yet, use refresh'}` });
        if (reprice) {
          // The numbers the approval rested on changed: void it. approved -> PENDING_APPROVAL -> listing_drafted.
          let q = p;
          if (q.stage === S.APPROVED) q = stages.transition(id, S.PENDING, { actor, note: 'base cost changed; approval voided' });
          if (q.stage === S.PENDING) q = stages.transition(id, S.DRAFTED, { actor, note: 'base cost changed; the product needs submitting and approving again' });
          return q;
        }
        return p.stage === S.MOCKUP ? get(id) : stages.transition(id, S.MOCKUP, { actor, note: 'POD product created' });
      } catch (e) { throw failure(p, e, actor, 'saving the POD product'); }
    });
  }

  /** Re-read mockups from Printify (they can lag the create). A faked product has nothing to re-read. */
  function refreshMockups(id, { actor = 'human' } = {}) {
    id = Number(id);
    return exclusive(id, async () => {
      const p = need(id);
      guardStage(p, [S.MOCKUP, S.DRAFTED, S.PENDING], 'Refreshing mockups');
      if (!p.pod_external_id || String(p.pod_external_id).startsWith('stub-')) throw new PipelineError('This product has no real Printify product (DRY_RUN faked it); nothing to refresh', 409, 'faked_product');
      let ms;
      try { ms = await adapters.pod.getMockups(p.pod_external_id); } catch (e) { throw failure(p, e, actor, 'mockup refresh'); }
      storeMockups(id, ms);
      productEvent(db, id, { actor, note: `mockups refreshed (${ms.length})` });
      return get(id);
    });
  }

  /** mockup_ready -> listing_drafted: ensure copy exists (draft it if not), compute projected margin. */
  function draftListing(id, { actor = 'human' } = {}) {
    id = Number(id);
    return exclusive(id, async () => {
      let p = need(id);
      guardStage(p, [S.MOCKUP], 'Drafting the listing');
      if (!Number.isInteger(p.list_price_cents) || p.list_price_cents <= 0) throw new PipelineError('Set a list price first', 409, 'no_price');
      if (!Number.isInteger(p.pod_base_cost_cents)) throw new PipelineError('No POD base cost yet; create the POD product first', 409, 'no_cost');
      const have = db.prepare("SELECT id FROM listings WHERE product_id = ? AND platform = 'etsy' AND status = 'draft'").get(id);
      if (!have) {
        const design = db.prepare('SELECT * FROM designs WHERE product_id = ? ORDER BY id DESC LIMIT 1').get(id);
        let raw;
        try { raw = await adapters.listingcopy.generate({ brief: p.brief, prompt: design && design.prompt }, p.niche, kw(p)); }
        catch (e) { throw failure(p, e, actor, 'listing copy'); }
        if (raw.costCents > 0) spend.addCost({ productId: id, kind: 'llm', amountCents: raw.costCents, note: raw.model });
        try { saveCopy(id, raw, { model: raw.model, actor, via: 'drafted' }); } catch (e) { throw failure(p, e, actor, 'listing copy'); }
      }
      const m = applyMargin(id);
      db.prepare("UPDATE listings SET price_cents = ?, updated_at = ? WHERE product_id = ? AND platform = 'etsy' AND status = 'draft'").run(p.list_price_cents, new Date().toISOString(), id);
      p = get(id);
      return stages.transition(id, S.DRAFTED, { actor, note: `listing drafted; projected margin ${(m.marginCents / 100).toFixed(2)}${parseFlags(p).length ? `; flags: ${parseFlags(p).map(f => f.code).join(', ')}` : ''}` });
    });
  }

  /** Change price/shipping: margin recomputed; a PENDING_APPROVAL product steps back so the approval is re-requested. */
  function setPrice(id, { listPrice, shipping } = {}, { actor = 'human' } = {}) {
    id = Number(id);
    return exclusive(id, async () => {
      const p = need(id);
      guardStage(p, [S.IDEA, S.DESIGN, S.MOCKUP, S.DRAFTED, S.PENDING], 'Changing the price');
      const dollars = (v, name) => { const n = Number(v); if (v === '' || v === null || !Number.isFinite(n) || n < 0 || n > 10000) throw new PipelineError(`${name} must be dollars between 0 and 10000`); return Math.round(n * 100); };
      const price = listPrice !== undefined ? dollars(listPrice, 'listPrice') : p.list_price_cents;
      const ship = shipping !== undefined ? dollars(shipping, 'shipping') : p.shipping_cents;
      db.prepare('UPDATE products SET list_price_cents = ?, shipping_cents = ?, updated_at = ? WHERE id = ?').run(price, ship, new Date().toISOString(), id);
      db.prepare("UPDATE listings SET price_cents = ? WHERE product_id = ? AND platform = 'etsy' AND status = 'draft'").run(price, id);
      applyMargin(id);
      productEvent(db, id, { actor, note: `price set to ${(price / 100).toFixed(2)} (shipping ${(ship / 100).toFixed(2)})` });
      if (p.stage === S.PENDING) return stages.transition(id, S.DRAFTED, { actor, note: 'price changed; approval must be re-requested' });
      return get(id);
    });
  }

  /** listing_drafted -> PENDING_APPROVAL. Flags do not block submitting; they block autopublish and are shown at approval. */
  function submit(id, { actor = 'human' } = {}) {
    id = Number(id);
    return exclusive(id, async () => {
      const p = need(id);
      guardStage(p, [S.DRAFTED], 'Submitting for approval');
      if (!db.prepare("SELECT 1 FROM listings WHERE product_id = ? AND platform = 'etsy' AND status = 'draft'").get(id)) throw new PipelineError('No listing copy yet', 409, 'no_copy');
      applyMargin(id); // fresh numbers at the moment of asking
      return stages.transition(id, S.PENDING, { actor, note: 'submitted for approval' });
    });
  }

  /** PENDING_APPROVAL -> approved. The human confirm gate lives in the route; the agent rule lives in transition(). */
  function approve(id, { actor = 'human' } = {}) {
    id = Number(id);
    return exclusive(id, async () => {
      const p = need(id);
      guardStage(p, [S.PENDING], 'Approving');
      return stages.transition(id, S.APPROVED, { actor, note: 'approved' });
    });
  }
  const finish = (id, to, what, { actor = 'human', note = '' } = {}) => exclusive(Number(id), async () => stages.transition(Number(id), to, { actor, note: note || what }));
  const reject = (id, o = {}) => finish(id, S.REJECTED, 'rejected', o);
  const archive = (id, o = {}) => finish(id, S.ARCHIVED, 'archived', o);

  function unitEconomics(p) {
    if (!Number.isInteger(p.list_price_cents) || !Number.isInteger(p.pod_base_cost_cents)) return null;
    const floor = settings ? settings.getInt('margin_floor_cents', 200) : 200;
    const m = projectMargin({ listPriceCents: p.list_price_cents, shippingCents: p.shipping_cents || 0, podBaseCostCents: p.pod_base_cost_cents }, loadSchedule(settings));
    // `m` is the projection under the schedule in force now; `stored` is what was recorded when the margin was last written, under its own version.
    let stored = null; try { stored = p.margin_breakdown ? JSON.parse(p.margin_breakdown) : null; } catch { /* unreadable snapshot: ignore */ }
    return { listPriceCents: p.list_price_cents, shippingCents: p.shipping_cents || 0, costSource: p.pod_cost_source, floorCents: floor, ...m, stored };
  }

  const mockupUrl = m => (m.file ? `/api/mockups/${m.id}/file` : m.url);

  function detail(id) {
    const p = need(id);
    const designs = db.prepare('SELECT * FROM designs WHERE product_id = ? ORDER BY id DESC').all(p.id).map(d => ({
      id: d.id, url: `/api/images/${d.id}`, prompt: d.prompt, width: d.width, height: d.height, nativeWidth: d.native_width, nativeHeight: d.native_height,
      upscaleMethod: d.upscale_method, costCents: d.cost_cents, model: d.model, createdAt: d.created_at,
    }));
    const costs = db.prepare('SELECT id, kind, amount_cents AS amountCents, note, ts FROM costs WHERE product_id = ? ORDER BY id').all(p.id);
    const events = db.prepare('SELECT id, kind, stage_from AS stageFrom, stage_to AS stageTo, actor, note, ts FROM events WHERE product_id = ? ORDER BY id').all(p.id);
    const l = db.prepare("SELECT * FROM listings WHERE product_id = ? AND platform = 'etsy' ORDER BY id DESC LIMIT 1").get(p.id); // the draft, or after publish the same row
    const copy = l ? { title: l.title, tags: JSON.parse(l.tags || '[]'), description: l.description, repairs: JSON.parse(l.repairs || '[]'), model: l.model, updatedAt: l.updated_at } : null;
    const mockups = db.prepare('SELECT * FROM mockups WHERE product_id = ? ORDER BY is_default DESC, id').all(p.id).map(m => ({ id: m.id, url: mockupUrl(m), placement: m.placement, isDefault: !!m.is_default }));
    let readiness = null; try { if (p.print_spec && designs.length) readiness = printReadiness.checkProduct({ db, dataDir, product: p, ...printRule() }); } catch { readiness = null; }
    return { printReadiness: readiness, product: { ...p, keywords: kw(p), flags: parseFlags(p), pod_variant_ids: parse(p.pod_variant_ids, []), print_spec: parse(p.print_spec, null) }, mockups, economics: unitEconomics(p), designs, costs, costTotalCents: costs.reduce((a, c) => a + c.amountCents, 0), events, copy };
  }

  return { checkPrint, printRule, addFlags, rescanBlocklist, create, generateDesign, draftCopy, editCopy, detail, validateInput, PipelineError, selectPod, createPodProduct, refreshMockups, draftListing, setPrice, submit, approve, reject, archive, marginPreview, applyMargin, exclusive, get, need, setFlag };
}

module.exports = { makePipeline, PipelineError, PRINT_W, PRINT_H };
