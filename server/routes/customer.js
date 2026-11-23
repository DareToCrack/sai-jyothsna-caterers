// routes/customer.js — authenticated customer API: profile, bookings,
// printable quotations, and reviews.
'use strict';

const express = require('express');
const crypto = require('crypto');
const { getAllSettings, nowIso } = require('../db');
const lib = require('../lib');
const { computeQuotation } = require('../pricing');
const notify = require('../notify');
const { renderQuotationHTML } = require('../quotation');

const { ok, asyncHandler, badRequest, notFound } = lib;

const EVENT_TYPE_RE = /^fn_[a-z0-9_]+$/;

function customerRoutes(ctx) {
  const { db } = ctx;
  const router = express.Router();

  // --- Profile -------------------------------------------------------------

  router.get('/profile', lib.requireCustomer, (req, res) => {
    return ok(res, { user: lib.mapUser(req.user) });
  });

  router.put('/profile', lib.requireCustomer, asyncHandler(async (req, res) => {
    const body = req.body || {};
    const name = lib.optString(body, 'name', { max: 100 });
    const language = body.language === undefined
      ? undefined
      : lib.reqEnum(body, 'language', ['en', 'te', 'hi']);
    if (name === null && language === undefined) {
      badRequest('Nothing to update');
    }
    if (name !== null) {
      await db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.user.id);
    }
    if (language !== undefined) {
      await db.prepare('UPDATE users SET language = ? WHERE id = ?').run(language, req.user.id);
    }
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    return ok(res, { user: lib.mapUser(user) });
  }));

  // --- Bookings ------------------------------------------------------------

  // POST /api/bookings — the server ALWAYS computes the quotation from
  // current DB prices via pricing.js; client prices are never trusted.
  router.post('/bookings', lib.requireCustomer, asyncHandler(async (req, res) => {
    const body = req.body || {};
    const settings = await getAllSettings(db);

    // --- Validate the booking request ---
    const eventType = lib.reqString(body, 'eventType', { max: 100 });
    if (!EVENT_TYPE_RE.test(eventType)) {
      badRequest("eventType must be an fn_* key (e.g. fn_marriage) or 'fn_other'");
    }
    const customEventType = eventType === 'fn_other'
      ? lib.reqString(body, 'customEventType', { max: 100 })
      : lib.optString(body, 'customEventType', { max: 100 });

    const eventDate = lib.reqString(body, 'eventDate', { max: 10 });
    if (!lib.isValidDateString(eventDate)) badRequest('eventDate must be YYYY-MM-DD');
    if (eventDate < lib.tomorrowDateString()) {
      badRequest('eventDate must be at least tomorrow');
    }

    const guests = lib.reqInt(body, 'guests', {
      min: settings.minGuestsForBooking,
      max: 10000
    });
    const venueAddress = lib.reqString(body, 'venueAddress', { max: 500 });
    const landmark = lib.optString(body, 'landmark', { max: 200 });
    const city = lib.reqString(body, 'city', { max: 100 });
    const district = lib.optString(body, 'district', { max: 100 });
    const state = lib.optString(body, 'state', { max: 100 });
    const pincode = lib.optString(body, 'pincode', { max: 6 });
    if (pincode && !lib.PINCODE_RE.test(pincode)) {
      badRequest('pincode must be 6 digits');
    }
    const notes = lib.optString(body, 'notes', { max: 2000 });
    const transport = lib.optBool(body, 'transport', false);

    if (!Array.isArray(body.items) || body.items.length === 0) {
      badRequest('items must be a non-empty array of food item ids');
    }
    const itemIds = [...new Set(body.items)];
    if (itemIds.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 100)) {
      badRequest('items must contain only food item id strings');
    }

    const requestedServices = body.services === undefined ? [] : body.services;
    if (!Array.isArray(requestedServices)) badRequest('services must be an array');
    for (const entry of requestedServices) {
      if (!entry || typeof entry !== 'object' || typeof entry.serviceId !== 'string') {
        badRequest('each service entry must have a serviceId');
      }
      if (entry.quantity !== undefined &&
          (!Number.isInteger(entry.quantity) || entry.quantity < 0 || entry.quantity > 1000)) {
        badRequest('service quantity must be an integer between 0 and 1000');
      }
    }

    // --- Resolve items + services from the DB (current prices) ---
    const itemPlaceholders = itemIds.map(() => '?').join(',');
    const itemRows = await db
      .prepare(`SELECT * FROM food_items WHERE id IN (${itemPlaceholders})`)
      .all(...itemIds);
    if (itemRows.length !== itemIds.length) {
      badRequest('One or more selected food items do not exist');
    }
    const unavailableItem = itemRows.find((row) => row.is_available !== 1);
    if (unavailableItem) {
      badRequest(`Food item ${unavailableItem.id} is not available`);
    }

    const serviceIds = [...new Set(requestedServices.map((entry) => entry.serviceId))];
    let serviceRows = [];
    if (serviceIds.length > 0) {
      const svcPlaceholders = serviceIds.map(() => '?').join(',');
      serviceRows = await db
        .prepare(`SELECT * FROM services WHERE id IN (${svcPlaceholders})`)
        .all(...serviceIds);
      if (serviceRows.length !== serviceIds.length) {
        badRequest('One or more selected services do not exist');
      }
      const unavailableSvc = serviceRows.find((row) => row.is_available !== 1);
      if (unavailableSvc) {
        badRequest(`Service ${unavailableSvc.id} is not available`);
      }
    }
    const serviceById = new Map(serviceRows.map((row) => [row.id, row]));

    // Resolve quantities: 'number' services take the requested quantity (or
    // their default_quantity when omitted); 0 means "not selected".
    // 'checkbox' services ignore quantity entirely (flat price).
    const resolvedServices = [];
    for (const entry of requestedServices) {
      const row = serviceById.get(entry.serviceId);
      if (row.type === 'number') {
        const quantity = entry.quantity !== undefined ? entry.quantity : row.default_quantity;
        if (quantity === 0) continue; // explicitly not selected
        resolvedServices.push({
          id: row.id, nameEn: row.name_en, type: row.type,
          unitPrice: row.unit_price, quantity
        });
      } else {
        resolvedServices.push({
          id: row.id, nameEn: row.name_en, type: row.type,
          unitPrice: row.unit_price, quantity: 1
        });
      }
    }

    // --- Compute the quotation (pure function, exact original semantics) ---
    const quote = computeQuotation({
      items: itemRows.map((row) => ({ id: row.id, nameEn: row.name_en, price: row.price })),
      services: resolvedServices,
      guests,
      transportSelected: transport,
      settings
    });

    // --- Persist booking + lines atomically (one libsql batch = one
    // transaction, single round trip to Turso). Quote numbers are
    // sequential per creation year (SJC-<year>-<seq>); on a UNIQUE clash
    // (concurrent bookings) retry with the next sequence number. ---
    const year = new Date().getFullYear();
    let bookingId = null;
    let quoteNumber = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const countRow = await db
        .prepare("SELECT COUNT(*) AS n FROM bookings WHERE quote_number LIKE ?")
        .get(`SJC-${year}-%`);
      const seq = countRow.n + 1 + attempt;
      quoteNumber = `SJC-${year}-${String(seq).padStart(4, '0')}`;
      bookingId = crypto.randomUUID();
      const statements = [
        {
          sql: `INSERT INTO bookings
             (id, quote_number, user_id, customer_name, customer_phone, event_type,
              custom_event_type, event_date, guests, venue_address, landmark, city,
              district, state, pincode, status, food_total, services_total,
              transport_total, service_charge, gst_amount, grand_total,
              tax_rate, service_charge_rate, notes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending',
                   ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            bookingId, quoteNumber, req.user.id,
            req.user.name || 'Guest', req.user.phone,
            eventType, customEventType, eventDate, guests,
            venueAddress, landmark, city, district, state, pincode,
            quote.foodTotal, quote.servicesTotal, quote.transportTotal,
            quote.serviceCharge, quote.gstAmount, quote.grandTotal,
            quote.taxRate, quote.serviceChargeRate, notes, nowIso()
          ]
        },
        ...quote.itemLines.map((line) => ({
          sql: `INSERT INTO booking_items (booking_id, item_id, item_name, unit_price, qty_is_guests)
                VALUES (?, ?, ?, ?, 1)`,
          args: [bookingId, line.itemId, line.itemName, line.unitPrice]
        })),
        ...quote.serviceLines.map((line) => ({
          sql: `INSERT INTO booking_services (booking_id, service_id, service_name, unit_price, quantity, total)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [bookingId, line.serviceId, line.serviceName, line.unitPrice, line.quantity, line.total]
        }))
      ];
      try {
        await db.batch(statements);
        break;
      } catch (err) {
        // libsql surfaces the SQLite message ("UNIQUE constraint failed:
        // bookings.quote_number") and/or a UNIQUE error code.
        const isUniqueClash =
          (err.message && err.message.includes('UNIQUE constraint failed')) ||
          (err.code && String(err.code).includes('UNIQUE'));
        if (isUniqueClash && attempt < 4) {
          continue; // quote number clash: retry with the next sequence
        }
        throw err;
      }
    }
    if (!bookingId) {
      throw new Error('Could not allocate a quote number');
    }

    const bookingRow = await db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
    const booking = await lib.mapBookingDetail(db, bookingRow);

    // Notifications never fail the request (notify.js catches internally).
    const notifyResult = await notify.notifyBookingCreated(db, booking, {
      items: booking.items,
      services: booking.services
    });

    return ok(res, {
      booking,
      quotationUrl: `/api/quotations/${bookingId}`,
      whatsappUrl: notifyResult.whatsappUrl
    }, 201);
  }));

  // GET /api/bookings — the caller's own bookings, newest first (summary).
  router.get('/bookings', lib.requireCustomer, asyncHandler(async (req, res) => {
    const rows = await db
      .prepare('SELECT * FROM bookings WHERE user_id = ? ORDER BY created_at DESC')
      .all(req.user.id);
    return ok(res, { bookings: rows.map(lib.mapBookingSummary) });
  }));

  // GET /api/bookings/:id — own booking only (404 otherwise, so existence
  // is not leaked); admins may view any booking.
  router.get('/bookings/:id', asyncHandler(async (req, res) => {
    if (!req.user && !req.admin) {
      return lib.fail(res, 401, 'UNAUTHENTICATED', 'Please log in to continue');
    }
    const row = await db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
    if (!row) return notFound('Booking not found');
    if (!req.admin && row.user_id !== req.user.id) return notFound('Booking not found');
    return ok(res, { booking: await lib.mapBookingDetail(db, row) });
  }));

  // --- Quotations ----------------------------------------------------------

  // GET /api/quotations/:id — standalone printable HTML page.
  // Access: owning customer or any admin session, else 401/404.
  router.get('/quotations/:id', asyncHandler(async (req, res) => {
    if (!req.user && !req.admin) {
      return lib.fail(res, 401, 'UNAUTHENTICATED', 'Please log in to continue');
    }
    const row = await db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
    if (!row) return notFound('Quotation not found');
    if (!req.admin && row.user_id !== req.user.id) return notFound('Quotation not found');

    const booking = await lib.mapBookingDetail(db, row);

    // Group menu items by category (in menu order) for the receipt layout.
    const itemRows = await db.prepare(
      `SELECT bi.*, fi.category_id AS category_id, c.name_en AS category_name, c.order_index AS category_order
       FROM booking_items bi
       LEFT JOIN food_items fi ON fi.id = bi.item_id
       LEFT JOIN categories c ON c.id = fi.category_id
       WHERE bi.booking_id = ?`
    ).all(row.id);
    const groups = new Map();
    for (const itemRow of itemRows) {
      const key = itemRow.category_id || '__other__';
      if (!groups.has(key)) {
        groups.set(key, {
          categoryName: itemRow.category_name || 'Menu',
          order: itemRow.category_order ?? 999,
          items: []
        });
      }
      groups.get(key).items.push({
        itemName: itemRow.item_name,
        unitPrice: itemRow.unit_price,
        lineTotal: itemRow.qty_is_guests === 1 ? itemRow.unit_price * row.guests : itemRow.unit_price
      });
    }
    const groupedItems = [...groups.values()].sort((a, b) => a.order - b.order);

    const html = renderQuotationHTML({
      booking,
      groupedItems,
      serviceLines: booking.services,
      business: await getAllSettings(db)
    });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  }));

  // --- Reviews -------------------------------------------------------------

  // POST /api/reviews — authenticated customers only.
  router.post('/reviews', lib.requireCustomer, asyncHandler(async (req, res) => {
    const body = req.body || {};
    const rating = lib.reqInt(body, 'rating', { min: 1, max: 5 });
    const eventType = lib.optString(body, 'eventType', { max: 100 });
    const comment = lib.reqString(body, 'comment', { max: 1000 });

    const id = crypto.randomUUID();
    await db.prepare(
      `INSERT INTO reviews
         (id, user_id, user_name, rating, event_type, comment, verified, owner_reply, is_visible, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, NULL, 1, ?)`
    ).run(id, req.user.id, req.user.name || 'Guest', rating, eventType, comment, nowIso());
    const row = await db.prepare('SELECT * FROM reviews WHERE id = ?').get(id);
    return ok(res, { review: lib.mapReview(row) }, 201);
  }));

  // GET /api/reviews/mine — the caller's own reviews, newest first.
  router.get('/reviews/mine', lib.requireCustomer, asyncHandler(async (req, res) => {
    const rows = await db
      .prepare('SELECT * FROM reviews WHERE user_id = ? ORDER BY created_at DESC')
      .all(req.user.id);
    return ok(res, { reviews: rows.map(lib.mapReview) });
  }));

  return router;
}

module.exports = customerRoutes;
