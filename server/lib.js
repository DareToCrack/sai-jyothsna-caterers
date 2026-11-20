// lib.js — shared helpers: API envelope, validation, stateless HMAC-signed
// sessions, CSRF, auth middleware, audit logging, and DB-row -> camelCase
// mappers.
'use strict';

const crypto = require('crypto');
const { nowIso } = require('./db');

const CUSTOMER_SESSION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000; // 8 hours
const PHONE_RE = /^[6-9]\d{9}$/;
const EMAIL_RE = /^\S+@\S+\.\S+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PINCODE_RE = /^\d{6}$/;

// ---------------------------------------------------------------------------
// Envelope + errors
// ---------------------------------------------------------------------------

function ok(res, payload = {}, status = 200) {
  return res.status(status).json({ ok: true, ...payload });
}

function fail(res, status, code, message) {
  return res.status(status).json({ ok: false, error: code, message });
}

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function badRequest(message, code = 'VALIDATION_ERROR') {
  throw new ApiError(400, code, message);
}

function unauthorized(message = 'Authentication required', code = 'UNAUTHENTICATED') {
  throw new ApiError(401, code, message);
}

function forbidden(message = 'Forbidden', code = 'FORBIDDEN') {
  throw new ApiError(403, code, message);
}

function notFound(message = 'Not found', code = 'NOT_FOUND') {
  throw new ApiError(404, code, message);
}

/** Wrap an async route handler so ApiErrors become envelope responses. */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      if (err instanceof ApiError) return fail(res, err.status, err.code, err.message);
      return next(err);
    });
  };
}

// ---------------------------------------------------------------------------
// Validation helpers (all throw ApiError 400 on bad input)
// ---------------------------------------------------------------------------

function reqString(body, field, { min = 1, max = 500 } = {}) {
  const value = body[field];
  if (typeof value !== 'string' || value.trim().length < min) {
    badRequest(`${field} is required`);
  }
  if (value.trim().length > max) {
    badRequest(`${field} must be at most ${max} characters`);
  }
  return value.trim();
}

function optString(body, field, { max = 500, defaultValue = null } = {}) {
  const value = body[field];
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value !== 'string') badRequest(`${field} must be a string`);
  if (value.trim().length > max) {
    badRequest(`${field} must be at most ${max} characters`);
  }
  return value.trim();
}

function reqInt(body, field, { min = null, max = null } = {}) {
  const value = body[field];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    badRequest(`${field} must be an integer`);
  }
  if (min !== null && value < min) badRequest(`${field} must be at least ${min}`);
  if (max !== null && value > max) badRequest(`${field} must be at most ${max}`);
  return value;
}

function optInt(body, field, { min = null, max = null, defaultValue = null } = {}) {
  const value = body[field];
  if (value === undefined || value === null) return defaultValue;
  return reqInt(body, field, { min, max });
}

function reqNumber(body, field, { min = null, max = null } = {}) {
  const value = body[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    badRequest(`${field} must be a number`);
  }
  if (min !== null && value < min) badRequest(`${field} must be at least ${min}`);
  if (max !== null && value > max) badRequest(`${field} must be at most ${max}`);
  return value;
}

function optNumber(body, field, { min = null, max = null, defaultValue = null } = {}) {
  const value = body[field];
  if (value === undefined || value === null) return defaultValue;
  return reqNumber(body, field, { min, max });
}

function reqEnum(body, field, values) {
  const value = body[field];
  if (!values.includes(value)) {
    badRequest(`${field} must be one of: ${values.join(', ')}`);
  }
  return value;
}

function optBool(body, field, defaultValue = null) {
  const value = body[field];
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'boolean') badRequest(`${field} must be a boolean`);
  return value;
}

function isValidPhone(phone) {
  return typeof phone === 'string' && PHONE_RE.test(phone);
}

function isValidEmail(email) {
  return typeof email === 'string' && EMAIL_RE.test(email) && email.length <= 254;
}

/** Strict YYYY-MM-DD check: format + real calendar date. */
function isValidDateString(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Tomorrow's date as YYYY-MM-DD in server-local time. */
function tomorrowDateString() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ---------------------------------------------------------------------------
// Sessions + cookies (STATELESS — HMAC-signed, no DB row)
// ---------------------------------------------------------------------------
//
// Sessions are self-contained signed tokens, so they work across serverless
// instances that do not share a database (Vercel: each instance has its own
// ephemeral /tmp SQLite file). The cookie value is:
//
//   base64url(JSON payload) "." base64url(HMAC-SHA256(secret, payloadB64))
//
// Payload: { t: 'customer' | 'admin', id: <user id>, exp: <epoch ms>,
//            csrf: <random per-session CSRF token> }.
//
// The secret comes from SESSION_SECRET. When unset, a random per-process
// secret is generated at boot (fine for local dev — sessions just don't
// survive a restart — but on Vercel SESSION_SECRET MUST be set, otherwise
// every serverless instance signs with a different secret and sessions
// break across instances). A clear warning is logged in that case.
//
// Tradeoff of stateless sessions: logout only clears the cookies — a token
// stays cryptographically valid until its expiry (7 days customer, 8 hours
// admin). Password changes / admin deletion likewise cannot revoke already
// issued tokens. The loadSession check below does still verify that the
// user/admin row exists in THIS instance's database, so deleting an admin
// (or a customer re-verifying OTP on another instance) takes effect on
// instances whose database reflects it.

let sessionSecret = null;
let sessionSecretWarned = false;

function getSessionSecret() {
  if (sessionSecret) return sessionSecret;
  if (process.env.SESSION_SECRET) {
    sessionSecret = process.env.SESSION_SECRET;
  } else {
    sessionSecret = crypto.randomBytes(32).toString('hex');
    if (!sessionSecretWarned && process.env.NODE_ENV !== 'test') {
      sessionSecretWarned = true;
      console.warn(
        'WARNING: SESSION_SECRET is not set — using a random per-process secret. ' +
        'Sessions will not survive a restart and will not work across serverless ' +
        'instances. Set SESSION_SECRET (see .env.example) before deploying.'
      );
    }
  }
  return sessionSecret;
}

function signToken(payload) {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', getSessionSecret())
    .update(payloadB64)
    .digest('base64url');
  return `${payloadB64}.${signature}`;
}

/** Verify a session token. Returns the payload, or null when invalid/expired. */
function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = crypto
    .createHmac('sha256', getSessionSecret())
    .update(payloadB64)
    .digest('base64url');
  if (!safeEqual(signature, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || (payload.t !== 'customer' && payload.t !== 'admin')) return null;
  if (typeof payload.id !== 'string' || typeof payload.exp !== 'number') return null;
  if (typeof payload.csrf !== 'string' || !payload.csrf) return null;
  if (payload.exp <= Date.now()) return null;
  return payload;
}

function createSession(userType, userId) {
  const csrfToken = crypto.randomBytes(32).toString('hex');
  const lifetimeMs = userType === 'admin' ? ADMIN_SESSION_MS : CUSTOMER_SESSION_MS;
  const expiresAt = new Date(Date.now() + lifetimeMs);
  const token = signToken({
    t: userType,
    id: userId,
    exp: expiresAt.getTime(),
    csrf: csrfToken
  });
  return {
    token,
    user_type: userType,
    user_id: userId,
    csrf_token: csrfToken,
    expires_at: expiresAt.toISOString(),
    lifetimeMs
  };
}

function cookieOptions(maxAgeMs, httpOnly) {
  return {
    httpOnly,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: maxAgeMs
  };
}

function setSessionCookies(res, session) {
  res.cookie('sjc_session', session.token, cookieOptions(session.lifetimeMs, true));
  // CSRF cookie is intentionally NOT httpOnly: the frontend JS reads it and
  // echoes it back as the X-CSRF-Token header.
  res.cookie('sjc_csrf', session.csrf_token, cookieOptions(session.lifetimeMs, false));
}

function clearSessionCookies(res) {
  res.clearCookie('sjc_session', { path: '/' });
  res.clearCookie('sjc_csrf', { path: '/' });
}

/**
 * Load the session (if any) from the sjc_session cookie: verify the HMAC
 * signature + expiry, then load the user/admin row by id from THIS
 * instance's database and attach req.session plus req.user (customer) or
 * req.admin. On Vercel the database is per-instance, so a customer created
 * on one instance has no row on another — their token verifies, but the
 * request is treated as logged out until they re-verify OTP on that
 * instance (documented demo limitation). The seeded admin id is
 * deterministic (see seed.js), so admin sessions work across instances.
 */
function loadSession(db) {
  return (req, res, next) => {
    const token = req.cookies && req.cookies.sjc_session;
    if (!token) return next();
    const payload = verifyToken(token);
    if (!payload) return next();
    const session = {
      user_type: payload.t,
      user_id: payload.id,
      csrf_token: payload.csrf,
      expires_at: new Date(payload.exp).toISOString()
    };
    if (payload.t === 'customer') {
      req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id) || null;
      if (!req.user) return next();
    } else {
      req.admin = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(payload.id) || null;
      if (!req.admin) return next();
    }
    req.session = session;
    return next();
  };
}

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------
//
// Mutations (POST/PUT/PATCH/DELETE) require the X-CSRF-Token header to equal
// the sjc_csrf cookie value WHEN a session cookie is present. Bootstrap
// endpoints (OTP login, admin login, password reset) and guest inquiries
// normally carry no session cookie, so they are exempt — but any request
// that DOES carry a session cookie must pass CSRF on mutations. GETs never
// require CSRF.
//
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function csrfGuard(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const sessionId = req.cookies && req.cookies.sjc_session;
  if (!sessionId) return next(); // no session: bootstrap/guest request
  const cookieToken = req.cookies.sjc_csrf;
  const headerToken = req.get('X-CSRF-Token');
  if (!safeEqual(headerToken, cookieToken)) {
    return fail(res, 403, 'CSRF_INVALID', 'Invalid or missing CSRF token');
  }
  // When the session row is loaded, the token must also match the server-side
  // copy (defence in depth against cookie tampering).
  if (req.session && !safeEqual(headerToken, req.session.csrf_token)) {
    return fail(res, 403, 'CSRF_INVALID', 'Invalid or missing CSRF token');
  }
  return next();
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

function requireCustomer(req, res, next) {
  if (!req.user) return fail(res, 401, 'UNAUTHENTICATED', 'Please log in to continue');
  return next();
}

function requireAdmin(req, res, next) {
  if (req.admin) return next();
  if (req.user) return fail(res, 403, 'FORBIDDEN', 'Admin access required');
  return fail(res, 401, 'UNAUTHENTICATED', 'Please log in as an admin');
}

// ---------------------------------------------------------------------------
// Audit logging (admin mutations)
// ---------------------------------------------------------------------------

function auditLog(db, adminId, action, detail) {
  try {
    db.prepare(
      'INSERT INTO audit_logs (admin_id, action, detail, created_at) VALUES (?, ?, ?, ?)'
    ).run(adminId, action, detail === undefined ? null : JSON.stringify(detail), nowIso());
  } catch (err) {
    console.error('auditLog failed:', err);
  }
}

// ---------------------------------------------------------------------------
// DB-row -> camelCase mappers
// ---------------------------------------------------------------------------

function localizedName(row) {
  return { en: row.name_en, te: row.name_te || row.name_en, hi: row.name_hi || row.name_en };
}

function mapCategory(row) {
  return {
    id: row.id,
    name: localizedName(row),
    orderIndex: row.order_index,
    isActive: row.is_active === 1
  };
}

function mapItem(row) {
  return {
    id: row.id,
    categoryId: row.category_id,
    name: localizedName(row),
    desc: {
      en: row.desc_en || '',
      te: row.desc_te || row.desc_en || '',
      hi: row.desc_hi || row.desc_en || ''
    },
    imageUrl: row.image_url,
    isVeg: row.is_veg === 1,
    price: row.price,
    isAvailable: row.is_available === 1
  };
}

function mapService(row) {
  return {
    id: row.id,
    name: localizedName(row),
    type: row.type,
    unitPrice: row.unit_price,
    defaultQuantity: row.default_quantity,
    isAvailable: row.is_available === 1
  };
}

function mapUser(row) {
  return { id: row.id, name: row.name, phone: row.phone, language: row.language || 'en' };
}

function mapAdmin(row) {
  // Never include password_hash.
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    mustChangePassword: row.must_change_password === 1,
    createdAt: row.created_at
  };
}

function mapBooking(row) {
  return {
    id: row.id,
    quoteNumber: row.quote_number,
    userId: row.user_id,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    eventType: row.event_type,
    customEventType: row.custom_event_type,
    eventDate: row.event_date,
    guests: row.guests,
    venueAddress: row.venue_address,
    landmark: row.landmark,
    city: row.city,
    district: row.district,
    state: row.state,
    pincode: row.pincode,
    status: row.status,
    foodTotal: row.food_total,
    servicesTotal: row.services_total,
    transportTotal: row.transport_total,
    serviceCharge: row.service_charge,
    gstAmount: row.gst_amount,
    grandTotal: row.grand_total,
    taxRate: row.tax_rate,
    serviceChargeRate: row.service_charge_rate,
    notes: row.notes,
    createdAt: row.created_at
  };
}

function mapBookingSummary(row) {
  return {
    id: row.id,
    quoteNumber: row.quote_number,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    eventType: row.event_type,
    customEventType: row.custom_event_type,
    eventDate: row.event_date,
    guests: row.guests,
    city: row.city,
    status: row.status,
    grandTotal: row.grand_total,
    createdAt: row.created_at
  };
}

/** Full booking detail including its item/service lines. */
function mapBookingDetail(db, row) {
  const booking = mapBooking(row);
  const itemRows = db
    .prepare('SELECT * FROM booking_items WHERE booking_id = ? ORDER BY id')
    .all(row.id);
  booking.items = itemRows.map((item) => ({
    itemId: item.item_id,
    itemName: item.item_name,
    unitPrice: item.unit_price,
    qtyIsGuests: item.qty_is_guests === 1,
    lineTotal: item.qty_is_guests === 1 ? item.unit_price * row.guests : item.unit_price
  }));
  const serviceRows = db
    .prepare('SELECT * FROM booking_services WHERE booking_id = ? ORDER BY id')
    .all(row.id);
  booking.services = serviceRows.map((svc) => ({
    serviceId: svc.service_id,
    serviceName: svc.service_name,
    unitPrice: svc.unit_price,
    quantity: svc.quantity,
    total: svc.total
  }));
  return booking;
}

function mapInquiry(row) {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    eventType: row.event_type,
    eventDate: row.event_date,
    guests: row.guests,
    message: row.message,
    bookingId: row.booking_id,
    bookingQuoteNumber: row.booking_quote_number || null,
    status: row.status,
    createdAt: row.created_at
  };
}

function mapReview(row) {
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    rating: row.rating,
    eventType: row.event_type,
    comment: row.comment,
    verified: row.verified === 1,
    ownerReply: row.owner_reply,
    isVisible: row.is_visible === 1,
    createdAt: row.created_at
  };
}

function mapOutbox(row) {
  return {
    id: row.id,
    channel: row.channel,
    recipient: row.recipient,
    subject: row.subject,
    body: row.body,
    relatedType: row.related_type,
    relatedId: row.related_id,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    sentAt: row.sent_at
  };
}

function mapAuditLog(row) {
  let detail = row.detail;
  if (typeof detail === 'string') {
    try {
      detail = JSON.parse(detail);
    } catch { /* keep the raw string */ }
  }
  return {
    id: row.id,
    adminId: row.admin_id,
    action: row.action,
    detail,
    createdAt: row.created_at
  };
}

module.exports = {
  CUSTOMER_SESSION_MS,
  ADMIN_SESSION_MS,
  PHONE_RE,
  EMAIL_RE,
  DATE_RE,
  PINCODE_RE,
  ok,
  fail,
  ApiError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  asyncHandler,
  reqString,
  optString,
  reqInt,
  optInt,
  reqNumber,
  optNumber,
  reqEnum,
  optBool,
  isValidPhone,
  isValidEmail,
  isValidDateString,
  tomorrowDateString,
  createSession,
  verifyToken,
  setSessionCookies,
  clearSessionCookies,
  loadSession,
  csrfGuard,
  requireCustomer,
  requireAdmin,
  auditLog,
  mapCategory,
  mapItem,
  mapService,
  mapUser,
  mapAdmin,
  mapBooking,
  mapBookingSummary,
  mapBookingDetail,
  mapInquiry,
  mapReview,
  mapOutbox,
  mapAuditLog
};
