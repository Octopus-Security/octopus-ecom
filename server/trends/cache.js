'use strict';
/** trends/cache.js — tiny TTL cache in the trend_cache table (survives restarts; a stale row is simply refetched). */
function makeCache(db, now = () => new Date()) {
  return {
    get(key, { allowStale = false } = {}) {
      const r = db.prepare('SELECT value, fetched_at, expires_at FROM trend_cache WHERE key = ?').get(key);
      if (!r) return null;
      const stale = Date.parse(r.expires_at) <= now().getTime();
      if (stale && !allowStale) return null;
      try { return { value: JSON.parse(r.value), fetchedAt: r.fetched_at, stale }; } catch { return null; }
    },
    set(key, value, ttlMs) {
      const t = now().getTime();
      db.prepare(`INSERT INTO trend_cache(key, value, fetched_at, expires_at) VALUES(?,?,?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, fetched_at=excluded.fetched_at, expires_at=excluded.expires_at`)
        .run(key, JSON.stringify(value), new Date(t).toISOString(), new Date(t + ttlMs).toISOString());
    },
  };
}
module.exports = { makeCache };
