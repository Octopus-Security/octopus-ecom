# Architecture (first draft, milestone M1, 2026-10-05)

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
  domain/         stages.js (state machine), fees.js, etsy-rules.js, blocklist.js
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
marketplace write). Printify (M2), Etsy (M3) and trend research remain stubs/scaffolds; Printful is a
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

## Credentials

A credential comes from the sealed keystore (set in the panel) or, failing that,
from env. Sealed with AES-256-GCM, key derived by scrypt from `ECOM_SECRET`; there
is no default secret. Production without `ECOM_SECRET` refuses to boot; in dev one
is generated into `DATA_DIR/.dev-secret` (0600). The API returns only
`{present, fp, tail, source}`. Every log line goes through a redactor with token
shapes plus the exact value of every sealed secret and credential env var.

## Money

Integer cents everywhere. Fee constants only in `server/domain/fees.js`, each with a
provenance comment. Projected margin = list price - POD base cost - listing fee -
transaction fee(list + shipping) - processing fee. NET (summary) = sum of
`sales.net_cents` (gross less Etsy and processing fees) minus every `costs` row.
`MARGIN_FLOOR` and `DAILY_SPEND_CAP` are dollars in env, cents internally; the daily
cap uses the America/New_York calendar day.

## Data model

SQLite via `node:sqlite`. Spec tables: `stores`, `products`, `designs`, `mockups`,
`listings`, `events`, `costs`, `sales`; plus `settings`, `keys` (sealed),
`blocklist`. Migrations are additive only. `events.product_id` is NULL for system
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

Printify (M2; must implement `getAvailability`, and `getVariantCosts` returning `{variants:[{id,title,costCents}]}`), Etsy OAuth (M3; must implement `getListingStats(externalId) -> {views, favorites, sales}`, endpoint/scope assumed, unverified), publish path and
receipt ingest (M3), batch orchestrator, print-readiness enforcement and
`docs/COMPLIANCE.md` (M4).
