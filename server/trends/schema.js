'use strict';
/**
 * trends/schema.js — additive tables for trend sources and the opportunity score. CREATE ... IF NOT EXISTS only;
 * nothing is dropped, altered or reset, so a rerun is a no-op. Numbers only in trend_metrics (see metrics.js).
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS trend_cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,                       -- JSON
    fetched_at TEXT NOT NULL, expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS trend_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,                      -- season | wikipedia | etsy-market | csv | manual | score
    status TEXT NOT NULL,                      -- ok | disabled | no_data | error
    detail TEXT,
    week TEXT NOT NULL,                        -- ISO week in ET, e.g. 2026-W41
    trigger TEXT NOT NULL DEFAULT 'manual',    -- manual | schedule | import
    started_at TEXT NOT NULL, finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS trend_runs_source ON trend_runs(source, id);
  CREATE TABLE IF NOT EXISTS trend_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    term TEXT NOT NULL,                        -- a phrase WE supplied (watchlist / owner file), never text from a response body
    source TEXT NOT NULL,                      -- wikipedia | etsy-market | csv
    label TEXT NOT NULL DEFAULT '',            -- csv: the tool the owner exported from
    metric TEXT NOT NULL,                      -- closed whitelist, see trends/metrics.js
    value REAL NOT NULL,                       -- numbers only
    n INTEGER,                                 -- sample size the value was derived from (aggregates need >= 20)
    week TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS trend_metrics_key ON trend_metrics(term, source, label, metric, week);
  CREATE INDEX IF NOT EXISTS trend_metrics_term ON trend_metrics(term, metric);
  CREATE TABLE IF NOT EXISTS trend_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    theme TEXT NOT NULL, product_type TEXT NOT NULL,
    week TEXT NOT NULL,
    score REAL NOT NULL,
    confidence REAL NOT NULL,
    blocked INTEGER NOT NULL DEFAULT 0,
    parts_json TEXT NOT NULL,
    computed_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS trend_scores_key ON trend_scores(theme, product_type, week);
  CREATE TABLE IF NOT EXISTS trend_manual (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,                      -- pinterest-trends | redbubble | amazon-merch | google-trends | other (owner-typed label)
    term TEXT NOT NULL,
    direction TEXT NOT NULL DEFAULT 'rising' CHECK (direction IN ('rising','flat','falling')),
    growth_pct REAL,                           -- optional, as read off the site by a person
    note TEXT NOT NULL DEFAULT '',             -- the owner's own words, never pasted competitor listings
    observed_on TEXT NOT NULL,                 -- ET date the person looked
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS trend_manual_term ON trend_manual(term, observed_on);
  CREATE TABLE IF NOT EXISTS trend_theme_articles (
    theme TEXT PRIMARY KEY,
    article TEXT NOT NULL,                     -- Wikipedia article title chosen by the owner
    updated_at TEXT NOT NULL
  );
`;

function ensureTrendSchema(db) { db.exec(SCHEMA); return db; }
module.exports = { ensureTrendSchema, SCHEMA };
