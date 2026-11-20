// api.test.js — backend API tests (node:test + node:http only, no extra
// test dependencies).
//
// The app is started via createApp() with NODE_ENV=test on an ephemeral
// port and a temp SQLite file. Rate limiting is disabled in test mode by
// design (see server/app.js); the DB-level OTP limits stay enforced.
//
// Cookie + CSRF handling: the Client helper below keeps a cookie jar from
// set-cookie headers and echoes the sjc_csrf cookie back as the
// X-CSRF-Token header on mutations, exactly like the real frontend does.
//
// Sessions are stateless HMAC-signed tokens (see server/lib.js). The test
// suite sets a fixed SESSION_SECRET so the cross-instance test can run two
// app instances (different temp databases) in one process and prove a
// token issued by one verifies on the other — the Vercel serverless shape.
'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-only-session-secret-for-cross-instance-checks';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcryptjs');

const { createApp } = require('../server/app');

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let server;
let port;
let db;
let closeApp;
let tmpDir;

function tomorrowPlus(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function httpRequest({ method, path: urlPath, body, headers = {}, port: requestPort, rawBody, contentType }) {
  return new Promise((resolve, reject) => {
    const payload = rawBody !== undefined ? rawBody : (body === undefined ? null : JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1',
        port: requestPort || port,
        path: urlPath,
        method,
        headers: {
          ...(payload ? { 'Content-Type': contentType || 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers
        }
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let parsed = data;
          const ct = res.headers['content-type'] || '';
          if (ct.includes('application/json')) {
            try { parsed = JSON.parse(data); } catch { /* keep raw text */ }
          }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed, text: data });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Minimal HTTP client with a cookie jar + automatic CSRF header. */
class Client {
  constructor() {
    this.cookies = {};
  }

  cookieHeader() {
    const pairs = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`);
    return pairs.length > 0 ? pairs.join('; ') : undefined;
  }

  storeCookies(setCookie) {
    if (!setCookie) return;
    const list = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const entry of list) {
      const [pair] = entry.split(';');
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '') delete this.cookies[name];
      else this.cookies[name] = value;
    }
  }

  async req(method, urlPath, body, { csrf = true, port: requestPort, rawBody, contentType } = {}) {
    const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
    const headers = {};
    const cookie = this.cookieHeader();
    if (cookie) headers.Cookie = cookie;
    if (isMutation && csrf && this.cookies.sjc_csrf) {
      headers['X-CSRF-Token'] = this.cookies.sjc_csrf;
    }
    const res = await httpRequest({ method, path: urlPath, body, headers, port: requestPort, rawBody, contentType });
    this.storeCookies(res.headers['set-cookie']);
    return res;
  }
}

/** Build a single-file multipart/form-data body (for the image-upload test). */
function multipartBody(boundary, fieldName, filename, mimeType, fileBuffer) {
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return Buffer.concat([head, fileBuffer, tail]);
}

async function loginCustomer(client, phone, name) {
  const reqRes = await client.req('POST', '/api/auth/request-otp', { phone, name });
  assert.equal(reqRes.status, 200, `request-otp failed: ${reqRes.text}`);
  assert.equal(reqRes.body.ok, true);
  const otpRes = await client.req('GET', `/api/__test__/last-otp?phone=${phone}`);
  assert.equal(otpRes.status, 200, `last-otp failed: ${otpRes.text}`);
  const verifyRes = await client.req('POST', '/api/auth/verify-otp', { phone, code: otpRes.body.code, name });
  assert.equal(verifyRes.status, 200, `verify-otp failed: ${verifyRes.text}`);
  return verifyRes.body.user;
}

async function loginAdmin(client) {
  const res = await client.req('POST', '/api/admin/auth/login', {
    email: 'admin@saijyothsna.local',
    password: 'ChangeMe123!'
  });
  assert.equal(res.status, 200, `admin login failed: ${res.text}`);
  return res.body.admin;
}

function bookingBody(overrides = {}) {
  return {
    eventType: 'fn_marriage',
    eventDate: tomorrowPlus(2),
    guests: 100,
    venueAddress: 'Test Venue, Main Road',
    city: 'Hyderabad',
    items: ['dish_idly', 'dish_chicken_biryani'],
    services: [
      { serviceId: 'srv_serving_staff', quantity: 2 },
      { serviceId: 'srv_transport' }
    ],
    ...overrides
  };
}

// Hand-verified quotation for bookingBody() at the seeded prices/rates:
//   food    = (60 + 240) x 100 guests = 30,000
//   services = 800 x 2 (serving staff) = 1,600
//   transport = 1,500 (srv_transport, flat checkbox price)
//   service charge = 1,600 x 5% = 80            (services only)
//   GST     = (30,000 + 1,600 + 80 + 1,500) x 5% = 33,180 x 5% = 1,659
//   grand   = 30,000 + 1,600 + 1,500 + 80 + 1,659 = 34,839
const EXPECTED_QUOTE = {
  foodTotal: 30000,
  servicesTotal: 1600,
  transportTotal: 1500,
  serviceCharge: 80,
  gstAmount: 1659,
  grandTotal: 34839
};

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sjc-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const created = createApp({ dbPath });
  db = created.db;
  closeApp = created.close;
  server = created.app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  port = server.address().port;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeApp();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (1) OTP request + verify + /api/auth/me
// ---------------------------------------------------------------------------

test('OTP request + verify logs the customer in', async () => {
  const client = new Client();
  const user = await loginCustomer(client, '9876500001', 'Test User One');
  assert.equal(user.phone, '9876500001');
  assert.equal(user.name, 'Test User One');

  const me = await client.req('GET', '/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.phone, '9876500001');
  assert.equal(me.body.user.name, 'Test User One');
});

// ---------------------------------------------------------------------------
// (2) Wrong code -> 401
// ---------------------------------------------------------------------------

test('wrong OTP code is rejected with 401', async () => {
  const client = new Client();
  const reqRes = await client.req('POST', '/api/auth/request-otp', { phone: '9876500002' });
  assert.equal(reqRes.status, 200);

  const verifyRes = await client.req('POST', '/api/auth/verify-otp', {
    phone: '9876500002',
    code: '482910' // arbitrary wrong code (the real one is different)
  });
  assert.equal(verifyRes.status, 401);
  assert.equal(verifyRes.body.ok, false);
  assert.equal(verifyRes.body.error, 'OTP_INVALID');

  const me = await client.req('GET', '/api/auth/me');
  assert.equal(me.status, 401);
});

// ---------------------------------------------------------------------------
// (3) Expired code rejected + reused code rejected
// ---------------------------------------------------------------------------

test('expired OTP code is rejected', async () => {
  const phone = '9876500003';
  // Insert an already-expired, bcrypt-hashed code directly into the test DB.
  const hash = await bcrypt.hash('739201', 12);
  const expiredAt = new Date(Date.now() - 60 * 1000).toISOString();
  db.prepare(
    'INSERT INTO otp_codes (phone, code_hash, expires_at, attempts, created_at) VALUES (?, ?, ?, 0, ?)'
  ).run(phone, hash, expiredAt, new Date().toISOString());

  const client = new Client();
  const res = await client.req('POST', '/api/auth/verify-otp', { phone, code: '739201' });
  assert.equal(res.status, 410);
  assert.equal(res.body.error, 'OTP_EXPIRED');
});

test('an OTP code cannot be reused', async () => {
  const client = new Client();
  const phone = '9876500004';
  const reqRes = await client.req('POST', '/api/auth/request-otp', { phone, name: 'Reuse Test' });
  assert.equal(reqRes.status, 200);
  const otpRes = await client.req('GET', `/api/__test__/last-otp?phone=${phone}`);
  const code = otpRes.body.code;

  const first = await client.req('POST', '/api/auth/verify-otp', { phone, code });
  assert.equal(first.status, 200);

  const second = await client.req('POST', '/api/auth/verify-otp', { phone, code });
  assert.equal(second.status, 401);
  assert.equal(second.body.error, 'OTP_EXPIRED');
});

// ---------------------------------------------------------------------------
// (4) Seeded menu/service counts
// ---------------------------------------------------------------------------

test('seeded menu has exactly 13 categories and 15 items; services 13', async () => {
  const client = new Client();
  const menu = await client.req('GET', '/api/menu');
  assert.equal(menu.status, 200);
  assert.equal(menu.body.categories.length, 13);
  const itemCount = menu.body.categories.reduce((n, c) => n + c.items.length, 0);
  assert.equal(itemCount, 15);

  const services = await client.req('GET', '/api/services');
  assert.equal(services.status, 200);
  assert.equal(services.body.services.length, 13);

  // Spot-check the seeded prices the quotation test relies on.
  const allItems = menu.body.categories.flatMap((c) => c.items);
  const idly = allItems.find((i) => i.id === 'dish_idly');
  const biryani = allItems.find((i) => i.id === 'dish_chicken_biryani');
  assert.equal(idly.price, 60);
  assert.equal(biryani.price, 240);
  const staff = services.body.services.find((s) => s.id === 'srv_serving_staff');
  const transport = services.body.services.find((s) => s.id === 'srv_transport');
  assert.equal(staff.unitPrice, 800);
  assert.equal(staff.defaultQuantity, 2);
  assert.equal(transport.unitPrice, 1500);
});

// ---------------------------------------------------------------------------
// (5) Booking quotation totals, hand-verified
// ---------------------------------------------------------------------------

test('booking creates a quotation with exact hand-verified totals', async () => {
  const client = new Client();
  await loginCustomer(client, '9876500005', 'Quote Tester');

  const res = await client.req('POST', '/api/bookings', bookingBody());
  assert.equal(res.status, 201, `booking failed: ${res.text}`);
  const booking = res.body.booking;

  // Recompute from the pricing rules in the test itself, then compare both
  // against the hand-verified literals.
  const food = (60 + 240) * 100;
  const services = 800 * 2;
  const transport = 1500;
  const serviceCharge = services * 0.05;
  const gst = (food + services + serviceCharge + transport) * 0.05;
  const grand = Math.round(food + services + transport + serviceCharge + gst);
  assert.deepEqual(
    { food, services, transport, serviceCharge, gst, grand },
    {
      food: EXPECTED_QUOTE.foodTotal,
      services: EXPECTED_QUOTE.servicesTotal,
      transport: EXPECTED_QUOTE.transportTotal,
      serviceCharge: EXPECTED_QUOTE.serviceCharge,
      gst: EXPECTED_QUOTE.gstAmount,
      grand: EXPECTED_QUOTE.grandTotal
    }
  );

  assert.equal(booking.foodTotal, EXPECTED_QUOTE.foodTotal);
  assert.equal(booking.servicesTotal, EXPECTED_QUOTE.servicesTotal);
  assert.equal(booking.transportTotal, EXPECTED_QUOTE.transportTotal);
  assert.equal(booking.serviceCharge, EXPECTED_QUOTE.serviceCharge);
  assert.equal(booking.gstAmount, EXPECTED_QUOTE.gstAmount);
  assert.equal(booking.grandTotal, EXPECTED_QUOTE.grandTotal);
  assert.equal(booking.taxRate, 5);
  assert.equal(booking.serviceChargeRate, 5);
  assert.match(booking.quoteNumber, /^SJC-\d{4}-\d{4}$/);
  assert.equal(booking.status, 'pending');
  assert.equal(res.body.quotationUrl, `/api/quotations/${booking.id}`);

  // Per-item lines: unit price x guests.
  const idlyLine = booking.items.find((i) => i.itemId === 'dish_idly');
  const biryaniLine = booking.items.find((i) => i.itemId === 'dish_chicken_biryani');
  assert.equal(idlyLine.lineTotal, 60 * 100);
  assert.equal(biryaniLine.lineTotal, 240 * 100);
  assert.equal(idlyLine.qtyIsGuests, true);
  const staffLine = booking.services.find((s) => s.serviceId === 'srv_serving_staff');
  assert.equal(staffLine.total, 1600);
  assert.equal(staffLine.quantity, 2);
});

// ---------------------------------------------------------------------------
// (6) Booking without auth -> 401
// ---------------------------------------------------------------------------

test('booking without authentication returns 401', async () => {
  const client = new Client();
  const res = await client.req('POST', '/api/bookings', bookingBody());
  assert.equal(res.status, 401);
  assert.equal(res.body.ok, false);
});

// ---------------------------------------------------------------------------
// (7) Admin login + CRUD for item, category, service
// ---------------------------------------------------------------------------

test('admin login and CRUD for categories, items and services', async () => {
  const admin = new Client();
  const adminUser = await loginAdmin(admin);
  assert.equal(adminUser.email, 'admin@saijyothsna.local');
  assert.equal(adminUser.mustChangePassword, true);

  // Category: create -> delete (409 while an item references it).
  const catRes = await admin.req('POST', '/api/admin/categories', { nameEn: 'Test Category' });
  assert.equal(catRes.status, 201);
  const categoryId = catRes.body.category.id;

  // Item: create -> edit -> delete.
  const itemRes = await admin.req('POST', '/api/admin/items', {
    categoryId,
    nameEn: 'Test Dish',
    descEn: 'A dish created by the test suite',
    price: 99,
    isVeg: true
  });
  assert.equal(itemRes.status, 201, `item create failed: ${itemRes.text}`);
  const itemId = itemRes.body.item.id;
  assert.equal(itemRes.body.item.price, 99);

  const deleteBlocked = await admin.req('DELETE', `/api/admin/categories/${categoryId}`);
  assert.equal(deleteBlocked.status, 409);
  assert.equal(deleteBlocked.body.error, 'CATEGORY_IN_USE');

  const editRes = await admin.req('PUT', `/api/admin/items/${itemId}`, { price: 111 });
  assert.equal(editRes.status, 200);
  assert.equal(editRes.body.item.price, 111);

  const delItem = await admin.req('DELETE', `/api/admin/items/${itemId}`);
  assert.equal(delItem.status, 200);

  const delCat = await admin.req('DELETE', `/api/admin/categories/${categoryId}`);
  assert.equal(delCat.status, 200);

  // Service: create -> edit -> delete.
  const svcRes = await admin.req('POST', '/api/admin/services', {
    nameEn: 'Test Service',
    type: 'checkbox',
    unitPrice: 500
  });
  assert.equal(svcRes.status, 201);
  const serviceId = svcRes.body.service.id;

  const svcEdit = await admin.req('PUT', `/api/admin/services/${serviceId}`, { unitPrice: 600 });
  assert.equal(svcEdit.status, 200);
  assert.equal(svcEdit.body.service.unitPrice, 600);

  const svcDel = await admin.req('DELETE', `/api/admin/services/${serviceId}`);
  assert.equal(svcDel.status, 200);

  // Dashboard works for the admin.
  const dash = await admin.req('GET', '/api/admin/dashboard');
  assert.equal(dash.status, 200);
  assert.equal(typeof dash.body.stats.bookingsTotal, 'number');
});

// ---------------------------------------------------------------------------
// (8) Customer session gets 403 on admin routes
// ---------------------------------------------------------------------------

test('customer session gets 403 on admin dashboard', async () => {
  const client = new Client();
  await loginCustomer(client, '9876500008', 'Customer Eight');
  const res = await client.req('GET', '/api/admin/dashboard');
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'FORBIDDEN');
});

// ---------------------------------------------------------------------------
// (9) Inquiry saves + creates an outbox row
// ---------------------------------------------------------------------------

test('inquiry saves and creates an outbox row visible to the admin', async () => {
  const guest = new Client();
  const res = await guest.req('POST', '/api/inquiries', {
    name: 'Inquiry Person',
    phone: '9876500009',
    email: 'inquiry@example.com',
    eventType: 'fn_birthday',
    eventDate: tomorrowPlus(5),
    guests: 50,
    message: 'Please call me about a birthday booking.'
  });
  assert.equal(res.status, 201, `inquiry failed: ${res.text}`);
  const inquiryId = res.body.inquiry.id;
  assert.ok(res.body.whatsappUrl.startsWith('https://wa.me/'));

  const admin = new Client();
  await loginAdmin(admin);
  const outbox = await admin.req('GET', '/api/admin/outbox?status=pending&limit=100');
  assert.equal(outbox.status, 200);
  const row = outbox.body.outbox.find(
    (entry) => entry.relatedType === 'inquiry' && entry.relatedId === inquiryId
  );
  assert.ok(row, 'expected a pending outbox row for the inquiry');
  assert.equal(row.channel, 'email');
  assert.equal(row.status, 'pending');
});

// ---------------------------------------------------------------------------
// (10) Settings change (GST) affects the next quotation
// ---------------------------------------------------------------------------

test('changing taxRate changes GST on the next quotation, then restores', async () => {
  const admin = new Client();
  await loginAdmin(admin);

  const putRes = await admin.req('PUT', '/api/admin/settings', { taxRate: 10 });
  assert.equal(putRes.status, 200);
  assert.equal(putRes.body.settings.taxRate, 10);

  try {
    const client = new Client();
    await loginCustomer(client, '9876500010', 'GST Tester');
    const res = await client.req('POST', '/api/bookings', bookingBody());
    assert.equal(res.status, 201, `booking failed: ${res.text}`);
    const booking = res.body.booking;
    // Same order, 10% GST: (30,000 + 1,600 + 80 + 1,500) x 10% = 3,318;
    // grand = 30,000 + 1,600 + 1,500 + 80 + 3,318 = 36,498.
    assert.equal(booking.taxRate, 10);
    assert.equal(booking.gstAmount, 3318);
    assert.equal(booking.grandTotal, 36498);
  } finally {
    const restore = await admin.req('PUT', '/api/admin/settings', { taxRate: 5 });
    assert.equal(restore.status, 200);
    assert.equal(restore.body.settings.taxRate, 5);
  }
});

// ---------------------------------------------------------------------------
// Extra: CSRF enforcement + printable quotation page
// ---------------------------------------------------------------------------

test('mutations with a session cookie but no CSRF token are rejected', async () => {
  const client = new Client();
  await loginCustomer(client, '9876500011', 'CSRF Tester');
  const res = await client.req(
    'PUT',
    '/api/profile',
    { name: 'Should Not Apply' },
    { csrf: false }
  );
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'CSRF_INVALID');

  const me = await client.req('GET', '/api/auth/me');
  assert.equal(me.body.user.name, 'CSRF Tester');
});

test('quotation page renders printable HTML for the owning customer', async () => {
  const client = new Client();
  await loginCustomer(client, '9876500012', 'Quotation Tester');
  const bookingRes = await client.req('POST', '/api/bookings', bookingBody());
  assert.equal(bookingRes.status, 201);
  const booking = bookingRes.body.booking;

  const page = await client.req('GET', `/api/quotations/${booking.id}`);
  assert.equal(page.status, 200);
  assert.ok(page.headers['content-type'].includes('text/html'));
  assert.ok(page.text.includes(booking.quoteNumber));
  assert.ok(page.text.includes('34,839')); // grand total, en-IN formatted
  assert.ok(page.text.includes('valid for 7 days'));

  // Unauthenticated visitors cannot open someone else's quotation.
  const stranger = new Client();
  const denied = await stranger.req('GET', `/api/quotations/${booking.id}`);
  assert.equal(denied.status, 401);
});

// ---------------------------------------------------------------------------
// (11) Image upload serves via /api/uploads/:name; traversal rejected
// ---------------------------------------------------------------------------

test('image upload stores the file and serves it via /api/uploads/:name', async () => {
  const admin = new Client();
  await loginAdmin(admin);

  const itemRes = await admin.req('POST', '/api/admin/items', {
    categoryId: 'cat_breakfast',
    nameEn: 'Upload Test Dish',
    price: 42
  });
  assert.equal(itemRes.status, 201, `item create failed: ${itemRes.text}`);
  const itemId = itemRes.body.item.id;

  // 1x1 transparent PNG.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=',
    'base64'
  );
  const boundary = '----sjc-test-boundary';
  const up = await admin.req('POST', `/api/admin/items/${itemId}/image`, undefined, {
    rawBody: multipartBody(boundary, 'image', 'dish.png', 'image/png', png),
    contentType: `multipart/form-data; boundary=${boundary}`
  });
  assert.equal(up.status, 200, `upload failed: ${up.text}`);
  assert.ok(up.body.imageUrl.startsWith('/api/uploads/'));

  const get = await admin.req('GET', up.body.imageUrl);
  assert.equal(get.status, 200);
  assert.ok(get.headers['content-type'].includes('image/png'));

  // Path traversal must be rejected (400 from the sanitiser, or 404).
  const evil = await admin.req('GET', '/api/uploads/%2e%2e%2fpackage.json');
  assert.ok([400, 404].includes(evil.status), `expected 400/404, got ${evil.status}`);

  // Deleting the item removes the uploaded file too.
  const del = await admin.req('DELETE', `/api/admin/items/${itemId}`);
  assert.equal(del.status, 200);
  const gone = await admin.req('GET', up.body.imageUrl);
  assert.equal(gone.status, 404);
});

// ---------------------------------------------------------------------------
// (12) Stateless sessions work across two app instances (Vercel shape)
// ---------------------------------------------------------------------------

test('stateless sessions work across two app instances sharing SESSION_SECRET', async () => {
  // Second instance: a different temp database, the same SESSION_SECRET —
  // the shape of two Vercel serverless instances.
  const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sjc-test-2-'));
  const created2 = createApp({ dbPath: path.join(tmpDir2, 'test2.db') });
  const server2 = created2.app.listen(0);
  await new Promise((resolve) => server2.once('listening', resolve));
  const port2 = server2.address().port;
  try {
    // Admin: seeded on every instance with a deterministic id, so the
    // token issued by instance 1 verifies AND loads on instance 2.
    const admin = new Client();
    await loginAdmin(admin); // logs in on instance 1
    const me2 = await admin.req('GET', '/api/admin/auth/me', undefined, { port: port2 });
    assert.equal(me2.status, 200, `cross-instance admin /me failed: ${me2.text}`);
    assert.equal(me2.body.admin.email, 'admin@saijyothsna.local');

    // Customer: the token itself verifies on instance 2, but the user row
    // only exists in instance 1's database — the documented ephemeral
    // limitation (the customer re-verifies OTP on the new instance).
    const customer = new Client();
    await loginCustomer(customer, '9876500013', 'Cross Instance');
    const custMe2 = await customer.req('GET', '/api/auth/me', undefined, { port: port2 });
    assert.equal(custMe2.status, 401);
  } finally {
    await new Promise((resolve) => server2.close(resolve));
    created2.close();
    fs.rmSync(tmpDir2, { recursive: true, force: true });
  }
});
