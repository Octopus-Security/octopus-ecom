'use strict';
/**
 * adapters/trend/wikipedia.js — the WIKIPEDIA source: Wikimedia Pageviews, a proxy for ATTENTION to a topic (not purchase intent).
 *
 * GET https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/{project}/{access}/{agent}/{article}/{granularity}/{start}/{end}
 * verified 2026-10-06 - the spec (octopus-vault/memory/ecom-trend-sources.md 2.9) called it live that day (Halloween daily views
 * 2,604-2,704 in early September). No key. The access policy asks for a descriptive User-Agent with a contact and a sensible
 * request rate (corroborated, https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/documentation/access-policy.html;
 * page not read in this build). So: the User-Agent carries a contact taken from config (TREND_CONTACT / setting trend_contact)
 * and the source is DISABLED until a contact is set; requests are sequential and capped at 2/s.
 *
 * Series shape (daily items {timestamp:'YYYYMMDD00', views}) is read from the same spec call; it is the only thing parsed.
 * What is stored: numbers only (trends/metrics.js). The article NAME is the owner's choice (table trend_theme_articles) or a
 * labelled GUESS built from the theme text; it is never read from a response.
 *
 * Metrics per theme (spec 5.1), over complete days ending yesterday (ET):
 *   wp_level        mean daily views over the last 28 days
 *   wp_rise         log2((mean last 7d + 1) / (mean of the 28 days before those 7 + 1)); 0 and wp_low_volume=1 when wp_level < 200
 *   wp_season_ratio last-28d mean / the same 28 days one year earlier (> 1.3 reads as a seasonal ramp), only when last year has data
 * Cached per article per ET day, so a second run the same day makes no request.
 *
 * Read-only: DRY_RUN does not change it.
 */
const D = require('../../trends/dates');

const BASE = 'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article';
const LOW_VOLUME = 200;
const DAY_MS = 86400000;

const contactOf = ({ settings, env }) => String((settings && settings.get('trend_contact')) || (env && env.TREND_CONTACT) || '').trim();

/** "frog core" -> "Frog_core": a GUESS (first letter capitalised, spaces to underscores). The owner overrides it per theme. */
function guessArticle(theme) {
  const t = String(theme || '').trim().replace(/\s+/g, ' ');
  return t ? t[0].toUpperCase() + t.slice(1).replace(/ /g, '_') : '';
}
const stamp = (day) => day.replace(/-/g, '') + '00';
const dayOfStamp = (ts) => `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

/** Pure: daily series [{day, views}] + `end` (last complete day) -> metrics object. */
function computeMetrics(series, end) {
  const byDay = new Map(series.map(s => [s.day, s.views]));
  const range = (last, n) => Array.from({ length: n }, (_, i) => byDay.get(D.addDays(last, -i)) ?? 0);
  const last28 = range(end, 28); const last7 = last28.slice(0, 7);
  const prev28 = range(D.addDays(end, -7), 28);
  const level = mean(last28);
  const low = level < LOW_VOLUME;
  const out = { wp_level: level, wp_rise: low ? 0 : Math.log2((mean(last7) + 1) / (mean(prev28) + 1)), wp_low_volume: low ? 1 : 0 };
  const yearAgoEnd = D.addDays(end, -364);
  const ya = range(yearAgoEnd, 28);
  const haveYa = Array.from({ length: 28 }, (_, i) => byDay.has(D.addDays(yearAgoEnd, -i))).some(Boolean);
  if (haveYa && mean(ya) > 0) out.wp_season_ratio = level / mean(ya);
  return out;
}

function createWikipedia({ http, cache, db, settings, env = {}, now = () => new Date(), log = { info() {}, warn() {} } } = {}) {
  const contact = () => contactOf({ settings, env });
  const enabled = () => {
    if (settings && settings.get('trend_wikipedia_enabled') === 'false') return { enabled: false, reason: 'Turned off in settings.' };
    if (!contact()) return { enabled: false, reason: 'No contact set. Wikimedia asks for a descriptive User-Agent with a contact: set TREND_CONTACT (an address or URL) first.' };
    return { enabled: true, reason: '' };
  };
  const userAgent = () => `octopus-ecom/0.1 (trend research, low volume, sequential requests; contact: ${contact()})`;

  /** articleFor(theme) -> {article, guess:boolean}. Owner mapping wins; otherwise a labelled guess. */
  function articleFor(theme) {
    const row = db.prepare('SELECT article FROM trend_theme_articles WHERE theme = ?').get(theme);
    if (row) return { article: row.article, guess: false };
    return { article: guessArticle(theme), guess: true };
  }

  async function fetchSeries(article, end) {
    const start = D.addDays(end, -364 - 28);
    const url = `${BASE}/en.wikipedia/all-access/user/${encodeURIComponent(article.replace(/ /g, '_'))}/daily/${stamp(start)}/${stamp(end)}`;
    const res = await http.request(url, { headers: { 'User-Agent': userAgent(), Accept: 'application/json' }, ratePerSec: 2 });
    const j = res.json();
    if (!j || !Array.isArray(j.items)) throw new Error('Pageviews returned no items list');
    return j.items.filter(i => i && typeof i.timestamp === 'string' && Number.isFinite(i.views)).map(i => ({ day: dayOfStamp(i.timestamp), views: i.views }));
  }

  /**
   * collect({themes:[theme], week}) -> {status, detail, rows:[metric rows (not yet validated)], perTheme:[{theme, article, guess, state}]}
   * `rows` are handed to storeMetrics() by the caller, which validates them.
   */
  async function collect({ themes, week }) {
    const en = enabled();
    if (!en.enabled) return { source: 'wikipedia', status: 'disabled', detail: en.reason, rows: [], perTheme: [] };
    const today = D.etDay(now()); const end = D.addDays(today, -1);
    const rows = []; const perTheme = []; let errors = 0; let cached = 0;
    for (const theme of themes) {
      const { article, guess } = articleFor(theme);
      if (!article) { perTheme.push({ theme, article: '', guess, state: 'no_article' }); continue; }
      const key = `wp:${article}:${today}`;
      let metrics; const hit = cache.get(key);
      if (hit) { metrics = hit.value; cached++; }
      else {
        try { metrics = computeMetrics(await fetchSeries(article, end), end); cache.set(key, metrics, DAY_MS); }
        catch (e) {
          if (e && e.status === 404) { perTheme.push({ theme, article, guess, state: 'no_article' }); continue; }
          errors++; perTheme.push({ theme, article, guess, state: 'error', error: String(e.message).slice(0, 160) }); log.warn(`[trend] pageviews for "${article}" failed: ${e.message}`); continue;
        }
      }
      perTheme.push({ theme, article, guess, state: 'ok', cached: Boolean(hit) });
      for (const [metric, value] of Object.entries(metrics)) rows.push({ term: theme, source: 'wikipedia', metric, value, week });
    }
    const ok = perTheme.filter(p => p.state === 'ok').length;
    const status = ok ? 'ok' : errors ? 'error' : 'no_data';
    const guesses = perTheme.filter(p => p.state === 'ok' && p.guess).length;
    return { source: 'wikipedia', status, rows, perTheme, detail: `${ok}/${themes.length} theme(s) read${cached ? `, ${cached} from today's cache` : ''}${guesses ? `, ${guesses} on an automatic article GUESS` : ''}${errors ? `, ${errors} error(s)` : ''}` };
  }

  return {
    kind: 'trend', name: 'wikipedia',
    describe: () => 'Wikipedia pageviews: attention to a topic (a proxy, not purchase intent). Needs a contact for the User-Agent.',
    enabled, collect, articleFor, userAgent,
    /** Network-free: reads stored metrics. */
    async check(entry) {
      const m = (name) => { const r = db.prepare("SELECT value FROM trend_metrics WHERE term = ? AND source = 'wikipedia' AND metric = ? ORDER BY week DESC, id DESC LIMIT 1").get(entry.term, name); return r ? r.value : null; };
      const level = m('wp_level'); const rise = m('wp_rise');
      if (level === null || m('wp_low_volume') === 1) return [];
      if (rise !== null && rise >= 0.5) return [{ severity: 'info', message: `Wikipedia attention rising: ${Math.round(level)} views/day, ${rise.toFixed(1)} doublings week-on-week (attention, not sales).` }];
      return [];
    },
  };
}

module.exports = { createWikipedia, computeMetrics, guessArticle, LOW_VOLUME };
