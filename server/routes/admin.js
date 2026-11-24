// routes/admin.js — admin authentication + admin API.
//
// Every /api/admin/* route except auth login/forgot-password/reset-password
// requires an admin session (401 when logged out, 403 for a customer
// session). Every mutation is written to audit_logs with the admin id,
// action, and detail.
'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const { getAllSettings, setSetting, nowIso } = require('../db');
const lib = require('../lib');
const notify = require('../notify');
const uploads = require('../uploads');

const { ok, fail, asyncHandler, badRequest, notFound, forbidden } = lib;

const BCRYPT_COST = 12;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
// Brute-force protection for admin login (stored in the DB so it works
// across serverless instances, unlike the in-memory rate limiter): 5
// wrong passwords lock the account for 15 minutes.
const MAX_ADMIN_LOGIN_ATTEMPTS = 5;
const ADMIN_LOCKOUT_MS = 15 * 60 * 1000;
const BOOKING_STATUSES = ['pending', 'confirmed', 'completed', 'cancelled'];
const INQUIRY_STATUSES = ['new', 'contacted', 'closed'];

const SETTINGS_WHITELIST = {
  businessName: 'string',
  ownerName: 'string',
  phone: 'string',
  email: 'string',
  whatsapp: 'string',
  address: 'string',
  gstNumber: 'string',
  taxRate: 'rate',
  serviceChargeRate: 'rate',
  defaultTransportPrice: 'number',
  minGuestsForBooking: 'int',
  adminEmail: 'string',
  adminWhatsapp: 'string'
};

function adminRoutes(ctx) {
  const { db } = ctx;
  const router = express.Router();

  // Uploaded images are stored as BLOBs in the database (see
  // server/uploads.js) and served via GET /api/uploads/:name, so they
  // persist in every environment. Multer keeps the file in memory only
  // (2 MB limit); nothing is written to disk.
  const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const mimeOk = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
      if (ALLOWED_EXTENSIONS.has(ext) && mimeOk) return cb(null, true);
      const err = new Error('Only jpg, jpeg, png and webp images are allowed');
      err.code = 'INVALID_FILE_TYPE';
      return cb(err);
    }
  });

  // =========================================================================
  // Admin auth (no session required)
  // =========================================================================

  // POST /api/admin/auth/login — generic error on failure (no enumeration).
  // Brute-force protection: after MAX_ADMIN_LOGIN_ATTEMPTS wrong
  // passwords the account locks for ADMIN_LOCKOUT_MS. The counter and
  // the lock live in the database, so they work across serverless
  // instances. A locked account gets a 423 with the wait time; every
  // other failure gets the same generic 401, whether the email exists
  // or not.
  router.post('/auth/login', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const email = lib.reqString(body, 'email', { max: 254 }).toLowerCase();
    const password = lib.reqString(body, 'password', { max: 200 });
    const admin = await db.prepare('SELECT * FROM admin_users WHERE email = ?').get(email);
    if (!admin) {
      return fail(res, 401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }
    if (admin.locked_until && Date.parse(admin.locked_until) > Date.now()) {
      const minutes = Math.ceil((Date.parse(admin.locked_until) - Date.now()) / 60000);
      return fail(res, 423, 'ACCOUNT_LOCKED',
        `Too many failed login attempts. This account is locked — please try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
    }
    const matches = await bcrypt.compare(password, admin.password_hash);
    if (!matches) {
      const attempts = (admin.failed_attempts || 0) + 1;
      if (attempts >= MAX_ADMIN_LOGIN_ATTEMPTS) {
        const lockedUntil = new Date(Date.now() + ADMIN_LOCKOUT_MS).toISOString();
        await db.prepare(
          'UPDATE admin_users SET failed_attempts = ?, locked_until = ? WHERE id = ?'
        ).run(attempts, lockedUntil, admin.id);
        await lib.auditLog(db, admin.id, 'admin.locked-out', { email: admin.email, attempts });
        return fail(res, 423, 'ACCOUNT_LOCKED',
          'Too many failed login attempts. This account is locked for 15 minutes.');
      }
      await db.prepare(
        'UPDATE admin_users SET failed_attempts = ? WHERE id = ?'
      ).run(attempts, admin.id);
      return fail(res, 401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }
    if (admin.failed_attempts || admin.locked_until) {
      await db.prepare(
        'UPDATE admin_users SET failed_attempts = 0, locked_until = NULL WHERE id = ?'
      ).run(admin.id);
    }
    const session = lib.createSession('admin', admin.id);
    lib.setSessionCookies(res, session);
    return ok(res, { admin: lib.mapAdmin(admin) });
  }));

  // Logout clears the cookies. Sessions are stateless signed tokens, so a
  // logged-out token stays cryptographically valid until its 8-hour expiry
  // (documented tradeoff; see lib.js).
  router.post('/auth/logout', (req, res) => {
    lib.clearSessionCookies(res);
    return ok(res, {});
  });

  router.get('/auth/me', (req, res) => {
    if (!req.admin) return fail(res, 401, 'UNAUTHENTICATED', 'Please log in as an admin');
    return ok(res, { admin: lib.mapAdmin(req.admin) });
  });

  router.post('/auth/change-password', lib.requireAdmin, asyncHandler(async (req, res) => {
    const body = req.body || {};
    const oldPassword = lib.reqString(body, 'oldPassword', { max: 200 });
    const newPassword = lib.reqString(body, 'newPassword', { min: 8, max: 200 });
    const matches = await bcrypt.compare(oldPassword, req.admin.password_hash);
    if (!matches) {
      return fail(res, 401, 'INVALID_CREDENTIALS', 'Current password is incorrect');
    }
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
    await db.prepare(
      'UPDATE admin_users SET password_hash = ?, must_change_password = 0 WHERE id = ?'
    ).run(passwordHash, req.admin.id);
    await lib.auditLog(db, req.admin.id, 'admin.change-password', { email: req.admin.email });
    return ok(res, { message: 'Password changed' });
  }));

  // POST /api/admin/auth/forgot-password — always returns the same generic
  // success shape whether or not the email exists (no account enumeration).
  // With SMTP configured, emails a one-time reset link (token stored hashed,
  // 1h expiry); without SMTP, tells the owner to use `npm run reset-admin`.
  router.post('/auth/forgot-password', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const email = lib.reqString(body, 'email', { max: 254 }).toLowerCase();
    const generic = 'If an admin account exists for this email, a password reset has been sent.';
    const admin = await db.prepare('SELECT * FROM admin_users WHERE email = ?').get(email);

    if (!notify.isSmtpConfigured()) {
      return ok(res, {
        message: 'Email is not configured. Please ask the server owner to run `npm run reset-admin` to set a new password.',
        resetViaCli: true
      });
    }

    if (admin) {
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
      await db.prepare('DELETE FROM password_resets WHERE admin_id = ?').run(admin.id);
      await db.prepare(
        `INSERT INTO password_resets (admin_id, token_hash, expires_at, used, created_at)
         VALUES (?, ?, ?, 0, ?)`
      ).run(admin.id, tokenHash, expiresAt, nowIso());

      const origin = `${req.protocol}://${req.get('host')}`;
      const resetLink = `${origin}/admin.html#/reset?token=${token}`;
      try {
        const nodemailer = require('nodemailer');
        const port = Number(process.env.SMTP_PORT || 587);
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port,
          secure: port === 465,
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        });
        await transporter.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: admin.email,
          subject: 'Reset your Sai Jyothsna Caterers admin password',
          text: `You requested a password reset for your admin account.\n\nReset link (valid for 1 hour):\n${resetLink}\n\nIf you did not request this, you can ignore this email.`
        });
      } catch (err) {
        console.error('forgot-password email failed:', err);
        // Still return the generic success shape — no enumeration.
      }
    }
    return ok(res, { message: generic, resetViaCli: false });
  }));

  // POST /api/admin/auth/reset-password { token, newPassword }
  router.post('/auth/reset-password', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const token = lib.reqString(body, 'token', { max: 200 });
    const newPassword = lib.reqString(body, 'newPassword', { min: 8, max: 200 });
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const row = await db
      .prepare('SELECT * FROM password_resets WHERE token_hash = ? AND used = 0')
      .get(tokenHash);
    if (!row || new Date(row.expires_at) <= new Date()) {
      return fail(res, 400, 'INVALID_RESET_TOKEN', 'This reset link is invalid or has expired');
    }
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
    await db.prepare(
      'UPDATE admin_users SET password_hash = ?, must_change_password = 0 WHERE id = ?'
    ).run(passwordHash, row.admin_id);
    await db.prepare('UPDATE password_resets SET used = 1 WHERE id = ?').run(row.id);
    // NOTE: sessions are stateless signed tokens (see lib.js), so tokens
    // issued before this reset stay valid until their 8-hour expiry. The
    // reset token itself is single-use and the old password no longer works.
    return ok(res, { message: 'Password has been reset. Please log in with your new password.' });
  }));

  // =========================================================================
  // Everything below requires an admin session.
  // =========================================================================
  router.use(lib.requireAdmin);

  // --- Dashboard -----------------------------------------------------------
  router.get('/dashboard', asyncHandler(async (req, res) => {
    const byStatus = { pending: 0, confirmed: 0, completed: 0, cancelled: 0 };
    const statusRows = await db
      .prepare('SELECT status, COUNT(*) AS n FROM bookings GROUP BY status')
      .all();
    let bookingsTotal = 0;
    for (const row of statusRows) {
      if (row.status in byStatus) byStatus[row.status] = row.n;
      bookingsTotal += row.n;
    }
    const revenueRow = await db
      .prepare("SELECT COALESCE(SUM(grand_total), 0) AS total FROM bookings WHERE status IN ('confirmed', 'completed')")
      .get();
    // NOTE: `await` binds looser than `.`, so the awaited query must be
    // parenthesised before `.n` / `.map()` is applied to its result —
    // otherwise the property is read off the Promise, not the row.
    const customersTotal = (await db.prepare('SELECT COUNT(*) AS n FROM users').get()).n;
    const inquiriesPending = (await db.prepare("SELECT COUNT(*) AS n FROM inquiries WHERE status = 'new'").get()).n;
    const itemsTotal = (await db.prepare('SELECT COUNT(*) AS n FROM food_items').get()).n;
    const servicesTotal = (await db.prepare('SELECT COUNT(*) AS n FROM services').get()).n;

    const recentBookings = (await db
      .prepare('SELECT * FROM bookings ORDER BY created_at DESC LIMIT 5')
      .all()).map(lib.mapBookingSummary);
    const recentInquiries = (await db
      .prepare('SELECT * FROM inquiries ORDER BY created_at DESC LIMIT 5')
      .all()).map(lib.mapInquiry);
    const monthlyRevenue = (await db
      .prepare(
        `SELECT strftime('%Y-%m', created_at) AS month, SUM(grand_total) AS total
         FROM bookings WHERE status IN ('confirmed', 'completed')
         GROUP BY month ORDER BY month DESC LIMIT 12`
      )
      .all()).reverse().map((row) => ({ month: row.month, total: row.total }));
    const popularItems = await db
      .prepare(
        `SELECT item_name AS name, COUNT(*) AS count FROM booking_items
         GROUP BY item_name ORDER BY count DESC, name ASC LIMIT 5`
      )
      .all();
    const today = new Date().toISOString().slice(0, 10);
    const upcomingEvents = (await db
      .prepare(
        `SELECT * FROM bookings
         WHERE event_date >= ? AND status IN ('pending', 'confirmed')
         ORDER BY event_date ASC LIMIT 10`
      )
      .all(today)).map(lib.mapBookingSummary);

    return ok(res, {
      // True only in the Vercel-without-Turso demo mode (ephemeral /tmp
      // storage): the admin dashboard shows a dismissible notice
      // explaining that data may reset. Hidden once Turso is configured.
      // Never shown to customers.
      ephemeral: db.isEphemeral === true,
      stats: {
        bookingsTotal,
        bookingsByStatus: byStatus,
        revenueEstimate: revenueRow.total,
        customersTotal,
        inquiriesPending,
        itemsTotal,
        servicesTotal
      },
      recentBookings,
      recentInquiries,
      monthlyRevenue,
      popularItems,
      upcomingEvents
    });
  }));

  // --- Categories ----------------------------------------------------------
  router.get('/categories', asyncHandler(async (req, res) => {
    const rows = await db.prepare('SELECT * FROM categories ORDER BY order_index ASC, name_en ASC').all();
    return ok(res, { categories: rows.map(lib.mapCategory) });
  }));

  router.post('/categories', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const nameEn = lib.reqString(body, 'nameEn', { max: 100 });
    const nameTe = lib.optString(body, 'nameTe', { max: 100 });
    const nameHi = lib.optString(body, 'nameHi', { max: 100 });
    const orderIndex = lib.optInt(body, 'orderIndex', { min: 0, max: 10000, defaultValue: 99 });
    const id = `cat_custom_${Date.now()}`;
    await db.prepare(
      'INSERT INTO categories (id, name_en, name_te, name_hi, order_index, is_active) VALUES (?, ?, ?, ?, ?, 1)'
    ).run(id, nameEn, nameTe || nameEn, nameHi || nameEn, orderIndex);
    await lib.auditLog(db, req.admin.id, 'category.create', { id, nameEn });
    const row = await db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
    return ok(res, { category: lib.mapCategory(row) }, 201);
  }));

  router.put('/categories/:id', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const existing = await db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
    if (!existing) return notFound('Category not found');
    const nameEn = body.nameEn === undefined ? existing.name_en : lib.reqString(body, 'nameEn', { max: 100 });
    const nameTe = body.nameTe === undefined ? existing.name_te : lib.optString(body, 'nameTe', { max: 100 });
    const nameHi = body.nameHi === undefined ? existing.name_hi : lib.optString(body, 'nameHi', { max: 100 });
    const orderIndex = body.orderIndex === undefined
      ? existing.order_index
      : lib.reqInt(body, 'orderIndex', { min: 0, max: 10000 });
    const isActive = body.isAvailable === undefined && body.isActive === undefined
      ? existing.is_active
      : (lib.optBool(body, 'isActive', lib.optBool(body, 'isAvailable', existing.is_active === 1)) ? 1 : 0);
    await db.prepare(
      'UPDATE categories SET name_en = ?, name_te = ?, name_hi = ?, order_index = ?, is_active = ? WHERE id = ?'
    ).run(nameEn, nameTe, nameHi, orderIndex, isActive, req.params.id);
    await lib.auditLog(db, req.admin.id, 'category.update', { id: req.params.id, nameEn });
    const row = await db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
    return ok(res, { category: lib.mapCategory(row) });
  }));

  router.delete('/categories/:id', asyncHandler(async (req, res) => {
    const existing = await db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
    if (!existing) return notFound('Category not found');
    const refCount = (await db
      .prepare('SELECT COUNT(*) AS n FROM food_items WHERE category_id = ?')
      .get(req.params.id)).n;
    if (refCount > 0) {
      return fail(res, 409, 'CATEGORY_IN_USE', `Cannot delete: ${refCount} food item(s) still use this category`);
    }
    await db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
    await lib.auditLog(db, req.admin.id, 'category.delete', { id: req.params.id });
    return ok(res, {});
  }));

  // --- Food items ----------------------------------------------------------
  router.get('/items', asyncHandler(async (req, res) => {
    const { search, categoryId } = req.query;
    let sql = 'SELECT * FROM food_items';
    const where = [];
    const params = [];
    if (categoryId) {
      where.push('category_id = ?');
      params.push(categoryId);
    }
    if (search) {
      where.push('(name_en LIKE ? OR name_te LIKE ? OR name_hi LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like);
    }
    if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ' ORDER BY name_en ASC';
    const rows = await db.prepare(sql).all(...params);
    return ok(res, { items: rows.map(lib.mapItem) });
  }));

  router.post('/items', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const categoryId = lib.reqString(body, 'categoryId', { max: 100 });
    const category = await db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId);
    if (!category) badRequest('categoryId does not refer to an existing category');
    const nameEn = lib.reqString(body, 'nameEn', { max: 100 });
    const nameTe = lib.optString(body, 'nameTe', { max: 100 });
    const nameHi = lib.optString(body, 'nameHi', { max: 100 });
    const descEn = lib.optString(body, 'descEn', { max: 1000 });
    const descTe = lib.optString(body, 'descTe', { max: 1000 });
    const descHi = lib.optString(body, 'descHi', { max: 1000 });
    const price = lib.reqNumber(body, 'price', { min: 0.01 });
    const isVeg = lib.optBool(body, 'isVeg', true);
    const isAvailable = lib.optBool(body, 'isAvailable', true);
    const imageUrl = lib.optString(body, 'imageUrl', { max: 1000 });
    const id = `dish_custom_${Date.now()}`;
    await db.prepare(
      `INSERT INTO food_items
         (id, category_id, name_en, name_te, name_hi, desc_en, desc_te, desc_hi,
          image_url, is_veg, price, is_available)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, categoryId, nameEn, nameTe || nameEn, nameHi || nameEn,
      descEn, descTe || descEn, descHi || descEn,
      imageUrl, isVeg ? 1 : 0, price, isAvailable ? 1 : 0
    );
    await lib.auditLog(db, req.admin.id, 'item.create', { id, nameEn, price });
    const row = await db.prepare('SELECT * FROM food_items WHERE id = ?').get(id);
    return ok(res, { item: lib.mapItem(row) }, 201);
  }));

  router.put('/items/:id', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const existing = await db.prepare('SELECT * FROM food_items WHERE id = ?').get(req.params.id);
    if (!existing) return notFound('Food item not found');
    const categoryId = body.categoryId === undefined
      ? existing.category_id
      : lib.reqString(body, 'categoryId', { max: 100 });
    if (categoryId !== existing.category_id) {
      const category = await db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId);
      if (!category) badRequest('categoryId does not refer to an existing category');
    }
    const nameEn = body.nameEn === undefined ? existing.name_en : lib.reqString(body, 'nameEn', { max: 100 });
    const nameTe = body.nameTe === undefined ? existing.name_te : lib.optString(body, 'nameTe', { max: 100 });
    const nameHi = body.nameHi === undefined ? existing.name_hi : lib.optString(body, 'nameHi', { max: 100 });
    const descEn = body.descEn === undefined ? existing.desc_en : lib.optString(body, 'descEn', { max: 1000 });
    const descTe = body.descTe === undefined ? existing.desc_te : lib.optString(body, 'descTe', { max: 1000 });
    const descHi = body.descHi === undefined ? existing.desc_hi : lib.optString(body, 'descHi', { max: 1000 });
    const price = body.price === undefined ? existing.price : lib.reqNumber(body, 'price', { min: 0.01 });
    const isVeg = lib.optBool(body, 'isVeg', existing.is_veg === 1);
    const isAvailable = lib.optBool(body, 'isAvailable', existing.is_available === 1);
    const imageUrl = body.imageUrl === undefined ? existing.image_url : lib.optString(body, 'imageUrl', { max: 1000 });
    await db.prepare(
      `UPDATE food_items SET category_id = ?, name_en = ?, name_te = ?, name_hi = ?,
         desc_en = ?, desc_te = ?, desc_hi = ?, image_url = ?, is_veg = ?, price = ?, is_available = ?
       WHERE id = ?`
    ).run(
      categoryId, nameEn, nameTe, nameHi, descEn, descTe, descHi,
      imageUrl, isVeg ? 1 : 0, price, isAvailable ? 1 : 0, req.params.id
    );
    await lib.auditLog(db, req.admin.id, 'item.update', { id: req.params.id, nameEn, price });
    const row = await db.prepare('SELECT * FROM food_items WHERE id = ?').get(req.params.id);
    return ok(res, { item: lib.mapItem(row) });
  }));

  router.delete('/items/:id', asyncHandler(async (req, res) => {
    const existing = await db.prepare('SELECT * FROM food_items WHERE id = ?').get(req.params.id);
    if (!existing) return notFound('Food item not found');
    await db.prepare('DELETE FROM food_items WHERE id = ?').run(req.params.id);
    // Best-effort cleanup of a locally uploaded image (never remote URLs).
    await uploads.deleteLocalUpload(db, existing.image_url);
    await lib.auditLog(db, req.admin.id, 'item.delete', { id: req.params.id });
    return ok(res, {});
  }));

  // POST /api/admin/items/:id/image — multer single file, field "image".
  router.post('/items/:id/image', asyncHandler(async (req, res, next) => {
    const existing = await db.prepare('SELECT * FROM food_items WHERE id = ?').get(req.params.id);
    if (!existing) return notFound('Food item not found');
    req.existingItem = existing;
    return next();
  }), upload.single('image'), asyncHandler(async (req, res) => {
    if (!req.file) badRequest('No image file uploaded (field name: "image")');
    // Safe random filename, same <uuid>.<ext> shape as before; the bytes
    // go into the uploads table (BLOB), not onto disk.
    const ext = path.extname(req.file.originalname).toLowerCase();
    const filename = `${crypto.randomUUID()}${ext}`;
    const imageUrl = await uploads.saveUpload(db, {
      filename,
      mime: req.file.mimetype,
      buffer: req.file.buffer
    });
    await db.prepare('UPDATE food_items SET image_url = ? WHERE id = ?').run(imageUrl, req.params.id);
    // Best-effort cleanup of the previous local upload.
    const oldUrl = req.existingItem.image_url;
    if (oldUrl && oldUrl !== imageUrl) {
      await uploads.deleteLocalUpload(db, oldUrl);
    }
    await lib.auditLog(db, req.admin.id, 'item.image', { id: req.params.id, imageUrl });
    return ok(res, { imageUrl });
  }));

  // --- Services ------------------------------------------------------------
  router.get('/services', asyncHandler(async (req, res) => {
    const rows = await db.prepare('SELECT * FROM services ORDER BY name_en ASC').all();
    return ok(res, { services: rows.map(lib.mapService) });
  }));

  router.post('/services', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const nameEn = lib.reqString(body, 'nameEn', { max: 100 });
    const nameTe = lib.optString(body, 'nameTe', { max: 100 });
    const nameHi = lib.optString(body, 'nameHi', { max: 100 });
    const type = lib.reqEnum(body, 'type', ['checkbox', 'number']);
    const unitPrice = lib.reqNumber(body, 'unitPrice', { min: 0.01 });
    const defaultQuantity = lib.optInt(body, 'defaultQuantity', { min: 0, max: 10000, defaultValue: 1 });
    const isAvailable = lib.optBool(body, 'isAvailable', true);
    const id = `srv_custom_${Date.now()}`;
    await db.prepare(
      `INSERT INTO services (id, name_en, name_te, name_hi, type, unit_price, default_quantity, is_available)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, nameEn, nameTe || nameEn, nameHi || nameEn, type, unitPrice, defaultQuantity, isAvailable ? 1 : 0);
    await lib.auditLog(db, req.admin.id, 'service.create', { id, nameEn, type, unitPrice });
    const row = await db.prepare('SELECT * FROM services WHERE id = ?').get(id);
    return ok(res, { service: lib.mapService(row) }, 201);
  }));

  router.put('/services/:id', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const existing = await db.prepare('SELECT * FROM services WHERE id = ?').get(req.params.id);
    if (!existing) return notFound('Service not found');
    const nameEn = body.nameEn === undefined ? existing.name_en : lib.reqString(body, 'nameEn', { max: 100 });
    const nameTe = body.nameTe === undefined ? existing.name_te : lib.optString(body, 'nameTe', { max: 100 });
    const nameHi = body.nameHi === undefined ? existing.name_hi : lib.optString(body, 'nameHi', { max: 100 });
    const type = body.type === undefined ? existing.type : lib.reqEnum(body, 'type', ['checkbox', 'number']);
    const unitPrice = body.unitPrice === undefined ? existing.unit_price : lib.reqNumber(body, 'unitPrice', { min: 0.01 });
    const defaultQuantity = body.defaultQuantity === undefined
      ? existing.default_quantity
      : lib.reqInt(body, 'defaultQuantity', { min: 0, max: 10000 });
    const isAvailable = lib.optBool(body, 'isAvailable', existing.is_available === 1);
    await db.prepare(
      `UPDATE services SET name_en = ?, name_te = ?, name_hi = ?, type = ?,
         unit_price = ?, default_quantity = ?, is_available = ? WHERE id = ?`
    ).run(nameEn, nameTe, nameHi, type, unitPrice, defaultQuantity, isAvailable ? 1 : 0, req.params.id);
    await lib.auditLog(db, req.admin.id, 'service.update', { id: req.params.id, nameEn, type, unitPrice });
    const row = await db.prepare('SELECT * FROM services WHERE id = ?').get(req.params.id);
    return ok(res, { service: lib.mapService(row) });
  }));

  router.delete('/services/:id', asyncHandler(async (req, res) => {
    const existing = await db.prepare('SELECT * FROM services WHERE id = ?').get(req.params.id);
    if (!existing) return notFound('Service not found');
    await db.prepare('DELETE FROM services WHERE id = ?').run(req.params.id);
    await lib.auditLog(db, req.admin.id, 'service.delete', { id: req.params.id });
    return ok(res, {});
  }));

  // --- Bookings ------------------------------------------------------------
  router.get('/bookings', asyncHandler(async (req, res) => {
    const { status, from, to, q } = req.query;
    let sql = 'SELECT * FROM bookings';
    const where = [];
    const params = [];
    if (status) {
      if (!BOOKING_STATUSES.includes(status)) {
        return fail(res, 400, 'VALIDATION_ERROR', `status must be one of: ${BOOKING_STATUSES.join(', ')}`);
      }
      where.push('status = ?');
      params.push(status);
    }
    if (from) {
      if (!lib.isValidDateString(from)) {
        return fail(res, 400, 'VALIDATION_ERROR', 'from must be YYYY-MM-DD');
      }
      where.push('event_date >= ?');
      params.push(from);
    }
    if (to) {
      if (!lib.isValidDateString(to)) {
        return fail(res, 400, 'VALIDATION_ERROR', 'to must be YYYY-MM-DD');
      }
      where.push('event_date <= ?');
      params.push(to);
    }
    if (q) {
      where.push('(customer_name LIKE ? OR customer_phone LIKE ? OR quote_number LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like);
    }
    if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ' ORDER BY created_at DESC';
    const rows = await db.prepare(sql).all(...params);
    return ok(res, { bookings: rows.map(lib.mapBookingSummary) });
  }));

  router.get('/bookings/:id', asyncHandler(async (req, res) => {
    const row = await db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
    if (!row) return notFound('Booking not found');
    return ok(res, { booking: await lib.mapBookingDetail(db, row) });
  }));

  router.patch('/bookings/:id', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const existing = await db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
    if (!existing) return notFound('Booking not found');
    const status = body.status === undefined
      ? existing.status
      : lib.reqEnum(body, 'status', BOOKING_STATUSES);
    const notes = body.notes === undefined ? existing.notes : lib.optString(body, 'notes', { max: 2000 });
    await db.prepare('UPDATE bookings SET status = ?, notes = ? WHERE id = ?').run(status, notes, req.params.id);
    await lib.auditLog(db, req.admin.id, 'booking.update', { id: req.params.id, status });
    const row = await db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
    return ok(res, { booking: await lib.mapBookingDetail(db, row) });
  }));

  // DELETE /api/admin/bookings/:id — permanently deletes a booking and
  // its food/service lines. Child rows are deleted explicitly: there is
  // no FK cascade on Turso (the foreign_keys PRAGMA is a no-op over
  // HTTP), so deleting only the booking would orphan its lines. The
  // delete is recorded in the audit log. Use for test, duplicate, or
  // cancelled-by-mistake bookings; cancelling (PATCH status) is the
  // non-destructive option for real bookings.
  router.delete('/bookings/:id', asyncHandler(async (req, res) => {
    const existing = await db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
    if (!existing) return notFound('Booking not found');
    await db.batch([
      { sql: 'DELETE FROM booking_items WHERE booking_id = ?', args: [req.params.id] },
      { sql: 'DELETE FROM booking_services WHERE booking_id = ?', args: [req.params.id] },
      { sql: 'DELETE FROM bookings WHERE id = ?', args: [req.params.id] }
    ]);
    await lib.auditLog(db, req.admin.id, 'booking.delete', {
      id: req.params.id,
      quoteNumber: existing.quote_number,
      customerName: existing.customer_name,
      grandTotal: existing.grand_total
    });
    return ok(res, { deleted: true });
  }));

  // --- Customers -----------------------------------------------------------
  router.get('/customers', asyncHandler(async (req, res) => {
    const { q } = req.query;
    let sql = `
      SELECT u.*, COUNT(b.id) AS booking_count, COALESCE(SUM(b.grand_total), 0) AS total_spent
      FROM users u LEFT JOIN bookings b ON b.user_id = u.id`;
    const params = [];
    if (q) {
      sql += ' WHERE u.name LIKE ? OR u.phone LIKE ? OR u.email LIKE ?';
      const like = `%${q}%`;
      params.push(like, like, like);
    }
    sql += ' GROUP BY u.id ORDER BY u.created_at DESC';
    const rows = await db.prepare(sql).all(...params);
    return ok(res, {
      customers: rows.map((row) => ({
        ...lib.mapUser(row),
        createdAt: row.created_at,
        bookingCount: row.booking_count,
        totalSpent: row.total_spent
      }))
    });
  }));

  router.get('/customers/:id', asyncHandler(async (req, res) => {
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return notFound('Customer not found');
    const bookings = (await db
      .prepare('SELECT * FROM bookings WHERE user_id = ? ORDER BY created_at DESC')
      .all(req.params.id)).map(lib.mapBookingSummary);
    const totalSpent = bookings.reduce((sum, b) => sum + (b.grandTotal || 0), 0);
    return ok(res, {
      customer: {
        ...lib.mapUser(user),
        createdAt: user.created_at,
        bookingCount: bookings.length,
        totalSpent
      },
      bookings
    });
  }));

  // --- Inquiries -----------------------------------------------------------
  router.get('/inquiries', asyncHandler(async (req, res) => {
    const { status } = req.query;
    let rows;
    if (status) {
      if (!INQUIRY_STATUSES.includes(status)) {
        return fail(res, 400, 'VALIDATION_ERROR', `status must be one of: ${INQUIRY_STATUSES.join(', ')}`);
      }
      rows = await db.prepare(
        `SELECT i.*, b.quote_number AS booking_quote_number FROM inquiries i
         LEFT JOIN bookings b ON b.id = i.booking_id
         WHERE i.status = ? ORDER BY i.created_at DESC`
      ).all(status);
    } else {
      rows = await db.prepare(
        `SELECT i.*, b.quote_number AS booking_quote_number FROM inquiries i
         LEFT JOIN bookings b ON b.id = i.booking_id
         ORDER BY i.created_at DESC`
      ).all();
    }
    return ok(res, { inquiries: rows.map(lib.mapInquiry) });
  }));

  router.patch('/inquiries/:id', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const existing = await db.prepare('SELECT * FROM inquiries WHERE id = ?').get(req.params.id);
    if (!existing) return notFound('Inquiry not found');
    const status = lib.reqEnum(body, 'status', INQUIRY_STATUSES);
    await db.prepare('UPDATE inquiries SET status = ? WHERE id = ?').run(status, req.params.id);
    await lib.auditLog(db, req.admin.id, 'inquiry.update', { id: req.params.id, status });
    const row = await db.prepare('SELECT * FROM inquiries WHERE id = ?').get(req.params.id);
    return ok(res, { inquiry: lib.mapInquiry(row) });
  }));

  // --- Reviews -------------------------------------------------------------
  router.get('/reviews', asyncHandler(async (req, res) => {
    const rows = await db.prepare('SELECT * FROM reviews ORDER BY created_at DESC').all();
    return ok(res, { reviews: rows.map(lib.mapReview) });
  }));

  router.patch('/reviews/:id', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const existing = await db.prepare('SELECT * FROM reviews WHERE id = ?').get(req.params.id);
    if (!existing) return notFound('Review not found');
    const isVisible = body.isVisible === undefined
      ? existing.is_visible
      : (lib.reqEnum(body, 'isVisible', [true, false]) ? 1 : 0);
    const ownerReply = body.ownerReply === undefined
      ? existing.owner_reply
      : lib.optString(body, 'ownerReply', { max: 1000 });
    await db.prepare('UPDATE reviews SET is_visible = ?, owner_reply = ? WHERE id = ?')
      .run(isVisible, ownerReply, req.params.id);
    await lib.auditLog(db, req.admin.id, 'review.update', { id: req.params.id, isVisible: isVisible === 1 });
    const row = await db.prepare('SELECT * FROM reviews WHERE id = ?').get(req.params.id);
    return ok(res, { review: lib.mapReview(row) });
  }));

  router.delete('/reviews/:id', asyncHandler(async (req, res) => {
    const existing = await db.prepare('SELECT * FROM reviews WHERE id = ?').get(req.params.id);
    if (!existing) return notFound('Review not found');
    await db.prepare('DELETE FROM reviews WHERE id = ?').run(req.params.id);
    await lib.auditLog(db, req.admin.id, 'review.delete', { id: req.params.id });
    return ok(res, {});
  }));

  // --- Settings ------------------------------------------------------------
  router.get('/settings', asyncHandler(async (req, res) => {
    return ok(res, { settings: await getAllSettings(db) });
  }));

  router.put('/settings', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const updated = {};
    for (const [key, kind] of Object.entries(SETTINGS_WHITELIST)) {
      if (body[key] === undefined) continue;
      let value;
      if (kind === 'string') {
        value = lib.reqString(body, key, { max: 500 });
        if ((key === 'email' || key === 'adminEmail') && !lib.isValidEmail(value)) {
          badRequest(`${key} must be a valid email address`);
        }
      } else if (kind === 'rate') {
        value = lib.reqNumber(body, key, { min: 0, max: 30 });
      } else if (kind === 'int') {
        value = lib.reqInt(body, key, { min: 0, max: 100000 });
      } else {
        value = lib.reqNumber(body, key, { min: 0 });
      }
      await setSetting(db, key, value);
      updated[key] = value;
    }
    if (Object.keys(updated).length === 0) {
      badRequest('No valid settings keys provided');
    }
    await lib.auditLog(db, req.admin.id, 'settings.update', updated);
    return ok(res, { settings: await getAllSettings(db) });
  }));

  // --- Admins --------------------------------------------------------------
  router.get('/admins', asyncHandler(async (req, res) => {
    const rows = await db.prepare('SELECT * FROM admin_users ORDER BY created_at ASC').all();
    return ok(res, { admins: rows.map(lib.mapAdmin) });
  }));

  router.post('/admins', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const email = lib.reqString(body, 'email', { max: 254 }).toLowerCase();
    if (!lib.isValidEmail(email)) badRequest('email must be a valid email address');
    const password = lib.reqString(body, 'password', { min: 8, max: 200 });
    const name = lib.optString(body, 'name', { max: 100 });
    const existing = await db.prepare('SELECT id FROM admin_users WHERE email = ?').get(email);
    if (existing) {
      return fail(res, 409, 'CONFLICT', 'An admin with this email already exists');
    }
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    const id = crypto.randomUUID();
    await db.prepare(
      `INSERT INTO admin_users (id, email, password_hash, name, role, must_change_password, created_at)
       VALUES (?, ?, ?, ?, 'admin', 1, ?)`
    ).run(id, email, passwordHash, name, nowIso());
    await lib.auditLog(db, req.admin.id, 'admin.create', { id, email });
    const row = await db.prepare('SELECT * FROM admin_users WHERE id = ?').get(id);
    return ok(res, { admin: lib.mapAdmin(row) }, 201);
  }));

  router.delete('/admins/:id', asyncHandler(async (req, res) => {
    if (req.params.id === req.admin.id) {
      return forbidden('Admins cannot delete themselves');
    }
    const existing = await db.prepare('SELECT * FROM admin_users WHERE id = ?').get(req.params.id);
    if (!existing) return notFound('Admin not found');
    const count = (await db.prepare('SELECT COUNT(*) AS n FROM admin_users').get()).n;
    if (count <= 1) {
      return forbidden('Cannot delete the last admin');
    }
    await db.prepare('DELETE FROM admin_users WHERE id = ?').run(req.params.id);
    // NOTE: sessions are stateless (see lib.js) — the deleted admin's
    // tokens still verify, but loadSession finds no admin row on instances
    // whose database reflects the deletion, so they stop working there.
    await lib.auditLog(db, req.admin.id, 'admin.delete', { id: req.params.id, email: existing.email });
    return ok(res, {});
  }));

  // --- Outbox --------------------------------------------------------------
  router.get('/outbox', asyncHandler(async (req, res) => {
    const { status, limit } = req.query;
    const parsedLimit = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    let rows;
    if (status) {
      if (!['pending', 'sent', 'failed'].includes(status)) {
        return fail(res, 400, 'VALIDATION_ERROR', 'status must be pending, sent or failed');
      }
      rows = await db
        .prepare('SELECT * FROM notifications_outbox WHERE status = ? ORDER BY created_at DESC LIMIT ?')
        .all(status, parsedLimit);
    } else {
      rows = await db
        .prepare('SELECT * FROM notifications_outbox ORDER BY created_at DESC LIMIT ?')
        .all(parsedLimit);
    }
    return ok(res, { outbox: rows.map(lib.mapOutbox) });
  }));

  router.post('/outbox/:id/resend', asyncHandler(async (req, res) => {
    const row = await db
      .prepare('SELECT * FROM notifications_outbox WHERE id = ?')
      .get(req.params.id);
    if (!row) return notFound('Outbox entry not found');
    const result = await notify.resendOutbox(db, row);
    await lib.auditLog(db, req.admin.id, 'outbox.resend', { id: row.id, status: result.status });
    const updated = await db
      .prepare('SELECT * FROM notifications_outbox WHERE id = ?')
      .get(req.params.id);
    return ok(res, { outbox: lib.mapOutbox(updated), result });
  }));

  // --- Audit logs ----------------------------------------------------------
  router.get('/audit-logs', asyncHandler(async (req, res) => {
    const parsedLimit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    // Join the admin's email so the log shows WHO acted, not just an id.
    // (Admins are never hard-deleted while they have audit rows, but the
    // LEFT JOIN keeps the log readable even if one ever is.)
    const rows = await db
      .prepare(
        `SELECT a.*, u.email AS admin_email
         FROM audit_logs a
         LEFT JOIN admin_users u ON u.id = a.admin_id
         ORDER BY a.created_at DESC, a.id DESC LIMIT ?`
      )
      .all(parsedLimit);
    return ok(res, { auditLogs: rows.map(lib.mapAuditLog) });
  }));

  return router;
}

module.exports = adminRoutes;
