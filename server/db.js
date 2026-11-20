// db.js — SQLite database layer (Node.js v24 built-in node:sqlite, no native modules).
//
// The database file lives at DB_PATH, or — on Vercel (VERCEL=1, where only
// /tmp is writable and the filesystem is ephemeral per instance) — at
// <os.tmpdir()>/sai-jyothsna.db, or otherwise at
// <project>/data/sai-jyothsna.db. openDb() creates the parent directory and
// every table (CREATE TABLE IF NOT EXISTS), so a fresh checkout just works.
// All queries in the app use prepared statements; this module only exposes
// the raw DatabaseSync handle plus the settings helpers.
//
// NOTE: sessions are stateless HMAC-signed cookies (see lib.js) — there is
// deliberately no sessions table, so auth works across serverless instances
// that do not share a database.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  name TEXT,
  language TEXT DEFAULT 'en',
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
`;

// Fallback values used when a setting has never been seeded. The seed writes
// the real business values; these only keep pricing/validation working on a
// bare database (e.g. before the first seed run).
const DEFAULT_SETTINGS = {
  businessName: 'Sai Jyothsna Caterers & Suppliers',
  ownerName: 'Sai Jyothsna',
  phone: '9848022338',
  email: 'contact@saijyothsnacaterers.com',
  whatsapp: '919848022338',
  address: 'H.No. 4-12, Main Road, Hyderabad, Telangana - 500001',
  gstNumber: '36AAAAA1111A1Z1',
  taxRate: 5,
  serviceChargeRate: 5,
  defaultTransportPrice: 1500,
  minGuestsForBooking: 20,
  adminEmail: 'contact@saijyothsnacaterers.com',
  adminWhatsapp: '919848022338'
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

function openDb(dbPath) {
  const resolved = dbPath || defaultDbPath();
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new DatabaseSync(resolved);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

function nowIso() {
  return new Date().toISOString();
}

/** Read one setting (JSON-decoded), falling back to the built-in default. */
function getSetting(db, key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
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
function setSetting(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
    key,
    JSON.stringify(value)
  );
}

/** All settings as a plain object, defaults merged underneath stored values. */
function getAllSettings(db) {
  const settings = { ...DEFAULT_SETTINGS };
  const rows = db.prepare('SELECT key, value FROM settings').all();
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
  openDb,
  nowIso,
  getSetting,
  setSetting,
  getAllSettings
};
