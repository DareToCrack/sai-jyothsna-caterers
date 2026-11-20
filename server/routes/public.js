// routes/public.js — unauthenticated public API: menu, services, business
// info, public reviews, guest/logged-in inquiries, and the test-only OTP
// helper (NODE_ENV=test only).
'use strict';

const express = require('express');
const crypto = require('crypto');
const { getAllSettings, nowIso } = require('../db');
const lib = require('../lib');
const notify = require('../notify');

const { ok, fail, asyncHandler, badRequest, notFound } = lib;

function publicRoutes(ctx) {
  const { db, testOtpCodes } = ctx;
  const router = express.Router();

  // GET /api/menu — active categories with their available items, ordered.
  router.get('/menu', (req, res) => {
    const categories = db
      .prepare('SELECT * FROM categories WHERE is_active = 1 ORDER BY order_index ASC, name_en ASC')
      .all();
    const items = db
      .prepare('SELECT * FROM food_items WHERE is_available = 1 ORDER BY name_en ASC')
      .all();
    const itemsByCategory = new Map();
    for (const item of items) {
      if (!itemsByCategory.has(item.category_id)) itemsByCategory.set(item.category_id, []);
      itemsByCategory.get(item.category_id).push(lib.mapItem(item));
    }
    return ok(res, {
      categories: categories.map((cat) => ({
        ...lib.mapCategory(cat),
        items: itemsByCategory.get(cat.id) || []
      }))
    });
  });

  // GET /api/services — available services only.
  router.get('/services', (req, res) => {
    const rows = db
      .prepare('SELECT * FROM services WHERE is_available = 1 ORDER BY name_en ASC')
      .all();
    return ok(res, { services: rows.map(lib.mapService) });
  });

  // GET /api/business — public business info. Never secrets.
  router.get('/business', (req, res) => {
    const s = getAllSettings(db);
    return ok(res, {
      business: {
        name: s.businessName,
        ownerName: s.ownerName,
        phone: s.phone,
        email: s.email,
        whatsapp: s.whatsapp,
        address: s.address,
        gstNumber: s.gstNumber,
        taxRate: s.taxRate,
        serviceChargeRate: s.serviceChargeRate,
        defaultTransportPrice: s.defaultTransportPrice,
        minGuestsForBooking: s.minGuestsForBooking
      }
    });
  });

  // GET /api/reviews — visible reviews only, newest first, with stats.
  router.get('/reviews', (req, res) => {
    const rows = db
      .prepare('SELECT * FROM reviews WHERE is_visible = 1 ORDER BY created_at DESC')
      .all();
    const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let sum = 0;
    for (const row of rows) {
      const rating = Math.min(5, Math.max(1, row.rating));
      counts[rating] += 1;
      sum += rating;
    }
    const average = rows.length > 0 ? Math.round((sum / rows.length) * 10) / 10 : 0;
    return ok(res, {
      reviews: rows.map((row) => {
        const r = lib.mapReview(row);
        delete r.userId;
        delete r.isVisible;
        return r;
      }),
      stats: { average, total: rows.length, counts }
    });
  });

  // POST /api/inquiries — logged-in OR guest. A bookingId, when given, must
  // exist and (when logged in) must belong to the caller.
  router.post('/inquiries', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const name = lib.reqString(body, 'name', { max: 100 });
    const phone = lib.reqString(body, 'phone', { max: 15 });
    if (!lib.isValidPhone(phone)) badRequest('phone must be a valid 10-digit Indian mobile number');
    const email = lib.optString(body, 'email', { max: 254 });
    if (email && !lib.isValidEmail(email)) badRequest('email is invalid');
    const eventType = lib.optString(body, 'eventType', { max: 100 });
    const eventDate = lib.optString(body, 'eventDate', { max: 10 });
    if (eventDate && !lib.isValidDateString(eventDate)) badRequest('eventDate must be YYYY-MM-DD');
    const guests = lib.optInt(body, 'guests', { min: 1, max: 100000 });
    const message = lib.optString(body, 'message', { max: 2000 });
    const bookingId = lib.optString(body, 'bookingId', { max: 100 });

    let booking = null;
    if (bookingId) {
      booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
      if (!booking) badRequest('bookingId does not refer to an existing booking');
      if (req.user && booking.user_id !== req.user.id) {
        // Do not leak whether the booking exists to a non-owner.
        return notFound('Booking not found');
      }
    }

    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO inquiries
         (id, user_id, name, phone, email, event_type, event_date, guests, message, booking_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`
    ).run(
      id,
      req.user ? req.user.id : null,
      name, phone, email, eventType, eventDate, guests, message, bookingId, nowIso()
    );
    const row = db.prepare('SELECT * FROM inquiries WHERE id = ?').get(id);
    const inquiry = lib.mapInquiry(row);

    // Notifications never fail the request (notify.js catches internally).
    const notifyResult = await notify.notifyInquiryCreated(
      db,
      inquiry,
      booking ? lib.mapBooking(booking) : null
    );

    return ok(res, { inquiry, whatsappUrl: notifyResult.whatsappUrl }, 201);
  }));

  // GET /api/__test__/last-otp?phone= — test-only helper. Returns the last
  // OTP code generated for a phone from an in-memory map that is populated
  // ONLY when NODE_ENV=test. Plaintext codes are never persisted in the DB.
  // In any other environment this route does not exist (404).
  router.get('/__test__/last-otp', (req, res) => {
    if (process.env.NODE_ENV !== 'test') return fail(res, 404, 'NOT_FOUND', 'Not found');
    const phone = req.query.phone;
    if (!phone || !testOtpCodes.has(phone)) {
      return fail(res, 404, 'NOT_FOUND', 'No OTP found for this phone');
    }
    return ok(res, { code: testOtpCodes.get(phone) });
  });

  return router;
}

module.exports = publicRoutes;
