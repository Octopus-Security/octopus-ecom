# Compliance assumptions (2026-10-05)

This records the policies and terms the design leans on, how sure we are of each, and what the software does to stay inside them.
It is not legal advice. **Provenance rule:** a claim says `verified 2026-10-05 - <url>` only if that page was read in the session that
wrote this file (through a fetch tool that summarises the page, so wording is the summary's, not a verbatim quote); everything else says
`assumed, unverified`, with the secondary source if one was read. Where a policy page is not verified, check the official page before
relying on it. Etsy's own legal and help pages (`etsy.com/legal/*`, `help.etsy.com`) and OpenAI's terms page returned **HTTP 403** to the
fetch tool on 2026-10-05, so no Etsy seller/IP/Creativity claim and no OpenAI claim below is verified.

## 1. Etsy seller policy, IP policy and Creativity Standards

| Claim | Status |
|---|---|
| Items fall into categories "Made by", "Designed by", "Handpicked by", "Sourced by" a seller; a design you created that a third party produces (print on demand), or that is generated with AI from your own prompts, is "Designed by". | assumed, unverified. Secondary source read: https://www.listadum.com/blog/etsy-creativity-standards (a third-party blog; official page `https://www.etsy.com/legal/creativity` returned 403). |
| An outside **production partner must be disclosed** (shop page / listing) and the seller must remain the creative force behind the item. | assumed, unverified (same secondary source; also a search-result summary naming Etsy's pages). |
| **AI-generated designs are allowed if you supply the prompts and shape the result, but must be disclosed** to buyers in the listing (and the AI checkbox ticked, with "Designed by", in the listing form). Selling prompt bundles alone is not allowed. | assumed, unverified (same secondary source plus search summaries, https://techcrunch.com/2024/07/09/etsy-new-seller-policy-2024-generative-ai). Whether the listing form's exact wording and checkbox exist today is unconfirmed. |
| Selling goods that use others' brands, characters, teams or likenesses without permission is an IP violation that can lead to takedowns, shop suspension or loss of the account. | assumed, unverified (https://etsy.com/legal/ip/ returned 403; only search summaries seen). |
| Reselling mass-produced items you did not design (classic dropshipping) is not allowed. | assumed, unverified. |

**What this software does about it.** Designs are generated original; trend input is the operator's typed keywords only and nothing from other
sellers is fetched (there is no scraper, and a test fails if a watcher source fetches competitor data). A trademark/IP blocklist flags brief,
title, tags and description (`server/domain/blocklist.js`); a flag blocks agent approval and autopublish and is listed in the human approval
summary. Batches refuse a branded niche and drop branded concepts. Nothing publishes without a human approval (or, only where store
autopublish is on, DRY_RUN is off and there are no flags). **Gap:** the software does **not** yet write an AI disclosure into the listing
description, tick Etsy's AI checkbox, or set "Designed by"; Printify publishes the listing, so the operator must check these on Etsy.
See open questions.

## 2. Etsy Open API v3

| Claim | Status |
|---|---|
| Rate limits are application-level at the API-key level: queries per second and queries per day (sliding 24-hour window), checked QPS first; headers `x-limit-per-second`, `x-remaining-this-second`, `x-limit-per-day`, `x-remaining-today`; `retry-after` on 429. The numeric limits are shown in the developer portal, not the docs. | verified 2026-10-05 - https://developers.etsy.com/documentation/essentials/rate-limits |
| OAuth 2 with **mandatory PKCE** (43-128 character verifier, SHA-256 challenge); access token 3600 s; refresh token 90 days. Scopes: `address_r email_r listings_r profile_r shops_r transactions_r` and `address_w listings_d listings_w profile_w shops_w transactions_w`. | verified 2026-10-05 - https://developers.etsy.com/documentation/essentials/authentication |
| **Scopes this app requests:** `listings_r listings_w transactions_r shops_r` and no others (listing reads/edits, receipts and refunds, shop lookup). | verified as to the scope names above; the choice of the four is ours (`server/etsy/auth.js`). |
| Endpoint paths and shapes used (receipts, payments `amount_fees`, listing inventory, `ShopRefund` with no id field, `Listing.views`) match the published OpenAPI document. | verified 2026-10-05 - https://www.etsy.com/openapi/generated/oas/3.0.0.json (downloaded and inspected, including the `ShopRefund` schema) |
| Etsy API Terms of Use prohibit automated systems or scraping of Etsy data without Etsy's written authorisation; access tiers are Seller App (own shop only), Personal App, Commercial Access (multi-seller, separate review). | assumed, unverified. Secondary source only: search-result summary of https://www.etsy.com/legal/api (official page 403). |
| Data-use restrictions (retention, sharing, use of buyer data) apply to what we store from receipts. | assumed, unverified: the terms were not read. |

**What this software does.** Own shop only: one connected shop under the operator's own account (the lowest access tier is enough; commercial
access is not requested and the app must not be used to serve other sellers). Tokens are sealed at rest and never returned by the API or
logged. A per-host token bucket holds Etsy to `ETSY_QPS` (default 4) and `ETSY_QPD` (default 4000), both our own conservative assumptions;
`x-remaining-today` is honoured; 429s back off honouring `retry-after`. It stores sale amounts and the receipt/transaction/listing ids needed
for accounting and reads **no buyer personal data** (no names, addresses or emails are requested or stored). It never reads other sellers'
listings.

## 3. Printify API

| Claim | Status |
|---|---|
| Limits: 600 requests/min globally, catalog endpoints 100/min per account, publishing 200 per 30 minutes; excess gets 429. | verified 2026-10-05 - https://developers.printify.com/ (read in M2; search summary re-checked 2026-10-05) |
| API Terms: you are solely responsible for content you create or upload through the API and warrant you own or have licensed it (granting Printify a licence to use it to fulfil orders); do not build applications that excessively burden the system; do not request more data than needed; delete merchant data on request/uninstall (30 days) and report a breach within 24 hours. | verified 2026-10-05 - https://printify.com/api-terms/ (summary of the page) |
| Whether Printify's own acceptable-use or IP rules additionally restrict AI-generated artwork. | assumed, unverified: not read. |

**What this software does.** Catalog calls are paced under the limit and cached; publishes are rare and human-approved. It uploads only designs
generated for the product and never downscales (a design that is too big fails visibly instead). It stores Printify product ids and costs
only, no merchant customer data. The blocklist and approval gate exist precisely because the uploader carries the IP warranty.

## 4. OpenAI image generation (gpt-image-1) and usage policies

| Claim | Status |
|---|---|
| Under OpenAI's terms the user owns the output and may use it commercially (OpenAI assigns its rights in output to the user); outputs are not exclusive (similar outputs may be produced for others); inputs/outputs may be used to improve services unless opted out. | assumed, unverified. https://openai.com/policies/terms-of-use/ returned 403; only third-party/search summaries seen (e.g. https://terms.law/ai-output-rights/chatgpt/). The API's own business terms may differ from the consumer terms summarised. |
| Purely AI-generated output may not be copyrightable in the US without sufficient human authorship (US Copyright Office guidance). | assumed, unverified (secondary summary). Practical consequence: the shop may not be able to stop copying of a design. |
| OpenAI's usage policies bar generating infringing or deceptive content. | assumed, unverified: not read. |

**What this software does.** The image prompt tells the model: original artwork, no logos, no brand names, no trademarked characters, no
watermarks (`server/domain/prompts.js`); the brief is blocklist-checked before any spend. The key is BYOK (sealed or env), generation is capped
per ET day, and the cost table is dated. It does not feed any competitor image into a model.

## 5. FTC Mail, Internet, or Telephone Order Merchandise Rule

verified 2026-10-05 - https://www.ftc.gov/business-guidance/resources/business-guide-ftcs-mail-internet-or-telephone-order-merchandise-rule
(read for the operator playbooks; reused here, not re-read for this file). In summary: the seller remains responsible when a supplier ships;
shipping-time claims need a reasonable basis (30 days by default if none is stated); a delay needs a prompt notice with a cancel-and-refund
option; refunds on non-credit payments are due within seven working days. **What this software does:** nothing automated; the playbooks
(`docs/playbooks/`) carry the checklists and the supplier watcher flags out-of-stock variants. Delivery-time statements in listings are the
operator's responsibility.

## 6. Other safeguards, in one place

- **No cloning or scraping:** no code fetches competitor titles or images; keyword signals are operator-typed and validated to `{message, severity}`.
- **Approval gate:** `published` is reachable only from `approved`; a human approves with a confirm summary naming price, margin, flags and blocklist hits.
- **DRY_RUN (default on):** every marketplace/POD write is faked; arming live writes needs a typed phrase.
- **Spend cap:** daily, ET calendar, checked before each paid call; a batch pauses rather than fails.
- **Print readiness:** a design below the print area's pixel size cannot reach mockup_ready (`PRINT_MIN_COVERAGE`, `PRINT_FIT`).
- **Credentials:** AES-256-GCM sealed, scrypt-derived key, never returned by the API; logs pass a redactor that knows every stored secret.
- **Rate limits and retries:** one HTTP wrapper with per-host buckets and jittered backoff; non-GET requests are not retried on 5xx.
- **Fees:** **verified 2026-10-06** from Etsy's own "Fees for selling on Etsy" page (shown during shop setup), read by the owner: $29 one-time set-up fee; $0.20 listing fee (create or renew); 6.5% transaction fee on the order total excluding tax; 3% + $0.25 payment processing on the order total including tax and shipping (US); 2.5% currency conversion when listing and payout currencies differ; Offsite Ads 12-15% on ad-driven sales (optional for most sellers); fees exclude VAT/similar taxes. They are an editable schedule (`server/domain/fee-schedule.js`, Settings -> Etsy fees); each projection records the schedule version it used. **Assumed, unverified (not on that page):** which of 12%/15% applies (commonly 15% under $10k/yr, 12% at or above); a $100 per-order Offsite Ads cap; the currency-conversion base (order total incl. tax); the sales-tax rate (7%, an estimate used only for the processing-fee base); the expected Offsite Ads share (default 0). **Not modelled:** the $0.20 auto-renew fee charged again on each sale of a multi-quantity listing (assumed, unverified). Where real Etsy receipts are ingested, Etsy's reported processing fee remains the truth; the schedule is only the fallback and the transaction-fee computation.
- **Trend sources and numeric metrics (added 2026-10-06; the owner must accept this widening).** The text-signal rule above is unchanged and strict: `validateSignals()` still accepts only `{message, severity}` and `FORBIDDEN_KEYS` is untouched. Numbers travel a second, separate path, `server/trends/metrics.js`: a closed whitelist of metric names, finite numbers only, a term that WE supplied (never a string from a response), and a sample of at least 20 for any aggregate over market listings, so no single listing is identifiable. Any other field, a competitor-shaped key, or an unknown metric rejects the whole batch. The Etsy market source stores only count, quartile prices, new-listing velocity, a favourites distribution and a taxonomy share: never a title, tag, description, image, URL, shop name or id, or listing id, and it never calls a shop endpoint (a test asserts the stored rows contain none of them). **It ships disabled.** Etsy's API Terms reportedly bar using the API to collect Etsy content for analytics unless expressly authorised (corroborated from search summaries only; Etsy's legal pages returned HTTP 403 on 2026-10-06, so the wording is unread). Turning it on is a confirm-gated owner action whose summary reads: "Read Etsy's current API Terms first; search summaries suggest analytics use may need Etsy's authorisation." It is also off while Etsy credentials are missing or Etsy has refused the key (HTTP 401/403), and it goes through the same per-host rate limiter and daily allowance as every Etsy call, stopping at `ETSY_QPD_RESERVE` (default 20) left. **Record here, with a date, what the owner concluded after reading the live terms:** not yet decided. Wikimedia Pageviews needs a descriptive User-Agent with a contact taken from `TREND_CONTACT` (assumed from the access policy, corroborated, page not read); the source is disabled without one. Paid-tool CSVs are exported by a person and imported keyword-level only; their layouts are assumed (fixtures are named ASSUMED-HEADERS). Manual entries are the owner's own dated notes. Scores are proxies: no source shows other sellers' sales.

## 7. Redbubble (second channel, manual)

Researched 2026-10-06; Redbubble's help, blog and terms pages all returned HTTP 403, so every claim is a search-result summary and stays
`assumed, unverified` here; the table with sources and per-claim status is in `docs/CHANNELS.md`. What matters for compliance:

- **No automation.** A summary of Redbubble's Community and Content Guidelines says uploading with any bot, scraper or other automated means without written
  permission is prohibited (https://help.redbubble.com/hc/en-us/articles/202270929-Community-and-Content-Guidelines). ecom therefore only prepares files and text; a person uploads. Do not add login or browser automation.
- **Same IP standard as Etsy.** The blocklist runs on the Redbubble copy (a hit is a lint error). Takedown handling: `docs/playbooks/redbubble-takedown.md`.
- **AI.** A search summary says Redbubble has an AI-generated checkbox on upload; another source found no AI wording in the guidelines. The pack's checklist tells the operator to tick it for AI-made designs. The upload form is the authority.
- **Money and tax.** Redbubble pays the artist margin; account fees and any excess markup fee come off payouts and are not in NET. Tax-form requirements were not found; follow the account's prompts.


## 8. Proposals (original ideas generated for the owner to review)

**Proposals never derive from a specific competitor listing or image.** The generator is given only: the owner's typed seeds (themes, occasions,
audiences), the owner's own watchlist terms and notes, trend signals that have passed `validateSignals` (a message and a severity, nothing else), and
the owner's own earlier rejections. It has no access to, and no code path to fetch, another seller's title, tags, description, image, price or shop
(a test greps the proposals code for network calls). The prompt tells the model it has none and must not imitate one, and it must refuse brands,
characters, celebrities, team names, protected phrases and "inspired by <seller>". Do not paste a competitor's listing text into a seed: seeds are
passed to the model as themes.

| Claim | Status |
|---|---|
| Seeds, watchlist terms and every trend signal are checked against the trademark blocklist before use; a blocklisted seed refuses the whole generation (422). | Implemented and tested (text only: it cannot see a logo, a likeness, a misspelling or an unlisted name). |
| Each proposal is checked three ways (blocklist over every field, a phrase tripwire for "inspired by" / "in the style of" / "fan art" / "official" / "parody of" and similar, the model's own originality self-check). A hit is dropped at generation, and cannot be approved if introduced by an edit. | Implemented and tested. The phrase list is a regular expression and misses paraphrase. A clean result is "nothing obvious", never "cleared". |
| A proposal's Etsy limits (title 140, 13 tags of 20 characters) and Redbubble limits are enforced and linted by `etsy-rules.js` and `redbubble-rules.js`. | The limits carry those files' own provenance: assumed / corroborated, **not verified** against an official page. |
| AI-generated designs must be disclosed on Etsy; Redbubble has an AI checkbox. | **Still the operator's job.** Proposals do not write an AI disclosure and do not tick any box (open question 1 above). The proposal description deliberately claims nothing about being handmade, official or licensed. |
| Price and margin on a proposal are projections from the editable fee schedule and a catalog or assumed base cost. | **Estimates.** Printify exposes the real base cost only on a created product. The assumed per-type base costs are placeholders: assumed, unverified, not Printify prices. |
| "List by" and "last realistic order" dates, and the "too late" flag. | Holiday dates are calendar rules. **The lead times (production 5, shipping 10, buffer 3, listing ramp 21 days) are assumed, unverified**: no Printify or carrier schedule was read. Replace them in the Proposals settings with the published schedules, and see the `seasonal-prep` playbook. Delivery promises in a listing need a reasonable basis (section 5). |
| The weekly digest generates ideas on a timer. | OFF by default (`proposals_weekly_enabled`). It only creates pending proposals and spends model tokens under the daily cap (or on the owner's cortex account); it never approves, creates a product or publishes. |

Approving a proposal creates a product in the IDEA stage and nothing else; every later gate (print readiness, flags, the human approval and its confirm,
DRY_RUN) applies unchanged. Someone still has to look at the finished image before approval: the blocklist is text only.


## Open questions for the operator

1. **AI disclosure on Etsy.** Secondary sources say AI-made designs must be disclosed in the listing, with "Designed by" and an AI checkbox. Read
   the current official Creativity Standards and decide the standard disclosure sentence. The app does not add it today; decide whether it should
   append it to every draft description.
2. **Production-partner disclosure.** Confirm the shop page lists Printify and the print provider(s), and the listing shows the ship-from country.
3. **Etsy API access tier and terms.** Confirm the app is registered as own-shop access, read the current API Terms of Use (data retention,
   buyer data, "commercial use" wording) and the actual QPS/QPD in the developer portal.
4. **Trademark of the shop's own name.** "Octopus Technology" (the shop) was not searched in any trademark register; do that before building a
   brand around it, and check the same for any design-line names. The blocklist protects against others' marks, not against yours colliding with
   one.
5. **Sales tax / VAT.** Etsy collects and remits marketplace tax in many places, but whether the operator has registration or income-tax
   obligations, and how COGS and fees should be booked, is outside this software. NET here is operational, not tax accounting.
6. **Refund treatment of fees.** The sales ingest assumes Etsy does not return its fees on a refund and does not reverse COGS (conservative).
   Check against a real refunded order and adjust.
7. **Copyright in AI output.** Decide whether you need protection against copying of the designs; the position on registrability is unsettled.
8. **Blocklist coverage.** The seed is a text list of names, not a trademark search; it cannot see logos, likenesses or misspellings. Decide who
   reviews designs visually before approval.
9. **OpenAI and Printify content rules.** Read OpenAI's current usage policies and Printify's acceptable-use and IP terms for AI-generated art.
