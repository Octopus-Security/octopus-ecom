# Architecture (first draft, milestone M0, 2026-10-05)

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

In M0 every real adapter is a scaffold (`implemented: false`), so all five run as
stubs whatever credentials exist. Printify (M2) and Etsy (M3) are signature-only; Printful is a
signature-only scaffold that stays unimplemented.

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
events (`kind = 'system'`). Confirm tokens are in memory (a restart invalidates them).

## Not yet built

Composer and real image generation (M1), Printify (M2), Etsy OAuth, publish path and
receipt ingest (M3), batch orchestrator, print-readiness enforcement and
`docs/COMPLIANCE.md` (M4).
