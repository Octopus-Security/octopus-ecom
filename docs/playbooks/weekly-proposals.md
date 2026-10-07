# Weekly proposals review

<!-- Generated from server/playbooks/definitions.js by server/playbooks/render-md.js. Edit the definition, not this file. -->

**When to use:** Once a week, or whenever the Proposals tab has new cards: decide what becomes a product, what waits, and what the next batch should avoid.

The Proposals tab holds original product ideas generated from your seeds (themes, occasions, audiences), your watchlist and any trend signals, with the season window worked out for each. Nothing is published from there: approving a proposal only creates a card in the IDEA stage, pre-filled, which then goes through the normal pipeline and the normal approval gate. Every price and margin on a proposal is an ESTIMATE (the real Printify base cost is only read when the POD product is created). The lead times behind "too late" and "list by" are assumed, unverified planning defaults (production 5 days, shipping 10, buffer 3, listing ramp 21): replace them with your print provider's and carrier's published schedule for the year (see the seasonal-prep playbook). A clean originality check means "nothing obvious", never "cleared": the blocklist reads text only and cannot see a logo or a likeness, so look at the finished design too. Proposals are never derived from a specific competitor listing or image, and you should not paste one into a seed. Weekly generation is OFF by default; turn it on in the Proposals tab if you want a batch each week (it spends model tokens, under the daily cap, or through cortex on your account).

## Steps

1. [ ] **Open the Proposals tab; if generation is off, press Generate with this week's seeds (occasions coming up, themes you care about)** (`open`)
2. [ ] **Read the season line on each card first: anything marked TOO LATE is for next year (snooze it to the "list by" date) and anything TIGHT needs listing now** (`season`)
   The dates come from assumed, unverified lead times; check them against the provider and carrier schedule.
3. [ ] **For each card you like, read the risk panel and run its ready-made originality prompt in any model you trust; refuse anything that reads as a brand, character, celebrity, team, protected phrase or "inspired by" another seller** (`originality`)
   _Live check: `blocklist_clean`._
4. [ ] **Check the Etsy title and the 13 tags read like what a buyer would type, and that the lint shows no errors; fix inline** (`copy`)
5. [ ] **Check the estimated price and margin; edit the price if you disagree (the margin recomputes)** (`price`)
   It is an estimate until the POD product is created and the real base cost is read.
6. [ ] **Approve (or edit and approve), snooze, or reject; when you reject, write the reason, because the next batch is told what you did not like** (`decide`)
7. [ ] **Approved proposals are IDEA cards: generate or upload the design, then continue through the normal pipeline and approval gate** (`pipeline`)
8. [ ] **Nothing left unreviewed for more than a week** (`backlog`)
   _Live check: `proposals_reviewed`._

Policy claims above say `verified 2026-10-05 - <url>` only where that page was read; anything else is `assumed, unverified`.
