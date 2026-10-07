'use strict';
/**
 * playbooks/checks.js — `check` hooks referenced by name from definitions.js. A hook READS live
 * state and returns {status:'pass'|'fail'|'unknown', detail}. They never write. A hook that needs a
 * product returns 'unknown' on the global checklist, and 'unknown' is never 'pass'.
 */
const { checkBlocklist } = require('../domain/blocklist');

const pass = detail => ({ status: 'pass', detail });
const fail = detail => ({ status: 'fail', detail });
const unknown = detail => ({ status: 'unknown', detail });
const usd = c => `$${(c / 100).toFixed(2)}`;
const needProduct = 'Needs a product: pick one to evaluate this check.';

const CHECKS = {
  margin_above_floor({ db, settings, product }) {
    if (!product) return unknown(needProduct);
    if (!Number.isInteger(product.projected_margin_cents)) return unknown('No projected margin yet (needs list price and POD base cost).');
    const floor = settings.getInt('margin_floor_cents', 200);
    const m = product.projected_margin_cents;
    return m > 0 && m >= floor ? pass(`margin ${usd(m)} >= floor ${usd(floor)}`) : fail(`margin ${usd(m)} is ${m <= 0 ? 'not positive' : `below floor ${usd(floor)}`}`);
  },
  no_flags({ product }) {
    if (!product) return unknown(needProduct);
    let flags = []; try { flags = JSON.parse(product.flags || '[]'); } catch { /* treat as none */ }
    return flags.length ? fail(`flags: ${flags.map(f => f.code).join(', ')}`) : pass('no flags');
  },
  blocklist_clean({ db, product }) {
    if (!product) return unknown(needProduct);
    const l = db.prepare('SELECT title, tags FROM listings WHERE product_id = ? ORDER BY id DESC LIMIT 1').get(product.id);
    const hits = checkBlocklist(db, [product.brief, product.title, product.niche, l && l.title, l && l.tags]);
    return hits.length ? fail(`blocklist hit: ${hits.join(', ')}`) : pass('no blocklist terms in brief, title or tags');
  },
  etsy_tag_rules({ db, product }) {
    if (!product) return unknown(needProduct);
    const l = db.prepare('SELECT title, tags FROM listings WHERE product_id = ? ORDER BY id DESC LIMIT 1').get(product.id);
    if (!l) return unknown('No listing draft yet.');
    let tags = []; try { tags = JSON.parse(l.tags || '[]'); } catch { return fail('tags are not valid JSON'); }
    const long = tags.filter(t => String(t).length > 20);
    if (tags.length > 13) return fail(`${tags.length} tags (max 13)`);
    if (long.length) return fail(`${long.length} tag(s) over 20 chars`);
    if ((l.title || '').length > 140) return fail('title over 140 chars');
    return pass(`${tags.length} tags, all <=20 chars; title ${(l.title || '').length}/140`);
  },
  has_pod_provider({ product }) {
    if (!product) return unknown(needProduct);
    return product.blueprint && product.print_provider_id ? pass(`blueprint ${product.blueprint} / provider ${product.print_provider_id}`) : fail('no blueprint / print provider chosen');
  },
  has_design({ db, product }) {
    if (!product) return unknown(needProduct);
    return db.prepare('SELECT 1 FROM designs WHERE product_id = ? LIMIT 1').get(product.id) ? pass('a design exists') : fail('no design yet');
  },
  no_open_alerts({ db, product }) {
    if (!product) return unknown(needProduct);
    const n = db.prepare('SELECT COUNT(*) AS n FROM alerts WHERE product_id = ? AND acknowledged = 0').get(product.id).n;
    return n ? fail(`${n} open alert(s) on this product`) : pass('no open alerts');
  },
  dry_run_state({ settings }) {
    return settings.getBool('dry_run', true) ? pass('DRY_RUN is ON (nothing reaches a marketplace)') : unknown('DRY_RUN is OFF: writes are live. Confirm that is intended.');
  },
  proposals_reviewed({ db }) {
    let n;
    try { n = db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE status = 'pending' AND created_at < ?").get(new Date(Date.now() - 7 * 86400000).toISOString()).n; }
    catch { return unknown('The proposals table could not be read.'); }
    return n ? fail(`${n} proposal(s) have been pending for more than a week`) : pass('no proposal has been pending for more than a week');
  },
  is_live({ product }) {
    if (!product) return unknown(needProduct);
    return ['published', 'live'].includes(product.stage) ? pass(`stage ${product.stage}`) : fail(`stage is ${product.stage}, not published/live`);
  },
};

function runCheck(name, ctx) {
  const fn = CHECKS[name];
  if (!fn) return unknown(`unknown check "${name}"`);
  try { return fn(ctx); } catch (e) { return unknown(`check failed: ${e.message}`); }
}
module.exports = { CHECKS, runCheck };
