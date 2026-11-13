# Go-live checklist: from zero to the first real Etsy listing

One ordered list. Steps marked **OWNER** need an account or a decision only the shop owner can make. Nothing here has been run against a
live Etsy shop or a live Printify account yet (see `ARCHITECTURE.md`, "Not yet built"); every "verify" line is what the app is
*expected* to show, and the first live run is the real test. Do one product end to end before you batch.

## What "the automatic shop maker" is, and is not

Automatic: *Run batch* (a niche and a count, max 25) or an approved **Proposal** takes a product from idea to **PENDING_APPROVAL**:
original design, Printify product and mockups, SEO'd Etsy copy, margin, blocklist and print-readiness checks. Then it stops.

A human approves (a confirm step that shows price, margin and flags) and then presses Publish (a second confirm). Publishing sends the
product to Printify, which publishes it to the linked Etsy shop. There is **one** unattended path, off by default: store *autopublish*
(Settings, Stores). It only fires when DRY_RUN is off, the store switch is on, the product has no flags (including `pod_cost_estimated`,
`print_review` and `single_variant`) and the automated QA review ran. Do not turn it on for the first listings.

## Where Stripe and the bank fit

Etsy pays out by itself (Etsy Payments to the bank account you give Etsy). **ecom has no Stripe integration and needs nothing from
Stripe.** Stripe in this estate sells Octopus Education through a different app. ecom only *tracks* money: Etsy sales sync into NET, with
Etsy's fees from a versioned schedule (Settings, Fees) and Printify's base cost per sale.

## Checklist

1. **OWNER: open the Etsy shop.** Shop Manager, then the payments/bank section: add the business bank account and finish Etsy's identity
   checks. The form asks for a state business registration number, or choose the individual seller type. Etsy charges a one-time
   setup fee and $0.20 per listing.
   *Verify:* you can open Shop Manager and see the shop name.
2. **OWNER: register an Etsy developer app** at `etsy.com/developers/your-apps`. Personal access is enough for your own shop. Redirect
   URI, exactly: `https://ecom.octopustechnology.net/api/etsy/callback`. Etsy may review a new app before the keystring works.
   *Verify:* you hold a keystring and a shared secret.
3. **OWNER: open a Printify account** and add your own shop to it by connecting **Etsy** (Printify, My stores, Connect, Etsy). Printify
   cannot say which Etsy shop it is linked to, so the Printify shop name must match the Etsy shop name (or set
   `ETSY_SKIP_PRINTIFY_SHOP_MATCH=1` if you are sure they are the same shop). Add a payment method to Printify: it bills you for the
   base cost when a sale happens.
   *Verify:* Printify shows the Etsy shop as connected.
4. **OWNER: create keys and enter them in the panel** (ecom, top bar, Settings, Credentials; sealed, never shown again):
   `printify` (API token from Printify account settings), `etsy_api_key`, `etsy_shared_secret`, and one image key for real designs (without one
   designs are placeholders): `nous` (Sign in to Nous Portal on that row; the chat inference key is refused), `gemini` (Google AI Studio key), `xai` (xAI API key) or `openrouter`.
   Sign in once. The shop stores its own Portal login and refreshes it. Do not paste the chat key, and do not paste a Hermes refresh token. Then in Settings, **Image generation**, pick that provider and model.
   The default is Nous Klein (`fal-ai/flux-2/klein/9b`). A provider with no key refuses to generate; it never switches to another. A solid colour
   block means the free placeholder ran because no nous key was set. Env fallbacks on the stack: `NOUS_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`,
   `OPENROUTER_API_KEY`. `OPENAI_API_KEY` is only the listing-copy fallback when cortex is absent. It is not an image key and has no Credentials row.
   OpenRouter has no default model: type an image model id. Its price is not known in advance, so set a per-image ceiling if 25 cents is wrong.
   Listing copy and proposal text go through cortex once the stack has `INTERNAL_SECRET`; with neither, copy
   is a stub template. If the Printify account has several shops, also set `PRINTIFY_SHOP_ID` on the stack.
   *Verify:* Settings shows each credential present; the top bar adapters line shows the real adapters, not stubs. Pick a real
   blueprint in *New product* (the list is Printify's catalogue, not "Stub").
5. **OWNER: connect Etsy.** Settings, Stores, Connect Etsy, approve the four scopes (`listings_r listings_w transactions_r shops_r`).
   *Verify (signed in):* `https://ecom.octopustechnology.net/api/etsy/status` lists the store as `connected` with its shop name. If it
   says `no_shop`, step 1 is not finished; fix it and use "Check shop".
6. **OWNER: decide the print rule.** The default places the whole design inside the print area ("fit") and refuses a design whose limiting
   side is under the area. A Nous image is at most 1024px on the long side (a 3951×4477 poster asks for 896×1024). Gemini, xAI and OpenRouter
   native sizes are not documented; the app records what comes back. A small file can fail print coverage even when the old colour-block
   placeholder looked ready. The file is kept. Upload a PNG that already fills the print area, or review the flag. Do not lower the coverage
   rule to force a product through. Choose *fit* or *fill* in Settings.
7. **Dry-run one product first.** Dry run fakes the shops and the print provider. It does not fake Generate: with a nous key, that click buys
   one image. Upload PNG on the card, or on New product, costs nothing and becomes the print file. A PNG you already like, including one saved
   during dry run, is reused later. Regenerate is the only new image spend. JPEG is refused: export a PNG. Run a batch of 1-3 in DRY_RUN, or
   approve a Proposal and press **Run to approval** on its card. Open the card and read it as a buyer: original, no brand or character, tags
   and title sensible, price above the margin floor.
   *Verify:* the product reaches PENDING_APPROVAL. Expect the flags `pod_cost_estimated` (dry-run cost is an estimate) and, if you did not
   pick sizes/colours, `single_variant` (only the first variant would be sold; choose the variants).
8. **OWNER: arm live writes.** Settings, DRY RUN off. Type `ARM LIVE WRITES` when asked. A system event is recorded.
   *Verify:* the top bar no longer says DRY RUN: ON.
9. **Re-create the Printify product with live writes** (card, "Create POD product + mockups"). This uploads the design PNG already saved.
   It does not generate a new image. It reads the real base cost, clears
   `pod_cost_estimated`, recomputes the margin and voids any earlier approval.
   *Verify:* the card shows a real Printify cost and mockups; a draft product appears in Printify (not yet published).
10. **OWNER: approve.** Card, Approve, read the summary, confirm.
11. **OWNER: publish.** Publish, confirm. The summary names the Etsy shop and says it is irreversible by this app.
    If anything blocks, the response lists the reason (`no_store`, `store_disconnected`, `printify_not_linked`, `printify_shop_mismatch`,
    `estimated_cost`, `no_pod_product`).
    *Verify:* the product moves to `published`, then `live` once Etsy reports the listing active (press Refresh status; Printify
    publishes asynchronously). Open the listing on Etsy.
12. **OWNER: finish the listing on Etsy by hand.** The app does not write an AI disclosure, tick Etsy's AI checkbox or set "Designed by"
    (`docs/COMPLIANCE.md`, section 1). Do it on the first listing, and check shipping/processing times against what the provider quotes.
13. **Check money tracking.** After the first sale: Sales, Sync. *Verify:* the sale appears with Etsy's fee and the Printify cost, and NET
    is the real figure.
14. **Only then scale:** batches of 5-10 in live mode, approving each card. Keep the daily spend cap (Settings) low. Leave autopublish off
    until several listings have gone out cleanly.

## Things that will look like bugs but are not

- Pushing `main` of this repo deploys the live shop. Never push while a batch is running; a restart resumes batches, but an in-flight
  step is retried once.
- A batch or a Proposal that names no variants is flagged `single_variant`: choose sizes/colours (Composer or the card's POD step).
- Product titles from the stub copy generator are placeholders; with a model connected they are real copy.
