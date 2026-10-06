# octopus-ecom — notes for working on this code

This repository is public; keep this file to facts about the code.

- Node 22+, Express 4 in `server/`, React + Vite in `client/`. One `npm install` at the root.
- `npm test` needs nothing but node and express: no network, no keys. Tests inject fake fetch/clock.
- `server/index.js` must stay side-effect free on `require` (boots.test.js loads it); it listens only when run directly. Exit 1 = deliberate boot refusal.
- Money is integer cents. Fee constants live only in `server/domain/fees.js`, each with a provenance comment. Never mark an external-API claim "verified" unless the source was actually read.
- `products.stage` is written only by `server/domain/stages.js` (a test greps for violations). Everything else calls `transition()`.
- Credentials never leave the server: the API returns `{present, fp, tail, source}` only. Env values are never written to the DB. Everything logged goes through the redactor.
- Real adapters go through `server/adapters/http.js`. Under DRY_RUN, marketplace/POD writes are faked; reads and image/LLM generation are real when a key exists.
- Migrations are additive (`addColumn` in `server/db.js`). Never drop or reset tables.
- No code may fetch competitor listing images or titles.
- Pushing to main deploys. Do not push work you are not ready to ship.
- Paid calls (images, LLM) check the daily cap BEFORE the request, inside the real adapter/provider, and the pipeline records the actual `costs` row after. A cap refusal pauses; it does not fail the product or fall back to a stub.
- Etsy text limits are enforced in code by `enforceCopy()` whatever a model returns; stored image dimensions are read from the PNG, never from a hook's claim.
