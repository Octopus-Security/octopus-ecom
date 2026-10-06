'use strict';
/** app.js — buildApp(deps): the Express app, no listen(). index.js owns config, refusals and listen. */
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { sameOrigin } = require('./auth');
const { BUILD, STARTED_AT } = require('./build');
const { router, errorHandler } = require('./routes/api');
const { createWatchRouter } = require('./watch');
const { createPlaybookRouter } = require('./playbooks');
const { createPlanRouter } = require('./plan/routes');
const { actorMiddleware } = require('./llm/actor');

const DIST = path.join(__dirname, '..', 'client', 'dist');

function buildApp(deps) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
    next();
  });

  // Unauthenticated probes. Nothing here reveals data.
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get('/api/build', (_req, res) => res.json({ ok: true, service: 'octopus-ecom', build: BUILD, startedAt: STARTED_AT, gate: deps.auth.gateSlug || null }));

  app.use(express.json({ limit: '1mb' }));
  app.use(deps.auth.identify);
  app.use(deps.auth.requireOwner);
  app.use(sameOrigin);
  app.use(actorMiddleware); // who a model call is billed to (cortex)

  // Before the /api router, whose catch-all 404 would swallow these. Same owner auth + sameOrigin as above.
  app.use('/api/watch', createWatchRouter(deps, { service: deps.watch }));
  app.use('/api/playbooks', createPlaybookRouter(deps));
  app.use('/api/plan', createPlanRouter(deps));
  app.use('/api', router(deps));

  if (fs.existsSync(path.join(DIST, 'index.html'))) {
    app.use(express.static(DIST, { index: false, maxAge: '1h' }));
    app.get('*', (_req, res) => res.sendFile(path.join(DIST, 'index.html')));
  } else {
    app.get('/', (_req, res) => res.type('text').send('octopus-ecom API is running. The panel is not built: run `npm start` (it builds client/dist) or `npm run build`.'));
  }

  app.use(errorHandler(deps));
  return app;
}

module.exports = { buildApp };
