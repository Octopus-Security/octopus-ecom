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
  domain/         stages.js (state machine), fees.js, fee-schedule.js, etsy-rules.js, blocklist.js (+ blocklist-seed.js), print-readiness.js, seasons.js, proposal-risk.js
  orchestrator.js batch queue (M4)
  llm/            complete() + chat() + stub / openai / openai-compatible / cortex + router-path.js, actor.js
  plan/           Plan chat: context.js (compact shop summary), routes.js (/api/plan, per-user conversations)
  adapters/       http.js, contract.js, route.js, <kind>/{index,stub,<real>}.js
  routes/api.js   REST API
  watch/          schedulers, watchers, alerts (supplier, performance, keywords)
  proposals/      Proposals queue: service.js (generate, edit, approve, digest), catalog.js, copy.js, templates.js; routes/proposals.js
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

**Bring your own design (no image credits).** `GET /api/products/:id/design-prompt` returns the exact `designPrompt()` text the
pipeline would send plus the blueprint's target size, aspect and extra guard rails (`manualPrompt` in `domain/prompts.js`). The
operator makes the image elsewhere and `POST /api/products/:id/upload-design` takes the PNG as the raw body (25 MB cap, type decided
by magic bytes; JPEG is recognised and refused with a "export as PNG" message, because the upscale and print-readiness paths read PNG
only). `pipeline.attachDesign` then runs the same `fitToArea` (upscale hook, real size from the header) as the image adapter,
writes a `designs` row with `source='manual'`, `model='manual'`, cost 0 (no `costs` row), raises the same early `print_not_ready`
flag and moves the product to `design_generated`. `designs.source` is null/`generated` for adapter output, so the listing's
AI-disclosure handling can tell them apart; an upload is NOT assumed to be human-made (it may come from an AI tool).

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

**cortex provider (`llm/cortex.js`).** With `INTERNAL_SECRET` set (or `LLM_PROVIDER=cortex`) every model call goes to
`${CORTEX_URL}/api/internal/llm` (non-stream) or `/llm/stream` (the Plan chat) with the `x-internal-secret` header and the
signed-in `username`, so cortex bills that account (own key, then granted credits, else a 402). It outranks the BYOK providers
when the secret is set. cortex takes aliases, so `cheap`/`standard`/`deep` map to `haiku`/`sonnet`/`opus`; there is no JSON mode
(an instruction is appended and callers still parse defensively). Who is asking comes from `llm/actor.js` (request-scoped); work
with no request (batch recovery/tick, watchers) is billed to the first `OWNER_USERNAMES` entry. cortex meters these calls, so
`costCents` is 0: they are logged (`[llm.cortex]`) but not counted against the daily cap. Images stay on the OpenAI path.
Contract read from cortex's `routes/internal-llm.js` 2026-10-06; not yet exercised against a live cortex.

**Plan chat (`plan/`).** Tab "Plan": a conversation for niches, pricing and what to make next. Each turn the server builds
a system prompt of about 600 tokens or less from this app's data (fee/margin settings via the one `readFees()` function, product counts
by stage, recent products with projected margin, real sales and NET, playbook titles) and sends the user's own last 20 messages.
Conversations are in `plan_conversations`/`plan_messages` with an `owner` column; another user's id is a 404. It takes no actions.
Only cortex (or the offline stub) answers; a BYOK provider is refused rather than spending the shop's key on open-ended chat.

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
`blocklist`, `refunds`, `batches`, `batch_items`, `oauth_pending`, `proposals`, `proposal_runs`. Migrations are additive only. `events.product_id` is NULL for system
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

## Proposals

A **proposal** is an original product idea waiting for the owner: concept, rationale (naming the seeds and signals it came from), product type,
a blueprint suggestion, a design brief, a ready-to-paste image prompt, an Etsy title and 13 tags, a Redbubble variant, an **estimated** price and
margin, a season window and a risk check. Nothing is published from the Proposals tab: **Approve** creates a product in the IDEA stage through the
existing `pipeline.create()` (then `selectPod` and `saveCopy`, so the brief, keywords, blueprint, print provider, list price, title, tags and
description are pre-filled and every rule that applies to a hand-made product applies). Stage changes still go through `domain/stages.js` only.
Layout: `server/proposals/service.js` (everything stateful), `catalog.js` (product types, blueprint match, price/margin estimate), `copy.js`
(Etsy and Redbubble lint), `templates.js` (deterministic proposals), `domain/seasons.js` (holiday dates, lead times), `domain/proposal-risk.js`,
`routes/proposals.js` (mounted by `routes/api.js`, so it is behind the same owner gate and `sameOrigin` as every other route).

**Inputs.** The owner's **seeds** (themes, occasions, audiences, typed in the tab) plus trend signals read through the *existing* trend side only:
(1) active `watchlist` rows; (2) the last 30 days of `trend_signal` alerts, which are what `watch/keywords.js` writes after asking the TrendSource, so
generating re-uses cached results and does not re-hit an external source; (3) optionally, on request (`liveSignals`), `trendSource.check(entry)` itself
(also `watch.trendSources[]` if a later change provides several); (4) `adapters.trend.suggest(query)`, **ignored while it is the echo stub**, which
carries no market data. Every signal passes `watch/trend.js validateSignals` (message and severity only: no competitor titles, images, prices or shops) and
the blocklist before it can reach a prompt. A seed that hits the blocklist is **refused** (422 `seed_blocklisted`) before anything is made or spent.
The date is the ET date (`toLocaleDateString('en-CA', {timeZone: 'America/New_York'})`).

**Seasons (`domain/seasons.js`).** Holiday dates are computed from their calendar rules (checked against known years); "Graduation season" and "Back
to school" are conventions (`approx`). `lastOrder = date - production - shipping - buffer`, `listBy = lastOrder - ramp`; status is `open`, `tight`
(orders can still arrive, a new listing has less than the ramp to be found) or `too_late` (today is past `lastOrder`; the window then also carries next
year's dates, so "too late" points at next year). **The lead times (5/10/3/21 days) are assumed, unverified planning defaults**, not a Printify or carrier
schedule; they are editable in the proposals settings (`proposals_lead_time`) and every window says so.

**Generation.** One model call per batch (`llm.complete`, tier `cheap` when a router tier table or `LLM_MODEL_<TIER>` exists, else `standard`;
overridable to `cheap`/`standard` by the `proposals_tier` setting or the request). The cap is checked before the call (`spend.assertCanSpend`, a refusal is
a 429 and nothing is stored) and the actual cost is written to `costs` as kind `llm`; through cortex the call is billed there and records 0 here, as for
the rest of the app. The prompt carries the date, a season table, the seeds and signals (labelled as data), the owner's earlier rejections with their
reasons ("the owner didn't like X"), and what is already proposed or made. **Nothing a model returns is trusted:** Etsy text goes through `enforceCopy`
and every repair is shown as a lint warning; a short tag list is padded to 13 from the keywords (recorded); the Redbubble variant is derived by
`adaptCopy` and linted by `lintCopy`; the price and margin are computed here from `fees.js` (`minListPrice`, then a charm price, then `projectMargin`),
never taken from the model. With the **stub LLM** the same pipeline runs on `templates.js` (deterministic for the same date, seeds and feedback), so
dry-run and tests need no keys. With a real model a shortfall is reported rather than topped up with templates, and a reply with nothing usable stores
nothing (502).

**Estimates.** The base cost is the median variant cost the catalog reports (the stub's labelled estimate under DRY_RUN) or, when no blueprint title
matches, an assumed per-type table, labelled `assumed, unverified`. Printify exposes the real base cost only on a created product, so every proposal
price and margin carries `estimate: true` and the note; a hand-entered `baseCost` is labelled `owner_entered`. The blueprint is a suggestion by title
match with the first listed provider; the card says to check it.

**Risk check (`domain/proposal-risk.js`), recomputed on every edit and again at approve time.** Three layers: the blocklist over every text field; a
deterministic tripwire for wording that leans on someone else's work ("inspired by", "in the style of", "fan art", "official", "parody of", "best-seller"
...); and the model's own originality self-check returned with each proposal, plus a ready-to-paste originality prompt (`risk.selfCheckPrompt`) that
refuses brands, characters, celebrities, team names, protected phrases and "inspired by <seller>". Levels: `blocked` (a blocklist or phrase hit, or a failed
self-check) is dropped at generation and **cannot be approved** (422 `risk_blocked`) until edited clean; `review` (a lint error, or a too-late season)
needs the **two-step confirm** (`confirm.js`, action `proposal.approve`, bound to the proposal and its `updated_at`); `clear` means "nothing obvious", never
"cleared": the blocklist reads text only and cannot see a logo or a likeness.

**Queue.** Table `proposals` (status `pending|approved|rejected|snoozed`, every field, source signals JSON, `product_id` once approved, timestamps) and
`proposal_runs` (one row per generation: trigger, counts, drops, source, model, cost). Both additive (`CREATE TABLE IF NOT EXISTS`, `db.js`). Events go
to the existing log: `systemEvent` for each generation and decision, `productEvent` on the created product. Every field is editable inline
(`PATCH /api/proposals/:id`, validated; pending or snoozed only) and the server re-derives lint, risk, margin, window, image prompt and Redbubble copy; a
derived value the owner has overwritten stays theirs until they ask to re-derive it. Approve with `edits` is edit-and-approve. **Reject** takes an optional
reason that is stored and fed to the next prompt; rejected concepts are not proposed again. **Snooze** takes a future ET date; a snoozed proposal is pending
again on that date (woken lazily on any read). **Regenerate** replaces one pending proposal in place. A later "Draft copy" on the product overwrites the
pre-filled listing draft, as it would any draft.

**Weekly digest.** `POST /api/proposals/digest` generates a fresh batch now from the saved digest settings (`GET` summarises what is waiting and what is
urgent by season); the playbook `weekly-proposals` is the review checklist. The timer lives in `index.js main()` (hourly, plus once 30 s after boot, `unref`'d,
cleared on shutdown) and calls `proposals.weeklyTick()`, which does nothing unless `proposals_weekly_enabled` is `true`. **It is OFF by default**; when on it runs
at most once per 7 days and once per ET day, and skips when a backlog of three batches is unreviewed. It never throws and never runs under `require`.

**API** (all owner-only, `sameOrigin` on writes): `GET /api/proposals[?status=]`, `/config`, `/runs`, `/settings`, `/digest`, `/:id`; `POST /generate`,
`/digest`, `/settings`, `/:id/{approve,reject,snooze,unsnooze,regenerate}`; `PATCH /:id`. Codes: 400 bad input, 402/502 model failure, 404 unknown id, 409 wrong state
or bad confirm token, 422 refused by a rule, 429 daily cap.

## Channels

A **channel** is a place a product is sold, with a **capability flag**: `api` (ecom may publish and read sales itself: Etsy) or `manual`
(ecom prepares, a human uploads, ecom tracks and imports: Redbubble). `server/channels/contract.js` defines the contract and
`assertChannel`; `server/channels/index.js` is the registry and is built in `deps.js` as `deps.channels`. It is not a sixth adapter kind: adapters
are HTTP interfaces behind `route.js` (and `/api/summary` lists exactly five), a channel is the operator-facing layer above them. Full model, the
automated-versus-manual table, the Redbubble research (verified/assumed, with URLs) and how to add the next marketplace: `docs/CHANNELS.md`.

- **State.** `channel_listings` (additive; `UNIQUE(product_id, channel)`): `not_listed -> uploaded -> live -> removed` (`channels/state.js`
  `TRANSITIONS`). `live` needs a work URL on `redbubble.com` (https, host checked by suffix); the numeric work id is parsed from it and used to match sales.
  A work id can sit on only one product. Etsy's state is derived from `products.stage`, never stored. Channel state never writes `products.stage`.
  Every change leaves a note event. `GET /api/products` cards carry `channels`; `GET /api/products/:id` carries `channels` and `salesByChannel`.
- **Pack.** `GET /api/products/:id/redbubble/pack` (JSON for the folder view), `/pack.zip` (PNG + text files + `pack.json`), `/design.png`. The PNG is the stored
  design fitted inside 7632x6480 by the same `fitToArea` as uploads, cached under `DATA_DIR/channel-packs`; the size reported is read back from the file, and with no
  upscaler configured the design is packed as is and says so. Copy comes from the Etsy listing through `domain/redbubble-rules.js` (`adaptCopy`, `lintCopy`,
  `advise`), whose limits each carry a provenance string. The zip is written by `server/zip.js` (stored entries, no dependency).
- **Sales.** `POST /api/sales/redbubble/import {csv, preview}` and `/entry`. New nullable-safe column `sales.channel` (default `etsy`); Redbubble lines are
  `source = 'redbubble'`, gross = net = artist margin, no fees, `cogs_cents` NULL. `spend.summary()` adds `channels`. The CSV header names are assumed.
- **No automation of Redbubble**, by decision: no login, browser driver or scraping, enforced by a test. Owner-only comes from `app.js` like every other route.

## Not yet built

- Etsy's transaction/listing fee as API fields (not exposed; computed instead).
- Clean-up of an orphaned Printify product when a design is regenerated after a live create.
- The Etsy direct-create path (`createListing` is implemented but wired to no route: it needs taxonomy, shipping profile and images).
- Writing an AI-disclosure sentence into listings or setting Etsy's AI/"Designed by" fields (see `docs/COMPLIANCE.md`).
- Batch autopublish and the whole live Etsy/Printify path have never run against real accounts.
- Redbubble is manual only: no upload automation (see `docs/CHANNELS.md`); its sales CSV headers are assumed until a real export is seen; account fees are not in NET. TeePublic and Printify Pop-Up Store channels are not built.
- Printful (signature only), a real TrendResearch source, a visual (image) check for logos or likenesses.
- Refund edge cases not verified against a real refunded order (fee treatment, partial statuses).
- Proposals: never run against a real model, a live Printify catalog or live trend sources (tested with a fake model and the stubs). The lead times behind "too late" are assumed, unverified defaults; the base cost on a proposal is an estimate; a clean originality check is "nothing obvious", not clearance (see `docs/COMPLIANCE.md` section 8).

## Trends (added 2026-10-06)

`server/trends/` and `server/adapters/trend/{season,wikipedia,etsy-market,csv-import}.js`. Sources write numbers to `trend_metrics` (validated by `trends/metrics.js`, whitelist and aggregate-only; see COMPLIANCE.md section 6); `trends/score.js` combines them per theme x product type into `trend_scores` (weights untested, one config object); `trends/report.js` builds the weekly report served at `/api/trends/*` and shown in the Trends tab. The existing `TrendSource` / `adapters.trend.suggest` interface is unchanged; `deps.trends.trendSource` is a network-free TrendSource over stored numbers, and a rebuild raises concise `trend_signal` alerts for the top scores. Network happens only in `trends.collect()` (manual, or the weekly run, which is OFF unless `trend_weekly_enabled=true`). Etsy market is off by default behind a confirm-gated switch. Tables are additive (`trends/schema.js`).
