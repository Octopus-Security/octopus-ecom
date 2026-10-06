'use strict';
/** settings.js — small key/value table; seeded from env once (INSERT OR IGNORE). */
function makeSettings(db) {
  const get = (key, fallback = null) => {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return r ? r.value : fallback;
  };
  const set = (key, value) => {
    db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
      .run(key, String(value), new Date().toISOString());
  };
  const seed = (key, value) => {
    db.prepare('INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES(?,?,?)').run(key, String(value), new Date().toISOString());
  };
  return {
    get, set, seed,
    getInt: (key, fb) => { const n = parseInt(get(key), 10); return Number.isFinite(n) ? n : fb; },
    getBool: (key, fb) => { const v = get(key); return v === null ? fb : v === 'true'; },
  };
}
function seedSettings(settings, cfg) {
  settings.seed('dry_run', cfg.seed.dryRun);
  settings.seed('daily_spend_cap_cents', cfg.seed.dailySpendCapCents);
  settings.seed('margin_floor_cents', cfg.seed.marginFloorCents);
}
module.exports = { makeSettings, seedSettings };
