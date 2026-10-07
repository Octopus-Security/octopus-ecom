'use strict';
/**
 * trends/routes.js — createTrendsRouter(deps): mounted at /api/trends by app.js, AFTER the owner gate and the same-origin check,
 * so every route here is owner-only and every mutating route refuses a cross-origin request exactly like the rest of /api.
 */
const express = require('express');
const { ConfirmError } = require('../confirm');
const { CONFIRM_SUMMARY } = require('../adapters/trend/etsy-market');
const { guessArticle } = require('../adapters/trend/wikipedia');
const { TOOLS } = require('../adapters/trend/csv-import');
const { WEIGHTS } = require('./score');

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

function createTrendsRouter(deps) {
  const { trends, settings, confirm } = deps;
  const r = express.Router();
  r.use(express.json({ limit: '1mb' }));

  const settingsView = () => ({
    etsyMarketEnabled: settings.get('trend_etsy_market_enabled') === 'true',
    etsyMarketBlocked: settings.get('trend_etsy_market_blocked') || null,
    weeklyEnabled: settings.get('trend_weekly_enabled') === 'true',
    wikipediaEnabled: settings.get('trend_wikipedia_enabled') !== 'false',
    contactSet: Boolean(settings.get('trend_contact') || (deps.env && deps.env.TREND_CONTACT)),
    country: trends.season.country(),
    weights: WEIGHTS, weightsNote: 'Untested starting guesses; recalibrate after 8-12 weeks of results.',
    csvTools: TOOLS,
  });

  r.get('/report', wrap(async (_req, res) => res.json(trends.report())));
  r.get('/opportunities', wrap(async (req, res) => res.json(trends.opportunities({ limit: Number(req.query.limit) || 25 }))));
  r.get('/status', wrap(async (_req, res) => res.json({ settings: settingsView(), sources: trends.report().sources, running: trends.isRunning() })));

  // POST /api/trends/report/rebuild {collect?: boolean} — recompute the scores; with collect:true first read the ENABLED sources.
  r.post('/report/rebuild', wrap(async (req, res) => {
    const b = req.body || {};
    if (b.collect !== undefined && typeof b.collect !== 'boolean') throw bad('collect must be a boolean');
    const out = await trends.rebuild({ collect: b.collect === true, trigger: 'manual' });
    if (out.run && out.run.skipped) return res.status(409).json({ error: out.run.reason });
    res.json(out);
  }));

  // POST /api/trends/settings {weeklyEnabled?, wikipediaEnabled?, country?, contact?}
  r.post('/settings', wrap(async (req, res) => {
    const b = req.body || {};
    for (const k of ['weeklyEnabled', 'wikipediaEnabled']) if (b[k] !== undefined && typeof b[k] !== 'boolean') throw bad(`${k} must be a boolean`);
    if (b.country !== undefined && !/^[A-Za-z]{2}$/.test(String(b.country))) throw bad('country must be a two-letter code, e.g. US');
    if (b.contact !== undefined && (typeof b.contact !== 'string' || b.contact.length > 200)) throw bad('contact must be a string (<=200 chars): an address or a URL Wikimedia can reach you at');
    if (b.weeklyEnabled !== undefined) settings.set('trend_weekly_enabled', b.weeklyEnabled);
    if (b.wikipediaEnabled !== undefined) settings.set('trend_wikipedia_enabled', b.wikipediaEnabled);
    if (b.country !== undefined) settings.set('trend_country', String(b.country).toUpperCase());
    if (b.contact !== undefined) settings.set('trend_contact', b.contact.trim());
    res.json({ ok: true, settings: settingsView() });
  }));

  // POST /api/trends/etsy-market/enable {token?} — confirm-gated two-step. Disabling needs no confirmation.
  r.post('/etsy-market/enable', wrap(async (req, res) => {
    const gate = confirm.check({ action: 'trend.etsy_market.enable', subject: 'etsy-market', summary: CONFIRM_SUMMARY }, (req.body || {}).token);
    if (gate.needsConfirm) return res.json(gate);
    settings.set('trend_etsy_market_enabled', true);
    settings.set('trend_etsy_market_blocked', '');
    res.json({ ok: true, enabled: trends.etsyMarket.enabled(), settings: settingsView() });
  }));
  r.post('/etsy-market/disable', wrap(async (_req, res) => { settings.set('trend_etsy_market_enabled', false); res.json({ ok: true, enabled: trends.etsyMarket.enabled(), settings: settingsView() }); }));

  // Theme -> Wikipedia article. A theme with no owner mapping shows an automatic GUESS, clearly marked as one.
  r.get('/articles', wrap(async (_req, res) => {
    res.json({ articles: trends.themes().map(t => { const a = trends.wikipedia.articleFor(t); return { theme: t, article: a.article, guess: a.guess }; }), note: 'An article marked guess was built from the theme text. Set it yourself to remove the guess.' });
  }));
  r.put('/articles', wrap(async (req, res) => {
    const b = req.body || {}; const theme = String(b.theme || '').trim().toLowerCase(); const article = String(b.article || '').trim();
    if (!theme || theme.length > 120) throw bad('theme is required');
    if (!article || article.length > 200 || /[|<>#{}\[\]]/.test(article) || /^https?:/i.test(article)) throw bad('article must be a Wikipedia article title (not a link), <=200 chars');
    deps.db.prepare(`INSERT INTO trend_theme_articles(theme, article, updated_at) VALUES(?,?,?)
      ON CONFLICT(theme) DO UPDATE SET article=excluded.article, updated_at=excluded.updated_at`).run(theme, article, new Date().toISOString());
    res.json({ ok: true, theme, article, guess: false });
  }));
  r.delete('/articles', wrap(async (req, res) => {
    const theme = String((req.body || {}).theme || req.query.theme || '').trim().toLowerCase();
    const n = deps.db.prepare('DELETE FROM trend_theme_articles WHERE theme = ?').run(theme).changes;
    if (!n) return res.status(404).json({ error: 'No owner-set article for that theme' });
    res.json({ ok: true, theme, guess: true, article: guessArticle(theme) });
  }));

  // CSV: preview first (reads, saves nothing), then import with the previewHash it returned.
  r.post('/csv/preview', wrap(async (req, res) => {
    const b = req.body || {};
    if (typeof b.csv !== 'string' || !b.csv.trim()) throw bad('csv text is required');
    res.json(trends.csv.preview(b.csv, b.tool));
  }));
  r.post('/csv/import', wrap(async (req, res) => {
    const b = req.body || {};
    if (typeof b.csv !== 'string' || !b.csv.trim()) throw bad('csv text is required');
    res.json(trends.csv.importCsv(b.csv, b.tool, b.previewHash));
  }));

  r.get('/manual', wrap(async (_req, res) => res.json({ entries: trends.manual.list(), sources: trends.manual.SOURCES, note: 'Entered by hand and labelled manual. Nothing here is fetched.' })));
  r.post('/manual', wrap(async (req, res) => res.status(201).json({ entry: trends.manual.add(req.body || {}) })));
  r.delete('/manual/:id', wrap(async (req, res) => {
    if (!trends.manual.remove(req.params.id)) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  }));

  r.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  r.use((err, _req, res, _next) => {
    if (err instanceof ConfirmError) return res.status(409).json({ error: err.message, code: err.code });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
    (deps.log || console).error(`[trends] route failed: ${err.message}`);
    res.status(500).json({ error: 'Internal error' });
  });
  return r;
}
module.exports = { createTrendsRouter };
