'use strict';
/**
 * dryrun.js — the DRY_RUN switch (decision 5).
 * ON by default; stored in settings, seeded from env. Turning it ON needs no
 * confirm. Turning it OFF is confirm-gated AND needs the typed phrase:
 *   step 1  disarm({actor})                         -> {needsConfirm, token, summary}
 *   step 2  disarm({actor, token, phrase})          -> executes, records an event
 */
const { systemEvent } = require('./events');

const PHRASE = 'ARM LIVE WRITES';

class DryRunError extends Error {
  constructor(message) { super(message); this.name = 'DryRunError'; }
}

function makeDryRun({ db, settings, confirm }) {
  const isOn = () => settings.getBool('dry_run', true);
  return {
    PHRASE,
    isOn,
    enable({ actor }) {
      const was = isOn();
      settings.set('dry_run', true);
      if (!was) systemEvent(db, { actor, note: 'DRY_RUN turned ON' });
      return { dryRun: true };
    },
    disarm({ actor, token, phrase } = {}) {
      if (!isOn()) return { dryRun: false };
      if (!token) {
        return confirm.check({
          action: 'dryrun.disarm', subject: 'global',
          summary: 'Turn DRY_RUN OFF. From now on, product creation/publishing on Printify and listing writes on Etsy are REAL: '
            + 'they appear on the live shop and can cost real money (listing fees are charged per listing, and orders are real and not reversible by this app). '
            + `Type "${PHRASE}" to confirm.`,
        });
      }
      if (phrase !== PHRASE) throw new DryRunError(`Confirmation phrase must be exactly "${PHRASE}".`);
      confirm.check({ action: 'dryrun.disarm', subject: 'global' }, token);
      settings.set('dry_run', false);
      systemEvent(db, { actor, note: 'DRY_RUN turned OFF (live writes armed)' });
      return { dryRun: false };
    },
  };
}

module.exports = { makeDryRun, PHRASE, DryRunError };
