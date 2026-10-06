'use strict';
/** events.js — non-stage events. System events have no product; note events belong to one. Stage events live in domain/stages.js. */
function systemEvent(db, { actor, note }) {
  db.prepare("INSERT INTO events(product_id, kind, actor, note, ts) VALUES(NULL,'system',?,?,?)").run(actor, note, new Date().toISOString());
}
/** A note on a product's timeline that is not a stage change (e.g. "design regenerated"). Never touches products.stage. */
function productEvent(db, productId, { actor, note }) {
  db.prepare("INSERT INTO events(product_id, kind, actor, note, ts) VALUES(?,'note',?,?,?)").run(productId, actor, note, new Date().toISOString());
}
module.exports = { systemEvent, productEvent };
