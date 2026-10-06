'use strict';
/**
 * playbooks/definitions.js — operator runbooks as data. docs/playbooks/*.md are RENDERED from this
 * file by render-md.js (a test fails if they drift), so edit here and run:
 *   node server/playbooks/render-md.js
 * Step: {id, title, detail?, check?}. `check` names a hook in checks.js that reads live state.
 *
 * Provenance rules (decision 15): a policy claim says `verified 2026-10-05 - <url>` ONLY if that page
 * was actually read; otherwise `assumed, unverified`. Etsy's own help/legal pages returned HTTP 403 to
 * the fetch tool on 2026-10-05, so Etsy claims are NOT marked verified; the third-party page that WAS
 * read is named as corroboration.
 */
const ETSY_POD = 'assumed, unverified (Etsy official pages returned HTTP 403 on 2026-10-05; corroborated by a third-party summary that was read: https://www.listadum.com/blog/understanding-etsys-rules-for-print-on-demand-sellers; official page to check: https://help.etsy.com/hc/en-us/articles/23948763872151)';
const FTC = 'verified 2026-10-05 - https://www.ftc.gov/business-guidance/resources/business-guide-ftcs-mail-internet-or-telephone-order-merchandise-rule';
const ETSY_IP = 'assumed, unverified (https://etsy.com/legal/ip/ returned HTTP 403 on 2026-10-05; only search-result summaries were seen)';

const PLAYBOOKS = [
  {
    id: 'launch-pod-etsy',
    title: 'Launch a new POD product on Etsy',
    whenToUse: 'A product is moving from idea to a live Etsy listing, using your own original design and a print-on-demand production partner.',
    background: `The pipeline already enforces the gates (human approval, margin floor, blocklist, print readiness). This list is the human side: what to look at before pressing approve.

- Own designs only. Do not use another seller's artwork, a "winning" listing as a reference image, or a brand, franchise, character or team. Trend data informs themes and keywords only.
- Etsy and production partners: using a print-on-demand partner for your own original designs is allowed provided the partner is disclosed as a production partner (${ETSY_POD}).
- Pushing to live is irreversible in the sense that matters (a listing fee is charged and the listing is public). Approving is a confirm-gated step in the panel.`,
    steps: [
      { id: 'original', title: 'Design is original, generated here, and not derived from anyone else\'s listing', detail: 'If you cannot say where every element came from, do not publish.' },
      { id: 'blocklist', title: 'No brand, franchise, character or team in brief, title or tags', check: 'blocklist_clean' },
      { id: 'pod', title: 'Blueprint and print provider chosen', check: 'has_pod_provider' },
      { id: 'design', title: 'Design exists and passed the print-readiness check', check: 'has_design' },
      { id: 'margin', title: 'Projected margin is positive and above the floor', detail: 'Remember the model leaves out offsite ads, currency conversion and listing renewals.', check: 'margin_above_floor' },
      { id: 'tags', title: 'Title <=140 chars, <=13 tags, each <=20 chars', check: 'etsy_tag_rules' },
      { id: 'flags', title: 'Product carries no flags', check: 'no_flags' },
      { id: 'disclose', title: 'Production partner is disclosed on the listing; you are listed as designer, the partner is not listed as the maker', detail: `Etsy: ${ETSY_POD}.` },
      { id: 'shipping', title: 'Processing and delivery times on the listing match what the provider actually quotes', detail: `Shipping-time claims need a reasonable basis (${FTC}).` },
      { id: 'mockups', title: 'Mockups show the real product and do not imply handmade-by-you if a partner makes it' },
      { id: 'dry', title: 'DRY_RUN state is what you intend', check: 'dry_run_state' },
      { id: 'approve', title: 'Approve (confirm modal), publish, then watch the first week of own-shop stats' },
    ],
  },
  {
    id: 'out-of-stock',
    title: 'Supplier or variant out of stock',
    whenToUse: 'The supplier watcher raised an "out of stock" alert, or an order was held because a variant is unavailable.',
    background: `A listing that keeps selling something you cannot fulfil leads to cancellations, late shipments and bad reviews. Under the FTC Mail Order Rule you need a reasonable basis for your shipping-time claims and must send a delay notice with a cancel-and-refund option when you cannot ship on time (${FTC}).

The watcher only reads. Nothing is changed on Etsy or at the provider automatically.`,
    steps: [
      { id: 'confirm', title: 'Confirm the outage at the provider\'s own catalogue, not just from the alert', detail: 'The alert reflects one read; stock can flip back.' },
      { id: 'scope', title: 'Which variants (sizes/colours) and which listings are affected?', check: 'no_open_alerts' },
      { id: 'pause', title: 'Deactivate or edit the affected variants on the listing (a human action in Etsy/Printify)', detail: 'This tool does not edit live listings from an alert.' },
      { id: 'orders', title: 'Open orders for the variant: tell the buyer promptly with a firm new date, or offer cancel and full refund', detail: `Do not make a buyer wait silently (${FTC}).` },
      { id: 'alt', title: 'Consider an alternative print provider for the same blueprint; re-check its base cost and margin', check: 'margin_above_floor' },
      { id: 'restock', title: 'When stock returns, re-enable variants and acknowledge the alert' },
    ],
  },
  {
    id: 'margin-fell',
    title: 'Base cost rose and margin fell below the floor',
    whenToUse: 'The supplier watcher flagged a product (margin <= 0 or below MARGIN_FLOOR). The flag blocks autopublish; a live listing keeps selling at the old price until you act.',
    background: `Projected margin = list price - POD base cost - listing fee - transaction fee - processing fee (see server/domain/fee-schedule.js; the rates come from Etsy's own fee page as read by the owner on 2026-10-06, and are editable in Settings). Raising price is a human decision; this tool never edits a live price.`,
    steps: [
      { id: 'see', title: 'Read the alert: old and new base cost, new projected margin', check: 'margin_above_floor' },
      { id: 'verify', title: 'Confirm the new cost at the provider (not a transient read)' },
      { id: 'options', title: 'Choose: raise the price, switch print provider, change blueprint, or retire the product', detail: 'Check that a higher price does not tank conversion: compare against your own listing stats only.' },
      { id: 'reprice', title: 'If repricing, edit the price on the listing yourself and update list_price in the panel; the margin recomputes on the next watch run' },
      { id: 'recheck', title: 'Run the supplier watch now and confirm the flag clears', check: 'no_flags' },
      { id: 'ack', title: 'Acknowledge the alert' },
    ],
  },
  {
    id: 'misprint-return-refund',
    title: 'Misprint, return or refund',
    whenToUse: 'A buyer reports a defective, misprinted, damaged, wrong or lost item, or asks for a return.',
    background: `Provider reprint/refund policies differ and time-limit claims; read the provider's current policy rather than relying on this list (assumed, unverified: no provider policy was read for this document). Refund timing for orders you cannot fulfil: a refund must be prompt, within seven working days for non-credit payments under the Mail Order Rule (${FTC}). Etsy's own case/dispute rules were not read (assumed, unverified).`,
    steps: [
      { id: 'evidence', title: 'Ask for a photo of the item and packaging; keep it with the order' },
      { id: 'classify', title: 'Classify: production fault (misprint/damage), carrier fault (lost/damaged in transit), or buyer preference' },
      { id: 'respond', title: 'Reply to the buyer quickly and plainly with the fix you are offering' },
      { id: 'provider', title: 'Production fault: open a reprint or refund claim with the print provider within their window; keep the order id and photos' },
      { id: 'refund', title: 'Refund the buyer yourself if the provider will not; record the cost as a cost row so NET stays honest' },
      { id: 'design', title: 'Misprints repeating? Re-check the design against the blueprint print area and DPI, and consider another provider', check: 'has_design' },
      { id: 'close', title: 'Note what happened; if one product keeps failing, archive it' },
    ],
  },
  {
    id: 'views-no-sales',
    title: 'Listing gets views but no sales',
    whenToUse: 'The performance watcher raised "views, no sales" (or a view drop) on one of your listings.',
    background: `Use only your own shop's stats (views, favorites, sales, search terms Etsy shows you). Do NOT look at competitors' listings, copy a winner's title or photos, or undercut prices based on scraped data: that is how shops get reported and closed, and this tool refuses to build it.`,
    steps: [
      { id: 'enough', title: 'Is it enough data? Fewer than ~100 views is mostly noise; wait' },
      { id: 'photos', title: 'Photos: is the first image clear at thumbnail size, on a realistic mockup, with the product obvious?' },
      { id: 'title', title: 'Title and tags: do the first words say what the item is in the words a buyer would type? Rewrite from your own watchlist keywords', check: 'etsy_tag_rules' },
      { id: 'price', title: 'Price and shipping: total price vs what the item plausibly costs; check margin before lowering anything', check: 'margin_above_floor' },
      { id: 'favs', title: 'Favorites without sales usually means interest but a blocker (price, shipping time, size/colour options, trust)' },
      { id: 'one', title: 'Change ONE thing, note it with the date, and wait a week before judging' },
      { id: 'retire', title: 'After two or three rounds with no sales, archive or retire the listing; do not keep paying renewal fees' },
    ],
  },
  {
    id: 'seasonal-prep',
    title: 'Seasonal and holiday prep (production cut-off dates)',
    whenToUse: 'A gift season is coming (you decide which) and listings need to be ready, with honest delivery estimates.',
    background: `Cut-off dates are not stated here: they change every year and per provider and carrier. Take them from the print provider's and the carrier's published schedules each season and write the date into the step notes (assumed, unverified: no schedule was read for this document). Delivery estimates you publish need a reasonable basis (${FTC}).`,
    steps: [
      { id: 'dates', title: 'Collect this year\'s provider production times and carrier last-order dates; write them down' },
      { id: 'backwards', title: 'Work back from the delivery date you want to promise: last order date = delivery date - transit - production - a buffer' },
      { id: 'launch', title: 'Launch seasonal listings well ahead of the season (rule of thumb, assumed, unverified: weeks, not days)' },
      { id: 'banner', title: 'Put the last-order date in the listing description and shop announcement' },
      { id: 'margin', title: 'Check margins: rush shipping and seasonal base-cost changes can erase them', check: 'margin_above_floor' },
      { id: 'watch', title: 'Make sure the supplier watch is running; stock-outs peak in season' },
      { id: 'after', title: 'After the cut-off, update delivery promises; after the season archive or de-list seasonal items' },
    ],
  },
  {
    id: 'ip-complaint',
    title: 'IP / trademark complaint received',
    whenToUse: 'Etsy (or a rights holder) notified you of an intellectual-property complaint, removed a listing, or sent a takedown.',
    background: `Policy here is simple: comply, do not argue a clone. Etsy's process, as seen in secondary sources, is a notice, removal, and for copyright a counter-notice path; repeat notices can end the shop (${ETSY_IP}). A counter-notice is a sworn legal statement: file one only for a genuine mistake (the design really is yours or licensed), and consider a lawyer. This is operational guidance, not legal advice.`,
    steps: [
      { id: 'read', title: 'Read the notice fully: who complained, which listing(s), what is claimed (copyright, trademark, design)' },
      { id: 'stop', title: 'Stop selling the item: take the listing down yourself and archive the product in the panel; do not relist a variation' },
      { id: 'scan', title: 'Check the rest of the catalogue for the same design, theme or term; the blocklist check helps but is not complete', check: 'blocklist_clean' },
      { id: 'blocklist', title: 'Add the offending brand/character/phrase to the blocklist so it cannot recur' },
      { id: 'origin', title: 'Work out how it got through: the brief, the generated design, the keywords, or the trend source. Fix the cause' },
      { id: 'respond', title: 'Reply to Etsy/the rights holder politely, confirming removal. Do not argue' },
      { id: 'counter', title: 'Only if you are certain the work is yours or licensed: consider a counter-notice (legal statement under penalty of perjury); take advice first' },
      { id: 'orders', title: 'Open orders for the item: handle per the misprint/refund playbook; do not ship infringing goods' },
    ],
  },
  {
    id: 'dropshipping',
    title: 'Dropshipping: what is allowed where',
    whenToUse: 'You are considering selling items you did not design or make, shipped directly from a third-party supplier. Read this BEFORE building or listing anything.',
    background: `## Policy landscape

| Where | Position | Provenance |
|---|---|---|
| **Etsy, your own designs on a print-on-demand partner** | Allowed, if you are the designer and the production partner is disclosed. | ${ETSY_POD} |
| **Etsy, generic manufactured goods you did not design (classic dropshipping, resold marketplace items)** | Not allowed. Summaries describe it as reselling mass-produced items you did not design, and say the partner cannot be listed as creator. | ${ETSY_POD} |
| **Etsy, items you sourced and sell as sourced/handpicked vintage or supplies** | Different rules apply to those categories; not researched here. | assumed, unverified |
| **Your own storefront (e.g. Shopify, WooCommerce) or other marketplaces** | Generally permitted by the platform, subject to each platform's own terms and any supplier brand-use rules; not researched here. | assumed, unverified |

**What this service does.** It is a POD pipeline for original designs and publishes to Etsy through a production partner. It does NOT implement classic dropshipping. Generic dropshipping is routed to a non-Etsy storefront as a **documented future option**: no Shopify, AliExpress or other dropship adapter is built, and none is planned until the owner asks. If it is ever built it would sit behind the same Storefront/PODProvider adapter contracts, DRY_RUN, approval gate and blocklist.

## Consumer-protection basics (any storefront)

- **You are the seller of record**, so the buyer's problems are yours even though a supplier ships the parcel. The FTC's Mail, Internet, or Telephone Order Merchandise Rule guide says the original seller remains legally responsible when dropshippers or fulfillment houses are used (${FTC}).
- **Shipping-time claims need a reasonable basis** when you make them, and with no stated time the default is 30 days from a properly completed order (${FTC}). Do not advertise "3-5 days" unless the supplier actually achieves it.
- **If you cannot ship on time** you must promptly notify the buyer with a revised date (or say it is uncertain) and offer the choice to cancel for a full, prompt refund; refunds on non-credit payments are due within seven working days (${FTC}).
- Other regimes (EU/UK withdrawal rights, VAT/customs, state sales tax, product-safety rules for children's goods and electronics) apply depending on where you sell and ship: assumed, unverified, check per market.

## Supplier vetting

Order samples yourself; check quality and the true delivery time; confirm they will ship unbranded (no supplier invoice or flyer in the box); get written terms for returns, defects and stock-outs; check they do not sell the same items under a brand that will complain; test one slow and one fast order; keep a second supplier for anything that sells.`,
    steps: [
      { id: 'classify', title: 'Classify the idea: (a) your own design on a disclosed POD partner, or (b) a generic item you did not design', detail: 'Only (a) belongs on Etsy via this service.' },
      { id: 'etsy', title: 'If (b): do NOT list it on Etsy. Pick a non-Etsy storefront you control (a documented future option; no adapter exists)', detail: `Etsy position: ${ETSY_POD}.` },
      { id: 'terms', title: 'Read the target platform\'s current terms on dropshipping and the supplier\'s terms before committing money' },
      { id: 'vet', title: 'Vet the supplier: samples, real delivery time, unbranded packing, returns/defects terms, stock reliability, backup supplier' },
      { id: 'ip', title: 'Check every item for brand, character and design infringement; do not resell knock-offs', check: 'blocklist_clean' },
      { id: 'times', title: 'Publish shipping times you can back with evidence from your own test orders', detail: `Reasonable basis; 30-day default if you state nothing (${FTC}).` },
      { id: 'margin', title: 'Work out margin including refunds, chargebacks and returns shipping, not just unit cost', check: 'margin_above_floor' },
      { id: 'delay', title: 'Have the delay-notice and cancel-and-refund process written down before the first order', detail: `${FTC}` },
      { id: 'owner', title: 'Record the decision with the owner; this service will not build a dropshipping adapter without it' },
    ],
  },
];

const byId = id => PLAYBOOKS.find(p => p.id === id) || null;
module.exports = { PLAYBOOKS, byId, ETSY_POD, FTC, ETSY_IP };
