# Base cost rose and margin fell below the floor

<!-- Generated from server/playbooks/definitions.js by server/playbooks/render-md.js. Edit the definition, not this file. -->

**When to use:** The supplier watcher flagged a product (margin <= 0 or below MARGIN_FLOOR). The flag blocks autopublish; a live listing keeps selling at the old price until you act.

Projected margin = list price - POD base cost - listing fee - transaction fee - processing fee (see server/domain/fees.js; the fee constants there carry their own provenance and are third-party-corroborated only, as Etsy's fee pages returned HTTP 403). Raising price is a human decision; this tool never edits a live price.

## Steps

1. [ ] **Read the alert: old and new base cost, new projected margin** (`see`)
   _Live check: `margin_above_floor`._
2. [ ] **Confirm the new cost at the provider (not a transient read)** (`verify`)
3. [ ] **Choose: raise the price, switch print provider, change blueprint, or retire the product** (`options`)
   Check that a higher price does not tank conversion: compare against your own listing stats only.
4. [ ] **If repricing, edit the price on the listing yourself and update list_price in the panel; the margin recomputes on the next watch run** (`reprice`)
5. [ ] **Run the supplier watch now and confirm the flag clears** (`recheck`)
   _Live check: `no_flags`._
6. [ ] **Acknowledge the alert** (`ack`)

Policy claims above say `verified 2026-10-05 - <url>` only where that page was read; anything else is `assumed, unverified`.
