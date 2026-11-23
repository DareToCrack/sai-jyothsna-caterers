// app.js — Express app factory.
//
// createApp({ dbPath }) is async: it opens (and seeds, idempotently) the
// database — Turso when TURSO_DATABASE_URL is set, otherwise a local
// SQLite file (see server/db.js) — and returns { app, db, close } so
// tests can start it on an ephemeral port with a temp DB file. server.js
// uses the same factory for local dev and api/index.js uses it for Vercel
// serverless (where the DB is auto-created + auto-seeded on cold start —
// seed() is idempotent, INSERT OR IGNORE, so concurrent cold starts can
// never double-seed). Sessions are stateless HMAC-signed cookies (see
// lib.js), so no shared session store is needed across serverless
// instances.
//
// Rate limiting: express-rate-limit is DISABLED when NODE_ENV=test so the
// test suite can exercise the API freely. The DB-level OTP limits (60s
// cooldown, 5/hour per phone, 5 verify attempts) stay enforced in tests —
// they are the real abuse guards for the OTP flow, and the tests verify
// them. In every other environment all limiters are active.
'use strict';

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');

const { openDb } = require('./db');
const { seed } = require('./seed');
const lib = require('./lib');
const uploads = require('./uploads');
const publicRoutes = require('./routes/public');
const authRoutes = require('./routes/auth');
const customerRoutes = require('./routes/customer');
const adminRoutes = require('./routes/admin');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function jsonRateLimitHandler(req, res) {
  return lib.fail(res, 429, 'RATE_LIMITED', 'Too many requests, please try again later.');
}

async function createApp(options = {}) {
  const db = await openDb(options.dbPath);
  // Idempotent: safe to run on every startup; INSERT OR IGNORE means a
  // re-run changes nothing (and never overwrites admin-edited settings).
  await seed(db, { log: process.env.NODE_ENV !== 'test' });

  // In-memory stores for tests ONLY (populated at OTP generation /
  // password-reset request when NODE_ENV=test; plaintext codes and tokens
  // are never persisted in the DB).
  const testOtpCodes = new Map();
  const testResetTokens = new Map();
  const ctx = { db, testOtpCodes, testResetTokens };

  const app = express();
  app.disable('x-powered-by');
  // Trust the first proxy (Vercel) so req.protocol / req.ip reflect the
  // real client: the Google OAuth redirect URI and the password-reset
  // links must be https on Vercel, and the rate limiter keys on the real
  // client IP. `1` (not `true`) trusts exactly one hop — express-rate-
  // limit rejects a fully permissive trust-proxy setting.
  app.set('trust proxy', 1);

  // Security headers. CSP is disabled: the frontend pages served from
  // public/ use inline scripts/styles, which a default CSP would break.
  // All other helmet protections (HSTS, X-Content-Type-Options, frameguard,
  // referrer-policy, …) remain active.
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: '200kb' }));
  app.use(cookieParser());

  // --- Rate limiters (skipped in tests; see the header comment) ---
  const isTest = process.env.NODE_ENV === 'test';
  if (!isTest) {
    const globalLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 300,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      handler: jsonRateLimitHandler
    });
    app.use('/api/', globalLimiter);

    const authLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 30,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      handler: jsonRateLimitHandler
    });
    app.use('/api/auth/request-otp', authLimiter);
    app.use('/api/auth/verify-otp', authLimiter);
    app.use('/api/auth/signup', authLimiter);
    app.use('/api/auth/login', authLimiter);
    app.use('/api/auth/forgot-password', authLimiter);
    app.use('/api/auth/reset-password', authLimiter);
    app.use('/api/auth/google', authLimiter);

    const adminLoginLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 10,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      handler: jsonRateLimitHandler
    });
    app.use('/api/admin/auth/login', adminLoginLimiter);
  }

  // --- Session loading + CSRF (must run before the routes) ---
  app.use(lib.loadSession(db));
  app.use(lib.csrfGuard);

  // --- Keep-alive for the Turso free tier (see vercel.json cron) ---
  // Free Turso databases are archived after 10 days without activity, so
  // Vercel pings this endpoint once a day. The SELECT is the activity.
  // When CRON_SECRET is set (Vercel sets it automatically for cron jobs),
  // the request must carry `Authorization: Bearer <CRON_SECRET>`; without
  // it the endpoint is open, so local dev and manual pings still work.
  app.get('/api/cron/keep-alive', async (req, res) => {
    const secret = process.env.CRON_SECRET;
    if (secret) {
      const header = req.get('Authorization') || '';
      const expected = `Bearer ${secret}`;
      const okHeader = header.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
      if (!okHeader) {
        return lib.fail(res, 401, 'UNAUTHENTICATED', 'Invalid cron secret');
      }
    }
    try {
      await db.prepare('SELECT 1 AS ok').get();
      return lib.ok(res, { ok: true, dbMode: db.mode });
    } catch (err) {
      console.error('keep-alive check failed:', err);
      return lib.fail(res, 500, 'INTERNAL_ERROR', 'Database check failed');
    }
  });

  // --- API routes ---
  app.use('/api', publicRoutes(ctx));
  app.use('/api/auth', authRoutes(ctx));
  app.use('/api', customerRoutes(ctx));
  app.use('/api/admin', adminRoutes(ctx));

  // --- Uploaded images (admin item photos), stored as BLOBs in the
  // database. Served through a route — not express.static — so uploads
  // work identically in every environment. Safe content type +
  // traversal rejection live in uploads.serveUpload.
  app.get('/api/uploads/:name', (req, res) => uploads.serveUpload(db, req, res));

  // --- Static frontend (index.html at /, admin.html). On Vercel these
  // files are served statically by Vercel itself and never reach this
  // function; locally the same middleware serves them. (Legacy /uploads/*
  // URLs from databases created before the /api/uploads move still resolve
  // through this static middleware on local/VPS installs.)
  app.use(express.static(PUBLIC_DIR));

  // --- 404 + error handling ---
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      return lib.fail(res, 404, 'NOT_FOUND', 'Not found');
    }
    return res.status(404).send('Not found');
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // Multer upload errors (file too large, wrong type).
    if (err && (err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_UNEXPECTED_FILE')) {
      return lib.fail(res, 400, 'FILE_TOO_LARGE', 'Uploaded file must be 2 MB or smaller');
    }
    if (err && err.code === 'INVALID_FILE_TYPE') {
      return lib.fail(res, 400, 'INVALID_FILE_TYPE', err.message);
    }
    // Malformed JSON bodies.
    if (err && err.type === 'entity.parse.failed') {
      return lib.fail(res, 400, 'VALIDATION_ERROR', 'Request body is not valid JSON');
    }
    if (err && err.type === 'entity.too.large') {
      return lib.fail(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
    }
    console.error('Unhandled error:', err);
    if (req.path.startsWith('/api/')) {
      return lib.fail(res, 500, 'INTERNAL_ERROR', 'Something went wrong');
    }
    return res.status(500).send('Internal server error');
  });

  return {
    app,
    db,
    close: () => {
      try {
        db.close();
      } catch { /* already closed */ }
    }
  };
}

module.exports = { createApp };
