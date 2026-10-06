'use strict';
/**
 * build.js — /api/build stamp, derived from the shipped files (never a pasted
 * constant). Walks server/ and client/dist; falls back to 'unknown', which is
 * deliberately not hash-shaped ("unknown is never current").
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIRS = ['server', 'client/dist'];
const SKIP = new Set(['node_modules', '.git', 'data']);

function walk(dir, prefix, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = `${prefix}/${e.name}`;
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(path.join(dir, e.name), rel, out); }
    else out.push(rel);
  }
}

function computeBuild() {
  try {
    const files = [];
    for (const d of DIRS) walk(path.join(ROOT, d), d, files);
    if (!files.length) return 'unknown';
    const h = crypto.createHash('sha256');
    for (const f of files) {
      try { const src = fs.readFileSync(path.join(ROOT, f)); h.update(f); h.update(src); } catch { /* skip */ }
    }
    return h.digest('hex').slice(0, 12);
  } catch { return 'unknown'; }
}

module.exports = { BUILD: computeBuild(), STARTED_AT: new Date().toISOString(), computeBuild };
