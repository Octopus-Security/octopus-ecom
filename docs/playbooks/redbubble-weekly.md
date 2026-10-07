# Weekly Redbubble routine

<!-- Generated from server/playbooks/definitions.js by server/playbooks/render-md.js. Edit the definition, not this file. -->

**When to use:** Once a week (15 minutes), starting the week after the first upload.

Redbubble's sales report is a CSV you request yourself, so the sales import is the one recurring manual task. assumed, unverified (search summary of https://help.redbubble.com/hc/en-us/articles/4412488515092: a CSV sales history is available from the Sales History page and is emailed quarterly; the column headers were not found anywhere)

Because the column headers are unconfirmed, ecom shows a preview of how it read your file (which header it took for which field) before saving anything. If a column is not recognised, the preview says so; the fix is one line (an alias in server/channels/redbubble-sales.js), or use the manual entry form meanwhile.

Money lands in ecom NET as the artist margin of each line, with no fees and no cost of goods (Redbubble bears production). Account fees and the excess markup fee are taken from payouts and are not modelled.

## Steps

1. [ ] **Check the Redbubble account email and dashboard for warnings, IP notices, or works put on hold** (`inbox`)
   If there is an IP notice, switch to the takedown playbook now, before anything else.
2. [ ] **Redbubble: Sales History > request the CSV report (it also arrives by email each quarter); download it** (`csv`)
   assumed, unverified (search summary of https://help.redbubble.com/hc/en-us/articles/4412488515092: a CSV sales history is available from the Sales History page and is emailed quarterly; the column headers were not found anywhere)
3. [ ] **ecom: Sales > Redbubble > paste or choose the CSV > Preview. Check the "read as" mapping and the skipped lines** (`preview`)
   Skipped lines are non-USD rows and unreadable rows. Enter those by hand.
4. [ ] **Import. Re-importing an overlapping file is safe: lines already known are ignored** (`import`)
5. [ ] **Any lines "not matched to a product"? Open the product, check its Redbubble title/URL is recorded, and re-import, or enter the sale by hand against the product** (`unmatched`)
   Matching uses the work number from the URL, then the title.
6. [ ] **Compare the weekly numbers with the 30/60/90-day targets in the Game plan** (`compare`)
7. [ ] **Pick the next 2 to 5 designs to cross-list, from the Game plan criteria, and run the Publish playbook for each** (`crosslist`)
   Products listed on Etsy but with Redbubble state "not listed" are the candidates.
8. [ ] **For works with views but no sales after 30 days: fix the title and tags on Redbubble, one change at a time** (`tags`)
9. [ ] **Check the payout: payments start processing on the 15th once $20 is earned; note the amount in your own books** (`payout`)
   assumed, unverified (search summaries of https://help.redbubble.com/hc/en-us/articles/360035050972 and https://help.redbubble.com/hc/articles/360027407652: payment needs valid payment details and at least $20 earned from orders shipped the previous month; PayPal must be set up as a confirmed account by adding and confirming a bank account; payments start processing on the 15th)

Policy claims above say `verified 2026-10-05 - <url>` only where that page was read; anything else is `assumed, unverified`.
