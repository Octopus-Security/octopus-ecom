'use strict';
/** watch/alerts.js — the alerts store. At most one UNACKNOWLEDGED alert per dedupe_key. */
const SEVERITIES = ['info', 'warn', 'critical'];
const now = () => new Date().toISOString();

function makeAlerts(db) {
  /** Returns the new alert id, or null if an open alert with the same dedupe_key already exists. */
  function raise({ kind, productId = null, severity = 'info', message, playbookId = null, dedupeKey = null }) {
    if (!kind || !message) throw new Error('alert needs kind and message');
    if (!SEVERITIES.includes(severity)) throw new Error(`severity must be one of ${SEVERITIES.join(', ')}`);
    if (dedupeKey && db.prepare('SELECT 1 FROM alerts WHERE dedupe_key = ? AND acknowledged = 0').get(dedupeKey)) return null;
    const r = db.prepare('INSERT INTO alerts(kind, product_id, severity, message, playbook_id, dedupe_key, created) VALUES(?,?,?,?,?,?,?)')
      .run(kind, productId, severity, String(message).slice(0, 1000), playbookId, dedupeKey, now());
    return Number(r.lastInsertRowid);
  }
  const shape = r => ({ id: r.id, kind: r.kind, productId: r.product_id, severity: r.severity, message: r.message, playbookId: r.playbook_id, created: r.created, acknowledged: !!r.acknowledged, acknowledgedAt: r.acknowledged_at });
  function list({ includeAcknowledged = false, limit = 200 } = {}) {
    const rows = db.prepare(`SELECT * FROM alerts ${includeAcknowledged ? '' : 'WHERE acknowledged = 0'} ORDER BY id DESC LIMIT ?`).all(Math.min(Math.max(limit | 0, 1), 1000));
    return rows.map(shape);
  }
  function counts() {
    const rows = db.prepare('SELECT severity, COUNT(*) AS n FROM alerts WHERE acknowledged = 0 GROUP BY severity').all();
    const by = Object.fromEntries(SEVERITIES.map(s => [s, 0]));
    for (const r of rows) by[r.severity] = r.n;
    return { open: by.info + by.warn + by.critical, bySeverity: by };
  }
  function acknowledge(id) {
    const r = db.prepare('UPDATE alerts SET acknowledged = 1, acknowledged_at = ? WHERE id = ? AND acknowledged = 0').run(now(), id);
    return r.changes > 0;
  }
  function acknowledgeAll() { return Number(db.prepare('UPDATE alerts SET acknowledged = 1, acknowledged_at = ? WHERE acknowledged = 0').run(now()).changes); }
  return { raise, list, counts, acknowledge, acknowledgeAll };
}
module.exports = { makeAlerts, SEVERITIES };
