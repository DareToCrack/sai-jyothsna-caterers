// db.js — database layer on @libsql/client (one client, two backends).
//
//   * TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN) set  -> remote Turso database
//     (Vercel production: persistent, shared by every serverless instance).
//   * Otherwise                                     -> local SQLite file via a
//     `file:` URL (local dev + tests keep working offline with the same code).
//   * On Vercel without Turso configured             -> the file lives in
//     /tmp (demo mode: data resets when the instance is recycled, exactly
//     as before; the admin dashboard shows the ephemeral-data notice only
//     in this case — see routes/admin.js).
//
// All database access goes through the libsql client's async execute()
// API. The handle returned by openDb() exposes a small node:sqlite-shaped
// surface (prepare().get/.all/.run, exec, batch) so the rest of the app
// keeps its existing query structure; every method is async and awaits
// client.execute() underneath. A test run (NODE_ENV=test) NEVER touches
// Turso, even if TURSO_DATABASE_URL is present in the environment — tests
// always use the explicit temp file path they are given.
//
// NOTE: sessions are stateless HMAC-signed cookies (see lib.js) — there is
// deliberately no sessions table, so auth works across serverless instances
// that do not share a database.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createClient } = require('@libsql/client');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  -- Phone is nullable: email/password and Google accounts are created
  -- without one (the customer enters a phone at booking time instead).
  -- Legacy phone-only (OTP) users always have one.
  phone TEXT UNIQUE,
  name TEXT,
  language TEXT DEFAULT 'en',
  -- Email/password login (always available, free): email is the login id.
  -- google_id links a Google Sign-In account (matched by google_id first,
  -- then by email). auth_provider records how the account was created.
  email TEXT UNIQUE,
  password_hash TEXT,
  google_id TEXT UNIQUE,
  auth_provider TEXT DEFAULT 'otp'
    CHECK (auth_provider IN ('password', 'google', 'otp')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  name TEXT,
  expires_at TEXT NOT NULL,
  attempts INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_otp_codes_phone ON otp_codes (phone);

CREATE TABLE IF NOT EXISTS admin_users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  role TEXT DEFAULT 'admin',
  must_change_password INTEGER DEFAULT 1,
  -- Brute-force protection: failed logins count up, and 5 failures lock
  -- the account until locked_until (ISO timestamp). See routes/admin.js.
  failed_attempts INTEGER DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS password_resets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_password_resets_admin ON password_resets (admin_id);

-- Customer password resets: same shape as password_resets (admin), kept as
-- a separate table so the admin table's NOT NULL admin_id never has to
-- change. Tokens are SHA-256-hashed at rest, 1-hour expiry, single-use.
CREATE TABLE IF NOT EXISTS customer_password_resets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customer_password_resets_user ON customer_password_resets (user_id);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name_en TEXT NOT NULL,
  name_te TEXT,
  name_hi TEXT,
  order_index INTEGER DEFAULT 99,
  is_active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS food_items (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES categories (id),
  name_en TEXT NOT NULL,
  name_te TEXT,
  name_hi TEXT,
  desc_en TEXT,
  desc_te TEXT,
  desc_hi TEXT,
  image_url TEXT,
  is_veg INTEGER DEFAULT 1,
  price REAL NOT NULL,
  is_available INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_food_items_category ON food_items (category_id);

CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  name_en TEXT NOT NULL,
  name_te TEXT,
  name_hi TEXT,
  type TEXT NOT NULL CHECK (type IN ('checkbox', 'number')),
  unit_price REAL NOT NULL,
  default_quantity INTEGER DEFAULT 1,
  is_available INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  quote_number TEXT UNIQUE NOT NULL,
  user_id TEXT REFERENCES users (id),
  customer_name TEXT,
  customer_phone TEXT,
  event_type TEXT NOT NULL,
  custom_event_type TEXT,
  event_date TEXT NOT NULL,
  guests INTEGER NOT NULL,
  venue_address TEXT NOT NULL,
  landmark TEXT,
  city TEXT NOT NULL,
  district TEXT,
  state TEXT,
  pincode TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'completed', 'cancelled')),
  food_total REAL NOT NULL,
  services_total REAL NOT NULL,
  transport_total REAL NOT NULL,
  service_charge REAL NOT NULL,
  gst_amount REAL NOT NULL,
  grand_total REAL NOT NULL,
  tax_rate REAL,
  service_charge_rate REAL,
  notes TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings (user_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings (status);
CREATE INDEX IF NOT EXISTS idx_bookings_event_date ON bookings (event_date);

CREATE TABLE IF NOT EXISTS booking_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id TEXT NOT NULL REFERENCES bookings (id),
  item_id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  unit_price REAL NOT NULL,
  qty_is_guests INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_booking_items_booking ON booking_items (booking_id);

CREATE TABLE IF NOT EXISTS booking_services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id TEXT NOT NULL REFERENCES bookings (id),
  service_id TEXT NOT NULL,
  service_name TEXT NOT NULL,
  unit_price REAL NOT NULL,
  quantity INTEGER NOT NULL,
  total REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_booking_services_booking ON booking_services (booking_id);

CREATE TABLE IF NOT EXISTS inquiries (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users (id),
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  event_type TEXT,
  event_date TEXT,
  guests INTEGER,
  message TEXT,
  booking_id TEXT REFERENCES bookings (id),
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'contacted', 'closed')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inquiries_status ON inquiries (status);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users (id),
  user_name TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  event_type TEXT,
  comment TEXT NOT NULL,
  verified INTEGER DEFAULT 0,
  owner_reply TEXT,
  is_visible INTEGER DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  recipient TEXT NOT NULL,
  subject TEXT,
  body TEXT NOT NULL,
  related_type TEXT,
  related_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed')),
  error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON notifications_outbox (status);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs (created_at);

-- Admin-uploaded item images, stored as BLOBs so they persist in every
-- environment (the old disk-based uploads were wiped with /tmp on Vercel).
-- id is the stored filename (<uuid>.<ext>); the image is served by
-- GET /api/uploads/:name, which looks the row up by that name.
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL
);
`;

// Fallback values used when a setting has never been seeded. The seed writes
// the real business values; these only keep pricing/validation working on a
// bare database (e.g. before the first seed run).
const DEFAULT_SETTINGS = {
  businessName: 'Sai Jyothsna Caterers & Suppliers',
  ownerName: 'Santosh Kumar',
  phone: '9700873454',
  email: 'pottahindu@gmail.com',
  whatsapp: '919700873454',
  address: 'D.No. 6-15-3/1, Beside Sarvakamadamba Park, Opp. BSNL Office, Woodpeta, Anakapalle, Andhra Pradesh - 531001',
  gstNumber: '36AAAAA1111A1Z1',
  taxRate: 5,
  serviceChargeRate: 5,
  defaultTransportPrice: 1500,
  minGuestsForBooking: 20,
  adminEmail: 'pottahindu@gmail.com',
  adminWhatsapp: '919700873454'
};

function defaultDbPath() {
  if (process.env.DB_PATH) return process.env.DB_PATH;
  // On Vercel only /tmp is writable, and it is ephemeral per instance: the
  // database is created + auto-seeded there on cold start (see api/index.js
  // and server/app.js). Data resets when the instance is recycled.
  if (process.env.VERCEL === '1') {
    return path.join(os.tmpdir(), 'sai-jyothsna.db');
  }
  return path.join(__dirname, '..', 'data', 'sai-jyothsna.db');
}

/**
 * Decide which backend to use. Precedence:
 *   1. An explicit dbPath argument (tests + CLI tools always pass one).
 *   2. TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN), except in tests.
 *   3. The local default path (/tmp on Vercel, data/ locally).
 */
function resolveBackend(dbPath) {
  if (dbPath) {
    return { mode: 'local', url: 'file:' + path.resolve(dbPath), filePath: path.resolve(dbPath) };
  }
  if (process.env.TURSO_DATABASE_URL && process.env.NODE_ENV !== 'test') {
    return {
      mode: 'turso',
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN || undefined
    };
  }
  const filePath = defaultDbPath();
  const mode = process.env.VERCEL === '1' ? 'ephemeral' : 'local';
  return { mode, url: 'file:' + filePath, filePath };
}

/** Coerce JS values into the shapes libsql accepts (booleans -> 1/0). */
function coerceArgs(args) {
  return args.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v));
}

/**
 * Build the app's database handle around one libsql client. Every method
 * is async and goes through client.execute() (or client.batch() /
 * client.executeMultiple() for multi-statement work).
 */
function createDbHandle(client, mode) {
  const isEphemeral = mode === 'ephemeral';
  return {
    /** Raw libsql client, for the rare call that needs it directly. */
    client,
    /** 'turso' | 'local' | 'ephemeral'. */
    mode,
    /** False only for the Vercel-without-Turso /tmp fallback. */
    isPersistent: !isEphemeral,
    isEphemeral,

    /**
     * Prepared-statement surface (node:sqlite-shaped, async). Each call
     * runs one client.execute() with positional `?` parameters.
     */
    prepare(sql) {
      return {
        get: async (...args) => {
          const r = await client.execute({ sql, args: coerceArgs(args) });
          return r.rows[0];
        },
        all: async (...args) => {
          const r = await client.execute({ sql, args: coerceArgs(args) });
          return r.rows;
        },
        run: async (...args) => {
          const r = await client.execute({ sql, args: coerceArgs(args) });
          return {
            changes: Number(r.rowsAffected ?? 0),
            // libsql returns lastInsertRowid as a bigint (or undefined).
            lastInsertRowid: r.lastInsertRowid == null ? undefined : Number(r.lastInsertRowid)
          };
        }
      };
    },

    /** Run a statement, or several (schema). Returns the raw result. */
    exec: async (sql) => client.executeMultiple(sql),

    /** Direct execute() passthrough (kept for callers that need raw rows). */
    execute: (...args) => client.execute(...args),

    /**
     * Run several statements atomically in a single transaction (one
     * round trip to Turso). `statements` is an array of { sql, args }.
     * This replaces the old BEGIN IMMEDIATE / COMMIT / ROLLBACK dance.
     */
    batch: async (statements) => client.batch(
      statements.map((s) => ({ sql: s.sql, args: coerceArgs(s.args || []) }))
    ),

    close: () => {
      try { client.close(); } catch { /* already closed */ }
    }
  };
}

/** Open the database (creating + migrating it) and return the handle. */
async function openDb(dbPath) {
  const backend = resolveBackend(dbPath);
  if (backend.filePath) {
    fs.mkdirSync(path.dirname(backend.filePath), { recursive: true });
  }
  const client = createClient(
    backend.authToken
      ? { url: backend.url, authToken: backend.authToken }
      : { url: backend.url }
  );
  const db = createDbHandle(client, backend.mode);
  // Foreign-key enforcement only sticks on a persistent connection (the
  // local file client); remote Turso connections are stateless HTTP, so
  // the PRAGMA is a no-op there. The app enforces referential rules in
  // code (e.g. the category-in-use check), so this is not load-bearing.
  if (backend.mode !== 'turso') {
    await client.execute('PRAGMA foreign_keys = ON');
  }
  await db.exec(SCHEMA);
  await migrate(db);
  return db;
}

/**
 * Lightweight migrations for databases created before a schema change.
 * (CREATE TABLE IF NOT EXISTS never alters an existing table, so a column
 * added later must be added explicitly.)
 *
 *   1. password_resets.expires_at was missing from the schema for a short
 *      window during the libsql conversion — add it to any database
 *      created then, and drop any rows left without an expiry (none can
 *      exist in practice: the INSERT always sets it, so a NULL row could
 *      only come from that window).
 *   2. Email/password + Google login: users.phone must become nullable
 *      (those accounts are created without a phone) and the users table
 *      gains email / password_hash / google_id / auth_provider. SQLite
 *      cannot drop NOT NULL from a column in place, so a database whose
 *      users.phone is still NOT NULL gets the standard table rebuild
 *      (create users_new, copy the old columns, drop, rename) with
 *      foreign keys disabled during the swap (SQLite's documented
 *      procedure — bookings/inquiries/reviews reference users). On Turso
 *      foreign keys are not enforced, so the PRAGMAs are skipped there.
 *      The new columns are then added individually if still missing.
 */
async function migrate(db) {
  const cols = await db.prepare('PRAGMA table_info(password_resets)').all();
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('expires_at')) {
    await db.prepare('ALTER TABLE password_resets ADD COLUMN expires_at TEXT').run();
    await db.prepare('DELETE FROM password_resets WHERE expires_at IS NULL').run();
  }

  const userCols = await db.prepare('PRAGMA table_info(users)').all();
  const userNames = new Set(userCols.map((c) => c.name));
  const phoneCol = userCols.find((c) => c.name === 'phone');
  if (phoneCol && phoneCol.notnull === 1) {
    const isTurso = db.mode === 'turso';
    if (!isTurso) await db.prepare('PRAGMA foreign_keys = OFF').run();
    try {
      await db.exec(`
        CREATE TABLE users_new (
          id TEXT PRIMARY KEY,
          phone TEXT UNIQUE,
          name TEXT,
          language TEXT DEFAULT 'en',
          email TEXT UNIQUE,
          password_hash TEXT,
          google_id TEXT UNIQUE,
          auth_provider TEXT DEFAULT 'otp'
            CHECK (auth_provider IN ('password', 'google', 'otp')),
          created_at TEXT NOT NULL
        );
        INSERT INTO users_new (id, phone, name, language, created_at)
          SELECT id, phone, name, language, created_at FROM users;
        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;
      `);
    } finally {
      if (!isTurso) await db.prepare('PRAGMA foreign_keys = ON').run();
    }
    // Re-read: the rebuild already added the new columns.
    const rebuilt = await db.prepare('PRAGMA table_info(users)').all();
    for (const c of rebuilt) userNames.add(c.name);
  }
  const newUserColumns = [
    ['email', 'ALTER TABLE users ADD COLUMN email TEXT UNIQUE'],
    ['password_hash', 'ALTER TABLE users ADD COLUMN password_hash TEXT'],
    ['google_id', 'ALTER TABLE users ADD COLUMN google_id TEXT UNIQUE'],
    ['auth_provider', "ALTER TABLE users ADD COLUMN auth_provider TEXT DEFAULT 'otp'"]
  ];
  for (const [name, sql] of newUserColumns) {
    if (!userNames.has(name)) {
      await db.prepare(sql).run();
    }
  }

  // Admin brute-force protection columns (added 2026-11-24).
  const adminCols = await db.prepare('PRAGMA table_info(admin_users)').all();
  const adminNames = new Set(adminCols.map((c) => c.name));
  const newAdminColumns = [
    ['failed_attempts', 'ALTER TABLE admin_users ADD COLUMN failed_attempts INTEGER DEFAULT 0'],
    ['locked_until', 'ALTER TABLE admin_users ADD COLUMN locked_until TEXT']
  ];
  for (const [name, sql] of newAdminColumns) {
    if (!adminNames.has(name)) {
      await db.prepare(sql).run();
    }
  }
}

function nowIso() {
  return new Date().toISOString();
}

/** Read one setting (JSON-decoded), falling back to the built-in default. */
async function getSetting(db, key, fallback) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) {
    if (fallback !== undefined) return fallback;
    return DEFAULT_SETTINGS[key];
  }
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

/** Write one setting (JSON-encoded). */
async function setSetting(db, key, value) {
  await db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
    key,
    JSON.stringify(value)
  );
}

/** All settings as a plain object, defaults merged underneath stored values. */
async function getAllSettings(db) {
  const settings = { ...DEFAULT_SETTINGS };
  const rows = await db.prepare('SELECT key, value FROM settings').all();
  for (const row of rows) {
    try {
      settings[row.key] = JSON.parse(row.value);
    } catch {
      settings[row.key] = row.value;
    }
  }
  return settings;
}

module.exports = {
  SCHEMA,
  DEFAULT_SETTINGS,
  defaultDbPath,
  resolveBackend,
  openDb,
  nowIso,
  getSetting,
  setSetting,
  getAllSettings
};
