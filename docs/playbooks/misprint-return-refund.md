# Misprint, return or refund

<!-- Generated from server/playbooks/definitions.js by server/playbooks/render-md.js. Edit the definition, not this file. -->

**When to use:** A buyer reports a defective, misprinted, damaged, wrong or lost item, or asks for a return.

Provider reprint/refund policies differ and time-limit claims; read the provider's current policy rather than relying on this list (assumed, unverified: no provider policy was read for this document). Refund timing for orders you cannot fulfil: a refund must be prompt, within seven working days for non-credit payments under the Mail Order Rule (verified 2026-10-05 - https://www.ftc.gov/business-guidance/resources/business-guide-ftcs-mail-internet-or-telephone-order-merchandise-rule). Etsy's own case/dispute rules were not read (assumed, unverified).

## Steps

1. [ ] **Ask for a photo of the item and packaging; keep it with the order** (`evidence`)
2. [ ] **Classify: production fault (misprint/damage), carrier fault (lost/damaged in transit), or buyer preference** (`classify`)
3. [ ] **Reply to the buyer quickly and plainly with the fix you are offering** (`respond`)
4. [ ] **Production fault: open a reprint or refund claim with the print provider within their window; keep the order id and photos** (`provider`)
5. [ ] **Refund the buyer yourself if the provider will not; record the cost as a cost row so NET stays honest** (`refund`)
6. [ ] **Misprints repeating? Re-check the design against the blueprint print area and DPI, and consider another provider** (`design`)
   _Live check: `has_design`._
7. [ ] **Note what happened; if one product keeps failing, archive it** (`close`)

Policy claims above say `verified 2026-10-05 - <url>` only where that page was read; anything else is `assumed, unverified`.
