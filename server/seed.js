// seed.js — idempotent seed: migrates ALL of the original project's default
// data (from `sai jyothsna/database.js`) into SQLite.
//
//   * 13 DEFAULT_CATEGORIES, 15 DEFAULT_FOOD_ITEMS, 13 DEFAULT_SERVICES,
//     3 DEFAULT_REVIEWS, DEFAULT_BUSINESS_INFO — copied exactly, with the
//     source ids preserved (cat_breakfast, dish_idly, srv_transport, rev_1…).
//   * nameKey/descKey values are resolved to en/te/hi text by require()ing
//     the project's own public/js/translations.js (single source of truth).
//     A missing te/hi key falls back to the English text — never
//     hand-translated.
//   * Services take default_quantity from the source `quantity` field
//     (serving_staff 2, cleaning 1, cooking 1, dining_tables 5,
//     premium_chairs 50); checkbox services default to 1.
//   * Reviews keep their source created_at and owner_reply, with
//     user_id NULL, verified = 1, is_visible = 1.
//   * Settings are inserted only when absent (INSERT OR IGNORE), so an admin's
//     later changes are never overwritten by a re-seed.
//   * First-run admin comes from ADMIN_EMAIL / ADMIN_PASSWORD env vars
//     (defaults admin@saijyothsna.local / ChangeMe123!), bcrypt cost 12,
//     must_change_password = 1. Created only if no admin with that email
//     exists yet. Its id is DETERMINISTIC (SHA-256 of the email, formatted
//     as a UUID) — deliberately, so the same seeded admin row exists on
//     every Vercel serverless instance and admin sessions (stateless,
//     signed tokens carrying the admin id) work across instances.
//   * ONE deliberate data repair: the source image URL
//     photo-1601050690597 (Gobi Manchurian, Hot Sambar Rice) returns 404
//     from Unsplash, so those two items use the fallback image URL the
//     original app itself used (photo-1546069901, its onerror fallback).
//     Everything else is copied exactly.
//
// Runnable standalone (`npm run seed`) and automatically on server startup
// via createApp(). Logs the counts it inserted.
'use strict';

// Load .env first so ADMIN_EMAIL / ADMIN_PASSWORD are visible to the seed.
require('./env').loadEnvFile();

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { openDb, nowIso } = require('./db');

// UMD export of the frontend translations dictionary — the same file the
// browser loads, so seed text can never drift from the UI text.
const TRANSLATIONS = require('../public/js/translations.js');

function t(key, lang) {
  const dict = TRANSLATIONS[lang] || {};
  return dict[key] || TRANSLATIONS.en[key] || key;
}

// ---------------------------------------------------------------------------
// Source data — copied verbatim from `sai jyothsna/database.js`
// (DEFAULT_CATEGORIES / DEFAULT_FOOD_ITEMS / DEFAULT_SERVICES /
// DEFAULT_BUSINESS_INFO / DEFAULT_REVIEWS). Counts verified by hand:
// 13 categories, 15 food items, 13 services, 3 reviews.
// ---------------------------------------------------------------------------

const DEFAULT_CATEGORIES = [
  { id: 'cat_breakfast', nameKey: 'cat_breakfast', orderIndex: 1 },
  { id: 'cat_starters', nameKey: 'cat_starters', orderIndex: 2 },
  { id: 'cat_south_indian', nameKey: 'cat_south_indian', orderIndex: 3 },
  { id: 'cat_north_indian', nameKey: 'cat_north_indian', orderIndex: 4 },
  { id: 'cat_chinese', nameKey: 'cat_chinese', orderIndex: 5 },
  { id: 'cat_biryani', nameKey: 'cat_biryani', orderIndex: 6 },
  { id: 'cat_curries', nameKey: 'cat_curries', orderIndex: 7 },
  { id: 'cat_sweets', nameKey: 'cat_sweets', orderIndex: 8 },
  { id: 'cat_desserts', nameKey: 'cat_desserts', orderIndex: 9 },
  { id: 'cat_beverages', nameKey: 'cat_beverages', orderIndex: 10 },
  { id: 'cat_live_counters', nameKey: 'cat_live_counters', orderIndex: 11 },
  { id: 'cat_pickles_papads', nameKey: 'cat_pickles_papads', orderIndex: 12 },
  { id: 'cat_special_items', nameKey: 'cat_special_items', orderIndex: 13 }
];

const DEFAULT_FOOD_ITEMS = [
  { id: 'dish_idly', categoryId: 'cat_breakfast', nameKey: 'dish_idly_name', descKey: 'dish_idly_desc', image: 'https://images.unsplash.com/photo-1668236543090-82eba5ee5976?auto=format&fit=crop&q=80&w=400', isVeg: true, price: 60, isAvailable: true },
  { id: 'dish_vada', categoryId: 'cat_breakfast', nameKey: 'dish_vada_name', descKey: 'dish_vada_desc', image: 'https://images.unsplash.com/photo-1589301760014-d929f3979dbc?auto=format&fit=crop&q=80&w=400', isVeg: true, price: 70, isAvailable: true },
  { id: 'dish_dosa', categoryId: 'cat_breakfast', nameKey: 'dish_dosa_name', descKey: 'dish_dosa_desc', image: 'https://images.unsplash.com/photo-1668236543090-82eba5ee5976?auto=format&fit=crop&q=80&w=400', isVeg: true, price: 80, isAvailable: true },
  { id: 'dish_poori', categoryId: 'cat_breakfast', nameKey: 'dish_poori_name', descKey: 'dish_poori_desc', image: 'https://images.unsplash.com/photo-1589301760014-d929f3979dbc?auto=format&fit=crop&q=80&w=400', isVeg: true, price: 90, isAvailable: true },
  { id: 'dish_paneer_tikka', categoryId: 'cat_starters', nameKey: 'dish_paneer_tikka_name', descKey: 'dish_paneer_tikka_desc', image: 'https://images.unsplash.com/photo-1567188040759-fb8a883dc6d8?auto=format&fit=crop&q=80&w=400', isVeg: true, price: 180, isAvailable: true },
  { id: 'dish_gobi_manchurian', categoryId: 'cat_starters', nameKey: 'dish_gobi_manchurian_name', descKey: 'dish_gobi_manchurian_desc', image: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&q=80&w=400', isVeg: true, price: 150, isAvailable: true },
  { id: 'dish_chicken_tikka', categoryId: 'cat_starters', nameKey: 'dish_chicken_tikka_name', descKey: 'dish_chicken_tikka_desc', image: 'https://images.unsplash.com/photo-1599487488170-d11ec9c172f0?auto=format&fit=crop&q=80&w=400', isVeg: false, price: 220, isAvailable: true },
  { id: 'dish_bagara_rice', categoryId: 'cat_south_indian', nameKey: 'dish_bagara_rice_name', descKey: 'dish_bagara_rice_desc', image: 'https://images.unsplash.com/photo-1626132647523-66f5bf380027?auto=format&fit=crop&q=80&w=400', isVeg: true, price: 120, isAvailable: true },
  { id: 'dish_sambar_rice', categoryId: 'cat_south_indian', nameKey: 'dish_sambar_rice_name', descKey: 'dish_sambar_rice_desc', image: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&q=80&w=400', isVeg: true, price: 100, isAvailable: true },
  { id: 'dish_paneer_masala', categoryId: 'cat_north_indian', nameKey: 'dish_paneer_masala_name', descKey: 'dish_paneer_masala_desc', image: 'https://images.unsplash.com/photo-1631452180519-c014fe946bc7?auto=format&fit=crop&q=80&w=400', isVeg: true, price: 180, isAvailable: true },
  { id: 'dish_roti', categoryId: 'cat_north_indian', nameKey: 'dish_roti_name', descKey: 'dish_roti_desc', image: 'https://images.unsplash.com/photo-1505253716362-afaea1d3d1af?auto=format&fit=crop&q=80&w=400', isVeg: true, price: 25, isAvailable: true },
  { id: 'dish_veg_biryani', categoryId: 'cat_biryani', nameKey: 'dish_veg_biryani_name', descKey: 'dish_veg_biryani_desc', image: 'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?auto=format&fit=crop&q=80&w=400', isVeg: true, price: 160, isAvailable: true },
  { id: 'dish_chicken_biryani', categoryId: 'cat_biryani', nameKey: 'dish_chicken_biryani_name', descKey: 'dish_chicken_biryani_desc', image: 'https://images.unsplash.com/photo-1633945274405-b6c8069047b0?auto=format&fit=crop&q=80&w=400', isVeg: false, price: 240, isAvailable: true },
  { id: 'dish_gulab_jamun', categoryId: 'cat_sweets', nameKey: 'dish_gulab_jamun_name', descKey: 'dish_gulab_jamun_desc', image: 'https://images.unsplash.com/photo-1589301760014-d929f3979dbc?auto=format&fit=crop&q=80&w=400', isVeg: true, price: 50, isAvailable: true },
  { id: 'dish_double_ka_meetha', categoryId: 'cat_sweets', nameKey: 'dish_double_ka_meetha_name', descKey: 'dish_double_ka_meetha_desc', image: 'https://images.unsplash.com/photo-1589301760014-d929f3979dbc?auto=format&fit=crop&q=80&w=400', isVeg: true, price: 60, isAvailable: true }
];

const DEFAULT_SERVICES = [
  { id: 'srv_transport', nameKey: 'srv_transport', type: 'checkbox', unitPrice: 1500, isAvailable: true },
  { id: 'srv_serving_staff', nameKey: 'srv_serving_staff', type: 'number', unitPrice: 800, isAvailable: true, quantity: 2 },
  { id: 'srv_cleaning_staff', nameKey: 'srv_cleaning_staff', type: 'number', unitPrice: 600, isAvailable: true, quantity: 1 },
  { id: 'srv_cooking_staff', nameKey: 'srv_cooking_staff', type: 'number', unitPrice: 1500, isAvailable: true, quantity: 1 },
  { id: 'srv_dining_tables', nameKey: 'srv_dining_tables', type: 'number', unitPrice: 150, isAvailable: true, quantity: 5 },
  { id: 'srv_premium_chairs', nameKey: 'srv_premium_chairs', type: 'number', unitPrice: 15, isAvailable: true, quantity: 50 },
  { id: 'srv_stage_decoration', nameKey: 'srv_stage_decoration', type: 'checkbox', unitPrice: 15000, isAvailable: true },
  { id: 'srv_traditional_decor', nameKey: 'srv_traditional_decor', type: 'checkbox', unitPrice: 8000, isAvailable: true },
  { id: 'srv_steel_plates', nameKey: 'srv_steel_plates', type: 'checkbox', unitPrice: 20, isAvailable: true },
  { id: 'srv_banana_leaves', nameKey: 'srv_banana_leaves', type: 'checkbox', unitPrice: 15, isAvailable: true },
  { id: 'srv_mineral_water', nameKey: 'srv_mineral_water', type: 'checkbox', unitPrice: 30, isAvailable: true },
  { id: 'srv_welcome_drinks', nameKey: 'srv_welcome_drinks', type: 'checkbox', unitPrice: 40, isAvailable: true },
  { id: 'srv_live_counter', nameKey: 'srv_live_counter', type: 'checkbox', unitPrice: 5000, isAvailable: true }
];

const DEFAULT_REVIEWS = [
  {
    id: 'rev_1',
    userName: 'Rajesh Sharma',
    rating: 5,
    eventType: 'fn_marriage',
    comment: "Exceptional catering service for my daughter's wedding! The Paneer Tikka and Hyderabadi Chicken Biryani were praised by all guests. Highly recommended!",
    verified: true,
    createdAt: '2026-06-15T10:30:00.000Z',
    ownerReply: "Thank you Rajesh Ji for your wonderful review! It was an honor to cater your daughter's grand event."
  },
  {
    id: 'rev_2',
    userName: 'Srinivas Rao',
    rating: 5,
    eventType: 'fn_housewarming',
    comment: 'Authentic South Indian taste! Idly, Sambar Rice and Gulab Jamun were super fresh. Clean service staff as well.',
    verified: true,
    createdAt: '2026-07-02T14:15:00.000Z',
    ownerReply: null
  },
  {
    id: 'rev_3',
    userName: 'Priya Verma',
    rating: 4,
    eventType: 'fn_birthday',
    comment: 'Great setup for our 50th birthday party. Guest count was 150 and food arrangements were smooth and timely.',
    verified: true,
    createdAt: '2026-07-20T18:45:00.000Z',
    ownerReply: null
  }
];

// Business settings from DEFAULT_BUSINESS_INFO, plus the admin contact keys
// (adminEmail / adminWhatsapp) which default to the business email/WhatsApp.
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

const DEFAULT_ADMIN_EMAIL = 'admin@saijyothsna.local';
const DEFAULT_ADMIN_PASSWORD = 'ChangeMe123!';

/**
 * Deterministic id for the seeded admin, derived from the email so every
 * database seeded with the same ADMIN_EMAIL has the same admin row. This
 * is what makes admin sessions work across Vercel serverless instances
 * (each instance seeds its own ephemeral /tmp database). The id is not a
 * secret — it is just a stable identifier.
 */
function seededAdminId(email) {
  const hash = crypto.createHash('sha256').update(`sai-jyothsna-admin:${email.toLowerCase()}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

async function seed(db, options = {}) {
  const log = options.log !== false;
  const counts = { categories: 0, foodItems: 0, services: 0, reviews: 0, settings: 0, admins: 0 };

  const insertCategory = db.prepare(
    `INSERT OR IGNORE INTO categories (id, name_en, name_te, name_hi, order_index, is_active)
     VALUES (?, ?, ?, ?, ?, 1)`
  );
  for (const cat of DEFAULT_CATEGORIES) {
    const r = await insertCategory.run(
      cat.id, t(cat.nameKey, 'en'), t(cat.nameKey, 'te'), t(cat.nameKey, 'hi'), cat.orderIndex
    );
    counts.categories += r.changes;
  }

  const insertItem = db.prepare(
    `INSERT OR IGNORE INTO food_items
       (id, category_id, name_en, name_te, name_hi, desc_en, desc_te, desc_hi,
        image_url, is_veg, price, is_available)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const item of DEFAULT_FOOD_ITEMS) {
    const r = await insertItem.run(
      item.id, item.categoryId,
      t(item.nameKey, 'en'), t(item.nameKey, 'te'), t(item.nameKey, 'hi'),
      t(item.descKey, 'en'), t(item.descKey, 'te'), t(item.descKey, 'hi'),
      item.image, item.isVeg ? 1 : 0, item.price, item.isAvailable ? 1 : 0
    );
    counts.foodItems += r.changes;
  }

  const insertService = db.prepare(
    `INSERT OR IGNORE INTO services
       (id, name_en, name_te, name_hi, type, unit_price, default_quantity, is_available)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const srv of DEFAULT_SERVICES) {
    const r = await insertService.run(
      srv.id,
      t(srv.nameKey, 'en'), t(srv.nameKey, 'te'), t(srv.nameKey, 'hi'),
      srv.type, srv.unitPrice,
      srv.quantity != null ? srv.quantity : 1,
      srv.isAvailable ? 1 : 0
    );
    counts.services += r.changes;
  }

  const insertReview = db.prepare(
    `INSERT OR IGNORE INTO reviews
       (id, user_id, user_name, rating, event_type, comment, verified, owner_reply, is_visible, created_at)
     VALUES (?, NULL, ?, ?, ?, ?, 1, ?, 1, ?)`
  );
  for (const rev of DEFAULT_REVIEWS) {
    const r = await insertReview.run(
      rev.id, rev.userName, rev.rating, rev.eventType, rev.comment, rev.ownerReply, rev.createdAt
    );
    counts.reviews += r.changes;
  }

  const insertSetting = db.prepare(
    'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
  );
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    const r = await insertSetting.run(key, JSON.stringify(value));
    counts.settings += r.changes;
  }

  // First-run admin (only when no admin with that email exists yet).
  const adminEmail = (options.adminEmail || process.env.ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL).toLowerCase();
  const adminPassword = options.adminPassword || process.env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
  const existing = await db.prepare('SELECT id FROM admin_users WHERE email = ?').get(adminEmail);
  if (!existing) {
    const passwordHash = bcrypt.hashSync(adminPassword, 12);
    // INSERT OR IGNORE, not a plain INSERT: several serverless instances
    // share one Turso database and can seed at the same time — two
    // instances can both pass the check above, and a plain INSERT would
    // then crash the loser with a UNIQUE constraint failure.
    const r = await db.prepare(
      `INSERT OR IGNORE INTO admin_users (id, email, password_hash, name, role, must_change_password, created_at)
       VALUES (?, ?, ?, ?, 'admin', 1, ?)`
    ).run(seededAdminId(adminEmail), adminEmail, passwordHash, 'Admin', nowIso());
    counts.admins += r.changes;
  }

  if (log) {
    console.log(
      `Seed complete: ${counts.categories} categories, ${counts.foodItems} food items, ` +
      `${counts.services} services, ${counts.reviews} reviews, ${counts.settings} settings, ` +
      `${counts.admins} admin(s) inserted.`
    );
  }
  return counts;
}

// Standalone runner: `npm run seed`
if (require.main === module) {
  (async () => {
    const db = await openDb();
    try {
      await seed(db);
    } finally {
      db.close();
    }
  })().catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
}

module.exports = {
  seed,
  seededAdminId,
  DEFAULT_CATEGORIES,
  DEFAULT_FOOD_ITEMS,
  DEFAULT_SERVICES,
  DEFAULT_REVIEWS,
  DEFAULT_SETTINGS,
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_PASSWORD
};
