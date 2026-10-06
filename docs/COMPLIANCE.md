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
- **Fees:** Etsy fee constants are *corroborated, official page not read* (see `server/domain/fees.js`); projected margins depend on them.

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
