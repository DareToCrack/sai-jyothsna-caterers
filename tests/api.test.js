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
  const created = await createApp({ dbPath });
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
  await db.prepare(
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
  // the shape of two Vercel serverless instances WITHOUT Turso (each with
  // its own ephemeral /tmp database). With Turso configured the two
  // instances share one database and the customer check below would be 200.
  const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sjc-test-2-'));
  const created2 = await createApp({ dbPath: path.join(tmpDir2, 'test2.db') });
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

// ---------------------------------------------------------------------------
// (13) Keep-alive endpoint for the Turso free tier (see vercel.json cron)
// ---------------------------------------------------------------------------

test('keep-alive endpoint answers and enforces CRON_SECRET when set', async () => {
  const client = new Client();
  // No CRON_SECRET in the test env: open, and reports the db mode.
  const open = await client.req('GET', '/api/cron/keep-alive');
  assert.equal(open.status, 200);
  assert.equal(open.body.ok, true);
  assert.equal(open.body.dbMode, 'local');

  // With a secret set, the bearer token is required.
  process.env.CRON_SECRET = 'test-cron-secret';
  try {
    const noAuth = await client.req('GET', '/api/cron/keep-alive');
    assert.equal(noAuth.status, 401);
    // A wrong bearer token is rejected too (httpRequest for raw headers).
    const wrong = await httpRequest({
      method: 'GET',
      path: '/api/cron/keep-alive',
      headers: { Authorization: 'Bearer not-the-secret' }
    });
    assert.equal(wrong.status, 401);
    const authed = await httpRequest({
      method: 'GET',
      path: '/api/cron/keep-alive',
      headers: { Authorization: 'Bearer test-cron-secret' }
    });
    assert.equal(authed.status, 200);
    assert.equal(authed.body.ok, true);
  } finally {
    delete process.env.CRON_SECRET;
  }
});

// ---------------------------------------------------------------------------
// (14) Phone normalization at the API level (+91 / spaces / leading 0)
// ---------------------------------------------------------------------------

test('OTP request accepts a +91-prefixed number and normalizes it', async () => {
  const client = new Client();
  const res = await client.req('POST', '/api/auth/request-otp', {
    phone: '+91 98765 00021',
    name: 'Plus Nine One'
  });
  assert.equal(res.status, 200, `request-otp failed: ${res.text}`);
  // The code is stored under the normalized 10-digit number.
  const otpRes = await client.req('GET', '/api/__test__/last-otp?phone=9876500021');
  assert.equal(otpRes.status, 200, `last-otp failed: ${otpRes.text}`);
  const verifyRes = await client.req('POST', '/api/auth/verify-otp', {
    phone: '09876500021',
    code: otpRes.body.code
  });
  assert.equal(verifyRes.status, 200, `verify-otp failed: ${verifyRes.text}`);
  assert.equal(verifyRes.body.user.phone, '9876500021');
});

// ---------------------------------------------------------------------------
// (15) Inquiries reject a past event date
// ---------------------------------------------------------------------------

test('inquiry with a past event date is rejected', async () => {
  const client = new Client();
  const yesterday = tomorrowPlus(-1);
  const res = await client.req('POST', '/api/inquiries', {
    name: 'Past Date',
    phone: '9876500022',
    eventDate: yesterday
  });
  assert.equal(res.status, 400);
  assert.match(res.body.message, /today or in the future/);
});

// ---------------------------------------------------------------------------
// (16) Audit log entries carry the acting admin's email
// ---------------------------------------------------------------------------

test('audit log shows the admin email, not just the id', async () => {
  const admin = new Client();
  await loginAdmin(admin);
  // Perform an audited action first.
  const catRes = await admin.req('POST', '/api/admin/categories', { nameEn: 'Audit Email Check' });
  assert.equal(catRes.status, 201);
  const logs = await admin.req('GET', '/api/admin/audit-logs?limit=5');
  assert.equal(logs.status, 200);
  const entries = logs.body.auditLogs || logs.body.logs;
  assert.ok(Array.isArray(entries) && entries.length > 0, 'expected audit entries');
  const created = entries.find((e) => e.action === 'category.create');
  assert.ok(created, 'expected a category.create audit entry');
  assert.equal(created.adminEmail, 'admin@saijyothsna.local');
  await admin.req('DELETE', `/api/admin/categories/${catRes.body.category.id}`);
});

// ---------------------------------------------------------------------------
// (17) WhatsApp OTP channel (mocked Graph API call)
// ---------------------------------------------------------------------------

test('WhatsApp OTP sends the code via the approved authentication template', async () => {
  const sms = require('../server/sms');
  const realFetch = globalThis.fetch;
  const calls = [];
  // The WhatsApp channel is third in priority: make sure MSG91/Twilio are off.
  const savedEnv = {
    MSG91_AUTH_KEY: process.env.MSG91_AUTH_KEY,
    TWILIO_SID: process.env.TWILIO_SID,
    TWILIO_TOKEN: process.env.TWILIO_TOKEN,
    TWILIO_FROM: process.env.TWILIO_FROM,
    WHATSAPP_CLOUD_TOKEN: process.env.WHATSAPP_CLOUD_TOKEN,
    WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID,
    WHATSAPP_OTP_TEMPLATE: process.env.WHATSAPP_OTP_TEMPLATE
  };
  delete process.env.MSG91_AUTH_KEY;
  delete process.env.TWILIO_SID;
  delete process.env.TWILIO_TOKEN;
  delete process.env.TWILIO_FROM;
  process.env.WHATSAPP_CLOUD_TOKEN = 'test-wa-token';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890';
  process.env.WHATSAPP_OTP_TEMPLATE = 'test_otp_template';
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, text: async () => '{"messages":[{"id":"wamid.test"}]}' };
  };
  try {
    const result = await sms.sendOtp('9876500031', '482913');
    assert.equal(result.provider, 'whatsapp');
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://graph.facebook.com/v21.0/1234567890/messages');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer test-wa-token');
    const payload = JSON.parse(calls[0].options.body);
    assert.equal(payload.messaging_product, 'whatsapp');
    assert.equal(payload.to, '919876500031');
    assert.equal(payload.type, 'template');
    assert.equal(payload.template.name, 'test_otp_template');
    assert.equal(payload.template.language.code, 'en');
    assert.equal(payload.template.components[0].type, 'body');
    assert.equal(payload.template.components[0].parameters[0].type, 'text');
    assert.equal(payload.template.components[0].parameters[0].text, '482913');

    // A Graph API error is reported as a failed send, never thrown.
    globalThis.fetch = async () => ({
      ok: false, status: 400, text: async () => '{"error":{"message":"template not found"}}'
    });
    const failed = await sms.sendOtp('9876500031', '482913');
    assert.equal(failed.provider, 'whatsapp');
    assert.equal(failed.ok, false);
    assert.match(failed.error, /WhatsApp Cloud HTTP 400/);
  } finally {
    globalThis.fetch = realFetch;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// ---------------------------------------------------------------------------
// (18) Regression: password_resets must have the expires_at column
// (it was dropped from the schema during the libsql conversion, which broke
// the forgot-password flow on fresh databases — the INSERT 500'd).
// ---------------------------------------------------------------------------

test('fresh database schema supports the password-reset flow', async () => {
  const { openDb } = require('../server/db');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sjc-schema-'));
  const dbPath = path.join(tmpDir, 'schema.db');
  const db = await openDb(dbPath);
  try {
    await db.prepare(
      'INSERT INTO password_resets (admin_id, token_hash, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)'
    ).run('admin-1', 'hash', new Date(Date.now() + 3600000).toISOString(), new Date().toISOString());
    const row = await db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get('hash');
    assert.ok(row, 'expected the reset row to be readable');
    assert.ok(new Date(row.expires_at) > new Date(), 'expected a future expiry');
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (19) /api/auth/methods reflects the actual configuration
// ---------------------------------------------------------------------------

test('auth methods endpoint reflects configuration', async () => {
  const client = new Client();
  const savedEnv = {
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    MSG91_AUTH_KEY: process.env.MSG91_AUTH_KEY,
    TWILIO_SID: process.env.TWILIO_SID,
    TWILIO_TOKEN: process.env.TWILIO_TOKEN,
    TWILIO_FROM: process.env.TWILIO_FROM,
    WHATSAPP_CLOUD_TOKEN: process.env.WHATSAPP_CLOUD_TOKEN,
    WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID,
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASS: process.env.SMTP_PASS
  };
  try {
    for (const key of Object.keys(savedEnv)) delete process.env[key];
    const base = await client.req('GET', '/api/auth/methods');
    assert.equal(base.status, 200);
    assert.equal(base.body.password, true);
    assert.equal(base.body.google, false);
    assert.equal(base.body.otp, false);
    assert.equal(base.body.passwordReset, false);

    process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
    process.env.MSG91_AUTH_KEY = 'test-msg91-key';
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_USER = 'user@example.com';
    process.env.SMTP_PASS = 'secret';
    const configured = await client.req('GET', '/api/auth/methods');
    assert.equal(configured.body.password, true);
    assert.equal(configured.body.google, true);
    assert.equal(configured.body.otp, true);
    assert.equal(configured.body.passwordReset, true);
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// ---------------------------------------------------------------------------
// (20) Email/password signup: validation, duplicate email, success + session
// ---------------------------------------------------------------------------

test('signup validates input, rejects duplicate emails, and logs the user in', async () => {
  const client = new Client();
  const base = {
    name: 'Signup User',
    email: 'signup.user@example.com',
    password: 'StrongPass1',
    confirmPassword: 'StrongPass1'
  };

  // Short name.
  let res = await client.req('POST', '/api/auth/signup', { ...base, name: 'Al' });
  assert.equal(res.status, 400);
  // Bad email.
  res = await client.req('POST', '/api/auth/signup', { ...base, email: 'not-an-email' });
  assert.equal(res.status, 400);
  // Weak passwords: too short, no uppercase, no lowercase, no number.
  for (const weak of ['Short1', 'alllowercase1', 'ALLUPPERCASE1', 'NoDigitsHere']) {
    res = await client.req('POST', '/api/auth/signup', { ...base, password: weak, confirmPassword: weak });
    assert.equal(res.status, 400, `expected weak password ${weak} to be rejected`);
  }
  // Mismatched confirmation.
  res = await client.req('POST', '/api/auth/signup', { ...base, confirmPassword: 'Different1' });
  assert.equal(res.status, 400);

  // Success: 201, user returned, session cookie set.
  res = await client.req('POST', '/api/auth/signup', base);
  assert.equal(res.status, 201, `signup failed: ${res.text}`);
  assert.equal(res.body.user.email, 'signup.user@example.com');
  assert.equal(res.body.user.name, 'Signup User');
  assert.equal(res.body.user.phone, null);
  assert.equal(res.body.user.authProvider, 'password');
  assert.ok(!('password_hash' in res.body.user), 'password_hash must never leak');
  assert.ok(client.cookies.sjc_session, 'expected a session cookie after signup');

  // The session works: /api/auth/me returns the same user.
  const me = await client.req('GET', '/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, 'signup.user@example.com');

  // Duplicate email (case-insensitive) is rejected with a clear message.
  const dup = await new Client().req('POST', '/api/auth/signup', {
    ...base, email: 'SIGNUP.USER@example.com'
  });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error, 'EMAIL_EXISTS');
  assert.match(dup.body.message, /already exists/);
});

// ---------------------------------------------------------------------------
// (21) Login: same generic error for unknown email, wrong password, and
// Google-only accounts (no account enumeration)
// ---------------------------------------------------------------------------

test('login returns the same generic error for unknown email and wrong password', async () => {
  const generic = 'Invalid email or password';

  // Unknown email.
  let res = await new Client().req('POST', '/api/auth/login', {
    email: 'nobody@example.com',
    password: 'Whatever123'
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'INVALID_CREDENTIALS');
  assert.equal(res.body.message, generic);

  // Existing email (created by the signup test), wrong password — identical.
  res = await new Client().req('POST', '/api/auth/login', {
    email: 'signup.user@example.com',
    password: 'WrongPassword1'
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'INVALID_CREDENTIALS');
  assert.equal(res.body.message, generic);

  // Google-only account (no password_hash) — identical again.
  await db.prepare(
    `INSERT INTO users (id, phone, name, language, email, google_id, auth_provider, created_at)
     VALUES (?, NULL, ?, 'en', ?, ?, 'google', ?)`
  ).run('test-google-only-1', 'Google Only', 'google.only@example.com', 'google-sub-only', new Date().toISOString());
  res = await new Client().req('POST', '/api/auth/login', {
    email: 'google.only@example.com',
    password: 'Whatever123'
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.message, generic);

  // Correct password works and starts a session.
  const client = new Client();
  res = await client.req('POST', '/api/auth/login', {
    email: 'signup.user@example.com',
    password: 'StrongPass1'
  });
  assert.equal(res.status, 200, `login failed: ${res.text}`);
  assert.equal(res.body.user.email, 'signup.user@example.com');
  assert.ok(client.cookies.sjc_session, 'expected a session cookie after login');
  const me = await client.req('GET', '/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, 'signup.user@example.com');
});

// ---------------------------------------------------------------------------
// (22) Google OAuth callback with mocked fetch (token + userinfo)
// ---------------------------------------------------------------------------

test('Google OAuth callback creates/links the user and starts a session', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  const savedEnv = {
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI
  };
  process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-google-client-secret';
  delete process.env.GOOGLE_REDIRECT_URI;
  try {
    // Start the flow: redirect to Google with a state, state cookie set.
    const client = new Client();
    const start = await client.req('GET', '/api/auth/google');
    assert.equal(start.status, 302);
    assert.ok(client.cookies.sjc_oauth_state, 'expected a state cookie');
    const location = new URL(start.headers.location);
    assert.equal(location.origin + location.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(location.searchParams.get('client_id'), 'test-google-client-id');
    assert.equal(location.searchParams.get('response_type'), 'code');
    assert.equal(location.searchParams.get('scope'), 'openid email profile');
    assert.ok(location.searchParams.get('redirect_uri').endsWith('/api/auth/google/callback'));
    const state = location.searchParams.get('state');
    assert.equal(state, client.cookies.sjc_oauth_state);

    // Mock the Google token + userinfo endpoints.
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      if (url === 'https://oauth2.googleapis.com/token') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'test-access-token', token_type: 'Bearer', expires_in: 3600 })
        };
      }
      if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            sub: 'google-sub-123',
            email: 'google.user@example.com',
            email_verified: true,
            name: 'Google User'
          })
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    // Complete the flow: session set, redirect back to the login view.
    const callback = await client.req('GET', `/api/auth/google/callback?code=test-code&state=${state}`);
    assert.equal(callback.status, 302, `callback failed: ${callback.text}`);
    assert.equal(callback.headers.location, '/#/login');
    assert.ok(client.cookies.sjc_session, 'expected a session cookie after Google login');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
    assert.match(String(calls[0].options.body), /grant_type=authorization_code/);
    assert.match(String(calls[0].options.body), /code=test-code/);
    assert.equal(calls[1].url, 'https://openidconnect.googleapis.com/v1/userinfo');
    assert.equal(calls[1].options.headers.Authorization, 'Bearer test-access-token');

    const me = await client.req('GET', '/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, 'google.user@example.com');
    assert.equal(me.body.user.name, 'Google User');
    assert.equal(me.body.user.authProvider, 'google');

    // A second Google login with the same sub returns the SAME user.
    const client2 = new Client();
    const start2 = await client2.req('GET', '/api/auth/google');
    const state2 = new URL(start2.headers.location).searchParams.get('state');
    await client2.req('GET', `/api/auth/google/callback?code=test-code-2&state=${state2}`);
    const me2 = await client2.req('GET', '/api/auth/me');
    assert.equal(me2.body.user.id, me.body.user.id);

    // Linking: a Google login whose email matches an existing password
    // account links the google_id to that account (same user id).
    globalThis.fetch = async (url) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return { ok: true, status: 200, json: async () => ({ access_token: 'test-access-token-2' }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sub: 'google-sub-999',
          email: 'signup.user@example.com',
          email_verified: true,
          name: 'Signup User'
        })
      };
    };
    const client3 = new Client();
    const start3 = await client3.req('GET', '/api/auth/google');
    const state3 = new URL(start3.headers.location).searchParams.get('state');
    await client3.req('GET', `/api/auth/google/callback?code=test-code-3&state=${state3}`);
    const me3 = await client3.req('GET', '/api/auth/me');
    assert.equal(me3.body.user.email, 'signup.user@example.com');
    const linked = await db.prepare('SELECT google_id FROM users WHERE email = ?').get('signup.user@example.com');
    assert.equal(linked.google_id, 'google-sub-999');

    // Wrong state is rejected with a redirect to the login error view.
    const client4 = new Client();
    const start4 = await client4.req('GET', '/api/auth/google');
    const state4 = new URL(start4.headers.location).searchParams.get('state');
    const badState = await client4.req('GET', `/api/auth/google/callback?code=x&state=${state4}tampered`);
    assert.equal(badState.status, 302);
    assert.equal(badState.headers.location, '/#/login?google=error');
    assert.ok(!client4.cookies.sjc_session, 'no session must be created on a state mismatch');

    // User denial at Google redirects with ?google=denied.
    const denied = await new Client().req('GET', '/api/auth/google/callback?error=access_denied');
    assert.equal(denied.status, 302);
    assert.equal(denied.headers.location, '/#/login?google=denied');
  } finally {
    globalThis.fetch = realFetch;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// ---------------------------------------------------------------------------
// (23) Customer forgot/reset password (mocked SMTP: unreachable host, so the
// send fails fast and is swallowed — the token is still created, exactly as
// the handler guarantees). The plaintext token comes from the test hook.
// ---------------------------------------------------------------------------

test('forgot-password + reset-password flow works and cannot probe emails', async () => {
  const savedEnv = {
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_PORT: process.env.SMTP_PORT,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASS: process.env.SMTP_PASS,
    SMTP_FROM: process.env.SMTP_FROM
  };
  // Unreachable SMTP host: nodemailer fails fast (ECONNREFUSED), which the
  // handler swallows — the token is still created and the response is the
  // generic success shape.
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = '1';
  process.env.SMTP_USER = 'test@example.com';
  process.env.SMTP_PASS = 'test-secret';
  delete process.env.SMTP_FROM;
  try {
    const email = 'reset.user@example.com';
    // Create the account first.
    const signup = await new Client().req('POST', '/api/auth/signup', {
      name: 'Reset User',
      email,
      password: 'OldPassword1',
      confirmPassword: 'OldPassword1'
    });
    assert.equal(signup.status, 201, `signup failed: ${signup.text}`);

    const client = new Client();
    const generic = 'If an account exists for this email, a password reset link has been sent.';

    // Unknown email: same generic success, no token created.
    const unknown = await client.req('POST', '/api/auth/forgot-password', { email: 'ghost@example.com' });
    assert.equal(unknown.status, 200);
    assert.equal(unknown.body.message, generic);
    const noToken = await client.req('GET', '/api/__test__/last-reset-token?email=ghost@example.com');
    assert.equal(noToken.status, 404);

    // Known email: same generic success, token created.
    const forgot = await client.req('POST', '/api/auth/forgot-password', { email });
    assert.equal(forgot.status, 200);
    assert.equal(forgot.body.message, generic);
    const tokenRes = await client.req('GET', `/api/__test__/last-reset-token?email=${email}`);
    assert.equal(tokenRes.status, 200, `last-reset-token failed: ${tokenRes.text}`);
    const token = tokenRes.body.token;
    assert.equal(typeof token, 'string');
    assert.ok(token.length >= 32);

    // Weak new password is rejected; the token is NOT consumed.
    const weak = await client.req('POST', '/api/auth/reset-password', {
      token, newPassword: 'weak', confirmPassword: 'weak'
    });
    assert.equal(weak.status, 400);
    // Mismatched confirmation is rejected.
    const mismatch = await client.req('POST', '/api/auth/reset-password', {
      token, newPassword: 'NewPassword1', confirmPassword: 'OtherPassword1'
    });
    assert.equal(mismatch.status, 400);

    // Valid reset succeeds.
    const reset = await client.req('POST', '/api/auth/reset-password', {
      token, newPassword: 'NewPassword1', confirmPassword: 'NewPassword1'
    });
    assert.equal(reset.status, 200, `reset failed: ${reset.text}`);

    // The token is single-use.
    const reuse = await client.req('POST', '/api/auth/reset-password', {
      token, newPassword: 'AnotherPass1', confirmPassword: 'AnotherPass1'
    });
    assert.equal(reuse.status, 400);
    assert.equal(reuse.body.error, 'INVALID_RESET_TOKEN');

    // New password works, old one does not.
    const loginNew = await new Client().req('POST', '/api/auth/login', { email, password: 'NewPassword1' });
    assert.equal(loginNew.status, 200);
    const loginOld = await new Client().req('POST', '/api/auth/login', { email, password: 'OldPassword1' });
    assert.equal(loginOld.status, 401);
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// ---------------------------------------------------------------------------
// (24) Migration: a database created with the OLD users schema (phone NOT
// NULL, no email/password/google columns) migrates on openDb — the phone
// becomes nullable, the new columns appear, and existing rows survive.
// ---------------------------------------------------------------------------

test('openDb migrates a legacy users table (phone NOT NULL, no auth columns)', async () => {
  const { createClient } = require('@libsql/client');
  const { openDb } = require('../server/db');
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sjc-legacy-'));
  const dbPath = path.join(legacyDir, 'legacy.db');
  // Build the OLD users table by hand (pre-email-login schema) + one user.
  const raw = createClient({ url: 'file:' + dbPath });
  await raw.executeMultiple(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      phone TEXT UNIQUE NOT NULL,
      name TEXT,
      language TEXT DEFAULT 'en',
      created_at TEXT NOT NULL
    );
    INSERT INTO users (id, phone, name, language, created_at)
      VALUES ('legacy-user-1', '9876500099', 'Legacy User', 'en', '2026-11-20T00:00:00.000Z');
  `);
  raw.close();

  const db = await openDb(dbPath);
  try {
    const cols = await db.prepare('PRAGMA table_info(users)').all();
    const byName = new Map(cols.map((c) => [c.name, c]));
    assert.equal(byName.get('phone').notnull, 0, 'phone must be nullable after migration');
    assert.ok(byName.has('email'), 'email column missing after migration');
    assert.ok(byName.has('password_hash'), 'password_hash column missing after migration');
    assert.ok(byName.has('google_id'), 'google_id column missing after migration');
    assert.ok(byName.has('auth_provider'), 'auth_provider column missing after migration');
    // The legacy row survived the rebuild.
    const legacy = await db.prepare('SELECT * FROM users WHERE id = ?').get('legacy-user-1');
    assert.ok(legacy, 'legacy user row must survive the migration');
    assert.equal(legacy.phone, '9876500099');
    assert.equal(legacy.name, 'Legacy User');
    assert.equal(legacy.auth_provider, 'otp');
    // And a phone-less (email) user can now be inserted.
    await db.prepare(
      `INSERT INTO users (id, phone, name, language, email, password_hash, auth_provider, created_at)
       VALUES (?, NULL, ?, 'en', ?, ?, 'password', ?)`
    ).run('migrated-email-user', 'Migrated Email', 'migrated@example.com', 'hashed', new Date().toISOString());
    const emailUser = await db.prepare('SELECT * FROM users WHERE email = ?').get('migrated@example.com');
    assert.ok(emailUser, 'phone-less user insert must work after migration');
    assert.equal(emailUser.phone, null);
  } finally {
    db.close();
    fs.rmSync(legacyDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (25) Admin booking delete: removes the booking + its lines, 404s on
// repeat, 401s without an admin session.
// ---------------------------------------------------------------------------

test('admin can delete a booking and its lines; repeat delete 404s', async () => {
  const customer = new Client();
  await loginCustomer(customer, '9876500091', 'Delete Me');
  const created = await customer.req('POST', '/api/bookings', bookingBody());
  assert.equal(created.status, 201, `booking failed: ${created.text}`);
  const bookingId = created.body.booking.id;

  const itemsBefore = await db.prepare(
    'SELECT COUNT(*) AS n FROM booking_items WHERE booking_id = ?').get(bookingId);
  const servicesBefore = await db.prepare(
    'SELECT COUNT(*) AS n FROM booking_services WHERE booking_id = ?').get(bookingId);
  assert.ok(itemsBefore.n > 0, 'booking should have item lines before delete');
  assert.ok(servicesBefore.n > 0, 'booking should have service lines before delete');

  // No session -> 401.
  const anon = new Client();
  const anonDel = await anon.req('DELETE', `/api/admin/bookings/${bookingId}`);
  assert.equal(anonDel.status, 401);

  const admin = new Client();
  await loginAdmin(admin);
  const del = await admin.req('DELETE', `/api/admin/bookings/${bookingId}`);
  assert.equal(del.status, 200, `delete failed: ${del.text}`);
  assert.equal(del.body.deleted, true);

  const gone = await admin.req('GET', `/api/admin/bookings/${bookingId}`);
  assert.equal(gone.status, 404);
  const itemsAfter = await db.prepare(
    'SELECT COUNT(*) AS n FROM booking_items WHERE booking_id = ?').get(bookingId);
  const servicesAfter = await db.prepare(
    'SELECT COUNT(*) AS n FROM booking_services WHERE booking_id = ?').get(bookingId);
  assert.equal(itemsAfter.n, 0, 'booking item lines must be deleted too');
  assert.equal(servicesAfter.n, 0, 'booking service lines must be deleted too');

  const again = await admin.req('DELETE', `/api/admin/bookings/${bookingId}`);
  assert.equal(again.status, 404);
});

// ---------------------------------------------------------------------------
// (26) Admin login lockout: 5 wrong passwords lock the account for 15
// minutes (423); the correct password is rejected while locked and works
// again once the lock expires.
// ---------------------------------------------------------------------------

test('admin login locks after 5 wrong passwords and unlocks after expiry', async () => {
  const admin = new Client();
  await loginAdmin(admin);
  const created = await admin.req('POST', '/api/admin/admins', {
    email: 'lockout-test@example.com',
    password: 'LockoutTest123',
    name: 'Lockout Test'
  });
  assert.equal(created.status, 201, `admin create failed: ${created.text}`);
  const throwawayId = created.body.admin.id;

  try {
    const probe = new Client();
    for (let i = 1; i <= 4; i++) {
      const r = await probe.req('POST', '/api/admin/auth/login', {
        email: 'lockout-test@example.com', password: 'WrongPassword123'
      });
      assert.equal(r.status, 401, `attempt ${i} should be 401, got ${r.status}`);
    }
    const fifth = await probe.req('POST', '/api/admin/auth/login', {
      email: 'lockout-test@example.com', password: 'WrongPassword123'
    });
    assert.equal(fifth.status, 423, `5th wrong attempt should lock (423), got ${fifth.status}`);
    assert.equal(fifth.body.error, 'ACCOUNT_LOCKED');

    // Correct password is still rejected while locked.
    const whileLocked = await probe.req('POST', '/api/admin/auth/login', {
      email: 'lockout-test@example.com', password: 'LockoutTest123'
    });
    assert.equal(whileLocked.status, 423);

    // Move the lock into the past (simulating expiry) — login works again
    // and the failure counter resets.
    const past = new Date(Date.now() - 1000).toISOString();
    await db.prepare('UPDATE admin_users SET locked_until = ? WHERE id = ?').run(past, throwawayId);
    const afterExpiry = await probe.req('POST', '/api/admin/auth/login', {
      email: 'lockout-test@example.com', password: 'LockoutTest123'
    });
    assert.equal(afterExpiry.status, 200, `login after lock expiry failed: ${afterExpiry.text}`);
    const row = await db.prepare('SELECT failed_attempts, locked_until FROM admin_users WHERE id = ?').get(throwawayId);
    assert.equal(row.failed_attempts, 0);
    assert.equal(row.locked_until, null);
  } finally {
    await admin.req('DELETE', `/api/admin/admins/${throwawayId}`);
  }
});

// ---------------------------------------------------------------------------
// (27) Production seed (VERCEL=1) without ADMIN_PASSWORD seeds no admin —
// the hardcoded default password must never reach a public production DB.
// ---------------------------------------------------------------------------

test('production seed without ADMIN_PASSWORD creates no admin account', async () => {
  const { openDb } = require('../server/db');
  const { seed } = require('../server/seed');
  const prevVercel = process.env.VERCEL;
  const prevPassword = process.env.ADMIN_PASSWORD;
  const prodDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sjc-prod-seed-'));
  const dbPath = path.join(prodDir, 'prod.db');
  try {
    process.env.VERCEL = '1';
    delete process.env.ADMIN_PASSWORD;
    const prodDb = await openDb(dbPath);
    try {
      await seed(prodDb, { log: false });
      const admins = await prodDb.prepare('SELECT COUNT(*) AS n FROM admin_users').get();
      assert.equal(admins.n, 0, 'no admin must be seeded in production without ADMIN_PASSWORD');
      // The rest of the seed data still loads.
      const cats = await prodDb.prepare('SELECT COUNT(*) AS n FROM categories').get();
      assert.equal(cats.n, 13);
    } finally {
      prodDb.close();
    }
  } finally {
    if (prevVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = prevVercel;
    if (prevPassword !== undefined) process.env.ADMIN_PASSWORD = prevPassword;
    fs.rmSync(prodDir, { recursive: true, force: true });
  }
});
