'use strict';
/**
 * trends/manual.js — signals a PERSON checked by hand each week (Pinterest Trends website, a Redbubble look at "trending",
 * Amazon Merch, the Google Trends website). Nothing is fetched: the owner types what they saw. Every entry is dated (the ET day
 * they looked, never in the future) and carries the label "manual" wherever it is shown. The note is the owner's own words;
 * pasting competitor titles, links or shop names is not what this is for, and a link is rejected.
 */
const D = require('./dates');

const SOURCES = ['pinterest-trends', 'google-trends', 'redbubble', 'amazon-merch', 'etsy-trends', 'other'];
const DIRECTIONS = ['rising', 'flat', 'falling'];
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

function makeManual({ db, now = () => new Date() }) {
  const shape = (r) => ({ id: r.id, source: r.source, term: r.term, direction: r.direction, growthPct: r.growth_pct, note: r.note, observedOn: r.observed_on, createdAt: r.created_at, label: 'manual' });
  return {
    SOURCES, DIRECTIONS,
    add(b = {}) {
      const today = D.etDay(now());
      const source = String(b.source || 'other');
      if (!SOURCES.includes(source)) throw bad(`source must be one of ${SOURCES.join(', ')}`);
      const term = String(b.term || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (!term || term.length > 120) throw bad('term is required (<=120 chars)');
      const direction = b.direction === undefined ? 'rising' : String(b.direction);
      if (!DIRECTIONS.includes(direction)) throw bad(`direction must be one of ${DIRECTIONS.join(', ')}`);
      let growth = null;
      if (b.growthPct !== undefined && b.growthPct !== null && b.growthPct !== '') { growth = Number(b.growthPct); if (!Number.isFinite(growth) || Math.abs(growth) > 100000) throw bad('growthPct must be a number'); }
      const note = b.note === undefined ? '' : String(b.note);
      if (note.length > 500) throw bad('note must be <=500 chars');
      if (/https?:\/\/|www\./i.test(note)) throw bad('note must be your own words, not a link');
      const observedOn = b.observedOn === undefined || b.observedOn === '' ? today : String(b.observedOn);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(observedOn) || Number.isNaN(Date.parse(observedOn))) throw bad('observedOn must be YYYY-MM-DD');
      if (observedOn > today) throw bad('observedOn cannot be in the future (ET)');
      const id = Number(db.prepare('INSERT INTO trend_manual(source, term, direction, growth_pct, note, observed_on, created_at) VALUES(?,?,?,?,?,?,?)')
        .run(source, term, direction, growth, note, observedOn, now().toISOString()).lastInsertRowid);
      return shape(db.prepare('SELECT * FROM trend_manual WHERE id = ?').get(id));
    },
    list(limit = 100) { return db.prepare('SELECT * FROM trend_manual ORDER BY observed_on DESC, id DESC LIMIT ?').all(Math.min(Math.max(limit | 0, 1), 500)).map(shape); },
    remove(id) { return db.prepare('DELETE FROM trend_manual WHERE id = ?').run(Number(id)).changes > 0; },
    /** Entries for terms containing `theme`, seen within `days`. */
    recentFor(theme, today, days = 21) {
      const since = D.addDays(today, -days);
      return db.prepare('SELECT * FROM trend_manual WHERE observed_on >= ? ORDER BY observed_on DESC, id DESC').all(since).filter(r => r.term.includes(theme)).map(shape);
    },
  };
}
module.exports = { makeManual, SOURCES, DIRECTIONS };
