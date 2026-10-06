'use strict';
/**
 * db.js — node:sqlite, additive migrations only. NEVER drop or reset tables.
 * Money is integer cents everywhere (columns end in _cents).
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS keys (
    name TEXT PRIMARY KEY,
    sealed TEXT NOT NULL,     -- crypto.seal() output; never plaintext
    fp TEXT, tail TEXT, added_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    name TEXT NOT NULL,
    oauth_sealed TEXT,        -- sealed JSON of OAuth tokens; never plaintext
    shop_id TEXT,
    autopublish INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stage TEXT NOT NULL DEFAULT 'idea',   -- written ONLY by domain/stages.js
    brief TEXT NOT NULL DEFAULT '',
    niche TEXT NOT NULL DEFAULT '',
    title TEXT,
    blueprint TEXT,
    print_provider_id TEXT,
    store_id INTEGER REFERENCES stores(id),
    list_price_cents INTEGER,
    shipping_cents INTEGER NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'USD',
    pod_base_cost_cents INTEGER,
    model_used TEXT,
    projected_margin_cents INTEGER,
    flags TEXT NOT NULL DEFAULT '[]',     -- JSON array of {code, detail}
    failed_reason TEXT,
    failed_from TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS products_stage ON products(stage);
  CREATE TABLE IF NOT EXISTS designs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id),
    image_path TEXT, image_url TEXT,
    prompt TEXT, width INTEGER, height INTEGER,
    cost_cents INTEGER NOT NULL DEFAULT 0,
    model TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mockups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id),
    url TEXT NOT NULL, placement TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id),
    external_id TEXT, platform TEXT NOT NULL,
    title TEXT, tags TEXT NOT NULL DEFAULT '[]', description TEXT,
    price_cents INTEGER, status TEXT, url TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER REFERENCES products(id),  -- NULL for system events
    kind TEXT NOT NULL DEFAULT 'stage',          -- stage | system
    stage_from TEXT, stage_to TEXT,
    actor TEXT NOT NULL, note TEXT, ts TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_product ON events(product_id);
  CREATE TABLE IF NOT EXISTS costs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER REFERENCES products(id),  -- NULL = not yet attributable
    kind TEXT NOT NULL CHECK (kind IN ('image','llm','pod','listing_fee','ad')),
    amount_cents INTEGER NOT NULL,
    note TEXT, ts TEXT NOT NULL,
    day TEXT NOT NULL                            -- America/New_York date, for the daily cap
  );
  CREATE INDEX IF NOT EXISTS costs_day ON costs(day);
  CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id INTEGER REFERENCES listings(id),
    external_order_id TEXT,
    gross_cents INTEGER NOT NULL,
    etsy_fees_cents INTEGER NOT NULL DEFAULT 0,
    processing_fee_cents INTEGER NOT NULL DEFAULT 0,
    net_cents INTEGER NOT NULL,   -- gross - etsy fees - processing; costs are subtracted at roll-up
    ts TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS blocklist (
    term TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'brand', added_at TEXT NOT NULL
  );
`;

/** Additive migration: a rerun is a no-op. */
function addColumn(db, table, column, ddl) {
  const have = db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
  if (!have) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

// Future additive migrations go here, wrapped in addColumn().
function migrate(_db) { /* none yet */ }

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Run fn inside one transaction; rolls back on throw. */
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch { /* already gone */ } throw e; }
}

module.exports = { openDb, tx, addColumn, SCHEMA };
