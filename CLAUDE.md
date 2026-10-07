# octopus-ecom — notes for working on this code

This repository is public; keep this file to facts about the code.

- Node 22+, Express 4 in `server/`, React + Vite in `client/`. One `npm install` at the root.
- `npm test` needs nothing but node and express: no network, no keys. Tests inject fake fetch/clock.
- `server/index.js` must stay side-effect free on `require` (boots.test.js loads it); it listens only when run directly. Exit 1 = deliberate boot refusal.
- Money is integer cents. Fee rates live only in `server/domain/fee-schedule.js` (editable via the `fee_schedule` setting, each with a provenance note); `fees.js` takes the schedule as an argument. Never mark an external-API claim "verified" unless the source was actually read.
- `products.stage` is written only by `server/domain/stages.js` (a test greps for violations). Everything else calls `transition()`.
- Credentials never leave the server: the API returns `{present, fp, tail, source}` only. Env values are never written to the DB. Everything logged goes through the redactor.
- Real adapters go through `server/adapters/http.js`. Under DRY_RUN, marketplace/POD writes are faked; reads and image/LLM generation are real when a key exists.
- Migrations are additive (`addColumn` in `server/db.js`). Never drop or reset tables.
- No code may fetch competitor listing images or titles.
- Pushing to main deploys. Do not push work you are not ready to ship.
- Paid calls (images, LLM) check the daily cap BEFORE the request, inside the real adapter/provider, and the pipeline records the actual `costs` row after. A cap refusal pauses; it does not fail the product or fall back to a stub.
- Etsy text limits are enforced in code by `enforceCopy()` whatever a model returns; stored image dimensions are read from the PNG, never from a hook's claim.
- The POD base cost is per-unit COGS on sale, not spend: never write it to `costs` at draft time. Printify exposes it only on a created product, so under DRY_RUN it is a labelled estimate (`pod_cost_source`, `pod_cost_estimated` flag).
- Never downscale a design to fit an upload limit; fail with the reason instead.
- Etsy tokens exist only sealed in `stores.oauth_sealed`; OAuth state and PKCE verifiers live sealed in `oauth_pending`, single use, 10 minutes. Etsy `x-api-key` is `keystring:shared_secret`.
- A live publish is refused by name (`etsy/publish.js` `blockers`) before any confirm token exists; the Etsy listing fee is written once, when the listing id is first known. `costs.kind='pod'` is per-sale COGS written only by the sales ingest, and neither it nor `listing_fee` counts toward the daily cap.
- Simulated (stub) sales carry `source='stub'` and never enter real NET.
- Print readiness reads the PNG header of the stored file, never stored metadata; do not weaken the default (`PRINT_MIN_COVERAGE=1`, cover) to make a design pass: change the rule explicitly or regenerate.
- A blocklist hit only flags. The matcher is token-based (`domain/blocklist.js`); add a seeded common word only as the phrase that makes it a brand, and add a false-positive test with any new rule.
- The batch orchestrator never publishes except through autopublish (store flag, DRY_RUN off, no flags, QA ran) via `pipeline.approve` + `publisher.publish`; a cap hit is a pause, not a failure; QA only adds flags.
- A refund has no Etsy id: its key is derived; never subtract without the `refunds.refund_key` uniqueness check.
- Channels have a capability flag (`api` or `manual`, `server/channels/contract.js`). Redbubble is `manual` on purpose: never add login, browser automation or scraping for it (its rules reportedly forbid bots; a test enforces it). Its limits and CSV headers are labelled assumed in `domain/redbubble-rules.js` and `channels/redbubble-sales.js`; change them there when a real export or upload form disagrees. Never mark them verified unless the official page was read.
- Redbubble sales are `sales.channel='redbubble'`, gross = net = artist margin, no COGS; `sales.channel` defaults to `etsy`.
- Trend numbers go only through `server/trends/metrics.js` (closed whitelist, numbers, our own terms, aggregates n>=20); `FORBIDDEN_KEYS` and the text-signal rule stay strict. The Etsy market source is disabled by default and must never store titles, tags, images, shop or listing ids, or call shop endpoints. Season dates come from `trends/season-table.js` (Hanukkah is a table, never guessed); all dates are ET.
