'use strict';
/** playbooks/schema.js — tick state for playbook checklists. product_id 0 = the global checklist. */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS playbook_ticks (
    playbook_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    product_id INTEGER NOT NULL DEFAULT 0,
    checked INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (playbook_id, step_id, product_id)
  );
`;
function ensurePlaybookSchema(db) { db.exec(SCHEMA); return db; }
module.exports = { ensurePlaybookSchema, SCHEMA };
