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

## First run, end to end (no keys)

1. `npm install && npm start`, open http://127.0.0.1:3050. The top bar shows **DRY RUN: ON**.
2. **New product** (or **Run batch**): pick the stub "Unisex Tee", a price, and generate. The stub makes a placeholder design at the full print
   size, a placeholder mockup and copy, and a projected margin on an *estimated* base cost.
3. Open the card, **Submit for approval**, then **Approve...** (a summary lists price, margin and any flags). Publishing is only simulated while
   DRY_RUN is on. Nothing leaves the machine.

Going live is deliberate and step by step (see `ARCHITECTURE.md`): add keys in Settings (OpenAI for real images and copy, Printify, Etsy app
credentials), connect Etsy, arm live writes (typed phrase), re-run "create POD product" to read the real cost, approve, publish.

**Batches:** *Run batch* takes a niche and a count (max 25), proposes original concepts, and takes each product to PENDING_APPROVAL, then
stops. It pauses when the daily spend cap is reached and survives a restart. **Blocklist** and the **print-readiness rule** are in Settings.
**Channels:** Etsy is automatic (`api`); Redbubble is `manual`: ecom builds an upload pack (sized PNG, adapted and linted copy, markup, product types, checklist), tracks not listed / uploaded / live, and imports the Redbubble sales CSV into NET. See `docs/CHANNELS.md` and the `redbubble-*` playbooks.

**Proposals:** the *Proposals* tab generates original product ideas from your own seeds (themes, occasions, audiences), your watchlist and any trend signals, each with an Etsy title and 13 tags, a Redbubble variant, a design brief and a ready-to-paste image prompt, an *estimated* price and margin, and a season window (list-by and last-realistic-order dates, flagged TOO LATE when this year's has passed; the lead times are assumed defaults you can edit). Every field is editable inline. **Approve** (or edit-and-approve) creates a pre-filled product in the IDEA stage and nothing more; **Reject** takes a reason that the next batch is told about; **Snooze** hides one until a date; **Regenerate** replaces one. It needs no keys (deterministic templates with the stub model); with cortex or an OpenAI key a cheap/standard model writes them, under the daily cap (calls billed through cortex are metered there). A weekly digest exists but is OFF by default (`proposals_weekly_enabled`); the checklist is the `weekly-proposals` playbook. Design: `ARCHITECTURE.md` "Proposals"; the originality rules: `docs/COMPLIANCE.md` section 8.

**Legal/policy assumptions** and what is not verified: `docs/COMPLIANCE.md`.

## Status

All milestones (M0-M4) are built; the Etsy path has never been run against a live shop (it is tested against fakes built from Etsy's
published OpenAPI document). Generation is real with an OpenAI key (BYOK, daily cap) even in dry-run; otherwise stubbed. Text generation (listing copy, ideas, the **Plan** chat tab) goes through octopus-cortex when `INTERNAL_SECRET` is set, billed to the signed-in user. Known gaps are
listed under "Not yet built" in `ARCHITECTURE.md`.
