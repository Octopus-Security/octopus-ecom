# IP / trademark complaint received

<!-- Generated from server/playbooks/definitions.js by server/playbooks/render-md.js. Edit the definition, not this file. -->

**When to use:** Etsy (or a rights holder) notified you of an intellectual-property complaint, removed a listing, or sent a takedown.

Policy here is simple: comply, do not argue a clone. Etsy's process, as seen in secondary sources, is a notice, removal, and for copyright a counter-notice path; repeat notices can end the shop (assumed, unverified (https://etsy.com/legal/ip/ returned HTTP 403 on 2026-10-05; only search-result summaries were seen)). A counter-notice is a sworn legal statement: file one only for a genuine mistake (the design really is yours or licensed), and consider a lawyer. This is operational guidance, not legal advice.

## Steps

1. [ ] **Read the notice fully: who complained, which listing(s), what is claimed (copyright, trademark, design)** (`read`)
2. [ ] **Stop selling the item: take the listing down yourself and archive the product in the panel; do not relist a variation** (`stop`)
3. [ ] **Check the rest of the catalogue for the same design, theme or term; the blocklist check helps but is not complete** (`scan`)
   _Live check: `blocklist_clean`._
4. [ ] **Add the offending brand/character/phrase to the blocklist so it cannot recur** (`blocklist`)
5. [ ] **Work out how it got through: the brief, the generated design, the keywords, or the trend source. Fix the cause** (`origin`)
6. [ ] **Reply to Etsy/the rights holder politely, confirming removal. Do not argue** (`respond`)
7. [ ] **Only if you are certain the work is yours or licensed: consider a counter-notice (legal statement under penalty of perjury); take advice first** (`counter`)
8. [ ] **Open orders for the item: handle per the misprint/refund playbook; do not ship infringing goods** (`orders`)

Policy claims above say `verified 2026-10-05 - <url>` only where that page was read; anything else is `assumed, unverified`.
