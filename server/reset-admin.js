// reset-admin.js — CLI to reset (or create) an admin password.
//
// Usage:
//   npm run reset-admin
//   ADMIN_EMAIL=owner@example.com ADMIN_PASSWORD='NewPass123' npm run reset-admin
//   node server/reset-admin.js --email owner@example.com --password 'NewPass123'
//
// Without arguments it resets the default first-run admin
// (admin@saijyothsna.local). The admin must change the password again on
// next login (must_change_password = 1). This is the recovery path when
// SMTP is not configured and the forgot-password email cannot be sent.
'use strict';

// Load .env first so ADMIN_EMAIL / ADMIN_PASSWORD are visible below.
require('./env').loadEnvFile();

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { openDb, nowIso } = require('./db');
const { DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD } = require('./seed');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--email' && argv[i + 1]) args.email = argv[i + 1];
    if (argv[i] === '--password' && argv[i + 1]) args.password = argv[i + 1];
  }
  return args;
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const email = (cli.email || process.env.ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL).toLowerCase();
  const password = cli.password || process.env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;

  if (password.length < 8) {
    console.error('Error: password must be at least 8 characters.');
    process.exit(1);
  }

  const db = await openDb();
  try {
    const passwordHash = bcrypt.hashSync(password, 12);
    const existing = await db.prepare('SELECT id FROM admin_users WHERE email = ?').get(email);
    if (existing) {
      await db.prepare(
        'UPDATE admin_users SET password_hash = ?, must_change_password = 1 WHERE id = ?'
      ).run(passwordHash, existing.id);
      // NOTE: sessions are stateless signed tokens (see lib.js), so tokens
      // issued before this reset stay valid until their 8-hour expiry.
      console.log(`Admin password reset for ${email}. The admin must change it on next login.`);
    } else {
      await db.prepare(
        `INSERT INTO admin_users (id, email, password_hash, name, role, must_change_password, created_at)
         VALUES (?, ?, ?, ?, 'admin', 1, ?)`
      ).run(crypto.randomUUID(), email, passwordHash, 'Admin', nowIso());
      console.log(`Admin account created for ${email}. The admin must change the password on first login.`);
    }
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Admin reset failed:', err);
    process.exit(1);
  });
}

module.exports = { main };
