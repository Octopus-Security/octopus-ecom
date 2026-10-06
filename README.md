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

## Status

Milestone M0 (skeleton): server, panel with an empty board, sealed credential
storage, DRY_RUN plumbing, the product state machine, and stub adapters for image
generation, print-on-demand, storefront, trend research and listing copy. The
composer, real providers, Etsy OAuth and the batch orchestrator arrive in later
milestones. See `ARCHITECTURE.md`.
