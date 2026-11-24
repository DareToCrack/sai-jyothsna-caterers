// routes/auth.js — customer authentication.
//
// Three login methods, all free for the business to run:
//   1. Email + password (always available; needs no third-party setup).
//   2. Google Sign-In (when GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are
//      set — standard OAuth 2.0 code flow, plain fetch, no extra deps).
//   3. Mobile OTP (only when an SMS/WhatsApp provider is configured; see
//      sms.js — MSG91 -> Twilio -> WhatsApp -> dev console log).
// GET /api/auth/methods reports which methods are actually available, and
// the frontend only shows those. MSG91 is therefore fully optional now:
// without it, customers simply log in with email/password or Google.
//
// Security notes:
//   * Passwords are bcrypt-hashed (cost 12) at rest. Login returns the
//     SAME generic error whether the email does not exist, the account
//     has no password (Google-only), or the password is wrong — no
//     account enumeration. Password rule: at least 8 characters with an
//     uppercase letter, a lowercase letter and a number.
//   * Password-reset tokens are 32 random bytes, SHA-256-hashed at rest,
//     1-hour expiry, single-use (same pattern as the admin reset flow,
//     stored in customer_password_resets). Forgot-password ALWAYS returns
//     the same generic success shape — it cannot probe which emails have
//     accounts.
//   * Google OAuth verifies a random state cookie (CSRF protection)
//     before exchanging the code. Accounts are matched by google_id
//     first, then by email (linking the google_id to the existing
//     account), then created. The redirect URI comes from
//     GOOGLE_REDIRECT_URI, defaulting to the request origin +
//     /api/auth/google/callback.
//   * OTP codes are 6 digits from crypto.randomInt, bcrypt-hashed (cost
//     12) at rest, 5-minute expiry, max 5 verify attempts per code.
//     There are no hardcoded codes anywhere; verification ALWAYS runs
//     bcrypt.compare.
//   * 60-second resend cooldown and max 5 OTP requests/hour per phone are
//     enforced at the DB level, so they hold even when the HTTP rate
//     limiter is disabled in tests.
//   * SMS failure never fails the request: the code is still stored and
//     the client still gets { ok: true, cooldownSeconds, devMode }.
//   * Plaintext codes and reset tokens are kept in in-memory Maps ONLY
//     when NODE_ENV=test, powering GET /api/__test__/last-otp and
//     GET /api/__test__/last-reset-token. They are never written to the DB.
'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { nowIso } = require('../db');
const lib = require('../lib');
const notify = require('../notify');
const sms = require('../sms');

const { ok, fail, asyncHandler, badRequest } = lib;

const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const OTP_COOLDOWN_MS = 60 * 1000; // 60 seconds between requests
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_PER_HOUR = 5;
const BCRYPT_COST = 12;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const OAUTH_STATE_COOKIE = 'sjc_oauth_state';
const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes
// Admin Google login reuses this same OAuth client and callback (one
// redirect URI registered with Google). The admin start endpoint
// (GET /api/admin/auth/google, in routes/admin.js) sets this separate
// state cookie; the callback branches on which cookie matches. Exported
// for the admin routes — keep the value in sync.
const OAUTH_ADMIN_STATE_COOKIE = 'sjc_oauth_admin';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

/**
 * The redirect URI registered with Google. GOOGLE_REDIRECT_URI wins when
 * set (recommended in production); otherwise the request origin is used,
 * which works locally and on Vercel (trust proxy is set in app.js, so
 * req.protocol is https there).
 */
function googleRedirectUri(req) {
  return process.env.GOOGLE_REDIRECT_URI
    || `${req.protocol}://${req.get('host')}/api/auth/google/callback`;
}

function authRoutes(ctx) {
  const { db, testOtpCodes, testResetTokens } = ctx;
  const router = express.Router();

  // =========================================================================
  // Login methods
  // =========================================================================

  // GET /api/auth/methods — which login methods are actually available.
  // The frontend shows only these. passwordReset is true when SMTP is
  // configured (reset emails need it); without it the forgot-password link
  // is hidden and customers are pointed at Contact Owner instead.
  router.get('/methods', (req, res) => {
    return ok(res, {
      password: true,
      google: Boolean(process.env.GOOGLE_CLIENT_ID),
      otp: sms.isSmsConfigured(),
      passwordReset: notify.isSmtpConfigured()
    });
  });

  // =========================================================================
  // Email + password
  // =========================================================================

  // POST /api/auth/signup { name, email, password, confirmPassword }
  router.post('/signup', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const name = lib.reqString(body, 'name', { min: 3, max: 100 });
    const email = lib.reqString(body, 'email', { max: 254 }).toLowerCase();
    if (!lib.isValidEmail(email)) badRequest('email must be a valid email address');
    const password = lib.reqString(body, 'password', { min: 8, max: 200 });
    if (!lib.isStrongPassword(password)) badRequest(lib.PASSWORD_RULE_MESSAGE);
    const confirmPassword = lib.reqString(body, 'confirmPassword', { max: 200 });
    if (confirmPassword !== password) badRequest('Passwords do not match');

    const existing = await db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      return fail(res, 409, 'EMAIL_EXISTS', 'An account with this email already exists. Please log in instead.');
    }

    const userId = crypto.randomUUID();
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    await db.prepare(
      `INSERT INTO users (id, phone, name, language, email, password_hash, auth_provider, created_at)
       VALUES (?, NULL, ?, 'en', ?, ?, 'password', ?)`
    ).run(userId, name, email, passwordHash, nowIso());
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

    const session = lib.createSession('customer', user.id);
    lib.setSessionCookies(res, session);
    return ok(res, { user: lib.mapUser(user) }, 201);
  }));

  // POST /api/auth/login { email, password } — generic error on failure
  // (no enumeration: same message for unknown email, Google-only account
  // with no password, and wrong password).
  router.post('/login', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const email = lib.reqString(body, 'email', { max: 254 }).toLowerCase();
    const password = lib.reqString(body, 'password', { max: 200 });
    const generic = 'Invalid email or password';
    const user = await db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !user.password_hash) {
      return fail(res, 401, 'INVALID_CREDENTIALS', generic);
    }
    const matches = await bcrypt.compare(password, user.password_hash);
    if (!matches) {
      return fail(res, 401, 'INVALID_CREDENTIALS', generic);
    }
    const session = lib.createSession('customer', user.id);
    lib.setSessionCookies(res, session);
    return ok(res, { user: lib.mapUser(user) });
  }));

  // =========================================================================
  // Google Sign-In (OAuth 2.0 code flow)
  // =========================================================================

  // GET /api/auth/google — redirect the browser to Google's consent screen.
  router.get('/google', (req, res) => {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      return fail(res, 400, 'GOOGLE_NOT_CONFIGURED', 'Google login is not configured for this site');
    }
    const state = crypto.randomBytes(32).toString('hex');
    res.cookie(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/api/auth/google',
      maxAge: OAUTH_STATE_MAX_AGE_MS
    });
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: googleRedirectUri(req),
      response_type: 'code',
      scope: 'openid email profile',
      state
    });
    return res.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`);
  });

  // GET /api/auth/google/callback — verify the state, exchange the code,
  // find-or-create the user, start a session, redirect back to the app.
  // Failures redirect to #/login?google=denied (user cancelled at Google)
  // or #/login?google=error (anything else), where the login view shows a
  // clear message. Success redirects to #/login, where the app's session
  // check sees the new session and sends the user on to their return-to
  // page (or home).
  //
  // The SAME callback serves admin Google login: when the state matches
  // the admin state cookie (set by GET /api/admin/auth/google), the
  // Google-verified email must match an EXISTING admin account — admins
  // are never auto-created (anyone with a Google account could otherwise
  // become an admin). A non-admin Google account redirects to
  // /admin.html?google=not-admin; a locked admin account to
  // /admin.html?google=locked; success to /admin.html with an admin
  // session. Admin failures use the admin login page, customer failures
  // the customer login view.
  router.get('/google/callback', asyncHandler(async (req, res) => {
    const { code, state, error } = req.query;
    const cookies = req.cookies || {};
    const adminState = cookies[OAUTH_ADMIN_STATE_COOKIE];
    const customerState = cookies[OAUTH_STATE_COOKIE];
    // The state is single-use: clear both cookies whatever happens next.
    res.clearCookie(OAUTH_STATE_COOKIE, { path: '/api/auth/google' });
    res.clearCookie(OAUTH_ADMIN_STATE_COOKIE, { path: '/api/auth/google' });
    // The flow is admin when the admin state cookie exists — even if the
    // returned state is tampered (a failed admin login must return to the
    // admin page, not the customer login view).
    const adminFlow = !!adminState;
    const isAdmin = !!(state && adminState && state === adminState);
    const isCustomer = !!(state && customerState && state === customerState);
    const failRedirect = (reason) => res.redirect(
      adminFlow ? `/admin.html?google=${reason}` : `/#/login?google=${reason}`);
    if (error) {
      return failRedirect(error === 'access_denied' ? 'denied' : 'error');
    }
    if (!code || !state || (!isAdmin && !isCustomer)) {
      return failRedirect('error');
    }
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      return failRedirect('error');
    }

    let tokenData;
    try {
      const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          redirect_uri: googleRedirectUri(req),
          grant_type: 'authorization_code'
        })
      });
      tokenData = await tokenRes.json();
      if (!tokenRes.ok || !tokenData.access_token) {
        console.error('Google token exchange failed:', tokenRes.status, JSON.stringify(tokenData).slice(0, 200));
        return failRedirect('error');
      }
    } catch (err) {
      console.error('Google token exchange failed:', err);
      return failRedirect('error');
    }

    let profile;
    try {
      const userRes = await fetch(GOOGLE_USERINFO_URL, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` }
      });
      profile = await userRes.json();
      if (!userRes.ok || !profile.sub || !profile.email) {
        console.error('Google userinfo failed:', userRes.status, JSON.stringify(profile).slice(0, 200));
        return failRedirect('error');
      }
    } catch (err) {
      console.error('Google userinfo failed:', err);
      return failRedirect('error');
    }

    const email = String(profile.email).toLowerCase();
    const googleId = String(profile.sub);
    const name = (profile.name && String(profile.name).trim()) || email.split('@')[0];

    // --- Admin Google login: email must match an EXISTING admin. ---
    // No account is ever created here, and a locked admin account stays
    // locked (Google login must not bypass the brute-force lockout).
    if (isAdmin) {
      const admin = await db.prepare('SELECT * FROM admin_users WHERE email = ?').get(email);
      if (!admin) {
        return failRedirect('not-admin');
      }
      if (admin.locked_until && Date.parse(admin.locked_until) > Date.now()) {
        return failRedirect('locked');
      }
      if (admin.failed_attempts || admin.locked_until) {
        await db.prepare(
          'UPDATE admin_users SET failed_attempts = 0, locked_until = NULL WHERE id = ?'
        ).run(admin.id);
      }
      await lib.auditLog(db, admin.id, 'admin.login-google', { email: admin.email });
      const session = lib.createSession('admin', admin.id);
      lib.setSessionCookies(res, session);
      return res.redirect('/admin.html');
    }

    // Match by google_id first, then by email (linking the google_id to
    // the existing account), then create a new Google account.
    let user = await db.prepare('SELECT * FROM users WHERE google_id = ?').get(googleId);
    if (!user) {
      user = await db.prepare('SELECT * FROM users WHERE email = ?').get(email);
      if (user) {
        await db.prepare('UPDATE users SET google_id = ? WHERE id = ?').run(googleId, user.id);
        user = await db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      }
    }
    if (!user) {
      const userId = crypto.randomUUID();
      await db.prepare(
        `INSERT INTO users (id, phone, name, language, email, google_id, auth_provider, created_at)
         VALUES (?, NULL, ?, 'en', ?, ?, 'google', ?)`
      ).run(userId, name, email, googleId, nowIso());
      user = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    }

    const session = lib.createSession('customer', user.id);
    lib.setSessionCookies(res, session);
    return res.redirect('/#/login');
  }));

  // =========================================================================
  // Customer forgot / reset password
  // =========================================================================

  // POST /api/auth/forgot-password — always returns the same generic
  // success shape whether or not the email exists (no account enumeration).
  // With SMTP configured, emails a one-time reset link (token stored
  // hashed, 1h expiry); without SMTP, no email can be sent — the frontend
  // hides the forgot-password link in that case (see /methods).
  router.post('/forgot-password', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const email = lib.reqString(body, 'email', { max: 254 }).toLowerCase();
    const generic = 'If an account exists for this email, a password reset link has been sent.';
    // A malformed address gets the same success shape — nothing to learn.
    if (!lib.isValidEmail(email)) {
      return ok(res, { message: generic });
    }
    const user = await db.prepare('SELECT * FROM users WHERE email = ?').get(email);

    if (user && notify.isSmtpConfigured()) {
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
      await db.prepare('DELETE FROM customer_password_resets WHERE user_id = ?').run(user.id);
      await db.prepare(
        `INSERT INTO customer_password_resets (user_id, token_hash, expires_at, used, created_at)
         VALUES (?, ?, ?, 0, ?)`
      ).run(user.id, tokenHash, expiresAt, nowIso());

      if (process.env.NODE_ENV === 'test') {
        testResetTokens.set(email, token);
      }

      const origin = `${req.protocol}://${req.get('host')}`;
      const resetLink = `${origin}/#/reset?token=${token}`;
      try {
        await notify.sendPasswordResetEmail({ to: user.email, resetLink });
      } catch (err) {
        console.error('forgot-password email failed:', err);
        // Still return the generic success shape — no enumeration.
      }
    } else if (user) {
      console.warn('forgot-password requested but SMTP is not configured; no reset email sent');
    }
    return ok(res, { message: generic });
  }));

  // POST /api/auth/reset-password { token, newPassword, confirmPassword }
  router.post('/reset-password', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const token = lib.reqString(body, 'token', { max: 200 });
    const newPassword = lib.reqString(body, 'newPassword', { min: 8, max: 200 });
    if (!lib.isStrongPassword(newPassword)) badRequest(lib.PASSWORD_RULE_MESSAGE);
    const confirmPassword = lib.reqString(body, 'confirmPassword', { max: 200 });
    if (confirmPassword !== newPassword) badRequest('Passwords do not match');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const row = await db
      .prepare('SELECT * FROM customer_password_resets WHERE token_hash = ? AND used = 0')
      .get(tokenHash);
    if (!row || new Date(row.expires_at) <= new Date()) {
      return fail(res, 400, 'INVALID_RESET_TOKEN', 'This reset link is invalid or has expired');
    }
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
    await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, row.user_id);
    await db.prepare('UPDATE customer_password_resets SET used = 1 WHERE id = ?').run(row.id);
    // NOTE: sessions are stateless signed tokens (see lib.js), so tokens
    // issued before this reset stay valid until their 7-day expiry. The
    // reset token itself is single-use and the old password no longer works.
    return ok(res, { message: 'Password has been reset. Please log in with your new password.' });
  }));

  // =========================================================================
  // Mobile OTP (optional — only offered when a provider is configured)
  // =========================================================================

  // POST /api/auth/request-otp { phone, name? }
  router.post('/request-otp', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const phone = lib.normalizePhone(lib.reqString(body, 'phone', { max: 20 }));
    if (!lib.isValidPhone(phone)) {
      badRequest('phone must be a valid 10-digit Indian mobile number');
    }
    const name = lib.optString(body, 'name', { max: 100 });

    // 60s resend cooldown (DB-level, always enforced).
    const latest = await db
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
    const hourCount = await db
      .prepare('SELECT COUNT(*) AS n FROM otp_codes WHERE phone = ? AND created_at >= ?')
      .get(phone, oneHourAgo);
    if (hourCount.n >= OTP_MAX_PER_HOUR) {
      return fail(res, 429, 'OTP_LIMIT', 'Too many OTP requests for this number. Please try again later.');
    }

    const code = String(crypto.randomInt(100000, 999999));
    const codeHash = await bcrypt.hash(code, BCRYPT_COST);
    const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();

    // A new code supersedes any older ones for this phone.
    await db.prepare('DELETE FROM otp_codes WHERE phone = ?').run(phone);
    await db.prepare(
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
    const phone = lib.normalizePhone(lib.reqString(body, 'phone', { max: 20 }));
    if (!lib.isValidPhone(phone)) {
      badRequest('phone must be a valid 10-digit Indian mobile number');
    }
    const code = lib.reqString(body, 'code', { min: 6, max: 6 });
    if (!/^\d{6}$/.test(code)) badRequest('code must be a 6-digit number');
    const name = lib.optString(body, 'name', { max: 100 });

    const row = await db
      .prepare('SELECT * FROM otp_codes WHERE phone = ? ORDER BY created_at DESC LIMIT 1')
      .get(phone);
    if (!row) {
      return fail(res, 401, 'OTP_EXPIRED', 'No valid code found. Please request a new one.');
    }
    if (new Date(row.expires_at) <= new Date()) {
      await db.prepare('DELETE FROM otp_codes WHERE id = ?').run(row.id);
      return fail(res, 410, 'OTP_EXPIRED', 'This code has expired. Please request a new one.');
    }
    if (row.attempts >= OTP_MAX_ATTEMPTS) {
      await db.prepare('DELETE FROM otp_codes WHERE id = ?').run(row.id);
      return fail(res, 401, 'OTP_TOO_MANY_ATTEMPTS', 'Too many wrong attempts. Please request a new code.');
    }

    const matches = await bcrypt.compare(code, row.code_hash);
    if (!matches) {
      const attempts = row.attempts + 1;
      if (attempts >= OTP_MAX_ATTEMPTS) {
        await db.prepare('DELETE FROM otp_codes WHERE id = ?').run(row.id);
        return fail(res, 401, 'OTP_TOO_MANY_ATTEMPTS', 'Too many wrong attempts. Please request a new code.');
      }
      await db.prepare('UPDATE otp_codes SET attempts = ? WHERE id = ?').run(attempts, row.id);
      return fail(res, 401, 'OTP_INVALID', 'Incorrect code. Please try again.');
    }

    // Success: the code is single-use.
    await db.prepare('DELETE FROM otp_codes WHERE id = ?').run(row.id);
    if (process.env.NODE_ENV === 'test') {
      testOtpCodes.delete(phone);
    }

    // Create or fetch the user. A supplied name is used for a new user (or
    // the name captured at request-otp time); an existing user's name is
    // kept — profile updates go through PUT /api/profile.
    let user = await db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    if (!user) {
      const userId = crypto.randomUUID();
      const userName = name || row.name || null;
      await db.prepare(
        'INSERT INTO users (id, phone, name, language, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(userId, phone, userName, 'en', nowIso());
      user = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
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
// Shared with routes/admin.js (admin Google login reuses this client,
// redirect URI, and callback — see OAUTH_ADMIN_STATE_COOKIE above).
module.exports.OAUTH_ADMIN_STATE_COOKIE = OAUTH_ADMIN_STATE_COOKIE;
module.exports.OAUTH_STATE_MAX_AGE_MS = OAUTH_STATE_MAX_AGE_MS;
module.exports.googleRedirectUri = googleRedirectUri;
module.exports.GOOGLE_AUTH_URL = GOOGLE_AUTH_URL;
