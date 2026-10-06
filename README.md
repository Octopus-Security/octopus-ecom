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

Milestone M1: everything from M0 plus the **New product** composer (brief, niche,
keywords, list price -> generate design -> auto-draft Etsy copy), board cards with
thumbnail, cost and flags, and a detail drawer with regenerate (edit the brief) and
copy editing with live Etsy-limit counters. With an OpenAI key (panel Settings or
`OPENAI_API_KEY`) generation is real (BYOK, governed by the daily spend cap) even in
dry-run; without one it is stubbed. Print-on-demand, Etsy publishing and the batch
orchestrator arrive in later milestones. See `ARCHITECTURE.md`.
