# Architecture (milestone M4, 2026-10-05)

Where this and the code disagree, the code is right.

## Shape

```
client/  React + Vite panel (board, top bar, settings drawer, confirm modal)
server/
  index.js        config, boot refusals, listen (exit 1 = refusing to boot)
  app.js          buildApp(deps): Express app, no listen (testable)
  deps.js         wires every collaborator; tests call it with an in-memory DB
  config.js       env validation          secret.js   ECOM_SECRET / dev secret
  auth.js         sso | dev, owner gate, sameOrigin
  crypto.js keystore.js credentials.js redact.js log.js   sealed credentials, redacted logs
  db.js settings.js spend.js confirm.js dryrun.js events.js
  domain/         stages.js (state machine), fees.js, fee-schedule.js, etsy-rules.js, blocklist.js (+ blocklist-seed.js), print-readiness.js
  orchestrator.js batch queue (M4)
  llm/            complete() + stub / openai / openai-compatible + router-path.js
  adapters/       http.js, contract.js, route.js, <kind>/{index,stub,<real>}.js
  routes/api.js   REST API
  watch/          schedulers, watchers, alerts (supplier, performance, keywords)
  playbooks/      runbooks as data + check hooks
```

## Isolation

A standalone service, deliberately separate from the router/crew tooling. This
service is outward-facing and holds marketplace credentials; the router is a
local, bring-your-own-key tool that drives coding agents with shell access over
workspaces. The trust boundaries are opposite, so nothing is shared at runtime.

**What is imported from a router checkout, and why the crew is not.** If
`ROUTER_PATH` is set and `${ROUTER_PATH}/server/router.js` can be required,
`server/llm/router-path.js` reads exactly two of its exports: `TIERS` (tier name to
alias name) and `ALIASES` (alias to `{provider, model, cost}`), to choose a model per
`cheap`/`standard`/`deep` tier. Read 2026-10-05: the module's load-time work is
declaring constants from `process.env` and requiring its sibling `providers.js`; it
starts no server or timers. Anything unexpected (unset, missing, throws,
different shape) falls back to built-in defaults and logs which path was taken; the
router is never required to run. The router's **crew** is not used: it drives
tool-using coding agents over workspaces and its own keystore, which is the wrong
shape (this service makes single stateless completions) and the wrong trust
boundary (an outward-facing service must not share a process with something that
can run shell or hold other keys). The endpoint of a running router or gateway can
still be used as an `openai-compatible` provider over HTTP, without importing it.

## DRY_RUN: what is faked and what is real

DRY_RUN is a row in `settings`, seeded from env (`DRY_RUN`, default ON; only the
literal `false`/`0`/`off` turn it off), then owned by the panel.

| Operation | DRY_RUN on | DRY_RUN off |
|---|---|---|
| Marketplace/POD **writes** (Printify product create/publish, Etsy create/update) | logged and faked by the stub | real (needs credential) |
| External **reads** (blueprints, variant costs, receipts, shop info) | real when a credential is present | real |
| **Image/LLM generation** | real when a key is present: it is spend, not a marketplace write, and is governed by the daily cap | same |

Turning it ON needs no confirm. Turning it OFF is a two-step confirmed action that
also requires typing `ARM LIVE WRITES`, and records a system event.

## Confirm gate

Irreversible actions (publish, disarm DRY_RUN, enable per-store autopublish, delete
a credential) use `server/confirm.js`: the first call returns
`{needsConfirm, token, summary}` and executes nothing; the second call with the
token executes. Tokens are single use, expire in 5 minutes and are bound to their
action and subject. M0 wires disarm and credential delete; publish and autopublish
use the same module in later milestones.

## State machine (`server/domain/stages.js`)

```
idea -> design_generated -> mockup_ready -> listing_drafted -> PENDING_APPROVAL
     -> approved -> published -> live            (+ rejected, failed, archived)
```

All stage changes go through `transition(product, to, {actor, note})`: validate
against the table, then write the `events` row and update `stage` and `updated_at`
in one transaction. Rules enforced there:

- `published` is reachable only from `approved` (the single publish guard).
- `approved` by actor `agent` only if the store has autopublish on, DRY_RUN is off
  and the product has no flags. A human may approve a flagged product; the confirm
  summary lists the flags.
- Any flag (margin floor, blocklist hit, print-readiness warning) blocks autopublish
  unconditionally.
- `failed` needs a reason and is reachable from any stage except
  failed/rejected/archived; `failed -> idea` is the retry. Going back to
  `design_generated` (regenerate) is allowed from mockup_ready, listing_drafted and
  PENDING_APPROVAL; un-approve (`approved -> PENDING_APPROVAL`) is allowed.

## Adapters

Five narrow interfaces (`adapters/contract.js`): ImageGen, PODProvider, Storefront,
TrendResearch, ListingCopy. Each method is tagged `read`, `write` or `spend`, and
`route.js` picks real or stub per call: real needs a credential, an implemented
(non-scaffold) real adapter, and, for writes, DRY_RUN off. Every real adapter uses
`adapters/http.js` (per-host token bucket, timeout, exponential backoff with
jitter on 429/5xx honouring Retry-After, redacted logs; fetch/sleep/clock are
injectable). Non-GET requests are retried only on 429, never on 5xx or timeout, to
avoid double-creating a listing. Adapter failures are caught by the pipeline and
move the product to `failed`; they never crash the process.

As of M1, **ImageGen** (OpenAI Images) and **ListingCopy** (via the LLM interface) have real
implementations and are chosen whenever a key exists, even in DRY_RUN (generation is spend, not a
marketplace write). Printify is real as of M2 (below); Etsy (M3) is real; trend research remains a stub/scaffold; Printful is a
signature-only scaffold that stays unimplemented.

### M1: image generation, copy, pipeline

**ImageGen (`adapters/imagegen/openai.js`).** `POST /v1/images/generations` with `gpt-image-1`
(`IMAGE_MODEL`, `IMAGE_QUALITY` default `high`). It asks for the largest size the model supports
in the requested orientation (portrait 1024x1536 for the 4500x5400 default print area), decodes
`b64_json`, and runs the pluggable **upscale hook** (`server/upscale.js`, interface documented
there). The default hook is a pure-JS bilinear resample (own PNG decode/encode in `server/png.js`,
no dependencies); it fits INSIDE the target keeping aspect ratio, so 1024x1536 becomes **3600x5400,
not 4500x5400**, and it adds pixels, not detail. The design row stores the REAL size (`width`,
`height`, read back from the PNG header, never from the hook's claim) plus `native_width/height`
and `upscale_method`; print-readiness (M4) can reject on the real size. `IMAGE_UPSCALE=off` keeps
the native size. Cost comes from the dated table in `adapters/imagegen/pricing.js`, rounded up to a
cent; an unpriced model/quality/size is refused rather than guessed.

**LLM (`server/llm/`).** `openai` (BYOK) and `openai-compatible` (`LLM_BASE_URL` + optional
`LLM_API_KEY`) share `chat.js`; the provider is resolved per call, so a key saved in the panel works
without a restart. Model per tier: `LLM_MODEL_<TIER>` > the `ROUTER_PATH` table (read-only, `TIERS` +
`ALIASES`) > built-in defaults (`gpt-4.1-nano` / `-mini` / `gpt-4.1`). Cost = reported token usage x the
dated table in `llm/pricing.js` (override unknown models with `LLM_PRICE_IN_PER_M`/`_OUT_PER_M`; an
unknown unpriced model is costed at a conservative worst case and reported `priceAssumed`).

**Spend cap.** Checked BEFORE each paid call from a price estimate (inside the real adapter/provider,
so a refusal makes no request) and the ACTUAL cost is recorded in `costs` right after the call, even if
a later step fails. A cap refusal is a **pause**, not a failure: the product keeps its stage, a note
event is written, the API answers 429. Cap hit does not fall back to a stub image (that would hide that
generation is paused).

**ListingCopy.** The LLM is asked (tier `standard`) for JSON `{title, tags, description}` using buyer
search phrasing, no keyword stuffing, no brand/trademark terms. The model's output is never trusted:
`domain/etsy-rules.js enforceCopy()` truncates the title on a word boundary to 140, strips characters
Etsy titles/tags do not allow, allows `% : & +` once each in a title, trims/lowercases/dedupes tags,
drops tags over 20 chars, keeps 13, and records every repair (`listings.repairs`). The M0 blocklist then
runs over title, tags, description and brief; a hit sets a `blocklist` flag on the product (shown on the
card, blocks autopublish) and the text is kept as written, not silently rewritten.

**Pipeline (`server/pipeline.js`).** create (idea) -> generateDesign (design row + `costs` row,
`transition` to `design_generated`) -> draftCopy. The draft copy lives in a `listings` row (platform
`etsy`, status `draft`, one per product) with the title mirrored on `products.title`; the product STAYS
at `design_generated` until M2 makes mockups. Regenerate appends a new `designs` row (history is never
deleted); from later stages it steps back via `transition()`. Any failure other than a cap pause moves the
product to `failed` with the reason (`failed -> idea` is the retry, done automatically by
generate-design). One operation per product at a time.

**API.** `POST /api/products`, `POST /api/products/:id/generate-design` (a `brief` in the body =
regenerate with an edited brief), `POST /api/products/:id/draft-copy`, `PATCH /api/products/:id/copy`,
`GET /api/products/:id`, `GET /api/images/:id` (authenticated like everything under `/api`).

### M2: Printify, mockups, margin, approval

**Printify adapter (`adapters/pod/printify.js`).** Every endpoint and shape carries its provenance in the file
header: `verified 2026-10-05 — https://developers.printify.com/` where that page was read (base URL, Bearer auth and
required `User-Agent`, limits of 600/min global, 100/min catalog and 200 per 30 min for publishing, shops, catalog
blueprints / print providers / variants with placeholder pixel sizes, product create/get/publish paths, the read-only
variant `cost` and the mock-up `images`) and `assumed, unverified` where it was not (the exact upload path and response
shape, image placement semantics `x/y/scale`, and the `?show-out-of-stock=1` availability trick). The page was read through a
summariser, so shapes are as summarised.

- **Where the base cost lives.** Not in the catalog: the variants endpoint carries no pricing. It is the read-only `cost`
  (cents) of each variant on a *product*. So a real base cost requires a real product, which is a WRITE. Under DRY_RUN
  there is no Printify product, the base cost is a stub **estimate** (`products.pod_cost_source = 'estimate'`), the card
  says "(est.)", and the product carries a `pod_cost_estimated` flag (which blocks agent approval, like any flag). With
  live writes armed the cost is read back from the created product (`printify_product`). Catalog reads (blueprints,
  providers, variants, print-area pixels, availability) are real whenever a token exists, even in DRY_RUN.
- **Upload.** `contents` is base64 in a JSON body (a ~28 MB PNG is ~37 MB on the wire; the timeout is raised to 180 s).
  The limit is `PRINTIFY_MAX_UPLOAD_BYTES` (default 100 MB, the help-centre figure for PNG/JPEG, not confirmed for the API).
  Over the limit, or a 413 from Printify, fails with an explicit message and the product goes to `failed`: the image is
  never downscaled because that would break print readiness.
- **Rate limits.** Catalog calls are paced at 1.5/s (90/min against the documented 100/min); catalog responses are cached
  10 minutes; everything else uses the http.js default (5/s against 600/min). Publish (M3) must stay under 200/30 min.
- **Shop.** `PRINTIFY_SHOP_ID`, else the account's only shop; zero or several shops is an explicit error.
- `publish` and `getPublishState` are real as of M3 (below).

**Print requirements.** `selectPod` reads the chosen variants' placeholders and stores them on the product as
`products.print_spec` (`{blueprint, providerId, positions:[{position,width,height}], source, fetchedAt}`); designs are generated
for the first position's size. The M4 print-readiness check reads this (below).

**Pipeline.** `design_generated -> (create-pod) mockup_ready -> (draft-listing: copy if absent, margin) listing_drafted ->
(submit) PENDING_APPROVAL -> (approve) approved`. Projected margin and its `margin_*` flags use `domain/fees.js`
`projectMargin`/`marginFlags` and the `margin_floor_cents` setting, the same functions as the supplier watcher. Flags have a
`source` (`pipeline` or `watch`); each writer replaces only its own code prefix.

**Money decision.** The POD base cost is per-unit COGS paid when a unit sells, not spend at draft time: no `costs` row is
written and it never counts toward the daily cap; it only feeds projected margin. `costs.kind='pod'` is reserved for per-sale
COGS ingested in M3, `listing_fee` is charged at publish (M3).

**Approval gate (API).** `POST /api/products/:id/{submit,approve,reject,archive}`, `PATCH .../price`, `POST .../{pod,create-pod,
refresh-mockups,draft-listing}`, `GET /api/pod/blueprints[/:bp/providers[/:pp/variants]]`, `GET /api/margin-preview`.
`approve` is two-step (confirm token bound to the product AND its `updated_at`, so an edit voids it); the summary lists list price,
base cost (flagged if an estimate), projected margin, flags and whether DRY_RUN is on. Only a human reaches the route; the agent
rule lives in `transition()`. `POST .../publish` is the M3 path (below).

### M3: Etsy, publish, sales

Layout: `adapters/storefront/etsy.js` (HTTP adapter), `etsy/auth.js` (PKCE, state, tokens), `etsy/service.js` (store: connect,
status, autopublish, disconnect), `etsy/publish.js` (publish, reconcile, listing edits), `etsy/sales.js` (ingest),
`routes/etsy.js`. Provenance for every endpoint is in the header of `etsy.js` and `etsy/auth.js`: read 2026-10-05 from
Etsy's published OpenAPI document (`https://www.etsy.com/openapi/generated/oas/3.0.0.json`) and the authentication and rate-limit
pages on developers.etsy.com. Nothing has been run against a live Etsy shop.

**Connect.** `GET /api/etsy/connect` (JSON `{url}`, or `?redirect=1`) creates a 32-byte `state` and a 64-byte PKCE verifier, stores
the verifier SEALED in `oauth_pending` for 10 minutes, and returns Etsy's authorize URL (S256 challenge). `GET /api/etsy/callback`
consumes the state (single use; unknown, reused and expired states are refused), exchanges the code with the verifier, seals the
token pair in `stores.oauth_sealed`, reads the shop, and redirects to `/?etsy=connected|no_shop|error`. No credentials: the connect
route answers 400 "No Etsy app credentials ..." and everything stays on stubs. Scopes: `listings_r listings_w transactions_r shops_r`
and nothing else is needed (see `etsy/auth.js`). Access token 1 h, refresh token 90 days and rotating; refresh happens 2 min before expiry and on a 401,
single-flight per store, and the new pair is saved before use. A refused refresh (400/401/403) marks the store `disconnected` with a
message and drops the tokens; a 5xx does not. `x-api-key` is `keystring:shared_secret`.

**No shop.** The store connects with status `no_shop` and the message "Open an Etsy shop first (Shop Manager -> open shop), then
reconnect." Publish and sales sync refuse with that message; "Check shop" re-reads it with the saved tokens.

**Publish (Printify -> Etsy).** `POST /api/products/:id/publish`: not `approved` -> 409 `not_approved`; with DRY_RUN off any failed
precondition -> 409 with the named reason BEFORE a confirm token exists: a real Printify product (not a DRY_RUN stub), a base cost
that is not an estimate, a list price, listing copy, a connected Etsy store WITH a shop, a Printify shop whose `sales_channel` is
`etsy` and whose name matches the Etsy shop (Printify does not say which Etsy shop it is linked to, so the match is by name; override
`ETSY_SKIP_PRINTIFY_SHOP_MATCH=1`). Then the two-step confirm (summary: shop, price, listing fee, projected margin, flags, "real
marketplace, irreversible"). DRY_RUN on: confirm, then `{faked:true, liveBlockers:[...]}`, nothing sent, stage unchanged. Live: PUT the final
copy to the Printify product, `publish.json` with all section flags, `approved -> published`, then look up the Etsy listing id
(`PUBLISH_POLL_ATTEMPTS` x `PUBLISH_POLL_MS`) and read the listing back from Etsy. `reconcile` (also `POST .../refresh-status`, and run by
the performance watcher) fills in the id when it appears late, writes the URL and Etsy's state, flags a listing found in a different
Etsy shop, and moves `published -> live` when Etsy says `active`. **The Etsy listing fee (20 cents) is written to `costs` once, when the
Etsy listing id is first known** (normally inside the publish call), not when `publish.json` is accepted: a publish that never produces
a listing has not been charged. A Printify publish error leaves the product `approved`. The agent path (`publisher.publish(id,
{actor:'agent'})`) additionally needs the store's autopublish on and no flags, and is refused under DRY_RUN. Re-running create-pod on an
estimated-cost product (allowed from drafted/pending/approved) reads the real cost and steps the product back to `listing_drafted`,
voiding the approval.

**Edits.** `PATCH /api/products/:id/listing {title?, tags?, price?}` on a published product: `enforceCopy` and the blocklist run, title/tags
go through `PATCH listing`, the price through the listing inventory (Etsy's updateListing has no price field), and a price change
needs the confirm. DRY_RUN: faked, nothing sent or changed locally. Etsy prices may be overwritten by Printify on a re-publish.

**Sales.** `POST /api/sales/sync` (and inside the performance watcher's run): paid receipts oldest-first from the cursor minus a 2-day
overlap, one `sales` row per transaction, unique on (receipt id, transaction id). gross = unit price x qty + shipping. Fees: the API
exposes ONLY the card processing fee (`Payment.amount_fees`), used when readable; the 6.5% transaction fee is always computed from
`domain/fees.js`; `sales.fee_source` says which. A tracked listing also writes a `costs` row kind `pod` = base cost x qty in the same
transaction; an untracked listing is kept at store level with COGS unknown (NULL). NET = real sales net minus every cost. Simulated
sales (stub storefront) have `source='stub'`, write no COGS and are reported under `summary.simulated`, never in NET. The daily spend
cap ignores `pod` and `listing_fee` costs: it governs generation. Refunds (M4): see below.

**Listing stats.** Etsy's `Listing.views` (tabulated daily, active listings only) and `num_favorers` ARE exposed;
there is no per-listing sales counter, so `getListingStats` returns `sales: null` and the performance watcher counts ingested sales.

**Rate limits.** Etsy's QPS/QPD are per key and not published in the docs (they show in the developer portal). `http.js` takes
`hostLimits`; `api.etsy.com` is held to `ETSY_QPS` (default 4) and `ETSY_QPD` (default 4000 per rolling 24 h), both assumed, unverified
defaults; `x-remaining-today` is logged when low.

**Register the Etsy app and connect (operator steps).**
1. On https://www.etsy.com/developers/your-apps create an app (personal access is enough for your own shop; commercial access is needed
   to serve other sellers). Etsy reviews new apps; until it is approved the keystring may not work.
2. Add the redirect URI exactly as `https://<this service's host>/api/etsy/callback` (set the same value as `ETSY_REDIRECT_URI`).
3. In Settings -> Credentials save `etsy_api_key` (the keystring) and `etsy_shared_secret` (or set `ETSY_API_KEY` / `ETSY_SHARED_SECRET`).
4. Etsy needs a shop: open one in Shop Manager first. In Printify, connect that Etsy shop to your Printify shop.
5. Settings -> Stores -> Connect Etsy, approve the four scopes. The store should read "connected" with the shop name.
6. For each product: arm live writes, re-run "create POD product" (reads the real base cost), submit, approve, then Publish.

### M4: print readiness, blocklist, batches, refunds

**Print readiness (`domain/print-readiness.js`).** The latest design's TRUE pixel size is read from the PNG IHDR of the stored file (never
from `designs.width/height`) and compared with `products.print_spec`. With `rw = designW / requiredW` and `rh = designH / requiredH`:
`PRINT_FIT=cover` (default) takes `coverage = min(rw, rh)`, so both dimensions must reach the requirement; `PRINT_FIT=contain` takes
`max(rw, rh)`: the design is placed whole, letter-boxed, and only its limiting side must reach it (this is how the Printify adapter
actually places the image). A position passes at `coverage >= PRINT_MIN_COVERAGE` (default 1.0). Panel Settings can override both. Only the position the
design is placed on is decided. DPI is reported only if the spec carries physical size (Printify's does not: pixel-based only). If the
design was upscaled the message says so and what fraction the native size was. A failing design makes `create-pod` answer 422
`print_not_ready` (nothing is sent to the provider, the stage stays `design_generated`), sets the `print_not_ready` flag (also set as
soon as the design is generated), and an unreadable file or unknown print spec is a refusal, not a pass. **Default consequence:** M1 upscales
gpt-image-1's 1024x1536 to 3600x5400, which is 80% of a 4500x5400 tee area's width: at the defaults it is REFUSED. Accept it with
`PRINT_MIN_COVERAGE=0.8` or `PRINT_FIT=contain`. The stub generator makes the requested size, so the no-key flow passes.

**Blocklist (`domain/blocklist.js`, seed in `blocklist-seed.js`).** About 1,650 seeded terms (brands, leagues, teams, franchises, characters,
celebrities, slogans), editable in Settings -> Blocklist (list, add, remove, newline import, a test box); every edit re-scans unfinished
products. A removed seed term stays removed across a seed-version bump. Checked on the brief at creation (before any spend), then title, tags
and description at every copy save, with the field named in the flag (`nike [title, brief]`). **Matching:** lower-case, diacritics stripped,
split on every non-alphanumeric character into whole-word tokens (so `nike` never matches inside `nikephoros`); hyphen/space/joined variants
(`spider-man`, `spider man`, `spiderman`), plurals (`nikes`) and possessives (`nike's`) match, a listed plural is not matched by its singular;
common words are seeded only as the phrase that makes them a brand (`apple watch`, `new york giants`), and a small EXCEPTIONS list drops
known benign contexts (`nikola tesla`). **Limits:** text only; no logos or likenesses, misspellings (`n1ke`), other scripts or unlisted
names; a seeded phrase flags innocent uses of the same words together; a clean result means "nothing obvious", never "cleared". A hit FLAGS:
it blocks agent approval and autopublish, is listed in the human approval summary, and never rewrites the text.

**Batch orchestrator (`orchestrator.js`).** `POST /api/batch {niche, count<=25, keywords?, blueprint, printProviderId, variantIds?,
listPrice, shipping?, storeId?, concurrency?}` -> 202; poll `GET /api/batch/:id`; `POST .../cancel`, `.../resume`. Tables `batches` and
`batch_items`. Ideation: the LLM proposes distinct original concepts (blocklisted and near-duplicate ones dropped and counted); deterministic
templates top up whatever it cannot supply (the only source with the stub LLM). A branded niche/keyword is refused up front. Each item walks
create -> design -> print check + POD -> copy + margin -> QA -> submit and STOPS at PENDING_APPROVAL; concurrency 1 (default) or 2. The only
publishing path is autopublish: store autopublish ON and DRY_RUN off and no flags and a QA pass that actually ran, then `pipeline.approve`
(stages.transition's agent rule) and `publisher.publish` (same blocker list); a failed publish steps the product back to PENDING_APPROVAL.
**Spend cap:** checked before each paid step; a hit pauses the batch (`paused_cap`, item back to pending, never failed, never a stub
fallback); the next ET day resumes it (a 60 s timer in `index.js`), or resume by hand. **Restart:** `recover()` marks running items
interrupted and retries each once (a second interruption fails it); work resumes from the product's stage so a paid design is never
re-bought. **Cancel:** nothing new starts; a step already in flight finishes. **Tiers:** with a ROUTER_PATH table (or any `LLM_MODEL_<TIER>`)
ideation uses `cheap` and QA `deep` (copy is always `standard`); without one both use `standard`. **QA:** an LLM review that can only add
`qa_*` flags (`addFlags` never removes); an error or the stub means "not reviewed" and blocks autopublish without flagging. Per-item cost
and model per step are stored. A batch's products carry the normal flags (e.g. `pod_cost_estimated` under DRY_RUN).

**Refunds (`etsy/sales.js`).** Etsy's `ShopRefund` is receipt-level and has no id (read from the OpenAPI document), so each refund is keyed
`<receipt>:<created_ts>:<amount>:<n-th identical>` in `refunds` (UNIQUE: re-reading never subtracts twice). The amount is spread over the
receipt's sales lines by gross (capped at what each grossed; the remainder goes to lines with room), stored in `sales.refund_cents`, and
`net_cents` is recomputed so NET reflects it. Receipts are re-read back `REFUND_LOOKBACK_DAYS` (30) without re-fetching their fee. Assumed,
unverified conservative choices: Etsy's fees are not returned, per-sale COGS is not reversed, all listed refunds count whatever their `status`.

## Credentials

A credential comes from the sealed keystore (set in the panel) or, failing that,
from env. Sealed with AES-256-GCM, key derived by scrypt from `ECOM_SECRET`; there
is no default secret. Production without `ECOM_SECRET` refuses to boot; in dev one
is generated into `DATA_DIR/.dev-secret` (0600). The API returns only
`{present, fp, tail, source}`. Every log line goes through a redactor with token
shapes plus the exact value of every sealed secret and credential env var.

## Money

Integer cents everywhere. Fee rates only in `server/domain/fee-schedule.js` (verified 2026-10-06, Etsy's own fee page via the owner; assumed items marked), stored as the versioned `fee_schedule` setting and editable in Settings. Projected margin = list price - POD base cost - listing fee -
transaction fee(list + shipping, tax-exclusive) - processing fee(list + shipping + estimated tax) - currency conversion (toggle) - expected Offsite Ads (rate x share), itemised by `projectMargin(input, schedule)`; `products.margin_breakdown` snapshots the lines and schedule version. `POST /api/price-calc` solves the minimum list price for a target and the set-up-fee break-even. NET (summary) = sum of
`sales.net_cents` (gross less Etsy and processing fees) minus every `costs` row.
`MARGIN_FLOOR` and `DAILY_SPEND_CAP` are dollars in env, cents internally; the daily
cap uses the America/New_York calendar day.

## Data model

SQLite via `node:sqlite`. Spec tables: `stores`, `products`, `designs`, `mockups`,
`listings`, `events`, `costs`, `sales`; plus `settings`, `keys` (sealed),
`blocklist`, `refunds`, `batches`, `batch_items`, `oauth_pending`. Migrations are additive only. `events.product_id` is NULL for system
events (`kind = 'system'`); `kind = 'note'` events belong to a product but are not stage changes. Confirm tokens are in memory (a restart invalidates them).

## Watchers and playbooks

`server/watch/` is read-only monitoring, mounted at `/api/watch` (behind the same owner auth and
`sameOrigin` as the rest, and before the `/api` router's catch-all 404).

- Three watchers: supplier (POD base cost and variant availability), performance (views/favourites/sales
  of OUR listings) and keywords (operator-supplied trend signals).
- The supplier watcher may add/clear `margin_*` flags and update `pod_base_cost_cents` /
  `projected_margin_cents` on non-terminal products, recomputing with `domain/fees.js`
  `projectMargin`/`marginFlags` and the `margin_floor_cents` setting. It never writes `stage` (only
  `domain/stages.js` does) and never makes an external write.
- Alerts are deduplicated per key while unacknowledged. Every run is a `watch_runs` row; a watcher error is
  recorded, not thrown. Each run summary says `[source: stub]` or `[source: adapter]`.
- The scheduler is in-process, jittered, unref'd, and started only from `index.js` `main()` (never on
  `require`, and off under `NODE_ENV=test`); SIGTERM/SIGINT stop it and close the server.
  `WATCH_INTERVAL_MINUTES` (default 360, min 1); tuning `WATCH_ZERO_SALES_VIEWS`, `WATCH_VIEW_DROP_PCT`,
  `WATCH_VIEW_DROP_MIN_PREV`.
- Tables: `watchlist`, `watch_runs`, `alerts`, `watch_state`, `playbook_ticks`.
- Read methods `pod.getAvailability` and `storefront.getListingStats` are in the adapter contract as `read`.
  `route.js` falls back to the stub for a read method the real adapter lacks (and for scaffolds), so a
  partial real adapter never throws on a watcher read.
- Guardrail: no competitor listing titles, images or shop data are fetched or stored (`TrendSource` signals
  are validated to `{message, severity}` only). Proposal, NOT built, needs an Etsy API ToS check: an
  aggregate result count per keyword.
- `docs/playbooks/*.md` are rendered from `server/playbooks/definitions.js`
  (`node server/playbooks/render-md.js`); a test fails if they drift.

## Not yet built

- Etsy's transaction/listing fee as API fields (not exposed; computed instead).
- Clean-up of an orphaned Printify product when a design is regenerated after a live create.
- The Etsy direct-create path (`createListing` is implemented but wired to no route: it needs taxonomy, shipping profile and images).
- Writing an AI-disclosure sentence into listings or setting Etsy's AI/"Designed by" fields (see `docs/COMPLIANCE.md`).
- Batch autopublish and the whole live Etsy/Printify path have never run against real accounts.
- Printful (signature only), a real TrendResearch source, a visual (image) check for logos or likenesses.
- Refund edge cases not verified against a real refunded order (fee treatment, partial statuses).
