// api/index.js — Vercel serverless entry point (@vercel/node).
//
// The Express app is created lazily behind a guarded promise: the first
// request in a serverless instance opens the (ephemeral /tmp) SQLite
// database and runs the idempotent seed, and concurrent cold-start
// requests all await the SAME promise, so initialisation runs exactly
// once per instance and can never double-seed. If init fails, the guard
// resets so a later request can retry.
//
// Local development does not use this file — `npm start` runs
// server/server.js, which listens on PORT directly.
'use strict';

// Load .env first (a no-op on Vercel, where env vars come from the
// dashboard; useful when testing the serverless entry locally).
require('../server/env').loadEnvFile();

const { createApp } = require('../server/app');

let appPromise = null;

function getApp() {
  if (!appPromise) {
    // createApp() is async (it opens the database) — await it before
    // taking .app. (Calling createApp().app on the pending promise
    // resolves to undefined and every request then fails with
    // "TypeError: app is not a function".)
    appPromise = (async () => {
      try {
        const { app } = await createApp();
        return app;
      } catch (err) {
        appPromise = null; // let a later request retry initialisation
        console.error('Serverless app initialisation failed:', err);
        throw err;
      }
    })();
  }
  return appPromise;
}

module.exports = async (req, res) => {
  const app = await getApp();
  app(req, res);
};
