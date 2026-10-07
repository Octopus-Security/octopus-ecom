# Sales channels

ecom sells the same approved design in more than one place. A **channel** is one of those places. The thing that matters
about a channel is how much of the work software may do, so every channel carries a **capability flag**:

| Channel | Capability | Meaning |
|---|---|---|
| Etsy | `api` | The marketplace has an API ecom is allowed to use. ecom publishes through Printify, reads sales and refunds, and edits listings itself, still behind the approval gate, the confirm modal and DRY_RUN. |
| Redbubble | `manual` | No usable API and the rules reportedly forbid automation. ecom **prepares** (a pack and a checklist), a **person uploads**, and ecom **tracks** state and imports sales from what the person brings back. |

Code: `server/channels/contract.js` (the contract and `assertChannel`), `server/channels/index.js` (the registry),
`GET /api/channels` (what the panel reads). This is separate from `server/adapters/`, which holds the interfaces ecom calls
over HTTP; a channel is the operator-facing idea and may sit on top of an adapter (Etsy does) or on none (Redbubble).

## What is automated, and what is not

### Etsy (`api`)

| Automated | Manual |
|---|---|
| Design, mockup, draft copy, margin projection | Approving a listing (a human click, by design) |
| Publish through Printify; status reconcile | Etsy-side settings: shipping profile, AI and "designed by" fields |
| Sales and refund sync; fees; per-sale cost of goods | Etsy Ads and the monthly Plus fee |
| Edit live title, tags, price | |

Playbooks: `launch-pod-etsy`, `margin-fell`, `views-no-sales`, `seasonal-prep`, `ip-complaint`.

### Redbubble (`manual`)

| Automated (ecom does it) | Manual (you do it) |
|---|---|
| **Upload pack** per product: the design PNG sized for Redbubble (real size reported), title, main tag, supporting tags, description, suggested markup, which product types to enable, a checklist for that design | Sign in and upload (there is no upload API; bots are reportedly prohibited) |
| Copy adapted from the Etsy copy and **linted** (title, tags, description, blocklist) | Paste each field into the form (every field has a copy button) |
| **Listing state** per product: not listed, uploaded, live, removed, plus the work URL | Paste the work URL back into ecom |
| **Sales import** from Redbubble's CSV, or a hand-entered line, attributed to the channel and counted in NET | Request and download the CSV from the Sales History page |
| Five playbooks (below) | Payment and tax settings; answering IP notices; the decision to contest one |

Playbooks: `redbubble-revive`, `redbubble-publish`, `redbubble-weekly`, `redbubble-takedown`, `redbubble-game-plan` (all in
`docs/playbooks/`, generated from `server/playbooks/definitions.js`).

## Why Redbubble is manual (researched 2026-10-06)

Redbubble's own help pages, blog and terms all returned **HTTP 403** to the fetch tool, so nothing below was read on an official page.
The status words follow the repo rule: `corroborated` means a search-result summary of the official page or several independent guides
agree; `assumed` means one source, or sources disagree. Confirm anything that matters in your own browser.

| Fact | Status | Source |
|---|---|---|
| No public or partner API to upload or list works. The only API integration found is order fulfilment for print partners. | corroborated | search results; https://connect-support.gelato.com/en/articles/10793373-integrating-gelatoconnect-with-redbubble |
| Uploading with "any bot, scraper, or other automated means" without written permission is prohibited | corroborated (a search summary of the guidelines; page unread) | https://help.redbubble.com/hc/en-us/articles/202270929-Community-and-Content-Guidelines |
| Third-party tools that automate uploads with Selenium exist; that does not make them allowed | n/a | https://automation-docs.lazymerch.com/upload/redbubble |
| Recommended size 7632x6480 px (big enough for a king-size duvet cover); PNG; maximum 13500x13500 px or 300 MB | corroborated | https://blog.redbubble.com/2018/05/uploading-on-redbubble/ , https://icons8.com/blog/articles/redbubble-image-size/ |
| Per-product minimums (sticker about 2800x2800, tee about 2875x3900; some products need square art) | assumed (third-party; Redbubble scales and crops per product) | https://icons8.com/blog/articles/redbubble-image-size/ , https://www.topbubbleindex.com/blog/redbubble-sizing-guide/ |
| Up to 15 tags, 50 characters each; one main tag plus supporting tags | tags corroborated, the main/supporting split assumed | https://help.redbubble.com/hc/en-us/articles/360047166432 |
| Title 60 characters | assumed (one guide says strict 60, another says no hard limit) | https://metadatareactor.com/blog/how-to-grow-on-redbubble-2026/ |
| Description 250 or 500 characters | assumed (sources disagree); ecom warns above 250 and errors above 500 | https://autokeyworder.com/redbubble-tag-generator/ |
| "Copy settings from existing work" in the upload form carries tags, markup and product settings over | corroborated | https://help.redbubble.com/hc/en/articles/202982515 |
| Price = base price + your markup; default markup 20%. From 2025-09-01 markup above 20% pays a 50% excess markup fee (Standard and Premium accounts); platform fee is separate | corroborated | https://help.redbubble.com/hc/en-us/articles/202270799 , https://blog.redbubble.com/2025/08/excess-markup-fee-explained/ |
| A CSV sales history exists (Sales History page; emailed quarterly) | corroborated | https://help.redbubble.com/hc/en-us/articles/4412488515092 |
| The CSV's **column headers** | **unknown** | nothing found; the importer maps headers by alias and the fixture is named `ASSUMED-HEADERS` |
| Payment needs valid payment details and at least $20 earned from the previous month's shipped orders; payments start processing on the 15th | corroborated | https://help.redbubble.com/hc/articles/360027407652 , https://help.redbubble.com/hc/en-us/articles/360035050972 |
| Tax form requirements for a US artist | **unknown** | not found; follow the prompts in the account |
| An AI-generated checkbox exists on upload | assumed (one search summary; the guidelines page reportedly has no AI wording) | the upload form is the authority |
| Takedown model resembles DMCA notice-and-takedown; counter notice available | corroborated | https://help.redbubble.com/hc/en-us/articles/20181954084500-Counter-Notice-FAQ |

**Decision recorded:** ecom will not log in to Redbubble, drive a browser, or scrape it. A test (`channels.test.js`) fails if the
Redbubble code makes a network call or names a browser-automation library. If you ever want to automate uploads, get Redbubble's
written permission first; an account that is banned for botting loses its sales history and payouts.

## How Redbubble sales reach NET

- Each imported or entered line becomes a `sales` row with `channel = 'redbubble'`, `source = 'redbubble'`.
- `gross = net = the artist margin`. No marketplace fee, no processing fee and **no cost of goods**: Redbubble bears production and shipping.
- Account fees (platform fee, excess markup fee) come out of payouts and are **not** modelled. NET is operational, not tax accounting.
- The headline NET, revenue and the per-product figures include these lines automatically; `GET /api/summary` adds a `channels` roll-up and
  `GET /api/products/:id` adds `salesByChannel`.
- Import is idempotent (order id or a content hash, plus an ordinal among identical lines), so an overlapping export adds nothing twice.
- Non-USD lines are skipped with a reason, never treated as dollars. Enter them by hand once you decide how to convert.
- Unmatched lines are kept without a product; they still count in NET. Matching is by the work number in the pasted URL, then by title.

## Adding the next marketplace (TeePublic, Printify Pop-Up Store)

1. **Decide the capability honestly.** Read the terms (or have a search summary and say it was one). If there is a real, permitted API, it is
   `api` and goes through an adapter. If not, or the terms forbid bots, it is `manual`. Record the verdict in the table above with a source and a status.
2. **Rules module** `server/domain/<channel>-rules.js`: limits with provenance (`corroborated`/`assumed`), `adaptCopy`, `lintCopy`, product-type advice. Copy the Redbubble one.
3. **Pack** `server/channels/<channel>.js` returning `pack()` and `zip()`: reuse `fitToArea` for the image, `zip.js` for the download, and report the real size.
4. **Sales** `server/channels/<channel>-sales.js`: a tolerant parser with an alias table and fixtures named for any assumed header; money model = what the channel actually pays you.
5. **Register** it in `server/channels/index.js` through `assertChannel` (a manual channel must supply `prepare` and `importSales`). State is already generic: `channel_listings` and `channels/state.js` take any channel id (add its host to the URL check).
6. **Routes** in `server/routes/channels.js` (owner-only comes free from `app.js`), a client panel next to `ChannelPanel.jsx`, **playbooks** in `definitions.js` (revive, publish, weekly, takedown), tests mirroring `test/channels.test.js`.
7. **Printify Pop-Up Store** is different: it lives inside the Printify account ecom already uses, so it is likely an `api` channel through the existing POD adapter (assumed; check Printify's API for storefront publishing before building). TeePublic is a sister site of Redbubble and Redbubble's help lists an "Importing to TeePublic" feature (https://help.redbubble.com/hc/en-us/articles/13575701581204-Importing-to-TeePublic), which is worth reading before writing anything: it may make a pack unnecessary.
