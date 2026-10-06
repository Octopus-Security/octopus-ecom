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
    kind TEXT NOT NULL DEFAULT 'stage',          -- stage | system | note
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
function migrate(db) {
  // M1
  addColumn(db, 'products', 'keywords', "TEXT NOT NULL DEFAULT '[]'");        // JSON array of operator keywords
  addColumn(db, 'designs', 'native_width', 'INTEGER');                          // size the model returned
  addColumn(db, 'designs', 'native_height', 'INTEGER');
  addColumn(db, 'designs', 'upscale_method', 'TEXT');                           // null = not upscaled; width/height are always the REAL stored size
  addColumn(db, 'listings', 'repairs', "TEXT NOT NULL DEFAULT '[]'");          // JSON: what enforceCopy changed
  addColumn(db, 'listings', 'model', 'TEXT');
  addColumn(db, 'listings', 'updated_at', 'TEXT');
  // M2
  addColumn(db, 'products', 'pod_external_id', 'TEXT');                         // Printify (or stub-) product id
  addColumn(db, 'products', 'pod_variant_ids', "TEXT NOT NULL DEFAULT '[]'");   // JSON: variants chosen in the composer
  addColumn(db, 'products', 'pod_cost_source', 'TEXT');                         // printify_product | catalog | estimate
  addColumn(db, 'products', 'print_spec', 'TEXT');                              // JSON: required print-area pixels per position (M4 reads it)
  addColumn(db, 'mockups', 'file', 'TEXT');                                     // local file under DATA_DIR/mockups (stub mockups); url is null then
  addColumn(db, 'mockups', 'is_default', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'mockups', 'variant_ids', "TEXT NOT NULL DEFAULT '[]'");
  // M3: Etsy connection, publish, sales ingest
  addColumn(db, 'stores', 'status', "TEXT NOT NULL DEFAULT 'disconnected'");   // connected | no_shop | disconnected
  addColumn(db, 'stores', 'status_detail', 'TEXT');                             // operator-facing message
  addColumn(db, 'stores', 'shop_name', 'TEXT');
  addColumn(db, 'stores', 'shop_url', 'TEXT');
  addColumn(db, 'stores', 'external_user_id', 'TEXT');
  addColumn(db, 'stores', 'token_expires_at', 'TEXT');                          // ISO; access token (about 1 h)
  addColumn(db, 'stores', 'refresh_expires_at', 'TEXT');                        // ISO; refresh token (about 90 days from the last refresh)
  addColumn(db, 'stores', 'connected_at', 'TEXT');
  addColumn(db, 'stores', 'sales_cursor', 'INTEGER');                           // newest receipt created_timestamp (epoch seconds) ingested
  addColumn(db, 'stores', 'last_sales_sync_at', 'TEXT');
  addColumn(db, 'listings', 'store_id', 'INTEGER');
  addColumn(db, 'listings', 'fee_recorded', 'INTEGER NOT NULL DEFAULT 0');      // the listing fee is charged to costs once
  addColumn(db, 'listings', 'views', 'INTEGER');
  addColumn(db, 'listings', 'checked_at', 'TEXT');
  addColumn(db, 'sales', 'transaction_id', 'TEXT');
  addColumn(db, 'sales', 'store_id', 'INTEGER');
  addColumn(db, 'sales', 'product_id', 'INTEGER');
  addColumn(db, 'sales', 'external_listing_id', 'TEXT');
  addColumn(db, 'sales', 'quantity', 'INTEGER NOT NULL DEFAULT 1');
  addColumn(db, 'sales', 'cogs_cents', 'INTEGER');                              // NULL = unknown (untracked listing)
  addColumn(db, 'sales', 'fee_source', 'TEXT');                                 // computed | payment_api+computed
  addColumn(db, 'sales', 'source', "TEXT NOT NULL DEFAULT 'etsy'");            // etsy | stub (simulated, never in real NET)
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS sales_order_tx ON sales(external_order_id, transaction_id) WHERE transaction_id IS NOT NULL');
  // M4: refunds (subtracted from the matching sale) and batches
  addColumn(db, 'sales', 'refund_cents', 'INTEGER NOT NULL DEFAULT 0');         // total refunded on this line; net_cents already has it subtracted
  db.exec(`CREATE TABLE IF NOT EXISTS refunds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    refund_key TEXT NOT NULL UNIQUE,         -- Etsy gives a refund no id: '<receipt>:<created_ts>:<amount>:<n-th identical>'
    external_order_id TEXT NOT NULL,         -- the receipt id
    store_id INTEGER,
    amount_cents INTEGER NOT NULL,           -- what Etsy reports
    applied_cents INTEGER NOT NULL,          -- what was subtracted from sales lines (never more than they grossed)
    reason TEXT, status TEXT,
    ts TEXT NOT NULL, created_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    niche TEXT NOT NULL, keywords TEXT NOT NULL DEFAULT '[]',
    requested_count INTEGER NOT NULL,
    blueprint TEXT, print_provider_id TEXT, variant_ids TEXT NOT NULL DEFAULT '[]',
    list_price_cents INTEGER, shipping_cents INTEGER NOT NULL DEFAULT 0, store_id INTEGER,
    status TEXT NOT NULL,                    -- ideating | running | paused_cap | done | cancelled | failed
    status_detail TEXT,
    concurrency INTEGER NOT NULL DEFAULT 1,
    ideation_model TEXT, ideation_cost_cents INTEGER NOT NULL DEFAULT 0, ideation_source TEXT,
    dropped_blocklist INTEGER NOT NULL DEFAULT 0, dropped_duplicate INTEGER NOT NULL DEFAULT 0,
    paused_day TEXT,                         -- ET day a spend-cap pause happened (auto-resume the next day)
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS batch_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL REFERENCES batches(id),
    idx INTEGER NOT NULL,
    concept TEXT NOT NULL,
    product_id INTEGER REFERENCES products(id),
    status TEXT NOT NULL,                    -- pending | running | interrupted | done | failed | cancelled
    step TEXT,                               -- the step running or last completed
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    qa_status TEXT,                          -- ran | skipped | error
    models TEXT NOT NULL DEFAULT '{}',       -- JSON {concept,image,copy,qa}
    cost_cents INTEGER NOT NULL DEFAULT 0,   -- generation spend attributed to the product
    outcome TEXT,                            -- the product's stage when the item ended
    updated_at TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS batch_items_batch ON batch_items(batch_id, status)');
  // Plan chat: conversations belong to the signed-in user (owner); someone else's id is a 404.
  db.exec(`CREATE TABLE IF NOT EXISTS plan_conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    tier TEXT NOT NULL DEFAULT 'standard',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS plan_conversations_owner ON plan_conversations(owner, updated_at)');
  db.exec(`CREATE TABLE IF NOT EXISTS plan_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES plan_conversations(id),
    role TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content TEXT NOT NULL,
    model TEXT, tier TEXT, funding TEXT,
    created_at TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS plan_messages_conv ON plan_messages(conversation_id, id)');
  db.exec(`CREATE TABLE IF NOT EXISTS oauth_pending (
    state TEXT PRIMARY KEY, verifier_sealed TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
  )`);
}

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
