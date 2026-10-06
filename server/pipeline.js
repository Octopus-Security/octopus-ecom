'use strict';
/**
 * pipeline.js — M1 service: create product (idea) -> generate design -> draft listing copy.
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
const { S, parseFlags } = require('./domain/stages');
const { checkBlocklist } = require('./domain/blocklist');
const { enforceCopy } = require('./domain/etsy-rules');
const { designPrompt } = require('./domain/prompts');
const { productEvent } = require('./events');

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
  if (b.blueprint !== undefined) out.blueprint = clean(b.blueprint, 100, 'blueprint') || null;
  if (b.printProviderId !== undefined) out.printProviderId = clean(b.printProviderId, 100, 'printProviderId') || null;
  return out;
}

function makePipeline({ db, stages, adapters, spend, log = console }) {
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
    const p = stages.createProduct({ brief: v.brief, niche: v.niche, blueprint: v.blueprint || null, printProviderId: v.printProviderId || null, listPriceCents: v.listPriceCents ?? null, actor });
    if (v.keywords) db.prepare('UPDATE products SET keywords = ? WHERE id = ?').run(JSON.stringify(v.keywords), p.id);
    const hits = checkBlocklist(db, [v.brief, v.niche, ...(v.keywords || [])]);
    if (hits.length) setFlag(p.id, 'blocklist', hits.join(', '));
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
      const hits = checkBlocklist(db, [p.brief, p.niche, ...kw(p)]);
      setFlag(id, 'blocklist', hits.length ? hits.join(', ') : null);
      if (p.stage === S.FAILED) p = stages.transition(id, S.IDEA, { actor, note: 'retry' });

      const prompt = designPrompt(p);
      let gen;
      try { gen = await adapters.imagegen.generate(prompt, { width: PRINT_W, height: PRINT_H, count: 1 }); }
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
      if (p.stage !== S.DESIGN) throw new PipelineError(`Copy is drafted from design_generated; the product is ${p.stage}`, 409, 'illegal_stage');
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
    const hits = checkBlocklist(db, [c.title, c.tags.join(' '), c.description, p.brief]);
    setFlag(id, 'blocklist', hits.length ? hits.join(', ') : null);
    const t = new Date().toISOString();
    const row = db.prepare("SELECT id FROM listings WHERE product_id = ? AND platform = 'etsy' AND status = 'draft'").get(id);
    if (row) db.prepare('UPDATE listings SET title=?, tags=?, description=?, repairs=?, model=?, price_cents=?, updated_at=? WHERE id=?')
      .run(c.title, JSON.stringify(c.tags), c.description, JSON.stringify(c.repairs), model, p.list_price_cents, t, row.id);
    else db.prepare("INSERT INTO listings(product_id,platform,title,tags,description,price_cents,status,created_at,updated_at,repairs,model) VALUES(?,'etsy',?,?,?,?,'draft',?,?,?,?)")
      .run(id, c.title, JSON.stringify(c.tags), c.description, p.list_price_cents, t, t, JSON.stringify(c.repairs), model);
    db.prepare('UPDATE products SET title = ?, updated_at = ? WHERE id = ?').run(c.title, t, id);
    productEvent(db, id, { actor, note: `copy ${via}${c.repairs.length ? ` (${c.repairs.length} repair${c.repairs.length === 1 ? '' : 's'})` : ''}${hits.length ? `; blocklist hit: ${hits.join(', ')}` : ''}` });
    return { product: get(id), repairs: c.repairs, blocklistHits: hits };
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

  function detail(id) {
    const p = need(id);
    const designs = db.prepare('SELECT * FROM designs WHERE product_id = ? ORDER BY id DESC').all(p.id).map(d => ({
      id: d.id, url: `/api/images/${d.id}`, prompt: d.prompt, width: d.width, height: d.height, nativeWidth: d.native_width, nativeHeight: d.native_height,
      upscaleMethod: d.upscale_method, costCents: d.cost_cents, model: d.model, createdAt: d.created_at,
    }));
    const costs = db.prepare('SELECT id, kind, amount_cents AS amountCents, note, ts FROM costs WHERE product_id = ? ORDER BY id').all(p.id);
    const events = db.prepare('SELECT id, kind, stage_from AS stageFrom, stage_to AS stageTo, actor, note, ts FROM events WHERE product_id = ? ORDER BY id').all(p.id);
    const l = db.prepare("SELECT * FROM listings WHERE product_id = ? AND platform = 'etsy' AND status = 'draft' ORDER BY id DESC LIMIT 1").get(p.id);
    const copy = l ? { title: l.title, tags: JSON.parse(l.tags || '[]'), description: l.description, repairs: JSON.parse(l.repairs || '[]'), model: l.model, updatedAt: l.updated_at } : null;
    return { product: { ...p, keywords: kw(p), flags: parseFlags(p) }, designs, costs, costTotalCents: costs.reduce((a, c) => a + c.amountCents, 0), events, copy };
  }

  return { create, generateDesign, draftCopy, editCopy, detail, validateInput, PipelineError };
}

module.exports = { makePipeline, PipelineError, PRINT_W, PRINT_H };
