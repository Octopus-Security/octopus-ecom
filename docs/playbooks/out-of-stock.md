# Supplier or variant out of stock

<!-- Generated from server/playbooks/definitions.js by server/playbooks/render-md.js. Edit the definition, not this file. -->

**When to use:** The supplier watcher raised an "out of stock" alert, or an order was held because a variant is unavailable.

A listing that keeps selling something you cannot fulfil leads to cancellations, late shipments and bad reviews. Under the FTC Mail Order Rule you need a reasonable basis for your shipping-time claims and must send a delay notice with a cancel-and-refund option when you cannot ship on time (verified 2026-10-05 - https://www.ftc.gov/business-guidance/resources/business-guide-ftcs-mail-internet-or-telephone-order-merchandise-rule).

The watcher only reads. Nothing is changed on Etsy or at the provider automatically.

## Steps

1. [ ] **Confirm the outage at the provider's own catalogue, not just from the alert** (`confirm`)
   The alert reflects one read; stock can flip back.
2. [ ] **Which variants (sizes/colours) and which listings are affected?** (`scope`)
   _Live check: `no_open_alerts`._
3. [ ] **Deactivate or edit the affected variants on the listing (a human action in Etsy/Printify)** (`pause`)
   This tool does not edit live listings from an alert.
4. [ ] **Open orders for the variant: tell the buyer promptly with a firm new date, or offer cancel and full refund** (`orders`)
   Do not make a buyer wait silently (verified 2026-10-05 - https://www.ftc.gov/business-guidance/resources/business-guide-ftcs-mail-internet-or-telephone-order-merchandise-rule).
5. [ ] **Consider an alternative print provider for the same blueprint; re-check its base cost and margin** (`alt`)
   _Live check: `margin_above_floor`._
6. [ ] **When stock returns, re-enable variants and acknowledge the alert** (`restock`)

Policy claims above say `verified 2026-10-05 - <url>` only where that page was read; anything else is `assumed, unverified`.
