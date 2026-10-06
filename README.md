# octopus-ecom

An operator's console and pipeline for print-on-demand: a design brief becomes an
original generated design, a product mockup and an SEO'd draft listing, waits for a
human approval, and is then published. Per-product cost, fees and revenue are
tracked so NET profit is visible.

It is **not** a tool for copying other sellers' designs or listings. Trend research
informs themes and keywords only; every design is generated original.

## Quick start

```sh
npm install
npm start
# open http://127.0.0.1:3050
```

No keys are needed: with nothing configured everything runs against stubs in
**DRY_RUN** (the default). `npm start` builds the panel on first run and generates a
local development secret into `data/.dev-secret` (gitignored). Copy `.env.example`
for every optional setting.

```sh
npm test     # node:test, no network, no keys
```

Operator playbooks (checklists for margin drops, stock-outs, etc.) live in `docs/playbooks/`; they are generated from `server/playbooks/definitions.js`.

## Status

Milestone M3: everything from M2 plus the real Etsy Open API v3 adapter (OAuth2 + PKCE connect
from Settings -> Stores, token refresh, listing edits, receipt ingest), the Printify -> Etsy publish
path (confirm-gated, refused unless every precondition holds), reconcile to `live`, per-sale COGS and
NET from real receipts. Etsy and publishing only go real with Etsy app credentials, a connected
shop and DRY_RUN off; otherwise everything is stubbed and a publish is only simulated.
The batch orchestrator and print-readiness check are M4. Generation is real with an OpenAI key
(BYOK, daily cap) even in dry-run; otherwise stubbed. See `ARCHITECTURE.md` (including the exact
steps to register the Etsy app and connect).
