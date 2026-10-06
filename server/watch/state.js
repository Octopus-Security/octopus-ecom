'use strict';
/** watch/state.js — last-seen snapshots (JSON) so watchers can tell what CHANGED. */
function makeState(db) {
  return {
    get(key) { const r = db.prepare('SELECT value FROM watch_state WHERE key = ?').get(key); if (!r) return null; try { return JSON.parse(r.value); } catch { return null; } },
    set(key, value) {
      db.prepare(`INSERT INTO watch_state(key,value,updated_at) VALUES(?,?,?)
                  ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(key, JSON.stringify(value), new Date().toISOString());
    },
  };
}
module.exports = { makeState };
