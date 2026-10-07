# Publish a design to Redbubble

<!-- Generated from server/playbooks/definitions.js by server/playbooks/render-md.js. Edit the definition, not this file. -->

**When to use:** A product with a finished design should also be sold on Redbubble. ecom prepares the pack; you do the upload.

Open the product in ecom, scroll to "Redbubble", press "Download pack (zip)" (or use the folder view: every text field has a copy button). The pack holds: the PNG at Redbubble's recommended size (the real size is shown; an upscale adds pixels, not detail), title.txt, tags.txt, description.txt, markup.txt, product-types.txt and a checklist for this design.

There is no upload API and bots are prohibited, so this is manual by design: assumed, unverified (search results on 2026-10-06 found no public or partner upload API; the only API integration found is order fulfilment for print partners, https://connect-support.gelato.com/en/articles/10793373-integrating-gelatoconnect-with-redbubble). assumed, unverified (a search summary of https://help.redbubble.com/hc/en-us/articles/202270929-Community-and-Content-Guidelines said uploading with any bot, scraper or other automated means without written permission is prohibited; page returned HTTP 403; read it yourself before relying on this either way)

Limits ecom lints against (all assumed, unless the upload form says otherwise): title 60 chars, 15 tags of up to 50 chars, description kept to 250 chars. Image: PNG, recommended 7632x6480 for large products, maximum 13500x13500 or 300 MB. Source pages: https://blog.redbubble.com/2018/05/uploading-on-redbubble/ and https://help.redbubble.com/hc/en-us/articles/360047166432 (both returned HTTP 403 to ecom). Markup: assumed, unverified (search summaries of https://help.redbubble.com/hc/en-us/articles/202270799 and https://blog.redbubble.com/2025/08/excess-markup-fee-explained/: default markup 20%; from 2025-09-01 markup above 20% is charged a 50% excess markup fee on Standard and Premium accounts)

## Steps

1. [ ] **The design is original, passed the blocklist, and the product carries no flags** (`ready`)
   Same standard as Etsy: no brand, franchise, character, team, lyric or likeness.
   _Live check: `no_flags`._
2. [ ] **In ecom: product drawer > Redbubble > Download pack (zip). Read the Lint box: fix every error before uploading** (`pack`)
   Errors are a title over 60 chars, more than 15 tags, a tag over 50 chars, a blocklist hit.
3. [ ] **Look at the image size line in the pack. If it says "upscaled", know that Redbubble will print it but fine detail will be soft; that is why large-format products are advised against** (`size`)
   The pack never claims more pixels than it has.
4. [ ] **Sign in to redbubble.com as the owner, open your dashboard, click Add new work** (`open`)
   The direct address ecom shows (https://www.redbubble.com/portfolio/images/new) is assumed; use the dashboard button if it differs.
5. [ ] **Upload the PNG from the zip** (`upload`)
6. [ ] **Paste the title from title.txt** (`title`)
7. [ ] **Paste the main tag, then the supporting tags, from tags.txt** (`tags`)
   One tag goes in the main tag field and the rest in supporting tags (assumed layout).
8. [ ] **Paste the description from description.txt** (`desc`)
9. [ ] **Tick the AI-generated checkbox if any AI tool made any part of the design** (`ai`)
   assumed, unverified (a search summary says Redbubble has an AI-generated checkbox on upload; a different search could not find any AI wording in its Community and Content Guidelines; the upload form is the authority)
10. [ ] **Tick the originality / rights confirmation only because it is true** (`rights`)
11. [ ] **Product types: turn OFF every type product-types.txt marks DISABLE; think about each CAUTION; leave ENABLE on** (`products`)
   Sizes per product are assumed from third-party guides; Redbubble scales and crops itself.
12. [ ] **Set markup to the pack's figure (20%) for every product** (`markup`)
   assumed, unverified (search summaries of https://help.redbubble.com/hc/en-us/articles/202270799 and https://blog.redbubble.com/2025/08/excess-markup-fee-explained/: default markup 20%; from 2025-09-01 markup above 20% is charged a 50% excess markup fee on Standard and Premium accounts)
13. [ ] **Preview on a dark and a light product; then save/publish the work** (`save`)
14. [ ] **Open the live work, copy the address, paste it into ecom (Redbubble section), choose "Mark live"** (`url`)
   If Redbubble is still reviewing it, press "Mark uploaded" first and come back. ecom stores the URL and the work number so the sales import can match sales to this product.
15. [ ] **Next design: use "Copy settings from existing work" in the upload form, replace the image, re-check title and tags** (`copy`)
   assumed, unverified: a search summary says tags, markup and product settings carry over.

Policy claims above say `verified 2026-10-05 - <url>` only where that page was read; anything else is `assumed, unverified`.
