# HANDOFF — octopus-ecom studio

2026-11-14. Live shop: https://ecom.octopustechnology.net
Shipped commit: `1c10ac3` on `main` ("Add a design studio and give each regenerate its own picture.").
Live build stamp after that deploy: `750d94e07e58`, started `2026-11-14T00:32:59Z`.
The page redirects to sign-in, so the card was not clicked on the live site.

DRY RUN is still ON. Nothing was published to Etsy. Live writes were not armed. No image was spent for this handoff.

## Do this next

1. Hard-refresh product **#3** (toad on a forklift). Studio is under the picture, above Print readiness.
2. Text: choose Text, font Heavy, type the words, click the picture. Undo removes the last change. **Save as print file** costs nothing and becomes the print PNG.
3. Fix one spot: Mark, write the change (at least 8 characters), **Redraw marked area**. Unmarked pixels stay. This spends a real Nous image even while dry run is on. Save text first. The redraw uses the saved file.
4. A new whole picture: under the brief, fill **What to change this time** (example: `yellow hard hat`). Blank still draws a new picture. Each generate sends its own seed, so the same brief is not the same request. This spends an image.
5. Edit the description on #3. It still says the lines are crisp. That was drafted before the copy rule changed. New drafts are told not to claim crisp, sharp, high-resolution, or handmade.
6. Read the yellow `print_review` flag before any approval. The file is 3917×4477 enlarged from a real 896×1024 (about 23% of the poster detail). Green "ready" only means the pixel count covers the area. The mockups are the dry-run stand-in. Judge softness on the preview, zoomed in.
7. When a design is one you would ship: top bar **DRY RUN: ON**, type `ARM LIVE WRITES`, then **Create POD product + mockups**. That click is real and replaces the stand-in. Read the economics table (the $12.50 base and $5.11 margin on #3 are estimates). Then approve and publish. Publish charges Etsy's $0.20 listing fee. Etsy pays out itself. This app has no Stripe.

## What the card can do now

- Studio tools: Move, Text, Sticker (star, heart, spark, banner), Mark, Eraser. Fonts: Heavy, Sans, Serif, Mono. Undo. Save as print file. Download this view. Save PNG (the file already stored).
- Redraw keeps unmarked pixels. The model rewrites a whole frame; the shop pastes the original back outside the mark and feathers the edge (radius 2). A mark over about 70% is refused. Use Regenerate for that.
- **Start sticker product** copies the brief, price, and latest PNG onto a new kiss-cut sticker. No image spend.
- **Create POD product + mockups** also shows on a dry-run stand-in (`stub-` id or estimated cost). While dry run is on, that button fakes the mockups again.
- A picture that is almost one flat colour gets `picture_flat`. A mostly black file gets `picture_blank`. A 1-bit dry-run colour block cannot be judged and is not flagged. This check does not look at the drawing. It will not catch an extra limb or melted letters.
- Listing copy must not claim a crisp, sharp, high-resolution, or handmade print.

## #3 as it was left

Listing drafted. Brief: `TOAD operating a forklift`. Four Klein designs, each 3917×4477, about $0.01 each. List price $20. Estimated POD base $12.50. Projected margin about $5.11 (25%), fee schedule v0, floor $2. Flags seen: `print_review`, `pod_cost_estimated`. Blueprint 5, provider 99, poster-sized areas (front 3951×4477). Title calls it both a frog and a toad. Tags were 12 of 13.

## First listings that can still make money

Today in the shop calendar is past Thanksgiving (last realistic order was 2026-11-08). Hanukkah's assumed last order is 2026-11-17, too soon for a new listing to be found. Christmas list-by was 2026-11-16. Assumed last order for Christmas delivery is 2026-12-07. Those dates are planning defaults (5 days production, 10 transit, 3 buffer), not Printify's or the carrier's calendar. Check those before promising a date.

Ship bold flat mugs and kiss-cut stickers, not a full-bleed poster, until a design has more than ~1024px of real detail. Type the words in the studio. One niche for the batch: cozy animal gifts. Two pictures, each as a mug and a sticker.

Price from the card after Create POD returns the real base. Catalog estimates at a 30% target, before real shipping: mug $11.99 on a $6.50 base, sticker $5.99 on a $2.50 base, tee $21.99 on a $12.50 base. A $5.99 sticker with free shipping loses money. Charge shipping on stickers.

Title: product noun in the first words, at most 140 characters. `% : & +` once each. No emoji.
Tags: 13 phrases, each at most 20 characters, or the shop drops them. Letters, digits, spaces, hyphens, apostrophes. Stored lowercase.
Squirrel mug tags that fit: `cozy squirrel mug`, `winter animal mug`, `cute forest mug`, `nature lover gift`, `animal lover gift`, `coffee cup gift`, `woodland animal`, `squirrel gift`, `cozy season gift`, `holiday coffee mug`, `forest friend`, `ceramic mug gift`, `stocking stuffer`.
Say a production partner prints it, and that the art was made with AI. The app does not tick Etsy's AI checkbox or the production-partner fields. Do that on Etsy.

## Checks already run

- `npm test` in this repo: 455 pass, then the listing-copy sentence was added and `test/copy.test.js`, `test/studio.test.js`, and `test/nous-image.test.js` passed (32).
- `npm run build` succeeded. `client/dist` is gitignored.
- Studio controls were measured in headless Chromium before Undo, Font, and the vary field existed. Drawer scrolled at a desktop size, a short window, 390px, and 360px. Those three controls were not remeasured.

## Do not

- Lower print coverage or remove `print_review` to make a soft file look ready.
- Send the upscaled poster to the image gateway as a data URI. Redraw downscales to the print size first (long side 1024).
- Treat a Generate, Regenerate, or Redraw click as free. A Nous sign-in spends a real image while dry run is on.
- Publish #3 until the description and the softness flag have been looked at.
- Touch `octopus-cortex` or `octopus-health`. Those trees were dirty on other branches and are not part of this work.
