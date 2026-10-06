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

Milestone M2: everything from M1 plus a Printify adapter (catalog reads are real once
`PRINTIFY_API_TOKEN` is set, product creation is faked under dry-run), a composer that picks
blueprint, print provider and variants with a live projected margin, mockups on the card and
drawer, and an approval gate (submit, two-step confirmed approve, reject, archive). Publishing
to a real store arrives in M3, the batch orchestrator and print-readiness check in M4.
Generation is real with an OpenAI key (BYOK, daily cap) even in dry-run; otherwise stubbed.
See `ARCHITECTURE.md`.
