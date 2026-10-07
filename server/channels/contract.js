'use strict';
/**
 * channels/contract.js — what a sales channel is, as opposed to an adapter.
 *
 * An ADAPTER (server/adapters) is a narrow interface ecom calls through a real HTTP client. A CHANNEL is the operator-facing
 * idea of "a place this product is sold", and it states honestly how much of the work software can do:
 *
 *   capability 'api'    the marketplace has an API ecom is allowed to use: ecom publishes and reads sales itself
 *                       (Etsy, through the storefront adapter, still behind the approval gate and DRY_RUN)
 *   capability 'manual' no usable API, or the terms forbid automation: ecom PREPARES a pack and a checklist, a human
 *                       uploads, and ecom tracks state and imports sales from what the human brings back (Redbubble)
 *
 * A manual channel must NEVER log in, drive a browser, or scrape. See docs/CHANNELS.md before adding one.
 */
const CAPABILITIES = Object.freeze(['api', 'manual']);
/** Per-product listing state on a channel. Etsy's is derived from the product stage; manual channels store it. */
const STATES = Object.freeze(['not_listed', 'uploaded', 'live', 'removed']);

const REQUIRED = ['id', 'label', 'capability', 'automated', 'manual', 'playbooks'];

function assertChannel(ch) {
  const missing = REQUIRED.filter(k => ch[k] === undefined);
  if (missing.length) throw new Error(`channel ${ch.id || '?'} is missing: ${missing.join(', ')}`);
  if (!CAPABILITIES.includes(ch.capability)) throw new Error(`channel ${ch.id}: capability must be one of ${CAPABILITIES.join(', ')}`);
  if (ch.capability === 'manual') for (const m of ['prepare', 'importSales']) if (typeof ch[m] !== 'function') throw new Error(`manual channel ${ch.id} must implement ${m}()`);
  return ch;
}

module.exports = { CAPABILITIES, STATES, assertChannel };
