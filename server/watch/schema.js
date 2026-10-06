'use strict';
/**
 * watch/schema.js — additive tables for the watchers. CREATE TABLE IF NOT EXISTS only;
 * never drops or resets anything. Money (if any) is integer cents.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS watchlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL DEFAULT 'keyword' CHECK (kind IN ('keyword','theme')),
    term TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',          -- operator's own notes; never scraped data
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS watchlist_term ON watchlist(kind, term);
  CREATE TABLE IF NOT EXISTS watch_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    watcher TEXT NOT NULL,
    trigger TEXT NOT NULL DEFAULT 'schedule',  -- schedule | manual
    status TEXT NOT NULL DEFAULT 'running',    -- running | ok | error
    started_at TEXT NOT NULL, finished_at TEXT,
    summary TEXT, error TEXT
  );
  CREATE INDEX IF NOT EXISTS watch_runs_started ON watch_runs(started_at);
  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    product_id INTEGER,                        -- nullable: some alerts are not about one product
    severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warn','critical')),
    message TEXT NOT NULL,
    playbook_id TEXT,
    dedupe_key TEXT,                           -- one unacknowledged alert per key
    created TEXT NOT NULL,
    acknowledged INTEGER NOT NULL DEFAULT 0,
    acknowledged_at TEXT
  );
  CREATE INDEX IF NOT EXISTS alerts_open ON alerts(acknowledged, created);
  CREATE TABLE IF NOT EXISTS watch_state (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
  );
`;

function ensureWatchSchema(db) { db.exec(SCHEMA); return db; }

module.exports = { ensureWatchSchema, SCHEMA };
