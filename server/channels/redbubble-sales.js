'use strict';
/**
 * channels/redbubble-sales.js — Redbubble sales into `sales`, attributed to channel 'redbubble'.
 *
 * Redbubble DOES offer a CSV sales history: Sales History page -> request the report, which is also emailed quarterly
 * (corroborated: search summary of https://help.redbubble.com/hc/en-us/articles/4412488515092 ; the page itself returned HTTP 403).
 * What the file's COLUMN HEADERS are was NOT found anywhere. Search results only confirm an order date and an artist-margin
 * field. So the parser is deliberately tolerant and EVERYTHING about the layout is ASSUMED:
 *   - header names are matched by alias (see ALIASES), case/space/punctuation-insensitive; the result reports which header it
 *     mapped to which field and lists the ones it could not use, so a wrong guess is visible, never silent;
 *   - the margin column is taken as the artist's earning for THAT LINE (not per unit), in USD unless a currency column or symbol says otherwise;
 *   - a non-USD row is SKIPPED with a reason (no conversion is modelled), never silently treated as dollars.
 * If your real file differs, add the real header to ALIASES: that one line is the whole fix. The fixture in test/fixtures is named
 * ASSUMED-HEADERS for the same reason.
 *
 * Money model: Redbubble pays the artist the margin, and bears production, shipping and payment costs itself. So per line:
 * gross = net = the margin, no marketplace/processing fee, no COGS (cogs_cents NULL). Account fees (platform fee, the excess markup
 * fee) are taken from payouts and are not in a per-sale line; they are NOT modelled here.
 * Idempotent: a line's identity is (order id or a content hash) + its ordinal, so importing an overlapping or repeated file adds nothing twice.
 */
const crypto = require('node:crypto');
const { tx } = require('../db');
const { productEvent } = require('../events');

const FIELDS = ['date', 'orderId', 'title', 'productType', 'quantity', 'margin', 'currency', 'workId', 'workUrl'];
const ALIASES = {
  date: ['saledate', 'orderdate', 'date', 'datepurchased', 'purchasedate', 'transactiondate', 'shippeddate'],
  orderId: ['ordernumber', 'orderid', 'order', 'orderno', 'ordernum', 'transactionid'],
  title: ['worktitle', 'work', 'title', 'workname', 'designtitle', 'producttitle', 'imagetitle', 'itemname'],
  productType: ['product', 'producttype', 'producttypename', 'item', 'category'],
  quantity: ['quantity', 'qty', 'units'],
  margin: ['artistmargin', 'margin', 'artistearnings', 'earnings', 'yourmargin', 'artistprofit', 'artistcommission', 'commission', 'amount'],
  currency: ['currency', 'currencycode'],
  workId: ['workid', 'imageid', 'artworkid', 'designid'],
  workUrl: ['workurl', 'url', 'link', 'workslug'],
};
const norm = h => String(h || '').toLowerCase().replace(/^﻿/, '').replace(/[^a-z0-9]/g, '');

/** RFC 4180-ish CSV: quotes, doubled quotes, CRLF, BOM; delimiter is , ; or tab, decided from the header line. */
function parseCsv(text) {
  const s = String(text || '').replace(/^﻿/, '');
  const first = s.split(/\r?\n/, 1)[0] || '';
  const delim = [',', ';', '\t'].map(d => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = []; let cur = ''; let q = false; let line = 1; const lines = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else { if (c === '\n') line++; cur += c; } continue; }
    if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some(x => x.trim() !== '')) { rows.push(row); lines.push(line); } row = []; line++; }
    else cur += c;
  }
  row.push(cur); if (row.some(x => x.trim() !== '')) { rows.push(row); lines.push(line); }
  return { rows, lines };
}

const CUR_SYMBOLS = { '$': 'USD', 'us$': 'USD', '£': 'GBP', '€': 'EUR', 'a$': 'AUD', 'au$': 'AUD', 'c$': 'CAD', 'ca$': 'CAD', 'nz$': 'NZD', '¥': 'JPY' };
/** "$1.23", "US$ 1,234.50", "(1.23)", "-1.23", "1,23" -> {cents, currency|null}. cents null when unreadable. */
function parseMoney(raw) {
  let s = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!s) return { cents: null, currency: null };
  let currency = null;
  const code = s.match(/\b(USD|GBP|EUR|AUD|CAD|NZD|JPY)\b/i); if (code) { currency = code[1].toUpperCase(); s = s.replace(code[0], ''); }
  const sym = s.match(/^[\s(+-]*([A-Za-z]{0,2}[$£€¥])/); if (sym) { currency = currency || CUR_SYMBOLS[sym[1].toLowerCase()] || null; s = s.replace(sym[1], ''); }
  let neg = false;
  if (/^\s*\(.*\)\s*$/.test(s)) { neg = true; s = s.replace(/[()]/g, ''); }
  s = s.replace(/\s/g, '');
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return { cents: null, currency };
  const cents = Math.round(Number(s) * 100);
  return { cents: neg ? -cents : cents, currency };
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
/** ISO, "M/D/YYYY" (US order assumed), "Mon D, YYYY" or "D Mon YYYY" -> "YYYY-MM-DD" or null. */
function parseDate(raw) {
  const s = String(raw || '').trim(); let y; let m; let d; let x;
  if ((x = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) { y = +x[1]; m = +x[2]; d = +x[3]; }
  else if ((x = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/))) { m = +x[1]; d = +x[2]; y = +x[3]; }
  else if ((x = s.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})/))) { m = MONTHS[x[1].toLowerCase()]; d = +x[2]; y = +x[3]; }
  else if ((x = s.match(/^(\d{1,2}) ([A-Za-z]{3})[a-z]*\.? (\d{4})/))) { d = +x[1]; m = MONTHS[x[2].toLowerCase()]; y = +x[3]; }
  else return null;
  if (!m || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return dt.toISOString().slice(0, 10);
}

function mapHeaders(header) {
  const map = {}; const used = new Set();
  const n = header.map(norm);
  for (const f of FIELDS) {
    for (const a of ALIASES[f]) { const i = n.indexOf(a); if (i !== -1 && !used.has(i)) { map[f] = i; used.add(i); break; } }
  }
  return { map, unmatched: header.filter((_, i) => !used.has(i) && header[i].trim() !== '') };
}

/**
 * parseReport(text) -> {assumedHeaders:true, headerMap:{field: headerText}, unmatchedHeaders[], rows:[{line,date,orderId,title,productType,quantity,marginCents,workId,workUrl}], skipped:[{line,reason}], fatal?}
 * Pure: touches no database. `fatal` is set when the file cannot be used at all (no date or margin column).
 */
function parseReport(text) {
  const out = { assumedHeaders: true, headerMap: {}, unmatchedHeaders: [], rows: [], skipped: [], fatal: null };
  const { rows, lines } = parseCsv(text);
  if (rows.length < 1) { out.fatal = 'The file is empty'; return out; }
  const { map, unmatched } = mapHeaders(rows[0]);
  out.unmatchedHeaders = unmatched;
  for (const f of Object.keys(map)) out.headerMap[f] = rows[0][map[f]].trim();
  const missing = ['date', 'margin'].filter(f => map[f] === undefined);
  if (missing.length) { out.fatal = `Could not find the ${missing.join(' and ')} column. Headers seen: ${rows[0].map(h => `"${h.trim()}"`).join(', ')}. Redbubble's real CSV headers were never confirmed; add yours to ALIASES in server/channels/redbubble-sales.js.`; return out; }
  const get = (r, f) => (map[f] === undefined ? '' : String(r[map[f]] === undefined ? '' : r[map[f]]).trim());
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]; const line = lines[i];
    const date = parseDate(get(r, 'date'));
    if (!date) { out.skipped.push({ line, reason: `unreadable date "${get(r, 'date').slice(0, 30)}"` }); continue; }
    const money = parseMoney(get(r, 'margin'));
    if (money.cents === null) { out.skipped.push({ line, reason: `unreadable margin "${get(r, 'margin').slice(0, 30)}"` }); continue; }
    const cur = (get(r, 'currency').toUpperCase() || money.currency || 'USD');
    if (cur !== 'USD') { out.skipped.push({ line, reason: `currency ${cur}: only USD is imported (no conversion is modelled); enter this one by hand` }); continue; }
    const qRaw = get(r, 'quantity'); const quantity = qRaw === '' ? 1 : Number.parseInt(qRaw, 10);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) { out.skipped.push({ line, reason: `unreadable quantity "${qRaw.slice(0, 20)}"` }); continue; }
    out.rows.push({ line, date, orderId: get(r, 'orderId') || null, title: get(r, 'title') || null, productType: get(r, 'productType') || null, quantity, marginCents: money.cents, workId: (get(r, 'workId').match(/\d{5,}/) || [null])[0], workUrl: get(r, 'workUrl') || null });
  }
  return out;
}

function makeRedbubbleSales({ db, now = () => new Date(), log = console }) {
  const bySales = (sql, ...a) => db.prepare(sql).all(...a);
  const wid = u => { const m = String(u || '').match(/\/(\d{5,})(?:\.[A-Za-z0-9]+)?\/?(?:[?#].*)?$/); return m ? m[1] : null; };

  /** Find the product a line belongs to: work id, then the title we recorded for the channel, then the product's own title. */
  function matcher() {
    const listed = bySales("SELECT product_id, work_id, work_title FROM channel_listings WHERE channel = 'redbubble'");
    const byWork = new Map();
    for (const l of listed) if (l.work_id) byWork.set(l.work_id, byWork.has(l.work_id) && byWork.get(l.work_id) !== l.product_id ? null : l.product_id); // one work id on two products: ambiguous, so unmatched

    const byTitle = new Map(); const ambiguous = new Set();
    const addTitle = (t, id) => { const k = String(t || '').trim().toLowerCase(); if (!k) return; if (byTitle.has(k) && byTitle.get(k) !== id) ambiguous.add(k); else byTitle.set(k, id); };
    listed.forEach(l => addTitle(l.work_title, l.product_id));
    bySales("SELECT id, title FROM products WHERE title IS NOT NULL").forEach(p => { if (!byTitle.has(String(p.title).trim().toLowerCase())) addTitle(p.title, p.id); });
    return row => {
      const w = row.workId || wid(row.workUrl);
      if (w && byWork.get(w)) return { productId: byWork.get(w), by: 'work id' };
      const k = String(row.title || '').trim().toLowerCase();
      if (k && !ambiguous.has(k) && byTitle.has(k)) return { productId: byTitle.get(k), by: 'title' };
      return { productId: null, by: null };
    };
  }

  const insert = () => db.prepare(`INSERT INTO sales(listing_id, external_order_id, transaction_id, store_id, product_id, external_listing_id, quantity, gross_cents, etsy_fees_cents, processing_fee_cents, net_cents, cogs_cents, fee_source, source, channel, ts)
    VALUES(NULL,?,?,NULL,?,?,?,?,0,0,?,NULL,'redbubble_margin','redbubble','redbubble',?) ON CONFLICT DO NOTHING`);

  function store(rows, { actor }) {
    const match = matcher(); const ins = insert();
    const seen = new Map();
    const out = { imported: 0, duplicates: 0, matched: 0, unmatched: 0, totalCents: 0, byProduct: {} };
    for (const r of rows) {
      const base = r.orderId || `rbh:${crypto.createHash('sha1').update([r.date, r.title || '', r.productType || '', r.marginCents, r.quantity].join('|')).digest('hex').slice(0, 16)}`;
      const n = (seen.get(base) || 0) + 1; seen.set(base, n);
      const m = match(r);
      tx(db, () => {
        const res = ins.run(base, String(n), m.productId, r.workId || wid(r.workUrl), r.quantity, r.marginCents, r.marginCents, `${r.date}T12:00:00.000Z`);
        if (res.changes === 0) { out.duplicates++; return; }
        out.imported++; out.totalCents += r.marginCents;
        if (m.productId) { out.matched++; out.byProduct[m.productId] = (out.byProduct[m.productId] || 0) + r.marginCents; } else out.unmatched++;
      });
    }
    for (const [pid, cents] of Object.entries(out.byProduct)) productEvent(db, Number(pid), { actor, note: `redbubble: ${cents >= 0 ? '+' : '-'}$${(Math.abs(cents) / 100).toFixed(2)} imported from sales history` });
    return out;
  }

  /** importCsv(text, {preview}) -> parse result + (when not preview) what was stored. Throws {status:400} for an unusable file. */
  function importCsv(text, { preview = false, actor = 'human' } = {}) {
    if (typeof text !== 'string' || !text.trim()) throw Object.assign(new Error('Send the CSV text as {"csv": "..."}'), { status: 400 });
    if (text.length > 900 * 1024) throw Object.assign(new Error('That file is too large for one upload (900 KB); split it by quarter'), { status: 413 });
    const parsed = parseReport(text);
    if (parsed.fatal) throw Object.assign(new Error(parsed.fatal), { status: 400, parsed });
    const match = matcher();
    const preRows = parsed.rows.map(r => ({ ...r, productId: match(r).productId }));
    const result = { ok: true, preview, assumedHeaders: true, headerMap: parsed.headerMap, unmatchedHeaders: parsed.unmatchedHeaders, parsed: parsed.rows.length, skipped: parsed.skipped, wouldMatch: preRows.filter(r => r.productId).length, wouldBeUnmatched: preRows.filter(r => !r.productId).length };
    if (preview) return { ...result, sample: preRows.slice(0, 5).map(r => ({ line: r.line, date: r.date, title: r.title, productType: r.productType, marginCents: r.marginCents, productId: r.productId })) };
    const s = store(parsed.rows, { actor });
    log.info(`[sales] redbubble csv import (by ${actor}): ${s.imported} new, ${s.duplicates} already known, ${s.unmatched} not matched to a product, ${parsed.skipped.length} skipped`);
    return { ...result, ...s };
  }

  /** One hand-entered line. {productId?, title?, date, marginCents, quantity?, orderId?} -> {id, ...}. */
  function addManual({ productId = null, title = null, date, marginCents, quantity = 1, orderId = null }, { actor = 'human' } = {}) {
    const bad = m => Object.assign(new Error(m), { status: 400 });
    const d = parseDate(date); if (!d) throw bad('date must look like 2026-10-06');
    if (!Number.isInteger(marginCents) || Math.abs(marginCents) > 10_000_000) throw bad('margin must be a dollar amount (negative for an adjustment)');
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) throw bad('quantity must be a whole number from 1 to 1000');
    let pid = null;
    if (productId !== null && productId !== undefined && productId !== '') {
      pid = Number(productId);
      if (!Number.isInteger(pid) || !db.prepare('SELECT 1 FROM products WHERE id = ?').get(pid)) throw Object.assign(new Error('Not found'), { status: 404 });
    } else if (title) pid = matcher()({ title }).productId;
    const oid = orderId ? String(orderId).slice(0, 80) : `rbm:${crypto.randomBytes(6).toString('hex')}`;
    const res = insert().run(oid, '1', pid, null, quantity, marginCents, marginCents, `${d}T12:00:00.000Z`);
    if (res.changes === 0) throw Object.assign(new Error(`Order ${oid} is already recorded`), { status: 409 });
    if (pid) productEvent(db, pid, { actor, note: `redbubble: ${marginCents >= 0 ? '+' : '-'}$${(Math.abs(marginCents) / 100).toFixed(2)} entered by hand` });
    return { ok: true, orderId: oid, productId: pid, marginCents, date: d };
  }

  return { importCsv, addManual, parseReport };
}

module.exports = { parseReport, parseCsv, parseMoney, parseDate, makeRedbubbleSales, ALIASES, FIELDS };
