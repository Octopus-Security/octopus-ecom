# Launch a new POD product on Etsy

<!-- Generated from server/playbooks/definitions.js by server/playbooks/render-md.js. Edit the definition, not this file. -->

**When to use:** A product is moving from idea to a live Etsy listing, using your own original design and a print-on-demand production partner.

The pipeline already enforces the gates (human approval, margin floor, blocklist, print readiness). This list is the human side: what to look at before pressing approve.

- Own designs only. Do not use another seller's artwork, a "winning" listing as a reference image, or a brand, franchise, character or team. Trend data informs themes and keywords only.
- Etsy and production partners: using a print-on-demand partner for your own original designs is allowed provided the partner is disclosed as a production partner (assumed, unverified (Etsy official pages returned HTTP 403 on 2026-10-05; corroborated by a third-party summary that was read: https://www.listadum.com/blog/understanding-etsys-rules-for-print-on-demand-sellers; official page to check: https://help.etsy.com/hc/en-us/articles/23948763872151)).
- Pushing to live is irreversible in the sense that matters (a listing fee is charged and the listing is public). Approving is a confirm-gated step in the panel.

## Steps

1. [ ] **Design is original, generated here, and not derived from anyone else's listing** (`original`)
   If you cannot say where every element came from, do not publish.
2. [ ] **No brand, franchise, character or team in brief, title or tags** (`blocklist`)
   _Live check: `blocklist_clean`._
3. [ ] **Blueprint and print provider chosen** (`pod`)
   _Live check: `has_pod_provider`._
4. [ ] **Design exists and passed the print-readiness check** (`design`)
   _Live check: `has_design`._
5. [ ] **Projected margin is positive and above the floor** (`margin`)
   Remember the model leaves out offsite ads, currency conversion and listing renewals.
   _Live check: `margin_above_floor`._
6. [ ] **Title <=140 chars, <=13 tags, each <=20 chars** (`tags`)
   _Live check: `etsy_tag_rules`._
7. [ ] **Product carries no flags** (`flags`)
   _Live check: `no_flags`._
8. [ ] **Production partner is disclosed on the listing; you are listed as designer, the partner is not listed as the maker** (`disclose`)
   Etsy: assumed, unverified (Etsy official pages returned HTTP 403 on 2026-10-05; corroborated by a third-party summary that was read: https://www.listadum.com/blog/understanding-etsys-rules-for-print-on-demand-sellers; official page to check: https://help.etsy.com/hc/en-us/articles/23948763872151).
9. [ ] **Processing and delivery times on the listing match what the provider actually quotes** (`shipping`)
   Shipping-time claims need a reasonable basis (verified 2026-10-05 - https://www.ftc.gov/business-guidance/resources/business-guide-ftcs-mail-internet-or-telephone-order-merchandise-rule).
10. [ ] **Mockups show the real product and do not imply handmade-by-you if a partner makes it** (`mockups`)
11. [ ] **DRY_RUN state is what you intend** (`dry`)
   _Live check: `dry_run_state`._
12. [ ] **Approve (confirm modal), publish, then watch the first week of own-shop stats** (`approve`)

Policy claims above say `verified 2026-10-05 - <url>` only where that page was read; anything else is `assumed, unverified`.
