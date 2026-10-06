'use strict';
/**
 * orchestrator.js — "Run batch": a niche + a count -> N products driven through
 *   concept -> design -> print-readiness -> POD product + mockups -> listing copy + margin -> QA -> submit
 * to PENDING_APPROVAL, then it STOPS. A human approves (or, only where every autopublish condition holds, the agent does).
 *
 * Guarantees (each one is tested):
 *  - Nothing is published from here, with ONE exception: the autopublish path. That needs store.autopublish AND DRY_RUN off AND
 *    no flags AND a QA pass that actually ran, and it goes through pipeline.approve (stages.transition's agent rule) and then
 *    publisher.publish (the same function, with the same blocker list, a human publish uses). If the publish fails the product is
 *    stepped back to PENDING_APPROVAL.
 *  - The daily spend cap is checked before every paid step (design, copy, ideation, QA). A cap hit is a PAUSE (batch status
 *    'paused_cap', the item goes back to pending with its step kept), never a failure, never a fall back to a stub. The next ET day
 *    resumes it automatically (tick()); `resume` does it by hand.
 *  - Persisted: `batches` + `batch_items`. A restart (recover()) marks items that were running as interrupted and retries each ONCE;
 *    pending items just continue. Work resumes from the product's stage, so a design already paid for is never paid for twice.
 *  - Cancel stops new work at once; a step already in flight finishes, then the item stops. Products already created stay on the board.
 *  - QA (an LLM review of title/tags/description against Etsy rules, the blocklist and originality) can only ADD flags.
 *  - Concepts are the LLM's ORIGINAL ideas from niche + keywords; nothing is fetched from anywhere. Concepts that hit the trademark
 *    blocklist are dropped, near-duplicates are dropped, and a deterministic template generator tops up what the model cannot supply.
 *
 * Tiers: with a ROUTER_PATH tier table (or an LLM_MODEL_<TIER> override) ideation uses 'cheap', copy 'standard' (always), QA 'deep'.
 * Without one there is no deliberate tier table, so ideation and QA both use 'standard' rather than silently paying for 'deep'.
 */
const { S, parseFlags } = require('./domain/stages');
const { scanFields, describeHits } = require('./domain/blocklist');
const { etDay } = require('./spend');
const { productEvent } = require('./events');
const { extractJson } = require('./adapters/listingcopy/llm');

const GLOBAL_MAX = 2;
const MAX_CONCEPT = 400;
const TERMINAL_ITEM = ['done', 'failed', 'cancelled'];
const QA_TYPES = ['ip_risk', 'originality', 'etsy_rules', 'misleading', 'other'];

class BatchError extends Error {
  constructor(message, status = 400, code = 'bad_request') { super(message); this.name = 'BatchError'; this.status = status; this.code = code; }
}

const parse = (t, d) => { try { return JSON.parse(t); } catch { return d; } };
const nowIso = () => new Date().toISOString();
const words = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(w => w.length > 2);
const STOP = new Set(['the', 'and', 'with', 'for', 'style', 'design', 'print', 'art', 'poster', 'shirt', 'featuring', 'illustration', 'artwork']);
const sigWords = s => new Set(words(s).filter(w => !STOP.has(w)));
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let i = 0; for (const x of a) if (b.has(x)) i++;
  return i / (a.size + b.size - i);
}

// ---- deterministic template ideation (no model, no network): the top-up and the stub-mode source ------------------------
const STYLES = ['retro sunset linocut', 'minimalist single-line drawing', 'soft watercolour wash', 'vintage circular badge', 'flat vector with a limited palette', 'folk-art pattern', 'two-colour risograph print',
  'cozy hand-drawn ink and marker', 'geometric low-poly', 'art-nouveau border', 'bold mid-century modern shapes', 'woodcut with chunky texture', 'pastel kawaii, rounded shapes', 'botanical engraving', 'psychedelic 70s swirl', 'paper-cut layered look'];
const COMPOSITIONS = ['a centred emblem', 'a circular badge with an empty ring for no text', 'a small scene on a plain background', 'a single character portrait', 'a repeating border around one focal subject', 'a stacked landscape in horizontal bands', 'a symmetrical mandala-like layout'];
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function hash(str) { let h = 2166136261; for (const c of String(str)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

/** Deterministic, varied, original concepts from niche + keywords. Pure. */
function templateConcepts({ niche, keywords = [], count, skip = 0 }) {
  const subjects = (keywords.length ? keywords : [niche]).map(s => String(s).trim()).filter(Boolean);
  const combos = [];
  for (const s of subjects) for (const st of STYLES) for (const c of COMPOSITIONS) combos.push(`${s}, ${st}, ${c}`);
  const rnd = mulberry32(hash(`${niche}|${subjects.join(',')}`));
  for (let i = combos.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [combos[i], combos[j]] = [combos[j], combos[i]]; }
  const out = [];
  // Spread the picks across subjects first so ten concepts are not all the same subject.
  const bySubject = subjects.map(s => combos.filter(c => c.startsWith(`${s},`)));
  for (let round = 0; out.length < count + skip && round < combos.length; round++) {
    for (const list of bySubject) { if (list[round]) out.push(list[round]); if (out.length >= count + skip) break; }
  }
  return out.slice(skip, skip + count);
}

function makeOrchestrator({ db, pipeline, stages, adapters, llm, spend, settings, publisher = null, dryRun, cfg, log = console, now = () => new Date() }) {
  const running = new Set();      // item ids in flight
  const inflight = new Set();     // promises (items + ideations), for idle()
  const requeueTimers = new Set();
  let stopped = false;

  const maxCount = (cfg && cfg.batch && cfg.batch.maxCount) || 25;
  const defaultConcurrency = (cfg && cfg.batch && cfg.batch.concurrency) || 1;

  const getBatch = id => db.prepare('SELECT * FROM batches WHERE id = ?').get(id);
  const getItem = id => db.prepare('SELECT * FROM batch_items WHERE id = ?').get(id);
  const setBatch = (id, patch) => {
    const cols = Object.keys(patch);
    db.prepare(`UPDATE batches SET ${cols.map(c => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...cols.map(c => patch[c]), nowIso(), id);
  };
  const setItem = (id, patch) => {
    const cols = Object.keys(patch);
    db.prepare(`UPDATE batch_items SET ${cols.map(c => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...cols.map(c => patch[c]), nowIso(), id);
  };

  // ---- cap + tiers ---------------------------------------------------------------------------------------------------
  const llmIsStub = () => { try { return llm.describe().provider === 'stub'; } catch { return false; } };
  const imageIsStub = () => { try { return adapters.imagegen.describe().methods.generate !== 'real'; } catch { return false; } };
  class CapPause extends Error { constructor(m) { super(m); this.name = 'CapPause'; } }
  /** Before a paid step: if today's generation spend already reached the cap, pause. (The real adapters also check an estimate.) */
  function capGuard(kind) {
    if (kind === 'llm' && llmIsStub()) return;
    if (kind === 'image' && imageIsStub()) return;
    const today = spend.todayCents(); const cap = spend.capCents();
    if (today >= cap) throw new CapPause(`Daily spend cap reached (${today}c spent of ${cap}c today, ET).`);
  }
  const isCap = e => e && (e.name === 'CapPause' || e.name === 'SpendCapError' || e.code === 'spend_cap');
  function tiers() {
    let explicit = false;
    try { explicit = llm.describe().routing.path === 'router'; } catch { explicit = false; }
    if (cfg && cfg.llm && Object.values(cfg.llm.models || {}).some(Boolean)) explicit = true;
    return explicit ? { ideation: 'cheap', qa: 'deep', explicit } : { ideation: 'standard', qa: 'standard', explicit };
  }

  // ---- input -----------------------------------------------------------------------------------------------------------
  async function validate(b = {}) {
    const niche = String(b.niche === undefined || b.niche === null ? '' : b.niche).trim();
    if (!niche) throw new BatchError('niche is required');
    if (niche.length > 200) throw new BatchError('niche must be at most 200 characters');
    const count = Number(b.count);
    if (!Number.isInteger(count) || count < 1) throw new BatchError('count must be a whole number of at least 1');
    if (count > maxCount) throw new BatchError(`count is capped at ${maxCount} per batch (BATCH_MAX_COUNT)`, 400, 'count_cap');
    const arr = b.keywords === undefined || b.keywords === null || b.keywords === '' ? [] : Array.isArray(b.keywords) ? b.keywords : String(b.keywords).split(',');
    if (arr.length > 30) throw new BatchError('at most 30 keywords');
    const keywords = [...new Set(arr.map(k => String(k).trim()).filter(Boolean))];
    if (keywords.some(k => k.length > 60)) throw new BatchError('a keyword is longer than 60 characters');
    const blueprint = String(b.blueprint || '').trim(); const providerId = String(b.printProviderId || b.providerId || '').trim();
    if (!blueprint || !providerId) throw new BatchError('blueprint and printProviderId are required (choose what to print on)');
    const price = Number(b.listPrice);
    if (!Number.isFinite(price) || price <= 0 || price > 10000) throw new BatchError('listPrice must be dollars above 0 and at most 10000');
    let shipping = 0;
    if (b.shipping !== undefined && b.shipping !== null && b.shipping !== '') { shipping = Number(b.shipping); if (!Number.isFinite(shipping) || shipping < 0 || shipping > 10000) throw new BatchError('shipping must be dollars between 0 and 10000'); }
    let storeId = null;
    if (b.storeId !== undefined && b.storeId !== null && b.storeId !== '') {
      storeId = Number(b.storeId);
      if (!Number.isInteger(storeId) || !db.prepare('SELECT 1 FROM stores WHERE id = ?').get(storeId)) throw new BatchError('storeId does not match a store');
    }
    let concurrency = defaultConcurrency;
    if (b.concurrency !== undefined && b.concurrency !== null && b.concurrency !== '') { concurrency = Number(b.concurrency); if (![1, 2].includes(concurrency)) throw new BatchError('concurrency must be 1 or 2'); }
    // A brand in the NICHE would poison every concept: refuse before anything is spent.
    const hits = scanFields(db, { niche, keywords });
    if (hits.length) throw new BatchError(`The niche/keywords contain trademark blocklist terms (${describeHits(hits)}). Batches generate original concepts only; remove them.`, 422, 'niche_blocklisted');
    // The print provider must be readable now, not discovered 25 times later.
    let variants;
    try { variants = await adapters.pod.listVariants(blueprint, providerId); }
    catch (e) { throw new BatchError(`could not read the print provider's variants: ${e.message}`, 422, 'pod_unreadable'); }
    const all = (variants && variants.variants) || [];
    if (!all.length) throw new BatchError('that blueprint/provider offers no variants', 422, 'no_variants');
    const want = (Array.isArray(b.variantIds) && b.variantIds.length ? b.variantIds : [all[0].id]).map(String);
    const chosen = all.filter(v => want.includes(String(v.id)));
    if (chosen.length !== new Set(want).size) throw new BatchError('one or more variants do not belong to that blueprint/provider', 422, 'bad_variant');
    return { niche, count, keywords, blueprint, providerId, variantIds: chosen.map(v => v.id), priceCents: Math.round(price * 100), shippingCents: Math.round(shipping * 100), storeId, concurrency };
  }

  /** Create the batch row and start ideating in the background. Returns the batch (status 'ideating'). */
  async function start(body) {
    const v = await validate(body);
    const t = nowIso();
    const id = Number(db.prepare(`INSERT INTO batches(niche,keywords,requested_count,blueprint,print_provider_id,variant_ids,list_price_cents,shipping_cents,store_id,status,concurrency,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,'ideating',?,?,?)`).run(v.niche, JSON.stringify(v.keywords), v.count, v.blueprint, v.providerId, JSON.stringify(v.variantIds), v.priceCents, v.shippingCents, v.storeId, v.concurrency, t, t).lastInsertRowid);
    systemNote(`batch ${id} started: ${v.count} x "${v.niche}"`);
    track(ideate(id));
    return getBatch(id);
  }
  const systemNote = note => { try { require('./events').systemEvent(db, { actor: 'agent', note }); } catch { /* best effort */ } };
  function track(p) { inflight.add(p); p.finally(() => inflight.delete(p)).catch(() => {}); return p; }

  // ---- ideation ---------------------------------------------------------------------------------------------------------
  const IDEATION_SYSTEM = [
    'You propose ORIGINAL design concepts for print-on-demand products (t-shirts, mugs, posters).',
    'Reply with ONLY a JSON object: {"concepts": [string, ...]}. Each concept is one sentence (15-40 words) describing a single printable graphic: subject, art style, palette, composition.',
    'Every concept must be clearly different from the others in subject AND style. Do not repeat a subject with a different adjective.',
    'NEVER use or imitate any brand, trademark, franchise, character, team, band, celebrity or artist name, any famous slogan or quote, or any existing artwork. No text in the image unless it is a short generic word.',
    'You are given a niche and optional keywords as THEMES only.',
  ].join(' ');

  async function ideate(batchId) {
    const b = getBatch(batchId);
    if (!b || b.status !== 'ideating') return;
    const keywords = parse(b.keywords, []);
    const want = b.requested_count;
    const accepted = []; const sigs = [];
    let dropBl = 0; let dropDup = 0; let model = null; let cost = 0; let nLlm = 0; let nTpl = 0;
    const existing = db.prepare("SELECT brief FROM products ORDER BY id DESC LIMIT 400").all().map(r => sigWords(r.brief));
    const offer = (text, via) => {
      const c = String(text || '').replace(/\s+/g, ' ').trim();
      if (c.length < 10 || c.length > MAX_CONCEPT) return;
      if (scanFields(db, { concept: c }).length) { dropBl++; return; }
      const sw = sigWords(c);
      if (sigs.some(s => jaccard(s, sw) >= 0.6) || existing.some(s => jaccard(s, sw) >= 0.8)) { dropDup++; return; }
      accepted.push(c); sigs.push(sw); if (via === 'llm') nLlm++; else nTpl++;
    };
    try {
      const t = tiers();
      for (let attempt = 0; attempt < 2 && accepted.length < want; attempt++) {
        capGuard('llm');
        const more = want - accepted.length;
        const ask = Math.min(60, Math.ceil(more * 1.5) + 2);
        const out = await llm.complete({
          system: IDEATION_SYSTEM, tier: t.ideation, json: true,
          prompt: [`Niche / theme: ${b.niche}`, `Keywords (themes): ${keywords.length ? keywords.join(', ') : '(none)'}`,
            accepted.length ? `Already have (do not repeat or paraphrase): ${accepted.map(a => `"${a.slice(0, 80)}"`).join('; ')}` : '',
            `Propose ${ask} distinct original concepts.`].filter(Boolean).join('\n'),
        });
        model = out.model; cost += out.costCents || 0;
        if (out.costCents > 0) spend.addCost({ productId: null, kind: 'llm', amountCents: out.costCents, note: `batch ${batchId} ideation (${out.model})` });
        let list = [];
        try { const j = extractJson(out.text); list = Array.isArray(j) ? j : Array.isArray(j && j.concepts) ? j.concepts : []; } catch { list = []; }
        for (const c of list) offer(typeof c === 'string' ? c : c && (c.concept || c.brief || c.description), 'llm');
        if (!list.length) break; // a model that returns nothing usable (the stub) will not do better on a second ask
      }
      if (accepted.length < want) {
        // Top up deterministically. Templates are blocklist- and duplicate-checked like model output.
        let skip = 0;
        for (let guard = 0; accepted.length < want && guard < 6; guard++) {
          const batch = templateConcepts({ niche: b.niche, keywords, count: want * 2, skip });
          if (!batch.length) break;
          skip += batch.length;
          for (const c of batch) { if (accepted.length >= want) break; offer(c, 'template'); }
        }
      }
    } catch (e) {
      if (isCap(e)) return pauseBatch(batchId, e, { ideating: true });
      log.warn(`[batch ${batchId}] ideation failed: ${e.message}`);
      return setBatch(batchId, { status: 'failed', status_detail: `ideation failed: ${e.message}`.slice(0, 400), finished_at: nowIso() });
    }
    const cur = getBatch(batchId);
    if (!cur || cur.status === 'cancelled') return; // cancelled while the model was thinking: create nothing
    const final = accepted.slice(0, want);
    const source = nLlm && nTpl ? 'llm+template' : nLlm ? 'llm' : 'template';
    if (!final.length) return setBatch(batchId, { status: 'failed', status_detail: 'no usable concepts could be produced', finished_at: nowIso() });
    const t = nowIso();
    const ins = db.prepare("INSERT INTO batch_items(batch_id, idx, concept, status, step, updated_at) VALUES(?,?,?,'pending','queued',?)");
    db.exec('BEGIN');
    try {
      final.forEach((c, i) => ins.run(batchId, i + 1, c, t));
      setBatch(batchId, { status: 'running', status_detail: final.length < want ? `only ${final.length} of ${want} distinct concepts could be made` : null, ideation_model: model || 'template', ideation_cost_cents: cost, ideation_source: source, dropped_blocklist: dropBl, dropped_duplicate: dropDup });
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch { /* gone */ } throw e; }
    pump();
  }

  // ---- the queue --------------------------------------------------------------------------------------------------------
  function nextPending() {
    return db.prepare(`SELECT i.* FROM batch_items i JOIN batches b ON b.id = i.batch_id
      WHERE i.status = 'pending' AND b.status = 'running'
        AND (SELECT COUNT(*) FROM batch_items r WHERE r.batch_id = i.batch_id AND r.status = 'running') < b.concurrency
      ORDER BY b.id, i.idx LIMIT 1`).get();
  }
  function pump() {
    if (stopped) return;
    while (running.size < GLOBAL_MAX) {
      const item = nextPending();
      if (!item) break;
      setItem(item.id, { status: 'running', attempts: item.attempts + 1, error: null });
      running.add(item.id);
      const p = runItem(item.id).catch(e => { log.warn(`[batch] item ${item.id} crashed: ${e.message}`); try { setItem(item.id, { status: 'failed', error: `unexpected: ${e.message}`.slice(0, 400) }); } catch { /* db closed */ } })
        .finally(() => { running.delete(item.id); finalize(item.batch_id); pump(); });
      track(p);
    }
  }
  function finalize(batchId) {
    const b = getBatch(batchId);
    if (!b || b.status !== 'running') return;
    const open = db.prepare("SELECT COUNT(*) AS n FROM batch_items WHERE batch_id = ? AND status IN ('pending','running','interrupted')").get(batchId).n;
    if (!open) setBatch(batchId, { status: 'done', finished_at: nowIso(), status_detail: null });
  }

  function pauseBatch(batchId, err, { ideating = false } = {}) {
    const b = getBatch(batchId);
    if (!b || ['cancelled', 'done', 'failed'].includes(b.status)) return;
    setBatch(batchId, { status: 'paused_cap', paused_day: etDay(now()), status_detail: `paused by the daily spend cap: ${err.message}`.slice(0, 400) });
    systemNote(`batch ${batchId} paused by the daily spend cap`);
    log.info(`[batch ${batchId}] paused (spend cap)${ideating ? ' during ideation' : ''}`);
  }

  function snapshot(itemId) {
    const it = getItem(itemId); if (!it || !it.product_id) return;
    const cost = db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS v FROM costs WHERE product_id = ?').get(it.product_id).v;
    const p = pipeline.get(it.product_id);
    const d = db.prepare('SELECT model FROM designs WHERE product_id = ? ORDER BY id DESC LIMIT 1').get(it.product_id);
    const l = db.prepare("SELECT model FROM listings WHERE product_id = ? AND platform = 'etsy' ORDER BY id DESC LIMIT 1").get(it.product_id);
    const models = { ...parse(it.models, {}), concept: (getBatch(it.batch_id) || {}).ideation_model || null, image: d && d.model || null, copy: l && l.model || null };
    setItem(itemId, { cost_cents: cost, models: JSON.stringify(models), outcome: p ? p.stage : null });
  }

  const cancelled = batchId => { const b = getBatch(batchId); return !b || b.status === 'cancelled'; };

  async function runItem(itemId) {
    let item = getItem(itemId);
    const batchId = item.batch_id;
    const b = getBatch(batchId);
    const step = name => { setItem(itemId, { step: name }); item = getItem(itemId); };
    const stop = (status, extra = {}) => { setItem(itemId, { status, ...extra }); snapshot(itemId); };
    try {
      // 1. the product
      let pid = item.product_id;
      if (!pid) {
        step('create');
        const created = pipeline.create({ brief: item.concept, niche: b.niche, keywords: parse(b.keywords, []), listPrice: b.list_price_cents / 100, shipping: b.shipping_cents / 100, storeId: b.store_id }, { actor: 'agent' });
        pid = created.id; setItem(itemId, { product_id: pid });
        await pipeline.selectPod(pid, { blueprint: b.blueprint, providerId: b.print_provider_id, variantIds: parse(b.variant_ids, []) });
        productEvent(db, pid, { actor: 'agent', note: `created by batch ${batchId}, item ${item.idx}` });
      }
      // 2. walk the stages
      for (let guard = 0; guard < 12; guard++) {
        if (cancelled(batchId)) return stop('cancelled', { error: 'batch cancelled' });
        const p = pipeline.get(pid);
        if (!p) return stop('failed', { error: 'the product was deleted' });
        if (p.stage === S.IDEA) { step('design'); capGuard('image'); await pipeline.generateDesign(pid, { actor: 'agent' }); }
        else if (p.stage === S.DESIGN) { step('print_readiness_and_pod'); await pipeline.createPodProduct(pid, { actor: 'agent' }); }
        else if (p.stage === S.MOCKUP) { step('copy_and_margin'); if (!hasCopy(pid)) capGuard('llm'); await pipeline.draftListing(pid, { actor: 'agent' }); }
        else if (p.stage === S.DRAFTED) {
          if (!item.qa_status) { step('qa'); await runQa(itemId, pid); item = getItem(itemId); }
          step('submit'); await pipeline.submit(pid, { actor: 'agent' });
        }
        else if (p.stage === S.PENDING) {
          step('pending_approval');
          const auto = await maybeAutopublish(itemId, pid);
          snapshot(itemId);
          return stop('done', { step: auto.published ? 'published' : 'pending_approval', error: auto.note || null });
        }
        else if (p.stage === S.FAILED) return stop('failed', { error: p.failed_reason || 'the product failed' });
        else return stop('done', { step: 'handled_elsewhere' }); // approved/published/live/rejected/archived: a human got there first
        snapshot(itemId);
      }
      return stop('failed', { error: 'the item did not converge (internal loop guard)' });
    } catch (e) {
      if (isCap(e)) {
        setItem(itemId, { status: 'pending', error: null }); // back in the queue with its step kept; nothing was lost
        snapshot(itemId); pauseBatch(batchId, e); return undefined;
      }
      if (e && e.code === 'busy') { // an operator is working on this product: try again shortly, without counting it
        setItem(itemId, { status: 'pending', attempts: Math.max(0, getItem(itemId).attempts - 1) });
        const h = setTimeout(() => { requeueTimers.delete(h); pump(); }, 1500); if (h.unref) h.unref(); requeueTimers.add(h);
        return undefined;
      }
      const msg = e && e.code === 'print_not_ready' ? `print_not_ready: ${e.message}` : (e && e.message) || String(e);
      log.warn(`[batch ${batchId}] item ${item.idx} stopped: ${msg}`);
      return stop('failed', { error: msg.slice(0, 500) });
    }
  }
  const hasCopy = pid => Boolean(db.prepare("SELECT 1 FROM listings WHERE product_id = ? AND platform = 'etsy' AND status = 'draft'").get(pid));

  // ---- QA ---------------------------------------------------------------------------------------------------------------
  const QA_SYSTEM = [
    'You review an Etsy print-on-demand listing before a human sees it. You may only RAISE issues; you cannot approve or change anything.',
    'Reply with ONLY JSON: {"issues": [{"type": "ip_risk"|"originality"|"etsy_rules"|"misleading"|"other", "detail": string}]}. An empty list means you found nothing.',
    'ip_risk: any brand, trademark, franchise, character, team, celebrity, slogan or quote that someone owns, or a claim of being official/licensed. originality: the concept reads as a copy of a known artwork or a famous design.',
    'etsy_rules: title over 140 characters, more than 13 tags, a tag over 20 characters, keyword stuffing, repeated phrases, misleading categories. misleading: the copy promises something the product cannot be.',
  ].join(' ');

  async function runQa(itemId, pid) {
    const l = db.prepare("SELECT * FROM listings WHERE product_id = ? AND platform = 'etsy' ORDER BY id DESC LIMIT 1").get(pid);
    const p = pipeline.get(pid);
    if (llmIsStub()) { setItem(itemId, { qa_status: 'skipped' }); productEvent(db, pid, { actor: 'agent', note: 'QA skipped: the LLM provider is the stub (no key). The product is not marked as reviewed.' }); return; }
    capGuard('llm');
    const tags = parse(l && l.tags, []);
    const bl = scanFields(db, { brief: p.brief, title: l && l.title, tags, description: l && l.description });
    const t = tiers();
    let out;
    try {
      out = await llm.complete({
        system: QA_SYSTEM, tier: t.qa, json: true,
        prompt: [`Niche: ${p.niche}`, `Design brief: ${p.brief}`, `Title (${(l && l.title || '').length} chars): ${l && l.title}`, `Tags (${tags.length}): ${tags.join(' | ')}`, `Description: ${(l && l.description || '').slice(0, 1500)}`,
          bl.length ? `The trademark blocklist already matched: ${describeHits(bl)}` : 'The trademark blocklist matched nothing.', 'List any issues now.'].join('\n'),
      });
    } catch (e) {
      if (isCap(e)) throw e;
      setItem(itemId, { qa_status: 'error' });
      productEvent(db, pid, { actor: 'agent', note: `QA could not run: ${e.message}. The product is not marked as reviewed.` });
      return;
    }
    if (out.costCents > 0) spend.addCost({ productId: pid, kind: 'llm', amountCents: out.costCents, note: `batch QA (${out.model})` });
    let issues = null;
    try { const j = extractJson(out.text); if (j && Array.isArray(j.issues)) issues = j.issues; } catch { issues = null; }
    const models = { ...parse(getItem(itemId).models, {}), qa: out.model };
    if (issues === null) { setItem(itemId, { qa_status: 'error', models: JSON.stringify(models) }); productEvent(db, pid, { actor: 'agent', note: 'QA could not run: the reviewer did not return the expected JSON. The product is not marked as reviewed.' }); return; }
    const flags = issues.filter(i => i && typeof i.detail === 'string' && i.detail.trim()).slice(0, 8).map(i => ({
      code: `qa_${QA_TYPES.includes(i.type) ? i.type : 'other'}`, detail: i.detail.trim().slice(0, 240), source: 'qa',
    }));
    if (flags.length) pipeline.addFlags(pid, flags); // add only: nothing the QA says can clear a flag
    setItem(itemId, { qa_status: 'ran', models: JSON.stringify(models) });
    productEvent(db, pid, { actor: 'agent', note: `QA (${out.model}) ${flags.length ? `raised: ${flags.map(f => f.code).join(', ')}` : 'found nothing'}` });
  }

  // ---- autopublish (the only way a batch can publish) ----------------------------------------------------------------------
  async function maybeAutopublish(itemId, pid) {
    const p = pipeline.get(pid);
    const store = p.store_id ? db.prepare('SELECT * FROM stores WHERE id = ?').get(p.store_id) : null;
    const why = [];
    if (!store || !store.autopublish) why.push('store autopublish is off');
    if (dryRun && dryRun.isOn()) why.push('DRY_RUN is on');
    const flags = parseFlags(p); if (flags.length) why.push(`flagged (${flags.map(f => f.code).join(', ')})`);
    if (getItem(itemId).qa_status !== 'ran') why.push('the QA review did not run');
    if (!publisher) why.push('no publisher');
    if (why.length) return { published: false, note: null, why };
    try {
      await pipeline.approve(pid, { actor: 'agent' });
      await publisher.publish(pid, { actor: 'agent' });
      productEvent(db, pid, { actor: 'agent', note: `autopublished by batch (store autopublish on, DRY_RUN off, no flags)` });
      return { published: true };
    } catch (e) {
      productEvent(db, pid, { actor: 'agent', note: `autopublish stopped: ${e.message}` });
      // Back to the human gate if it was left approved.
      try { if (pipeline.get(pid).stage === S.APPROVED) stages.transition(pid, S.PENDING, { actor: 'agent', note: 'autopublish failed; back to PENDING_APPROVAL for a human' }); } catch { /* leave it */ }
      return { published: false, note: `autopublish stopped: ${e.message}`.slice(0, 300) };
    }
  }

  // ---- control ----------------------------------------------------------------------------------------------------------
  function cancel(id) {
    const b = getBatch(id);
    if (!b) throw new BatchError('Batch not found', 404, 'not_found');
    if (['done', 'cancelled', 'failed'].includes(b.status)) throw new BatchError(`The batch is already ${b.status}`, 409, 'illegal_state');
    db.prepare("UPDATE batch_items SET status = 'cancelled', error = 'batch cancelled', updated_at = ? WHERE batch_id = ? AND status IN ('pending','interrupted')").run(nowIso(), id);
    setBatch(id, { status: 'cancelled', finished_at: nowIso(), status_detail: 'cancelled by the operator; a step already in flight finishes first' });
    systemNote(`batch ${id} cancelled`);
    return getBatch(id);
  }

  function resume(id) {
    const b = getBatch(id);
    if (!b) throw new BatchError('Batch not found', 404, 'not_found');
    if (b.status !== 'paused_cap') throw new BatchError(`Only a batch paused by the spend cap can be resumed; this one is ${b.status}`, 409, 'illegal_state');
    const hasItems = db.prepare('SELECT COUNT(*) AS n FROM batch_items WHERE batch_id = ?').get(id).n > 0;
    setBatch(id, { status: hasItems ? 'running' : 'ideating', paused_day: null, status_detail: spend.todayCents() >= spend.capCents() ? 'resumed by hand while the cap is still reached: the first paid step will pause it again' : null });
    if (hasItems) pump(); else track(ideate(id));
    return getBatch(id);
  }

  /** Called on a timer by index.js: a batch paused by the cap on an earlier ET day resumes by itself. */
  function tick() {
    const today = etDay(now());
    let n = 0;
    for (const b of db.prepare("SELECT * FROM batches WHERE status = 'paused_cap'").all()) {
      if (b.paused_day && b.paused_day !== today) { resume(b.id); n++; }
    }
    return n;
  }

  /** After a restart: running items were cut off. Each is retried ONCE; a second interruption fails it. Pending items just continue. */
  function recover() {
    const out = { interrupted: 0, retried: 0, failed: 0, ideating: 0 };
    const cut = db.prepare("SELECT * FROM batch_items WHERE status = 'running'").all();
    for (const it of cut) {
      out.interrupted++;
      setItem(it.id, { status: 'interrupted', error: 'interrupted by a restart' });
      if (it.attempts < 2) { setItem(it.id, { status: 'pending', error: 'retried after an interruption' }); out.retried++; }
      else { setItem(it.id, { status: 'failed', error: 'interrupted twice; not retried again' }); out.failed++; }
    }
    for (const b of db.prepare("SELECT * FROM batches WHERE status = 'ideating'").all()) { out.ideating++; track(ideate(b.id)); }
    for (const b of db.prepare("SELECT id FROM batches WHERE status = 'running'").all()) finalize(b.id);
    pump();
    return out;
  }

  // ---- read side --------------------------------------------------------------------------------------------------------
  function view(id) {
    const b = getBatch(id);
    if (!b) return null;
    const items = db.prepare(`SELECT i.*, p.stage AS product_stage, p.flags AS product_flags, p.title AS product_title, p.projected_margin_cents AS margin_cents,
        (SELECT id FROM designs d WHERE d.product_id = i.product_id ORDER BY d.id DESC LIMIT 1) AS design_id
      FROM batch_items i LEFT JOIN products p ON p.id = i.product_id WHERE i.batch_id = ? ORDER BY i.idx`).all(id).map(i => ({
      id: i.id, idx: i.idx, concept: i.concept, productId: i.product_id, status: i.status, step: i.step, attempts: i.attempts, error: i.error, qa: i.qa_status,
      models: parse(i.models, {}), costCents: i.cost_cents, stage: i.product_stage || null, title: i.product_title || null, marginCents: i.margin_cents,
      flags: parse(i.product_flags, []), thumbnail: i.design_id ? `/api/images/${i.design_id}` : null, updatedAt: i.updated_at,
    }));
    const by = {}; for (const i of items) by[i.status] = (by[i.status] || 0) + 1;
    const atApproval = items.filter(i => i.stage === S.PENDING).length;
    const itemCost = items.reduce((a, i) => a + i.costCents, 0);
    return {
      id: b.id, niche: b.niche, keywords: parse(b.keywords, []), requestedCount: b.requested_count, blueprint: b.blueprint, printProviderId: b.print_provider_id,
      listPriceCents: b.list_price_cents, storeId: b.store_id, status: b.status, statusDetail: b.status_detail, concurrency: b.concurrency,
      ideation: { model: b.ideation_model, source: b.ideation_source, costCents: b.ideation_cost_cents, droppedBlocklist: b.dropped_blocklist, droppedDuplicate: b.dropped_duplicate },
      createdAt: b.created_at, updatedAt: b.updated_at, finishedAt: b.finished_at,
      counts: { ...by, atPendingApproval: atApproval }, costCents: itemCost + b.ideation_cost_cents, items,
    };
  }
  function list(limit = 30) {
    return db.prepare('SELECT id FROM batches ORDER BY id DESC LIMIT ?').all(Math.min(Math.max(limit | 0, 1), 100)).map(r => { const v = view(r.id); const { items, ...head } = v; return head; });
  }

  async function idle() { while (inflight.size) await Promise.allSettled([...inflight]); }
  function stop() { stopped = true; for (const h of requeueTimers) clearTimeout(h); requeueTimers.clear(); }

  return { start, view, list, cancel, resume, recover, tick, pump, idle, stop, BatchError, validate };
}

module.exports = { makeOrchestrator, BatchError, templateConcepts, jaccard, sigWords, GLOBAL_MAX };
