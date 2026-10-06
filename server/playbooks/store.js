'use strict';
/** playbooks/store.js — tick state. product_id 0 is the global checklist. */
const { ensurePlaybookSchema } = require('./schema');

function makeTickStore(db) {
  ensurePlaybookSchema(db);
  return {
    get(playbookId, productId = 0) {
      const rows = db.prepare('SELECT step_id, checked FROM playbook_ticks WHERE playbook_id = ? AND product_id = ?').all(playbookId, productId);
      return Object.fromEntries(rows.map(r => [r.step_id, !!r.checked]));
    },
    set(playbookId, stepId, productId, checked) {
      db.prepare(`INSERT INTO playbook_ticks(playbook_id, step_id, product_id, checked, updated_at) VALUES(?,?,?,?,?)
                  ON CONFLICT(playbook_id, step_id, product_id) DO UPDATE SET checked=excluded.checked, updated_at=excluded.updated_at`)
        .run(playbookId, stepId, productId, checked ? 1 : 0, new Date().toISOString());
    },
    reset(playbookId, productId = 0) { return Number(db.prepare('DELETE FROM playbook_ticks WHERE playbook_id = ? AND product_id = ?').run(playbookId, productId).changes); },
  };
}
module.exports = { makeTickStore };
