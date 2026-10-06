'use strict';
/** events.js — system (non-stage) events, e.g. DRY_RUN disarmed. Stage events live in domain/stages.js. */
function systemEvent(db, { actor, note }) {
  db.prepare("INSERT INTO events(product_id, kind, actor, note, ts) VALUES(NULL,'system',?,?,?)").run(actor, note, new Date().toISOString());
}
module.exports = { systemEvent };
