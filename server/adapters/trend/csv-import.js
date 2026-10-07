'use strict';
/**
 * adapters/trend/csv-import.js — the CSV source: a HUMAN-exported keyword list from a licensed tool (eRank, Alura, EverBee,
 * Terapeak) or typed by hand. Nothing is fetched, no tool is automated or logged into; a person exports a file and drops it here.
 *
 * ASSUMED HEADERS. None of these tools' export layouts was found in any source read for the spec
 * (octopus-vault/memory/ecom-trend-sources.md 2.10: eRank/EverBee export "assumed", Alura keyword CSV export corroborated by search
 * summaries only). So the parser matches headers by ALIAS, case/space/punctuation-insensitive, reports exactly which header it
 * mapped to which field and which it ignored, and the fixture is named test/fixtures/trend-keywords-ASSUMED-HEADERS.csv. If a real
 * export differs, add its header to ALIASES: that one line is the whole fix.
 *
 * KEYWORD-LEVEL METRICS ONLY. From each row we keep the keyword phrase and up to five numbers (volume estimate, competition
 * estimate, trend %, sold estimate, average price in cents). Every other column - listing titles, shop names, URLs, tags, ids -
 * is ignored and never stored; ignored headers are listed in the preview so that is visible. The numbers are the TOOL'S models,
 * not Etsy data (Alura says its sales and revenue figures are estimates: https://alura.io/help-center/about-our-sales-and-revenue-estimates,
 * corroborated, page not read), and they are labelled "csv" with the tool name everywhere they appear.
 *
 * PREVIEW BEFORE SAVE. preview() reads and reports; import() refuses unless it is given the previewHash that preview()
 * returned for the SAME tool and text, so a file cannot be saved unseen.
 */
const crypto = require('node:crypto');
const { parseCsv, parseMoney } = require('../../channels/redbubble-sales');
const { storeMetrics } = require('../../trends/metrics');
const D = require('../../trends/dates');

const TOOLS = ['erank', 'alura', 'everbee', 'terapeak', 'other'];
const MAX_ROWS = 5000;
const FIELDS = ['keyword', 'volume', 'competition', 'trend', 'sold', 'price'];
const METRIC_OF = { volume: 'csv_volume_est', competition: 'csv_competition_est', trend: 'csv_trend_pct', sold: 'csv_sold_est', price: 'csv_price_avg' };
const ALIASES = {
  keyword: ['keyword', 'keywords', 'searchterm', 'searchterms', 'term', 'query', 'phrase', 'keywordphrase', 'searchkeyword', 'tag'],
  volume: ['searchvolume', 'volume', 'monthlysearches', 'monthlysearchvolume', 'avgmonthlysearches', 'searches', 'estsearches', 'estimatedsearches', 'etsysearches', 'etsysearchvolume'],
  competition: ['competition', 'totallistings', 'listings', 'etsycompetition', 'competinglistings', 'competingproducts', 'competitionscore', 'numberoflistings'],
  trend: ['trend', 'change', 'growth', 'yoy', 'searchtrend', 'trendpct', 'momchange', 'monthlychange'],
  sold: ['sold', 'solditems', 'estsales', 'estimatedsales', 'totalsold', 'itemssold'],
  price: ['avgprice', 'averageprice', 'avgsoldprice', 'averagesoldprice', 'price', 'medianprice'],
};
const norm = (h) => String(h || '').toLowerCase().replace(/^﻿/, '').replace(/[^a-z0-9]/g, '');

/** "1,234", "12.5K", "1.2M", "45%", "+3.5 %" -> number; null when it is not a number ("High", "-", "N/A"). */
function parseNum(raw) {
  let s = String(raw === undefined || raw === null ? '' : raw).trim().replace(/\s/g, '');
  if (!s || /^(-|n\/?a|null|none)$/i.test(s)) return null;
  s = s.replace(/%$/, '');
  let mult = 1; const suf = /([kKmM])$/.exec(s);
  if (suf) { mult = suf[1].toLowerCase() === 'k' ? 1e3 : 1e6; s = s.slice(0, -1); }
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s) * mult;
}
const cleanTerm = (raw) => {
  const t = String(raw || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t || t.length > 80 || t.split(' ').length > 10 || /https?:|www\.|@/.test(t)) return null;
  return t;
};

/** parse(text) -> {assumedHeaders, headerMap, unmatchedHeaders, rows:[{line, term, metrics}], skipped:[{line,reason}], fatal?} */
function parseKeywordCsv(text) {
  const { rows, lines } = parseCsv(text);
  const out = { assumedHeaders: true, headerMap: {}, unmatchedHeaders: [], rows: [], skipped: [] };
  if (rows.length < 2) { out.fatal = 'The file needs a header line and at least one data line.'; return out; }
  const head = rows[0].map(norm); const idx = {};
  for (const f of FIELDS) { const i = head.findIndex(h => ALIASES[f].includes(h)); if (i >= 0) { idx[f] = i; out.headerMap[f] = rows[0][i].trim(); } }
  const used = new Set(Object.values(idx));
  out.unmatchedHeaders = rows[0].map((h, i) => [h.trim(), i]).filter(([h, i]) => h && !used.has(i)).map(([h]) => h);
  if (idx.keyword === undefined) { out.fatal = `No keyword column found. Looked for: ${ALIASES.keyword.join(', ')}. Headers seen: ${rows[0].map(h => h.trim()).join(', ')}.`; return out; }
  if (Object.keys(idx).length < 2) { out.fatal = 'Only a keyword column was recognised: no metric column (volume, competition, trend, sold, price) matched, so there is nothing to import.'; return out; }
  const seen = new Set();
  for (let r = 1; r < rows.length; r++) {
    const line = lines[r]; const row = rows[r];
    if (out.rows.length + out.skipped.length >= MAX_ROWS) { out.skipped.push({ line, reason: `more than ${MAX_ROWS} rows: the rest was not read` }); break; }
    const term = cleanTerm(row[idx.keyword]);
    if (!term) { out.skipped.push({ line, reason: 'not a keyword phrase (empty, too long, or a link)' }); continue; }
    if (seen.has(term)) { out.skipped.push({ line, reason: `duplicate of "${term}" earlier in the file` }); continue; }
    const metrics = {};
    for (const f of ['volume', 'competition', 'trend', 'sold']) if (idx[f] !== undefined) { const n = parseNum(row[idx[f]]); if (n !== null) metrics[METRIC_OF[f]] = n; }
    if (idx.price !== undefined) { const m = parseMoney(row[idx.price]); if (m.cents !== null && (!m.currency || m.currency === 'USD')) metrics.csv_price_avg = m.cents; }
    if (!Object.keys(metrics).length) { out.skipped.push({ line, reason: 'no numeric value in any metric column' }); continue; }
    seen.add(term); out.rows.push({ line, term, metrics });
  }
  if (!out.rows.length) out.fatal = 'No usable rows. Every line was skipped; see the reasons.';
  return out;
}

function createCsvImport({ db, now = () => new Date() } = {}) {
  const hashOf = (tool, text) => crypto.createHash('sha256').update(`${tool}\n${text}`).digest('hex').slice(0, 24);
  const toolOf = (t) => { const v = String(t || 'other').toLowerCase(); if (!TOOLS.includes(v)) { const e = new Error(`tool must be one of ${TOOLS.join(', ')}`); e.status = 400; throw e; } return v; };
  const watchThemes = () => db.prepare("SELECT term FROM watchlist WHERE active = 1 AND kind = 'theme'").all().map(r => r.term);

  function preview(text, tool) {
    const t = toolOf(tool); const p = parseKeywordCsv(text);
    const themes = watchThemes();
    const matched = p.rows.filter(r => themes.some(th => r.term.includes(th))).length;
    return {
      tool: t, assumedHeaders: true, headerMap: p.headerMap, ignoredHeaders: p.unmatchedHeaders, fatal: p.fatal || null,
      rows: p.rows.length, matchedToWatchlistThemes: matched, skipped: p.skipped.slice(0, 50), skippedCount: p.skipped.length,
      sample: p.rows.slice(0, 10).map(r => ({ line: r.line, term: r.term, ...r.metrics })),
      previewHash: p.fatal ? null : hashOf(t, text),
      note: 'Estimates from the tool you exported from, not Etsy data. Only the keyword and these numbers are saved; every other column is ignored.',
    };
  }

  function importCsv(text, tool, previewHash) {
    const t = toolOf(tool);
    if (!previewHash || previewHash !== hashOf(t, text)) { const e = new Error('Preview this exact file first, then import with the previewHash it returned.'); e.status = 409; throw e; }
    const p = parseKeywordCsv(text);
    if (p.fatal) { const e = new Error(p.fatal); e.status = 400; throw e; }
    const week = D.isoWeek(D.etDay(now()));
    const rows = []; for (const r of p.rows) for (const [metric, value] of Object.entries(r.metrics)) rows.push({ term: r.term, source: 'csv', label: t, metric, value, week });
    const stored = storeMetrics(db, rows, { allowedTerms: new Set(p.rows.map(r => r.term)), now });
    const stamp = now().toISOString();
    db.prepare("INSERT INTO trend_runs(source, status, detail, week, trigger, started_at, finished_at) VALUES('csv','ok',?,?,'import',?,?)")
      .run(`${p.rows.length} keyword(s) from ${t}, ${stored} number(s) saved`, week, stamp, stamp);
    return { ok: true, tool: t, week, keywords: p.rows.length, numbersSaved: stored, skippedCount: p.skipped.length };
  }

  return { kind: 'trend', name: 'csv', describe: () => 'CSV import: a keyword export you download yourself from a licensed tool. Estimates, labelled by tool.', enabled: () => ({ enabled: true, reason: '' }), preview, importCsv, async check() { return []; } };
}

module.exports = { createCsvImport, parseKeywordCsv, parseNum, TOOLS, ALIASES, METRIC_OF };
