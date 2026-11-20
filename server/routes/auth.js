// routes/auth.js — customer OTP authentication (phone + 6-digit code).
//
// Security notes:
//   * Codes are 6 digits from crypto.randomInt, bcrypt-hashed (cost 12) at
//     rest, 5-minute expiry, max 5 verify attempts per code. There are no
//     hardcoded codes anywhere; verification ALWAYS runs bcrypt.compare.
//   * 60-second resend cooldown and max 5 OTP requests/hour per phone are
//     enforced at the DB level, so they hold even when the HTTP rate
//     limiter is disabled in tests.
//   * SMS failure never fails the request: the code is still stored and the
//     client still gets { ok: true, cooldownSeconds, devMode }.
//   * Plaintext codes are kept in an in-memory Map ONLY when NODE_ENV=test,
//     powering GET /api/__test__/last-otp. They are never written to the DB.
'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { nowIso } = require('../db');
const lib = require('../lib');
const sms = require('../sms');

const { ok, fail, asyncHandler, badRequest } = lib;

const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const OTP_COOLDOWN_MS = 60 * 1000; // 60 seconds between requests
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_PER_HOUR = 5;
const BCRYPT_COST = 12;

function authRoutes(ctx) {
  const { db, testOtpCodes } = ctx;
  const router = express.Router();

  // POST /api/auth/request-otp { phone, name? }
  router.post('/request-otp', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const phone = lib.reqString(body, 'phone', { max: 15 });
    if (!lib.isValidPhone(phone)) {
      badRequest('phone must be a valid 10-digit Indian mobile number');
    }
    const name = lib.optString(body, 'name', { max: 100 });

    // 60s resend cooldown (DB-level, always enforced).
    const latest = db
      .prepare('SELECT created_at FROM otp_codes WHERE phone = ? ORDER BY created_at DESC LIMIT 1')
      .get(phone);
    if (latest) {
      const elapsedMs = Date.now() - new Date(latest.created_at).getTime();
      if (elapsedMs < OTP_COOLDOWN_MS) {
        const retryAfterSeconds = Math.ceil((OTP_COOLDOWN_MS - elapsedMs) / 1000);
        return res.status(429).json({
          ok: false,
          error: 'OTP_COOLDOWN',
          message: 'Please wait before requesting another code',
          retryAfterSeconds
        });
      }
    }

    // Max 5 OTP requests/hour per phone (DB-level, always enforced).
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const hourCount = db
      .prepare('SELECT COUNT(*) AS n FROM otp_codes WHERE phone = ? AND created_at >= ?')
      .get(phone, oneHourAgo);
    if (hourCount.n >= OTP_MAX_PER_HOUR) {
      return fail(res, 429, 'OTP_LIMIT', 'Too many OTP requests for this number. Please try again later.');
    }

    const code = String(crypto.randomInt(100000, 999999));
    const codeHash = await bcrypt.hash(code, BCRYPT_COST);
    const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();

    // A new code supersedes any older ones for this phone.
    db.prepare('DELETE FROM otp_codes WHERE phone = ?').run(phone);
    db.prepare(
      `INSERT INTO otp_codes (phone, code_hash, name, expires_at, attempts, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`
    ).run(phone, codeHash, name, expiresAt, nowIso());

    if (process.env.NODE_ENV === 'test') {
      testOtpCodes.set(phone, code);
    }

    // SMS failure must NOT fail the request.
    const smsResult = await sms.sendOtp(phone, code);
    if (!smsResult.ok) {
      console.error(`OTP SMS failed for ${phone} (${smsResult.provider}): ${smsResult.error}`);
    }

    return ok(res, { cooldownSeconds: 60, devMode: !sms.isSmsConfigured() });
  }));

  // POST /api/auth/verify-otp { phone, code, name? }
  router.post('/verify-otp', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const phone = lib.reqString(body, 'phone', { max: 15 });
    if (!lib.isValidPhone(phone)) {
      badRequest('phone must be a valid 10-digit Indian mobile number');
    }
    const code = lib.reqString(body, 'code', { min: 6, max: 6 });
    if (!/^\d{6}$/.test(code)) badRequest('code must be a 6-digit number');
    const name = lib.optString(body, 'name', { max: 100 });

    const row = db
      .prepare('SELECT * FROM otp_codes WHERE phone = ? ORDER BY created_at DESC LIMIT 1')
      .get(phone);
    if (!row) {
      return fail(res, 401, 'OTP_EXPIRED', 'No valid code found. Please request a new one.');
    }
    if (new Date(row.expires_at) <= new Date()) {
      db.prepare('DELETE FROM otp_codes WHERE id = ?').run(row.id);
      return fail(res, 410, 'OTP_EXPIRED', 'This code has expired. Please request a new one.');
    }
    if (row.attempts >= OTP_MAX_ATTEMPTS) {
      db.prepare('DELETE FROM otp_codes WHERE id = ?').run(row.id);
      return fail(res, 401, 'OTP_TOO_MANY_ATTEMPTS', 'Too many wrong attempts. Please request a new code.');
    }

    const matches = await bcrypt.compare(code, row.code_hash);
    if (!matches) {
      const attempts = row.attempts + 1;
      if (attempts >= OTP_MAX_ATTEMPTS) {
        db.prepare('DELETE FROM otp_codes WHERE id = ?').run(row.id);
        return fail(res, 401, 'OTP_TOO_MANY_ATTEMPTS', 'Too many wrong attempts. Please request a new code.');
      }
      db.prepare('UPDATE otp_codes SET attempts = ? WHERE id = ?').run(attempts, row.id);
      return fail(res, 401, 'OTP_INVALID', 'Incorrect code. Please try again.');
    }

    // Success: the code is single-use.
    db.prepare('DELETE FROM otp_codes WHERE id = ?').run(row.id);
    if (process.env.NODE_ENV === 'test') {
      testOtpCodes.delete(phone);
    }

    // Create or fetch the user. A supplied name is used for a new user (or
    // the name captured at request-otp time); an existing user's name is
    // kept — profile updates go through PUT /api/profile.
    let user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    if (!user) {
      const userId = crypto.randomUUID();
      const userName = name || row.name || null;
      db.prepare(
        'INSERT INTO users (id, phone, name, language, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(userId, phone, userName, 'en', nowIso());
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    }

    const session = lib.createSession('customer', user.id);
    lib.setSessionCookies(res, session);
    return ok(res, { user: lib.mapUser(user) });
  }));

  // GET /api/auth/me
  router.get('/me', (req, res) => {
    if (!req.user) return fail(res, 401, 'UNAUTHENTICATED', 'Please log in to continue');
    return ok(res, { user: lib.mapUser(req.user) });
  });

  // POST /api/auth/logout — clears the cookies. Sessions are stateless
  // signed tokens, so a logged-out token stays cryptographically valid
  // until its 7-day expiry (documented tradeoff; see lib.js).
  router.post('/logout', (req, res) => {
    lib.clearSessionCookies(res);
    return ok(res, {});
  });

  return router;
}

module.exports = authRoutes;
