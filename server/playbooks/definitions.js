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
// Redbubble (researched 2026-10-06): help.redbubble.com, blog.redbubble.com and redbubble.com/terms all returned HTTP 403 to the fetch tool.
// Every Redbubble claim below is therefore from SEARCH-RESULT SUMMARIES of those pages and is marked assumed, with the page to confirm.
const RB_NOAPI = 'assumed, unverified (search results on 2026-10-06 found no public or partner upload API; the only API integration found is order fulfilment for print partners, https://connect-support.gelato.com/en/articles/10793373-integrating-gelatoconnect-with-redbubble)';
const RB_BOTS = 'assumed, unverified (a search summary of https://help.redbubble.com/hc/en-us/articles/202270929-Community-and-Content-Guidelines said uploading with any bot, scraper or other automated means without written permission is prohibited; page returned HTTP 403; read it yourself before relying on this either way)';
const RB_PAY = 'assumed, unverified (search summaries of https://help.redbubble.com/hc/en-us/articles/360035050972 and https://help.redbubble.com/hc/articles/360027407652: payment needs valid payment details and at least $20 earned from orders shipped the previous month; PayPal must be set up as a confirmed account by adding and confirming a bank account; payments start processing on the 15th)';
const RB_MARKUP = 'assumed, unverified (search summaries of https://help.redbubble.com/hc/en-us/articles/202270799 and https://blog.redbubble.com/2025/08/excess-markup-fee-explained/: default markup 20%; from 2025-09-01 markup above 20% is charged a 50% excess markup fee on Standard and Premium accounts)';
const RB_CSV = 'assumed, unverified (search summary of https://help.redbubble.com/hc/en-us/articles/4412488515092: a CSV sales history is available from the Sales History page and is emailed quarterly; the column headers were not found anywhere)';
const RB_COUNTER = 'assumed, unverified (search summary of https://help.redbubble.com/hc/en-us/articles/20181954084500-Counter-Notice-FAQ: a counter notice names you, gives contact details, the work URL, why the takedown was a mistake, and supporting evidence)';
const RB_AI = 'assumed, unverified (a search summary says Redbubble has an AI-generated checkbox on upload; a different search could not find any AI wording in its Community and Content Guidelines; the upload form is the authority)';

// Trend sources (researched 2026-10-06, octopus-vault/memory/ecom-trend-sources.md). Etsy's, Pinterest's and Google's own pages were largely
// unreadable to the fetch tool, so everything below about those services is corroborated from search summaries at best, never confirmed.
const TR_PINTEREST = 'assumed, unverified (Pinterest Trends at https://trends.pinterest.com is described as free for a person to use; its terms on automated access were not read, so ecom never touches it)';
const TR_GOOGLE_API = 'corroborated only (announced 2025-07-24 at https://developers.google.com/search/blog/2025/07/trends-api; the page body was not delivered to the fetch tool, details come from a search-engine-news summary; whether it is still alpha-only on 2026-10-06 is unknown)';
const TR_TERAPEAK = 'corroborated only (a summary of eBay making Terapeak free for Seller Hub sellers; eBay\'s own page was not read). It shows eBay sales only, so it is a cross-check, not our market';

// YouTube pages read 2026-10-10. Keep the phrase `verified <date> - https://` tight: a test rejects any other use of that word.
const YT_POLICY = 'verified 2026-10-10 - https://support.google.com/youtube/answer/1311392';
const YT_YPP = 'verified 2026-10-10 - https://www.youtube.com/creators/partner-program/';
const YT_CHANNEL = 'verified 2026-10-10 - https://support.google.com/youtube/answer/1646861';
const YT_2027 = 'assumed, unverified (a 2026-08-10 news report, https://www.theverge.com/streaming/977474/youtube-partner-program-new-requirements, said that from 2027-02-01 new applicants would need 8,000 watch hours or 20 million Shorts views, and that people already in the program stay on the old entry bar if they accept new terms by 2027-01-31; the creators page read on 2026-10-10 still lists 4,000 hours and 10 million Shorts views, so follow the creators page until you have read YouTube\'s own notice)';

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
  // ---- Redbubble (manual channel: ecom prepares, a human uploads; see docs/CHANNELS.md) -------------------------------------
  {
    id: 'redbubble-revive',
    title: 'Revive a dormant Redbubble account',
    whenToUse: 'You are about to use the existing Redbubble account again after a long gap, before the first upload.',
    background: `Everything on Redbubble is done by you, by hand, in the browser. ecom never signs in to Redbubble and has no password for it: ${RB_NOAPI}. ${RB_BOTS}

Do this once. It takes about an hour, most of it cleaning up old works. If anything on the account looks wrong (a warning email, a restricted banner), stop and read it first: a restricted account is a different problem from a dormant one.

Money facts you need: ${RB_PAY}. Markup: ${RB_MARKUP}.`,
    steps: [
      { id: 'login', title: 'Sign in at redbubble.com yourself; reset the password if needed; turn on two-step sign-in if offered', detail: 'Use a password manager entry for this account. Do not store the password in ecom.' },
      { id: 'inbox', title: 'Read every Redbubble email from the last year (warnings, restrictions, policy changes) and any banner on the dashboard', detail: 'A warning or restriction must be resolved before you upload anything new.' },
      { id: 'terms', title: 'Read the current Community and Content Guidelines and the User Agreement once, in your own browser', detail: `ecom could not read them (HTTP 403). The rule that matters most here: ${RB_BOTS}` },
      { id: 'profile', title: 'Account settings: profile name, shop name, bio, avatar; bio says what you actually make (original designs), with no brand or third-party names' },
      { id: 'banner', title: 'Shop banner / cover image: upload one that uses only your own artwork', detail: 'A simple banner made from one of your own designs is enough; improve it after the first sales.' },
      { id: 'payment', title: 'Payment details: set the payout currency and PayPal (or the option offered), then confirm the PayPal account is fully set up', detail: `${RB_PAY}. Nothing is paid until you have earned $20 in a month.` },
      { id: 'tax', title: 'Tax information: complete whatever tax or identity form the dashboard asks for (US person: a W-9 style form) and save it', detail: 'assumed, unverified: Redbubble\'s tax-form requirements were not found in searches; follow the prompts in your account. Income is yours to report; ask a tax adviser how, ecom NET is operational, not accounting.' },
      { id: 'old-review', title: 'Open Manage Portfolio and list every old work: title, image, tags, whether it sold', detail: 'Write down which ones to keep, fix, or delete before touching anything.' },
      { id: 'old-ip', title: 'For each old work: delete it if it uses anything you do not own (a brand, character, team, lyric, celebrity, a template you cannot license) or if you cannot say where every element came from', detail: 'Old works with an IP problem are the biggest risk to a revived account. When unsure, delete.' },
      { id: 'old-fix', title: 'For works you keep: set markup to 20%, fix titles and tags, tick the AI checkbox if an AI tool made any part', detail: `${RB_MARKUP}. ${RB_AI}` },
      { id: 'old-low', title: 'Delete or hide very low-quality works (blurry, tiny, no tags): they cost nothing to keep but drag the shop page down' },
      { id: 'prefs', title: 'Turn on the email notifications you want (sales, messages, policy notices) and make sure the email address on the account is one you read', detail: 'The takedown playbook depends on you seeing these emails quickly.' },
      { id: 'sandbox', title: 'Back in ecom: confirm the product you want to list first has a design, then open its Redbubble section and download the pack', detail: 'Next playbook: Publish a design to Redbubble.' },
    ],
  },
  {
    id: 'redbubble-publish',
    title: 'Publish a design to Redbubble',
    whenToUse: 'A product with a finished design should also be sold on Redbubble. ecom prepares the pack; you do the upload.',
    background: `Open the product in ecom, scroll to "Redbubble", press "Download pack (zip)" (or use the folder view: every text field has a copy button). The pack holds: the PNG at Redbubble's recommended size (the real size is shown; an upscale adds pixels, not detail), title.txt, tags.txt, description.txt, markup.txt, product-types.txt and a checklist for this design.

There is no upload API and bots are prohibited, so this is manual by design: ${RB_NOAPI}. ${RB_BOTS}

Limits ecom lints against (all assumed, unless the upload form says otherwise): title 60 chars, 15 tags of up to 50 chars, description kept to 250 chars. Image: PNG, recommended 7632x6480 for large products, maximum 13500x13500 or 300 MB. Source pages: https://blog.redbubble.com/2018/05/uploading-on-redbubble/ and https://help.redbubble.com/hc/en-us/articles/360047166432 (both returned HTTP 403 to ecom). Markup: ${RB_MARKUP}`,
    steps: [
      { id: 'ready', title: 'The design is original, passed the blocklist, and the product carries no flags', detail: 'Same standard as Etsy: no brand, franchise, character, team, lyric or likeness.', check: 'no_flags' },
      { id: 'pack', title: 'In ecom: product drawer > Redbubble > Download pack (zip). Read the Lint box: fix every error before uploading', detail: 'Errors are a title over 60 chars, more than 15 tags, a tag over 50 chars, a blocklist hit.' },
      { id: 'size', title: 'Look at the image size line in the pack. If it says "upscaled", know that Redbubble will print it but fine detail will be soft; that is why large-format products are advised against', detail: 'The pack never claims more pixels than it has.' },
      { id: 'open', title: 'Sign in to redbubble.com as the owner, open your dashboard, click Add new work', detail: 'The direct address ecom shows (https://www.redbubble.com/portfolio/images/new) is assumed; use the dashboard button if it differs.' },
      { id: 'upload', title: 'Upload the PNG from the zip' },
      { id: 'title', title: 'Paste the title from title.txt' },
      { id: 'tags', title: 'Paste the main tag, then the supporting tags, from tags.txt', detail: 'One tag goes in the main tag field and the rest in supporting tags (assumed layout).' },
      { id: 'desc', title: 'Paste the description from description.txt' },
      { id: 'ai', title: 'Tick the AI-generated checkbox if any AI tool made any part of the design', detail: RB_AI },
      { id: 'rights', title: 'Tick the originality / rights confirmation only because it is true' },
      { id: 'products', title: 'Product types: turn OFF every type product-types.txt marks DISABLE; think about each CAUTION; leave ENABLE on', detail: 'Sizes per product are assumed from third-party guides; Redbubble scales and crops itself.' },
      { id: 'markup', title: 'Set markup to the pack\'s figure (20%) for every product', detail: RB_MARKUP },
      { id: 'save', title: 'Preview on a dark and a light product; then save/publish the work' },
      { id: 'url', title: 'Open the live work, copy the address, paste it into ecom (Redbubble section), choose "Mark live"', detail: 'If Redbubble is still reviewing it, press "Mark uploaded" first and come back. ecom stores the URL and the work number so the sales import can match sales to this product.' },
      { id: 'copy', title: 'Next design: use "Copy settings from existing work" in the upload form, replace the image, re-check title and tags', detail: 'assumed, unverified: a search summary says tags, markup and product settings carry over.' },
    ],
  },
  {
    id: 'redbubble-weekly',
    title: 'Weekly Redbubble routine',
    whenToUse: 'Once a week (15 minutes), starting the week after the first upload.',
    background: `Redbubble's sales report is a CSV you request yourself, so the sales import is the one recurring manual task. ${RB_CSV}

Because the column headers are unconfirmed, ecom shows a preview of how it read your file (which header it took for which field) before saving anything. If a column is not recognised, the preview says so; the fix is one line (an alias in server/channels/redbubble-sales.js), or use the manual entry form meanwhile.

Money lands in ecom NET as the artist margin of each line, with no fees and no cost of goods (Redbubble bears production). Account fees and the excess markup fee are taken from payouts and are not modelled.`,
    steps: [
      { id: 'inbox', title: 'Check the Redbubble account email and dashboard for warnings, IP notices, or works put on hold', detail: 'If there is an IP notice, switch to the takedown playbook now, before anything else.' },
      { id: 'csv', title: 'Redbubble: Sales History > request the CSV report (it also arrives by email each quarter); download it', detail: RB_CSV },
      { id: 'preview', title: 'ecom: Sales > Redbubble > paste or choose the CSV > Preview. Check the "read as" mapping and the skipped lines', detail: 'Skipped lines are non-USD rows and unreadable rows. Enter those by hand.' },
      { id: 'import', title: 'Import. Re-importing an overlapping file is safe: lines already known are ignored' },
      { id: 'unmatched', title: 'Any lines "not matched to a product"? Open the product, check its Redbubble title/URL is recorded, and re-import, or enter the sale by hand against the product', detail: 'Matching uses the work number from the URL, then the title.' },
      { id: 'compare', title: 'Compare the weekly numbers with the 30/60/90-day targets in the Game plan' },
      { id: 'crosslist', title: 'Pick the next 2 to 5 designs to cross-list, from the Game plan criteria, and run the Publish playbook for each', detail: 'Products listed on Etsy but with Redbubble state "not listed" are the candidates.' },
      { id: 'tags', title: 'For works with views but no sales after 30 days: fix the title and tags on Redbubble, one change at a time' },
      { id: 'payout', title: 'Check the payout: payments start processing on the 15th once $20 is earned; note the amount in your own books', detail: RB_PAY },
    ],
  },
  {
    id: 'redbubble-takedown',
    title: 'Redbubble takedown or IP notice received',
    whenToUse: 'Redbubble emails that a work was removed, restricted, or reported for copyright, trademark or another policy problem.',
    background: `Do not delete the evidence, do not argue by email in anger, and do not re-upload the same work. Repeated infringement claims can restrict or suspend an account: ${'assumed, unverified (search summary of https://help.redbubble.com/hc/en-us/articles/360051811312 and https://help.redbubble.com/hc/en-us/articles/360056437771)'}. Redbubble's process is modelled on the US DMCA notice-and-takedown process (assumed, unverified: search summary of https://itsartlaw.org/2024/03/13/the-redbubble-of-legal-protections-for-digital-art-marketplaces/).

A counter notice: ${RB_COUNTER}. Only send one if you are sure the design is yours: a false counter notice has legal consequences. This is a checklist, not legal advice.`,
    steps: [
      { id: 'read', title: 'Read the whole notice: which work, who complained, which right (copyright, trademark, publicity), what Redbubble did, any deadline', detail: 'Screenshot the email and the work page for your records.' },
      { id: 'mark', title: 'In ecom: set the product\'s Redbubble state to "removed" (product drawer > Redbubble)', detail: 'It leaves a dated note on the product.' },
      { id: 'honest', title: 'Be honest about where the design came from: prompt, tool, any reference image, any text or name in it', detail: 'If you cannot say where every element came from, treat the complaint as correct.' },
      { id: 'sweep', title: 'Check every other work for the same element: a name, a phrase, a style tied to a brand or person. Remove those on every channel, Etsy included' },
      { id: 'etsy', title: 'Check the same product on Etsy. If it has the same problem, deactivate it there too and follow the Etsy IP playbook', detail: 'See "IP complaint" in the playbooks list.' },
      { id: 'decide', title: 'Decide: accept the removal (default), or contest with a counter notice if you are certain', detail: RB_COUNTER },
      { id: 'counter', title: 'If contesting: send the counter notice through the form Redbubble names in the notice; include your name, contact details, the work URL, why it was a mistake, and original-creation evidence (prompt history, source files, timestamps)', detail: 'ecom keeps the design prompt and timestamps in the product history; export them.' },
      { id: 'block', title: 'Add the offending term to the ecom blocklist (Settings > Blocklist) so it cannot come back', detail: 'A hit only flags; you still approve.' },
      { id: 'log', title: 'Write down what happened and what you changed; if you receive a second notice within months, stop listing new works until you understand the pattern' },
    ],
  },
  {
    id: 'redbubble-game-plan',
    title: 'Redbubble game plan: what to cross-list, price, and expect',
    whenToUse: 'Deciding which designs go to Redbubble first and what a good first three months looks like.',
    background: `Why Redbubble: it has its own shoppers, which a zero-review Etsy shop does not. Why only a side channel: money per sale is small. Redbubble pays you the artist margin, which is your markup percentage of the base price; ${RB_MARKUP}.

The numbers below are realistic planning figures, NOT forecasts and NOT sourced: a third-party blog (https://www.unil.ink/help-center/articles/how-to-sell-ai-art-2026) reported about $1 to $5 per sale to the artist, and most new works sell nothing for weeks. Treat them as assumed, unverified.

Effort per design: about 15 to 20 minutes the first time, less with "Copy settings from existing work".

PRICING: leave markup at 20%. Above that, 50% of the extra is taken, so a higher markup mostly raises the shelf price while barely raising your pay. If you want more per sale, make the shelf price your advantage elsewhere (better designs, more products), not by raising markup.

WHICH DESIGNS FIRST (in this order):
1. Evergreen over seasonal: a design that still sells in February (a hobby, a profession, a pet, a funny phrase). Seasonal designs need to be live well before the season; cross-list a Christmas design now or skip it until next year.
2. Designs already live on Etsy, flag-free, with a transparent PNG and a real size of at least about 3000px on the short side. Stickers and tees are where small designs do best.
3. Designs that work on many products (stickers, tees, mugs, totes) rather than one oddly shaped product like a ceramic ornament; products Redbubble does not make stay Etsy-only.
4. Anything with a clear search phrase ("fishing is my love language"): Redbubble is search-driven, so the title and 15 tags matter more than the picture.
5. Avoid: anything near a brand, any design that needs real detail at large-format sizes, anything you would not defend in a takedown email.

WHAT SUCCESS LOOKS LIKE (assumed, unverified planning numbers):
- Day 30: account revived, 10 to 15 designs live, 0 to 3 sales, $0 to $10 earned. Success = the routine works and nothing was flagged.
- Day 60: 25 designs live, 2 to 10 sales, $5 to $30 earned. Success = you know which 3 designs get views, and you have added the best-performing themes in new variants.
- Day 90: 40 designs live, 5 to 25 sales, $10 to $75 earned. Success = at least one payout (the $20 threshold, ${RB_PAY}), and a clear answer to "is Redbubble worth 2 hours a week?" Most likely answer: a small side income, not a replacement for Etsy.

If day 60 has zero sales and almost no views: the problem is titles and tags, not volume. If views but no sales: price and product choice. If day 90 is still zero: stop adding designs, keep the existing ones up, and spend the time on Etsy.`,
    steps: [
      { id: 'shortlist', title: 'In ecom, list products live on Etsy with Redbubble state "not listed"; shortlist 10 that are evergreen and flag-free' },
      { id: 'size', title: 'For each, open the Redbubble pack: keep those whose image size line is honest and whose product-types list has at least 3 ENABLE', detail: 'A design with few ENABLE types is a poor Redbubble candidate.' },
      { id: 'tags', title: 'Read each pack\'s title and tags as a shopper would: would you search those words? Edit the Etsy copy and re-open the pack if not' },
      { id: 'week1', title: 'Week 1: publish 3 designs (Publish playbook) and mark each live in ecom' },
      { id: 'd30', title: 'Day 30 review: designs live, views, sales, earned; was anything flagged?', detail: 'Targets: 10 to 15 designs, 0 to 3 sales, $0 to $10 (assumed).' },
      { id: 'd60', title: 'Day 60 review: which 3 designs get views? Make variants of those; retire none yet', detail: 'Targets: 25 designs, 2 to 10 sales, $5 to $30 (assumed).' },
      { id: 'd90', title: 'Day 90 review: total earned vs hours spent; first payout reached?', detail: 'Targets: 40 designs, 5 to 25 sales, $10 to $75 (assumed).' },
      { id: 'decide', title: 'Decide: keep, grow, or stop. Record the decision with the numbers' },
    ],
  },
  {
    id: 'weekly-proposals',
    title: 'Weekly proposals review',
    whenToUse: 'Once a week, or whenever the Proposals tab has new cards: decide what becomes a product, what waits, and what the next batch should avoid.',
    background: `The Proposals tab holds original product ideas generated from your seeds (themes, occasions, audiences), your watchlist and any trend signals, with the season window worked out for each. Nothing is published from there: approving a proposal only creates a card in the IDEA stage, pre-filled, which then goes through the normal pipeline and the normal approval gate. Every price and margin on a proposal is an ESTIMATE (the real Printify base cost is only read when the POD product is created). The lead times behind "too late" and "list by" are assumed, unverified planning defaults (production 5 days, shipping 10, buffer 3, listing ramp 21): replace them with your print provider's and carrier's published schedule for the year (see the seasonal-prep playbook). A clean originality check means "nothing obvious", never "cleared": the blocklist reads text only and cannot see a logo or a likeness, so look at the finished design too. Proposals are never derived from a specific competitor listing or image, and you should not paste one into a seed. Weekly generation is OFF by default; turn it on in the Proposals tab if you want a batch each week (it spends model tokens, under the daily cap, or through cortex on your account).`,
    steps: [
      { id: 'open', title: 'Open the Proposals tab; if generation is off, press Generate with this week\'s seeds (occasions coming up, themes you care about)' },
      { id: 'season', title: 'Read the season line on each card first: anything marked TOO LATE is for next year (snooze it to the "list by" date) and anything TIGHT needs listing now', detail: 'The dates come from assumed, unverified lead times; check them against the provider and carrier schedule.' },
      { id: 'originality', title: 'For each card you like, read the risk panel and run its ready-made originality prompt in any model you trust; refuse anything that reads as a brand, character, celebrity, team, protected phrase or "inspired by" another seller', check: 'blocklist_clean' },
      { id: 'copy', title: 'Check the Etsy title and the 13 tags read like what a buyer would type, and that the lint shows no errors; fix inline' },
      { id: 'price', title: 'Check the estimated price and margin; edit the price if you disagree (the margin recomputes)', detail: 'It is an estimate until the POD product is created and the real base cost is read.' },
      { id: 'decide', title: 'Approve (or edit and approve), snooze, or reject; when you reject, write the reason, because the next batch is told what you did not like' },
      { id: 'pipeline', title: 'Approved proposals are IDEA cards: generate or upload the design, then continue through the normal pipeline and approval gate' },
      { id: 'backlog', title: 'Nothing left unreviewed for more than a week', check: 'proposals_reviewed' },
    ],
  },
  {
    id: 'weekly-trend-review',
    title: 'Weekly trend review',
    whenToUse: 'Once a week (about 20 minutes), ideally Monday after the automatic Trends report, before deciding what to design next.',
    background: `The Trends tab ranks themes by an opportunity score built from sources that cost nothing and break no rules. Two things to hold onto: no source shows other sellers' sales, so every number is a proxy; and the weights behind the score are untested guesses until about 8 to 12 weeks of our own results exist. This list is the human half: the places a person may look but a program must not.

- Pinterest Trends (website): ${TR_PINTEREST}.
- Google Trends website and API alpha: ${TR_GOOGLE_API}.
- Terapeak in eBay Seller Hub: ${TR_TERAPEAK}.
- Do not automate any of these, and do not copy another seller's titles, tags or designs from what you see. Themes, keywords, product types and price bands only.`,
    steps: [
      { id: 'report', title: 'Open Trends, press Rebuild, read the note at the top and the per-source status line', detail: 'A source marked disabled, no data or error is a gap, not a zero. Low-confidence rows (small dot) are guesses.' },
      { id: 'pinterest', title: 'Pinterest Trends (website, by hand): check your watchlist themes and the "growing" lists for your categories; enter anything useful under Trends > Manual entries', detail: TR_PINTEREST },
      { id: 'google', title: 'Google Trends (website, by hand): compare 3 to 5 themes over 5 years to see their seasonality; type the direction into Manual entries', detail: 'A person using the website is fine; automating it (pytrends and similar scrapers) is not, and ecom does not do it.' },
      { id: 'google-api', title: 'Google Trends API alpha: apply through the form linked from the 2025-07 Google developers announcement if you have not, and note the date you applied', detail: TR_GOOGLE_API },
      { id: 'terapeak', title: 'Terapeak (eBay Seller Hub > Research), only if you also sell on eBay: look up one or two keywords for sold prices as a cross-check', detail: TR_TERAPEAK },
      { id: 'redbubble', title: 'Redbubble and Amazon Merch: glance at the trending sort and popular searches yourself; enter themes (never listings) in Manual entries', detail: 'Their rules reportedly forbid bots (docs/CHANNELS.md); a person looking is fine.' },
      { id: 'csv', title: 'If you pay for eRank, Alura or EverBee, export a keyword CSV and import it (Trends > CSV import > Preview > Import)', detail: 'The headers are assumed; read the preview mapping before importing. These are the tool\'s estimates, not Etsy data.' },
      { id: 'blocklist', title: 'Check the blocklist section: a hot term removed for brand or franchise reasons stays removed', detail: 'Trends inform theme and keyword only. Never reproduce a competitor\'s design or listing.' },
      { id: 'windows', title: 'Seasonal windows: for each window closing soon, decide design, list or skip, and write the last-order date where customers see it', detail: 'Last-order dates are estimates from our own lead-time table; replace them with this year\'s provider and carrier cut-offs (seasonal-prep playbook).' },
      { id: 'gaps', title: 'Gaps: pick up to three high-score themes with nothing in the catalogue and start a small batch (3 to 5 designs) to test the hypothesis' },
      { id: 'launches', title: 'Our launches: look at the score each launch had against its views and sales; note anything the score got badly wrong', detail: 'This is the data for re-fitting the weights after 8 to 12 weeks.' },
      { id: 'etsy-terms', title: 'If the Etsy market source is still off: have you read Etsy\'s current API Terms and decided? Record the date and the answer in docs/COMPLIANCE.md', detail: 'assumed, unverified: the terms may require Etsy\'s authorisation for analytics use; search summaries suggest so, the page itself was not readable.' },
    ],
  },
  {
    id: 'estate-income-order',
    title: 'Estate income order: what can pay, and in what order',
    whenToUse: 'You are choosing this week\'s work so the estate earns before a new channel can.',
    background: `A million dollars here means cumulative profit from a stack. It is not a payout from one faceless channel, and it is not a 90-day plan. The 90-day plan is ten shop sales, one repeatable video, one kit with a price, and a written answer to which of those three is worth next month's hours.

WHAT CAN PAY, IN THIS ORDER
1. The shop. This app already drafts original print-on-demand products and can publish to Etsy after keys are in and live writes are armed. That live path has never been run. One listing that can take money beats a folder of unmade videos. Redbubble is the same artwork, uploaded by you, and pays less per sale. Use launch-pod-etsy and redbubble-game-plan.
2. The blog, if it is public. The copy of octopus-blog/MONETIZATION.md in this checkout says an Amazon Associates account is open, the 180-day / 3-sale clock is running, and the associate tag is still a placeholder. Display ads want posts first. That checklist belongs to the blog, not to this app. Re-read the file if that checkout has since moved.
3. Shop traffic from video. A YouTube channel does not need the Partner Program to send a buyer to a listing. The link goes in the description the day the listing is live. Ad revenue comes later.
4. A digital kit. The niche playbooks are something you can sell: a written operating kit, mostly margin, no watch-hour gate. This app does not deliver digital files (ARCHITECTURE.md, not yet built). You sell a cleaned export by hand. See niche-digital-kit.
5. YouTube ads. Thresholds are below. A new channel does not pay rent this month. Treat ads as the back catalog's paycheck.

PLANNING ARITHMETIC, NOT A FORECAST (assumed, unverified)
Divide 1,000,000 by the NET on a real shop sale once you have one. If that NET were $8, you would need 125,000 sales. Use your number.
Story-channel ad rates are commonly talked about as a few dollars per thousand views. That band is not your rate. At $4 per thousand, which you should not budget, a million dollars of ad revenue is 250 million views.
A written kit listed in the tens of dollars needs tens of thousands of sales to reach the same million, but each sale is mostly margin and does not wait on watch hours. Someone still has to find the listing.

DO NOT OPEN WITH
- A ripped game, or a video model told to recreate one. The story bed is that moving-background style, built as your own design or as clips that follow the beats. See faceless-story-channel. A channel that reads other people's website posts under one loop is the pattern YouTube's monetization policy refuses.
- A second Google account to replace a banned or demonetized channel. ${YT_POLICY} says not to create new channels to get around those restrictions, and that doing so can terminate all of them.
- Bought views or subscribers. Same page, under creator integrity.
- An AI persona giving financial, legal, or medical advice. Same page: those channels are not allowed to monetize.

THIS MONTH
Week 1: one original product through the Etsy launch playbook as far as dry-run. Do not arm live writes until you mean to take a buyer's money.
Week 2: if dry-run looks right, arm, publish one, cross-list it on Redbubble by hand.
Week 3: open two YouTube channels only (shop, then story). Write four original stories. Produce one video. Upload it only with rights.txt filled in.
Week 4: if the listing is live, the video links to it. Export the story kit and write a price. Record hours and dollars, including zeroes.`,
    steps: [
      { id: 'read-order', title: 'Read docs/INCOME.md once. It is the map. This checklist is the order' },
      { id: 'shop', title: 'Take one original product through the Etsy launch playbook as far as dry-run, and write down the projected margin' },
      { id: 'arm', title: 'Arm live writes only when you intend a real charge, publish that one product, and add the AI disclosure and Designed-by line yourself', detail: 'The app does not write those fields. See docs/COMPLIANCE.md.' },
      { id: 'redbubble', title: 'Cross-list that design with the Redbubble publish playbook' },
      { id: 'blog', title: 'Open octopus-blog/MONETIZATION.md and do the one open item that the clock is running on', detail: 'In this checkout that item is the real Associates tag, and then traffic to buyer posts. Confirm the file still says that.' },
      { id: 'channels', title: 'Open the shop channel and the story channel. Do not open the explainer channel yet', detail: 'youtube-niche-channels playbook.' },
      { id: 'one-video', title: 'Produce one story video. Do not upload it with a blank rights.txt', detail: 'produce-one-video playbook.' },
      { id: 'link', title: 'When a listing URL exists, put it in that video\'s description. Do not link an empty shop' },
      { id: 'kit', title: 'Run the digital-kit playbook far enough to have a cleaned folder and a price written down' },
      { id: 'review', title: 'At day 30 write shop sales, whether a video is public, whether a kit is listed, and hours spent. Keep the winner and stop the loser' },
    ],
  },
  {
    id: 'faceless-story-channel',
    title: 'Faceless story channel: original fiction, footage you own',
    whenToUse: 'You want the long-form channel people describe as gameplay under a narrated story, and you want it eligible to monetize.',
    background: `The format is one voice telling one story, captions, and motion on screen, in a video long enough to sit with (a 2,000 to 4,000 word script is a planning range for roughly 15 to 30 minutes; pace is assumed, unverified). The style people mean is a picture that keeps moving while the story is told: a side view, a character or a camera travelling through a place, the way an endless runner feels. The picture changes when the story changes. That bed is yours. It is not a recording of someone else's game.

THE PICTURES, TWO WAYS.
1. An original design you animate. One character you drew or generated, and a handful of places, panned or looped in short stretches. The character can recur. The places follow this story.
2. A video model, one clip per beat. beats.md carries a prompt for that stretch: where they are, what moves, the mood, in your own words. Generate the clip, put it in footage/, and write the model name and the prompt in rights.txt. This shop's image generator makes print designs. It does not make these clips. Use a video model whose terms you have read and that allow ads. Which product that is, is assumed, unverified until you read the terms of the one you pick.

Do not feed a model a frame from Subway Surfers or any other commercial game, and do not name that game, its characters, or its interface in the prompt. A lookalike can draw the same strike as a rip.

COPYRIGHT. There is no step in this playbook for downloading gameplay. A commercial game's footage is not yours, and neither is another creator's recording of it.

MONETIZATION. ${YT_POLICY}
- Reused content includes readings of materials you did not create, and the page gives text from websites or news feeds as the example. A channel that is Reddit posts read aloud is that example. The same page says the reused-content rule applies even when you have permission from the original creator.
- Repetitive content includes templated storylines, minimal variation from video to video, and AI output from a generic template with none of your own perspective.
- The same page allows a character and narrative you invented, and AI used to make a background that belongs to that narrative. A shared intro is fine. The episode has to be a different story.

So the channel is original fiction in the shape viewers already sit through: one person, one mess, a turn, an ending. You may read public posts to learn which situations people finish. You may not read the post on the video. Same rule this shop uses for other sellers: themes, not the work.

VARIATION. Each video needs its own plot, its own scene list, and pictures that follow the scenes. One identical loop under every upload is a template, whether you drew it or a model did. A recurring character is fine. Quiet stretches can reuse a short loop you made. The places and the generated beats change with the plot. The same page that allows a background a model made for a narrative you invented still refuses a generic template with no change from video to video. ${YT_POLICY}

RIGHTS, BEFORE UPLOAD. ~/octopus-content/story/<yyyy-mm-dd-slug>/rights.txt names the script (you, or a person you paid), the voice (yours, or a commercial license that covers ads), the music (YouTube's audio library or a license), and every clip. A line that says "found online" means you do not upload.

ADS, WHEN. ${YT_YPP}
- Fan funding, shopping, gifts, supers, memberships, partnerships: 500 subscribers, 3 public uploads in 90 days, and either 3,000 long-form watch hours in 365 days or 3 million Shorts views in 90 days.
- Ads and YouTube Premium revenue: 1,000 subscribers, and either 4,000 long-form watch hours in 365 days or 10 million Shorts views in 90 days.
Shorts watch time does not count toward the 4,000 hours. Meeting the number does not admit you; the channel is reviewed, and the creators page says that review is often about a month. ${YT_2027}
Until those ads exist, the description can sell a live shop listing and, later, the kit.

WHERE A NEW TOOL GOES. Your money tools stay private. A new process gets its own repo, its own secret, and a hub.json with "access": "private" and its own subdomain. It does not share a process with the Discord bot, a shell, or anyone else's keys. The Discord bot in cortex is already the owner remote: it answers only DISCORD_USER_ID, and the public image strips it. A command that spends money or changes a stack stays behind the bot's existing 2FA list. Other people's access waits until you are being paid and you say so. No public content app in this pass.

CADENCE. Two long videos a week is enough to learn. One a day of the same shape is the mass-production pattern. If you cannot summarize the plot in two sentences that would not describe last week's video, do not record it.

BOUNDARY. Stories only. No financial, legal, or health advice, and no AI face playing an expert. Characters are fictional. A real private person's name does not go in. Public figures and real crimes are a defamation problem; leave them out.`,
    steps: [
      { id: 'name', title: 'Pick a name and handle that say fiction, not Reddit and not a game. Create the channel with the niche-channels playbook' },
      { id: 'folder', title: 'Create ~/octopus-content/story and one folder per video named yyyy-mm-dd-slug' },
      { id: 'library', title: 'Choose the bed: an original character and places you animate, or a video model with one prompt per beat', detail: 'Log each clip in ~/octopus-content/story/library/RIGHTS.md with the file, the model or "I made this", and the prompt. Do not rip a game, and do not name a commercial game or its characters in a prompt.' },
      { id: 'four', title: 'Write four scripts that do not share a plot. First person, a start, a turn, an ending. Save each as script.md', detail: '2,000 to 4,000 words is a planning range, assumed, unverified as a runtime.' },
      { id: 'beats', title: 'For each script write beats.md: every 20 to 40 seconds, the place, the motion, and the prompt or the library clip. Two videos do not share an order' },
      { id: 'pilot', title: 'Produce video one with the produce-one-video playbook. Upload only after rights.txt is complete' },
      { id: 'cadence', title: 'Publish at most two a week for four weeks. If you cannot hold that, fix the bottleneck before you add volume' },
      { id: 'shop', title: 'When a listing is live, one sentence and the URL in the description. The story still has to stand if the link is ignored' },
      { id: 'ypp', title: 'Apply from Studio\'s Earn page only when that page says you meet a threshold, and only if the new videos are still original stories', detail: YT_YPP },
      { id: 'kill', title: 'If a video is a reading of someone else\'s post, or one loop with no scene changes, unlist it before you apply', detail: `A review looks at the channel, not only the newest upload. ${YT_POLICY}` },
    ],
  },
  {
    id: 'produce-one-video',
    title: 'Produce one video: folders, rights, upload',
    whenToUse: 'A script is ready and you are making the file you will upload.',
    background: `Video files do not go in this repo. Pushing main deploys the shop.

PATH. ~/octopus-content/<channel>/<yyyy-mm-dd-slug>/
- script.md, the words that are spoken and nothing else
- beats.md, time ranges, what is on screen, and the prompt if a model made the clip
- voice.wav, the narration
- captions.srt, the same words as the voice
- footage/, clips already named in the library rights file
- project/, the editor project. CapCut, DaVinci, or whatever you already use. This app does not drive it and does not upload
- thumbnail.png, 1280x720, a moment from the story or the product. No game logo
- upload.txt, title, description, tags, shop URL or the word NONE, and whether the voice or a face is synthetic
- rights.txt, script, voice, music, footage, each with a source

Export 1920x1080, or 2560x1440 if the export is cheap for you. A 9:16 Short is cut later from this master (niche-shorts), not a second shoot.

VOICE. Your own voice is the simplest license. A synthetic voice needs a commercial license that covers advertising, and the altered-or-synthetic control on the upload form set to match. The control's exact label is assumed, unverified; read the form in front of you. Do not clone a voice that is not yours.

MUSIC. YouTube's audio library, or a track whose license you can paste into rights.txt. No commercial songs and no sped-up copies of them.

PICTURE. Cut on the beats. Captions on. The conflict is in the first 15 seconds, then the story. The bed keeps moving, and it changes when the story changes: a new place, a new action, a new generated clip. Do not open on silent footage. A loop with no words is the reused-footage case, not a story. A generated clip's prompt names the place and the motion in your own words. It does not name a commercial game or describe that game's characters. The model name and the prompt go in rights.txt. This shop does not generate the clip for you.

TITLE. Name the situation. Do not put "Reddit" in it and do not put a game's name in it. The game's name is a trademark you do not own, and it promises a video you are not making.`,
    steps: [
      { id: 'folder', title: 'Create the slug folder and an empty rights.txt before you record' },
      { id: 'script', title: 'Read script.md aloud once, cut any sentence that only stalls, and confirm you wrote it or paid for it' },
      { id: 'voice', title: 'Record or render voice.wav. If the voice is synthetic, write the product name and the license in rights.txt' },
      { id: 'beats', title: 'Lock beats.md so every 30 seconds names a picture. No stretch longer than 45 seconds on one unchanged loop' },
      { id: 'edit', title: 'Edit in project/, export, watch the export once at 1.5x, and fix the one dead stretch' },
      { id: 'captions', title: 'captions.srt matches the voice. Burn them in or upload the sidecar. They exist either way' },
      { id: 'thumb', title: 'thumbnail.png is a story moment or the product, plus the title\'s key words. No game logo, no celebrity face' },
      { id: 'upload-txt', title: 'Write upload.txt: title, two-sentence description, shop URL or NONE, situation tags rather than brand tags, synthetic yes or no', detail: 'Title length limits change. If Studio warns, shorten it. assumed, unverified that 70 characters is still a safe planning cap.' },
      { id: 'rights', title: 'rights.txt has no blank source. If one is blank, do not upload' },
      { id: 'upload', title: 'Upload yourself in Studio on the correct channel, set the disclosure to match upload.txt, and paste the video URL back into upload.txt' },
    ],
  },
  {
    id: 'youtube-niche-channels',
    title: 'YouTube channels: one account, one niche each',
    whenToUse: 'You are opening the shop channel, the story channel, or a later niche.',
    background: `One Google account, a separate channel per niche, each with its own name. ${YT_CHANNEL} A personal channel is created from Settings, then Add or manage channels. A channel under a business or other name is created from the channel list (https://www.youtube.com/channel_switcher) and that flow creates a Brand Account, which can have more than one manager. Use the Brand Account path so the shop name is the channel name, not your personal name.

OPEN IN THIS ORDER
1. Shop. The name is the shop, or a plain design name you can say. Its job is to show real products and send people to a listing. Playbook: niche-shop-traffic. This one can earn before any ad program.
2. Story. Fiction only. Playbook: faceless-story-channel.
3. Explainer. One topic you can teach without pretending to be a lawyer, a doctor, or a financial adviser. Playbook: niche-explainers. Open it only after the first two channels have four public videos each. A third empty channel splits the week.
4. No fourth channel until one of the three has either sales or a month of work you would repeat.

A different niche means a different promise in About. Shop: designs you made, and where to get them. Story: original short fiction. Explainer: the topic sentence. If two channels would accept the same upload, they are one channel. Copying one template onto several channels is the mass-production case. ${YT_POLICY} says a new channel opened to get around a demonetization or a termination can cost you every channel.

ACCOUNT. Use the Google account you already control. Turn on two-step verification before you apply to the partner program; the creators page lists it as a requirement. ${YT_YPP} A second Google account is for a real second person, not a spare in case of a strike. Passwords stay in the password manager. They do not go in this app, in a playbook, or in ~/octopus-content.

ABOUT. Say who makes the videos. Story says the stories are fiction. Do not write that you read Reddit. Do not put a game title in the name or the banner. Banners use art you own.`,
    steps: [
      { id: 'login', title: 'Sign in to the Google account you will keep, and confirm two-step verification is on', detail: YT_YPP },
      { id: 'shop-ch', title: 'From the channel list, create the shop channel as a Brand Account: shop name, handle, a picture you own', detail: YT_CHANNEL },
      { id: 'story-ch', title: 'Create the story channel the same way, with a different name and handle' },
      { id: 'about', title: 'Write both About boxes. Shop names the shop. Story says original fiction' },
      { id: 'banner', title: 'Banners use your own art or a still you made. No game screenshot and no trademark' },
      { id: 'switcher', title: 'Use the channel switcher once before the first upload, so a story does not land on the shop channel' },
      { id: 'later', title: 'Leave the explainer channel until shop and story each have four public videos' },
      { id: 'strike', title: 'If any channel is demonetized or terminated, stop and read the notice. Do not open a replacement', detail: YT_POLICY },
      { id: 'record', title: 'Write the channel URLs in ~/octopus-content/CHANNELS.md. Nothing else about the Google account' },
    ],
  },
  {
    id: 'niche-shop-traffic',
    title: 'Shop-traffic videos that sell a live listing',
    whenToUse: 'A product is live, or will be today, and you are making the video whose job is the sale.',
    background: `This channel earns by sending a buyer to a listing. A view that buys is worth more than a view that might pay ad rates in a year. The partner-program rules still apply once you want ads: the videos have to be yours, and they have to differ. ${YT_YPP}

ONE VIDEO, ONE PRODUCT. Show the design large in the first three seconds, say who it is for, show it on the real product type, say that you designed it and a print partner makes it, and put the listing URL in the first line of the description and in the pinned comment. If the listing is not live, do not publish the video.

DO NOT
- Use a brand, team, character, or lyric in the design or the title. Same bar as the Etsy launch playbook.
- Call it handmade by you when a partner prints it.
- Stuff the title with a game name or any unrelated viral words. That brings a viewer who will not buy, and misleading metadata is a community-guidelines problem.
- Read a script that would fit any product. Name this design.

CADENCE. One video per design you will stand behind, plus one Short cut from it. A weekly roundup is a second format, and only after four live listings.

MEASURE. ~/octopus-content/shop/LOG.md: date, video URL, listing URL, views after 7 days, listing sessions if Etsy shows them, orders. After five videos, make more of the format that produced a session. Stop the one that did not. The views-no-sales playbook is for the listing once the listing itself has views.

The app still does not write an AI disclosure onto the Etsy listing. If a frame or the design is AI-made, you say so in the description and on Etsy.`,
    steps: [
      { id: 'live', title: 'Open the listing URL and confirm the price matches ecom. If it does not load, stop' },
      { id: 'script', title: 'Write a 45 to 90 second script: who it is for, what is printed, who prints it, where to buy it. Save it under ~/octopus-content/shop/<slug>/' },
      { id: 'shoot', title: 'Record the mockup from the product drawer or a flat lay you made. The product fills the frame in the first three seconds' },
      { id: 'say-partner', title: 'The voice says you designed it and a print partner makes it, matching the listing' },
      { id: 'desc', title: 'Description line 1 is the listing URL. Line 2 is one sentence. No other shop\'s link' },
      { id: 'pin', title: 'Pin a comment with the same URL' },
      { id: 'short', title: 'Cut one Short from the same master the same day, using the Shorts playbook' },
      { id: 'log', title: 'Log the video URL, the listing URL, and a 7-day check in ~/octopus-content/shop/LOG.md' },
      { id: 'judge', title: 'At five videos, compare listing sessions. Repeat the kind that sent people. Stop the kind that did not' },
      { id: 'disclose', title: 'If any frame or the design is AI-generated, say so in the description and on the Etsy listing' },
    ],
  },
  {
    id: 'niche-explainers',
    title: 'Explainer channel: one topic you can teach',
    whenToUse: 'The shop channel and the story channel each have four public videos, and you are opening one teaching channel.',
    background: `Pick one topic you can explain from work you have done, for twenty videos, without inventing a new identity each week. Honest topics for this estate are narrow: running a small print shop, reading a fee, setting up a home server, training for a fight camp if that is your training. The channel promise is that topic. A video is one question, with a start, the steps, and the mistake you would not repeat.

NOT THIS CHANNEL. ${YT_POLICY} An AI persona presented as a human expert on health, law, finance, or politics is not allowed to monetize. No AI doctor, no AI lawyer, no AI host telling people what to do with their money. You may use a model to edit a script you wrote or to make a diagram. The judgment in the video is yours. The face on screen is not a credentialed stranger.

ORIGINAL. Each video answers a different question. Five tips with the nouns swapped is a template. Show the actual screen, the actual fee line, the actual sketch. A slideshow of sentences with no demonstration is the kind of video that page lists as outside monetization.

MONEY. Same thresholds as the story channel. ${YT_YPP} Before ads, the video can point at a kit or a product only after the question is answered, and only at something you sell that the video used. One link. Say that you sell it.

The cleaned scripts can become a second kit later (niche-digital-kit). Do not sell a script that recites another site's article.`,
    steps: [
      { id: 'topic', title: 'Write the topic sentence and twenty questions in ~/octopus-content/explainers/ABOUT.md', detail: 'If you cannot list twenty questions from experience, narrow the topic. Drop any question that needs a license you do not hold.' },
      { id: 'channel', title: 'Create the channel with the niche-channels playbook. About repeats the topic sentence and who you are, in plain words' },
      { id: 'pilot', title: 'Script one 6 to 10 minute video that demonstrates the thing. Produce it with the produce-one-video playbook' },
      { id: 'voice', title: 'Use your voice, or a synthetic voice you licensed, and set Studio\'s disclosure to match. No expert persona that is not you', detail: YT_POLICY },
      { id: 'link', title: 'At most one link, after the answer, to something you sell that the video used' },
      { id: 'four', title: 'Publish four, then read retention in Studio before you write the next six', detail: 'Where that graph sits in Analytics is assumed, unverified. Use the Analytics page you see.' },
      { id: 'kit', title: 'If the four are worth repeating, add the cleaned scripts to the kit folder. If not, do not package them' },
      { id: 'stop', title: 'If video three needed a fake expert to exist, stop the channel' },
      { id: 'separate', title: 'Do not post these videos on the story channel. Different promise' },
    ],
  },
  {
    id: 'niche-shorts',
    title: 'Shorts cut from a video you made',
    whenToUse: 'A long video you are willing to sign is exported, and you are cutting one Short from it.',
    background: `A Short is a cut of a video you already made, posted on the same channel, to bring a viewer to the long video or the listing. It is not a separate account and not a pile of other people's clips.

${YT_POLICY} Compilations of other people's clips with no narrative are reused content. A Shorts-feed note published by a YouTube employee on 2026-10-01 said recommendation would favor original work and show less of re-uploads that add nothing (assumed, unverified as a permanent policy: https://support.google.com/youtube/thread/470890423). Your Short uses your voice and your picture.

${YT_YPP} Shorts views and long-form watch hours are different doors. A Short does not add watch hours toward the 4,000. Do not expect shop Shorts to unlock ads unless the Shorts door itself gets to 10 million qualified views in 90 days. The shop Short's job is the click to the listing. The story Short's job is the click to the long video.

SHAPE. 20 to 45 seconds, vertical. The length cap is assumed, unverified; if Studio rejects the file, use the cap it shows. First frame is the product or the story's conflict. Captions burned in. One idea. End on the next action. No duet of a stranger's video. No gameplay you do not own, including a three-second sample: a sample of the game is still the game. No commercial song as the sound.`,
    steps: [
      { id: 'master', title: 'Start from an exported long video whose rights.txt is complete. No Short from a video you would not sign' },
      { id: 'cut', title: 'Cut 20 to 45 seconds at the strongest beat, 9:16, captions burned in' },
      { id: 'same', title: 'Upload it to the same channel as the master' },
      { id: 'point', title: 'Story Short links to the long video. Shop Short links to the live listing. Put that URL in the description and the pinned comment' },
      { id: 'disclose', title: 'Set the same synthetic-content answer as the master' },
      { id: 'count', title: 'One Short per long video. A second cut only if the first sent people after 7 days' },
      { id: 'audio', title: 'Use the master\'s licensed audio or the audio library. Do not attach a commercial song' },
      { id: 'log', title: 'Write the Short URL next to the master in that channel\'s LOG.md' },
    ],
  },
  {
    id: 'niche-digital-kit',
    title: 'Package a niche kit and sell it by hand',
    whenToUse: 'You are turning a playbook into a file someone else can buy.',
    background: `The product you can sell before any channel is in the partner program is the written kit: how to run one original niche, with the checklist, the folder layout, and the rules that keep a channel eligible. Mostly margin. No print partner. No watch hours.

THIS APP DOES NOT DELIVER IT. There is no digital-download adapter. You sell the zip by hand. Places a person can list a file, each with terms you read that day before you rely on them (assumed, unverified; those terms pages were not read for this playbook): an Etsy digital listing, Gumroad, Payhip, or a checkout you already run. Pick one. Do not automate the upload.

A BUYER GETS markdown, a blank video-folder layout, and a one-page list of what not to do: no ripped games, no scraped posts, no accounts opened to dodge a strike, no promise of income. A buyer does not get your Google login, shop keys, unreleased designs, or any hostname.

STRIP BEFORE THE ZIP. Delete hostnames, ports, secret names, account emails, unreleased product URLs, and lines that only make sense inside this app's database. You may say "a print-on-demand shop" and "a listing URL". Keep the policy warnings and the official YouTube URLs. Those are the part worth paying for, and they stop a buyer building a channel the partner program will not pay.

PRICE. A written checklist is often listed in the tens of dollars. That observation is assumed, unverified. Write $17 to $27 as a starting list price for the story kit, or another number you would pay for a checklist. Raise it after ten sales, not before. One kit. The explainer kit waits until that channel exists.

HONEST LISTING. Call it a checklist and templates. Do not promise income. Show the table of contents. Say the footage and the stories must be the buyer's. If a model drafted any paragraph, disclose that the way you disclose an AI design on a shirt. Etsy's current digital-listing rules were not read for this playbook; read them in the same sitting as the Etsy launch playbook before the file goes on Etsy. A kit that tells people to copy a game or a Reddit post is an IP problem on Etsy too. Do not sell that version.

After five support questions, fix the gap that two buyers shared. That is the research.`,
    steps: [
      { id: 'source', title: 'Copy docs/playbooks/faceless-story-channel.md and the public parts of docs/INCOME.md into ~/octopus-content/kits/story-channel/, plus a blank folder tree from the produce-one-video playbook' },
      { id: 'strip', title: 'Delete estate-only lines. Search the folder for hostnames, emails, and secret names. The search returns nothing' },
      { id: 'warning', title: 'Add DO-NOT.md: no commercial gameplay you do not own, no readings of other people\'s posts, no extra accounts to dodge a strike, no income promise' },
      { id: 'toc', title: 'Put a table of contents at the top of the kit README' },
      { id: 'price', title: 'Write the price and the place you will sell in ~/octopus-content/kits/story-channel/LISTING.md, after reading that place\'s current terms' },
      { id: 'sample', title: 'Link one public video made this way, or write that there is not one yet. Do not imply results you do not have' },
      { id: 'list', title: 'Upload the zip yourself. Paste the sales URL into LISTING.md' },
      { id: 'disclose', title: 'If a model wrote any part of the kit, say so on the listing' },
      { id: 'support', title: 'Keep the first five buyer questions. Fix the kit where two people missed the same step' },
      { id: 'next', title: 'A second kit only after the first has ten sales, or after you have written down that the first will not sell' },
    ],
  },
  {
    id: 'weekly-content',
    title: 'Weekly content and money review',
    whenToUse: 'At least one channel has a public video. Once a week, about an hour.',
    background: `One hour. If it takes longer, you are producing during the review. Produce on the other days.

ORDER
1. Money. Shop NET in this app, the Redbubble CSV if this is that week, kit sales written by hand, and the blog only if you are already in that habit. Write the dollars, including zero.
2. Notices. YouTube Studio for each channel, and the shop email, for strikes, claims, and takedowns. A claim stops this routine. Use the ip-complaint or redbubble-takedown playbook, or YouTube's own process if you are sure of the facts. Do not upload more until you know which asset was the problem.
3. One decision. The next artifact is one design, one story, or one kit fix. Not three.
4. Links. Every public shop video still points at a live listing. If a listing was deactivated, edit that description the same day.

Views are not the business. Keep orders, kit sales, and whether a description link was used if Studio shows that source. The exact Analytics label is assumed, unverified. Ignore subscriber count until a channel is near a threshold you just read on the Earn page.

Story stays at two long videos a week or fewer. Shop stays at one video per design.`,
    steps: [
      { id: 'money', title: 'Write this week\'s shop NET, any Redbubble import, and kit sales. Zero is a number you write down' },
      { id: 'inbox', title: 'Check Studio on each channel, and the shop email, for claims, strikes, and IP mail. Stop the routine on a hit' },
      { id: 'listings', title: 'Open each shop video\'s listing URL. Fix the description or unlist the video if the listing is gone' },
      { id: 'pick', title: 'Choose the one next artifact: one design, one story, or one kit fix' },
      { id: 'rights', title: 'If last week\'s upload has an empty rights line, fill it or unlist the video before you make another' },
      { id: 'hours', title: 'Write hours spent. If hours are high and dollars are zero for four weeks, cut the channel that took the hours' },
      { id: 'cadence', title: 'Confirm the story channel is still at two long videos a week or fewer, and the shop channel is still one video per design' },
      { id: 'ypp', title: 'Glance at Earn only to see distance to the threshold printed on that page. Do not change the videos to chase it', detail: YT_YPP },
      { id: 'blog', title: 'If octopus-blog/MONETIZATION.md still has an open clock, one action there counts as this week\'s extra', detail: 'A real Associates tag, or one buyer post actually shared. Confirm the file still says the clock is open.' },
      { id: 'done', title: 'Leave a five-line note: dollars, notices, the next artifact, hours, and the thing you stopped' },
    ],
  },
];

const byId = id => PLAYBOOKS.find(p => p.id === id) || null;
module.exports = { PLAYBOOKS, byId, ETSY_POD, FTC, ETSY_IP, RB_NOAPI, RB_BOTS };
