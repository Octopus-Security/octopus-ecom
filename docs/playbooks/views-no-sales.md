# Listing gets views but no sales

<!-- Generated from server/playbooks/definitions.js by server/playbooks/render-md.js. Edit the definition, not this file. -->

**When to use:** The performance watcher raised "views, no sales" (or a view drop) on one of your listings.

Use only your own shop's stats (views, favorites, sales, search terms Etsy shows you). Do NOT look at competitors' listings, copy a winner's title or photos, or undercut prices based on scraped data: that is how shops get reported and closed, and this tool refuses to build it.

## Steps

1. [ ] **Is it enough data? Fewer than ~100 views is mostly noise; wait** (`enough`)
2. [ ] **Photos: is the first image clear at thumbnail size, on a realistic mockup, with the product obvious?** (`photos`)
3. [ ] **Title and tags: do the first words say what the item is in the words a buyer would type? Rewrite from your own watchlist keywords** (`title`)
   _Live check: `etsy_tag_rules`._
4. [ ] **Price and shipping: total price vs what the item plausibly costs; check margin before lowering anything** (`price`)
   _Live check: `margin_above_floor`._
5. [ ] **Favorites without sales usually means interest but a blocker (price, shipping time, size/colour options, trust)** (`favs`)
6. [ ] **Change ONE thing, note it with the date, and wait a week before judging** (`one`)
7. [ ] **After two or three rounds with no sales, archive or retire the listing; do not keep paying renewal fees** (`retire`)

Policy claims above say `verified 2026-10-05 - <url>` only where that page was read; anything else is `assumed, unverified`.
