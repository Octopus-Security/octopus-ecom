# Dropshipping: what is allowed where

<!-- Generated from server/playbooks/definitions.js by server/playbooks/render-md.js. Edit the definition, not this file. -->

**When to use:** You are considering selling items you did not design or make, shipped directly from a third-party supplier. Read this BEFORE building or listing anything.

## Policy landscape

| Where | Position | Provenance |
|---|---|---|
| **Etsy, your own designs on a print-on-demand partner** | Allowed, if you are the designer and the production partner is disclosed. | assumed, unverified (Etsy official pages returned HTTP 403 on 2026-10-05; corroborated by a third-party summary that was read: https://www.listadum.com/blog/understanding-etsys-rules-for-print-on-demand-sellers; official page to check: https://help.etsy.com/hc/en-us/articles/23948763872151) |
| **Etsy, generic manufactured goods you did not design (classic dropshipping, resold marketplace items)** | Not allowed. Summaries describe it as reselling mass-produced items you did not design, and say the partner cannot be listed as creator. | assumed, unverified (Etsy official pages returned HTTP 403 on 2026-10-05; corroborated by a third-party summary that was read: https://www.listadum.com/blog/understanding-etsys-rules-for-print-on-demand-sellers; official page to check: https://help.etsy.com/hc/en-us/articles/23948763872151) |
| **Etsy, items you sourced and sell as sourced/handpicked vintage or supplies** | Different rules apply to those categories; not researched here. | assumed, unverified |
| **Your own storefront (e.g. Shopify, WooCommerce) or other marketplaces** | Generally permitted by the platform, subject to each platform's own terms and any supplier brand-use rules; not researched here. | assumed, unverified |

**What this service does.** It is a POD pipeline for original designs and publishes to Etsy through a production partner. It does NOT implement classic dropshipping. Generic dropshipping is routed to a non-Etsy storefront as a **documented future option**: no Shopify, AliExpress or other dropship adapter is built, and none is planned until the owner asks. If it is ever built it would sit behind the same Storefront/PODProvider adapter contracts, DRY_RUN, approval gate and blocklist.

## Consumer-protection basics (any storefront)

- **You are the seller of record**, so the buyer's problems are yours even though a supplier ships the parcel. The FTC's Mail, Internet, or Telephone Order Merchandise Rule guide says the original seller remains legally responsible when dropshippers or fulfillment houses are used (verified 2026-10-05 - https://www.ftc.gov/business-guidance/resources/business-guide-ftcs-mail-internet-or-telephone-order-merchandise-rule).
- **Shipping-time claims need a reasonable basis** when you make them, and with no stated time the default is 30 days from a properly completed order (verified 2026-10-05 - https://www.ftc.gov/business-guidance/resources/business-guide-ftcs-mail-internet-or-telephone-order-merchandise-rule). Do not advertise "3-5 days" unless the supplier actually achieves it.
- **If you cannot ship on time** you must promptly notify the buyer with a revised date (or say it is uncertain) and offer the choice to cancel for a full, prompt refund; refunds on non-credit payments are due within seven working days (verified 2026-10-05 - https://www.ftc.gov/business-guidance/resources/business-guide-ftcs-mail-internet-or-telephone-order-merchandise-rule).
- Other regimes (EU/UK withdrawal rights, VAT/customs, state sales tax, product-safety rules for children's goods and electronics) apply depending on where you sell and ship: assumed, unverified, check per market.

## Supplier vetting

Order samples yourself; check quality and the true delivery time; confirm they will ship unbranded (no supplier invoice or flyer in the box); get written terms for returns, defects and stock-outs; check they do not sell the same items under a brand that will complain; test one slow and one fast order; keep a second supplier for anything that sells.

## Steps

1. [ ] **Classify the idea: (a) your own design on a disclosed POD partner, or (b) a generic item you did not design** (`classify`)
   Only (a) belongs on Etsy via this service.
2. [ ] **If (b): do NOT list it on Etsy. Pick a non-Etsy storefront you control (a documented future option; no adapter exists)** (`etsy`)
   Etsy position: assumed, unverified (Etsy official pages returned HTTP 403 on 2026-10-05; corroborated by a third-party summary that was read: https://www.listadum.com/blog/understanding-etsys-rules-for-print-on-demand-sellers; official page to check: https://help.etsy.com/hc/en-us/articles/23948763872151).
3. [ ] **Read the target platform's current terms on dropshipping and the supplier's terms before committing money** (`terms`)
4. [ ] **Vet the supplier: samples, real delivery time, unbranded packing, returns/defects terms, stock reliability, backup supplier** (`vet`)
5. [ ] **Check every item for brand, character and design infringement; do not resell knock-offs** (`ip`)
   _Live check: `blocklist_clean`._
6. [ ] **Publish shipping times you can back with evidence from your own test orders** (`times`)
   Reasonable basis; 30-day default if you state nothing (verified 2026-10-05 - https://www.ftc.gov/business-guidance/resources/business-guide-ftcs-mail-internet-or-telephone-order-merchandise-rule).
7. [ ] **Work out margin including refunds, chargebacks and returns shipping, not just unit cost** (`margin`)
   _Live check: `margin_above_floor`._
8. [ ] **Have the delay-notice and cancel-and-refund process written down before the first order** (`delay`)
   verified 2026-10-05 - https://www.ftc.gov/business-guidance/resources/business-guide-ftcs-mail-internet-or-telephone-order-merchandise-rule
9. [ ] **Record the decision with the owner; this service will not build a dropshipping adapter without it** (`owner`)

Policy claims above say `verified 2026-10-05 - <url>` only where that page was read; anything else is `assumed, unverified`.
