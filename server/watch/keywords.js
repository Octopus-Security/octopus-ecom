'use strict';
/**
 * watch/keywords.js — keyword/theme watchlist run. Asks the TrendSource about each active entry
 * (manual source: nothing) and checks our own terms against the trademark blocklist table.
 */
const { validateSignals } = require('./trend');

async function runKeywordWatch({ db, alerts, trendSource, log }) {
  const entries = db.prepare('SELECT * FROM watchlist WHERE active = 1').all();
  const blocked = db.prepare('SELECT term FROM blocklist').all().map(r => r.term);
  let signals = 0, hits = 0, errors = 0;
  for (const e of entries) {
    const hay = ` ${e.term.toLowerCase().replace(/[^a-z0-9\-\s]/g, ' ')} `;
    for (const t of blocked.filter(t => hay.includes(` ${t} `))) {
      hits++;
      alerts.raise({ kind: 'watchlist_blocklist', severity: 'warn', playbookId: 'launch-pod-etsy', dedupeKey: `watchlist_blocklist.${e.id}.${t}`,
        message: `Watchlist ${e.kind} "${e.term}" contains blocklisted term "${t}". Do not design or list around a brand/franchise.` });
    }
    try {
      for (const s of validateSignals(await trendSource.check({ kind: e.kind, term: e.term, notes: e.notes }))) {
        signals++;
        alerts.raise({ kind: 'trend_signal', severity: s.severity, message: `${e.term}: ${s.message}`, dedupeKey: `trend.${e.id}.${s.message}` });
      }
    } catch (err) { errors++; log.warn(`[watch] trend source failed for "${e.term}": ${err.message}`); }
  }
  return `${entries.length} watchlist entr${entries.length === 1 ? 'y' : 'ies'} [source: ${trendSource.name}]; signals ${signals}, blocklist hits ${hits}, errors ${errors}`;
}
module.exports = { runKeywordWatch };
