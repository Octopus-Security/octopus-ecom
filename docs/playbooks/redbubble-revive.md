# Revive a dormant Redbubble account

<!-- Generated from server/playbooks/definitions.js by server/playbooks/render-md.js. Edit the definition, not this file. -->

**When to use:** You are about to use the existing Redbubble account again after a long gap, before the first upload.

Everything on Redbubble is done by you, by hand, in the browser. ecom never signs in to Redbubble and has no password for it: assumed, unverified (search results on 2026-10-06 found no public or partner upload API; the only API integration found is order fulfilment for print partners, https://connect-support.gelato.com/en/articles/10793373-integrating-gelatoconnect-with-redbubble). assumed, unverified (a search summary of https://help.redbubble.com/hc/en-us/articles/202270929-Community-and-Content-Guidelines said uploading with any bot, scraper or other automated means without written permission is prohibited; page returned HTTP 403; read it yourself before relying on this either way)

Do this once. It takes about an hour, most of it cleaning up old works. If anything on the account looks wrong (a warning email, a restricted banner), stop and read it first: a restricted account is a different problem from a dormant one.

Money facts you need: assumed, unverified (search summaries of https://help.redbubble.com/hc/en-us/articles/360035050972 and https://help.redbubble.com/hc/articles/360027407652: payment needs valid payment details and at least $20 earned from orders shipped the previous month; PayPal must be set up as a confirmed account by adding and confirming a bank account; payments start processing on the 15th). Markup: assumed, unverified (search summaries of https://help.redbubble.com/hc/en-us/articles/202270799 and https://blog.redbubble.com/2025/08/excess-markup-fee-explained/: default markup 20%; from 2025-09-01 markup above 20% is charged a 50% excess markup fee on Standard and Premium accounts).

## Steps

1. [ ] **Sign in at redbubble.com yourself; reset the password if needed; turn on two-step sign-in if offered** (`login`)
   Use a password manager entry for this account. Do not store the password in ecom.
2. [ ] **Read every Redbubble email from the last year (warnings, restrictions, policy changes) and any banner on the dashboard** (`inbox`)
   A warning or restriction must be resolved before you upload anything new.
3. [ ] **Read the current Community and Content Guidelines and the User Agreement once, in your own browser** (`terms`)
   ecom could not read them (HTTP 403). The rule that matters most here: assumed, unverified (a search summary of https://help.redbubble.com/hc/en-us/articles/202270929-Community-and-Content-Guidelines said uploading with any bot, scraper or other automated means without written permission is prohibited; page returned HTTP 403; read it yourself before relying on this either way)
4. [ ] **Account settings: profile name, shop name, bio, avatar; bio says what you actually make (original designs), with no brand or third-party names** (`profile`)
5. [ ] **Shop banner / cover image: upload one that uses only your own artwork** (`banner`)
   A simple banner made from one of your own designs is enough; improve it after the first sales.
6. [ ] **Payment details: set the payout currency and PayPal (or the option offered), then confirm the PayPal account is fully set up** (`payment`)
   assumed, unverified (search summaries of https://help.redbubble.com/hc/en-us/articles/360035050972 and https://help.redbubble.com/hc/articles/360027407652: payment needs valid payment details and at least $20 earned from orders shipped the previous month; PayPal must be set up as a confirmed account by adding and confirming a bank account; payments start processing on the 15th). Nothing is paid until you have earned $20 in a month.
7. [ ] **Tax information: complete whatever tax or identity form the dashboard asks for (US person: a W-9 style form) and save it** (`tax`)
   assumed, unverified: Redbubble's tax-form requirements were not found in searches; follow the prompts in your account. Income is yours to report; ask a tax adviser how, ecom NET is operational, not accounting.
8. [ ] **Open Manage Portfolio and list every old work: title, image, tags, whether it sold** (`old-review`)
   Write down which ones to keep, fix, or delete before touching anything.
9. [ ] **For each old work: delete it if it uses anything you do not own (a brand, character, team, lyric, celebrity, a template you cannot license) or if you cannot say where every element came from** (`old-ip`)
   Old works with an IP problem are the biggest risk to a revived account. When unsure, delete.
10. [ ] **For works you keep: set markup to 20%, fix titles and tags, tick the AI checkbox if an AI tool made any part** (`old-fix`)
   assumed, unverified (search summaries of https://help.redbubble.com/hc/en-us/articles/202270799 and https://blog.redbubble.com/2025/08/excess-markup-fee-explained/: default markup 20%; from 2025-09-01 markup above 20% is charged a 50% excess markup fee on Standard and Premium accounts). assumed, unverified (a search summary says Redbubble has an AI-generated checkbox on upload; a different search could not find any AI wording in its Community and Content Guidelines; the upload form is the authority)
11. [ ] **Delete or hide very low-quality works (blurry, tiny, no tags): they cost nothing to keep but drag the shop page down** (`old-low`)
12. [ ] **Turn on the email notifications you want (sales, messages, policy notices) and make sure the email address on the account is one you read** (`prefs`)
   The takedown playbook depends on you seeing these emails quickly.
13. [ ] **Back in ecom: confirm the product you want to list first has a design, then open its Redbubble section and download the pack** (`sandbox`)
   Next playbook: Publish a design to Redbubble.

Policy claims above say `verified 2026-10-05 - <url>` only where that page was read; anything else is `assumed, unverified`.
