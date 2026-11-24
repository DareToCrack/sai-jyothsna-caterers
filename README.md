# Sai Jyothsna Caterers & Suppliers — Web Application

A real full-stack catering web application, rebuilt from the original
mobile-style project (splash screen + 480px phone-frame shell) into a
responsive web app with a real database, real authentication, and a real
backend. No Firebase, no mock data, no mock OTP.

**Customers** browse the menu, build a cart, plan an event through a 5-step
booking wizard, and receive an automatic quotation computed server-side from
live database prices. They log in free with **email + password** or **Google
Sign-In** (mobile OTP is an optional extra when an SMS/WhatsApp provider is
configured — see [Customer login](#customer-login)), view their bookings and
quotations, write reviews, and contact the owner — inquiries are saved to the
database and forwarded to the owner's email / WhatsApp.

**Admins** use a separate secure portal (`/admin.html`) to manage food items,
categories, prices, images, services, bookings, customers, inquiries,
reviews, business settings, other admins, the notification outbox, and the
audit log.

Design keeps the original emerald-green (`#0C3E26`) and gold (`#C5A059` /
`#E5C158`) identity, Playfair Display + Outfit typography, and trilingual
support (English / తెలుగు / हिन्दी). The layout is a real responsive web
layout — sticky header, hero, responsive grids — at desktop, tablet, and
mobile widths.

## Quick start

Requires **Node.js 24+**. The database is SQLite accessed through
`@libsql/client` — a local file database by default, or a hosted
[Turso](https://turso.tech) database when `TURSO_DATABASE_URL` is set (see
[Database](#database)).

```bash
npm install
npm start
```

Then open:

- Customer site: <http://localhost:3000>
- Admin portal: <http://localhost:3000/admin.html>

On first start the server creates `data/sai-jyothsna.db`, builds the schema,
and seeds it (see [Seed data](#seed-data)). No separate setup step is needed.

```bash
npm test        # API test suite (node:test, 27 tests)
npm run seed    # Re-run the idempotent seed manually
npm run reset-admin   # Reset an admin password from the terminal
```

**Handing the site to the business owner?** Give them
[`OWNER_SETUP.md`](OWNER_SETUP.md) — a plain-language guide to the free
sign-ups (Turso database, Google Sign-In, Gmail notifications) that turn
the demo into the real live site. OTP via MSG91/WhatsApp is optional —
customers can log in without it.

## First-run admin login

**Local development** (default, dev-only — never used in production):

| Field | Value |
|---|---|
| URL | <http://localhost:3000/admin.html> |
| Email | `admin@saijyothsna.local` |
| Password | `ChangeMe123!` |

**Production (Vercel): there is no default password.** The first-run admin
comes from the `ADMIN_EMAIL` / `ADMIN_PASSWORD` environment variables, which
must be set in Vercel **before the first deploy**. If `ADMIN_PASSWORD` is not
set, no admin account is created at all and the server logs a warning — a
hardcoded password in a public repo would let anyone log in to the live
admin portal. Change the local defaults with `ADMIN_EMAIL` /
`ADMIN_PASSWORD` in `.env` *before* the first start, or reset later with:

```bash
ADMIN_EMAIL=owner@example.com ADMIN_PASSWORD='NewPass123' npm run reset-admin
# or: node server/reset-admin.js --email owner@example.com --password 'NewPass123'
```

The seeded admin **must change this password on first login** — the portal
forces the change before showing the dashboard. An admin can change their
password at any time from the portal sidebar (Change Password) and their
email address from the sidebar too (Change Email — needs the current
password to confirm). Admins can also sign in with Google
("Continue with Google" on the login page): the Google account's email
must match an existing admin's email, and Google login never creates an
admin account. Every password field has an eye icon to show/hide what
you typed.

**Brute-force protection:** 5 wrong passwords lock an admin account for 15
minutes (the counter and lock live in the database, so they work across
serverless instances). Logins are also rate-limited (10 attempts per 15
minutes per IP). A locked account shows how long to wait; the lock clears
automatically, and a successful login resets the counter.

## Configuration (`.env`)

Copy `.env.example` to `.env` and fill in values. The app reads `.env`
automatically (a small built-in loader in `server/env.js` — no dotenv
dependency). Real environment variables always win over `.env` values.

| Variable | Purpose |
|---|---|
| `PORT` | Port to listen on (default `3000`) |
| `NODE_ENV` | `development` / `production` / `test` |
| `DB_PATH` | SQLite file (default `data/sai-jyothsna.db`; on Vercel the DB lives in `/tmp` automatically when Turso is not set — do not set `DB_PATH` there) |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | **Required on Vercel for a real live app.** Hosted Turso database (free tier) — without these the Vercel deployment is ephemeral demo mode (see [Database](#database)) |
| `CRON_SECRET` | Shared secret for the keep-alive cron endpoint; Vercel sets and sends this automatically when cron jobs are configured |
| `SESSION_SECRET` | **Required on Vercel.** Secret for signing session cookies (see below) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | First-run admin — **required on Vercel** (no default password in production); local default `admin@saijyothsna.local` / `ChangeMe123!` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | SMTP for admin notification emails + admin and customer password-reset emails |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Sign-In for customers (OAuth client from Google Cloud; see [Customer login](#customer-login)). Without these the Google button is hidden |
| `GOOGLE_REDIRECT_URI` | Override for the Google OAuth redirect URI (default: request origin + `/api/auth/google/callback`) |
| `MSG91_AUTH_KEY`, `MSG91_SENDER_ID`, `MSG91_TEMPLATE_ID` | MSG91 SMS for OTP delivery (first priority) — optional; only needed if the owner wants OTP login |
| `TWILIO_SID`, `TWILIO_TOKEN`, `TWILIO_FROM` | Twilio SMS for OTP delivery (second priority) — optional |
| `WHATSAPP_CLOUD_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp Cloud API for automatic owner notifications + WhatsApp OTP (third priority) |
| `WHATSAPP_OTP_TEMPLATE` | Name of the approved WhatsApp authentication template for OTPs (default `sjc_otp_code`) |

### SESSION_SECRET — required on Vercel

Sessions are stateless HMAC-SHA256-signed cookies (no database session
table), so every serverless instance must sign with the **same** secret —
otherwise a login on one instance is rejected on the next. Generate one and
set it as an environment variable (Vercel dashboard → Project → Settings →
Environment Variables, or `.env` locally):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

If `SESSION_SECRET` is unset, the server generates a random per-process
secret at boot and logs a warning. That is fine for local development
(sessions just don't survive a restart), but it **breaks logins on Vercel** —
set it before deploying.

Tradeoff of stateless sessions: logging out clears the cookies, but an
already-issued token stays cryptographically valid until its expiry
(7 days for customers, 8 hours for admins). Password changes and admin
deletion likewise cannot revoke issued tokens — though the server still
checks that the user/admin row exists in the current instance's database,
so a deleted admin's token stops working on instances whose database
reflects the deletion.

### Database

The database layer (`server/db.js`) is a single `@libsql/client` client
whose URL comes from the environment:

| Environment | Database | Persists? |
|---|---|---|
| `TURSO_DATABASE_URL` (+ `TURSO_AUTH_TOKEN`) set | Hosted Turso database (`libsql://…`) | Yes — this is the real live mode |
| Local dev / tests, Turso not set | Local file database (`data/sai-jyothsna.db`, or the path in `DB_PATH`) | Yes, on disk |
| Vercel, Turso not set | Ephemeral `/tmp` file database, auto-seeded per instance | **No — demo mode only** |

The tests never touch Turso even if the variables are set (`NODE_ENV=test`
forces the local file path). The schema, seed data, and deterministic admin
id are identical in all three modes, and the local file path uses exactly
the same client code as the remote path — so the test suite exercises the
same queries production runs.

**Uploaded images** are stored as BLOBs in the database (`uploads` table:
id, filename, mime, data, created_at) in all environments — there is no
disk-based upload path — and served via `GET /api/uploads/:name`. They
therefore persist wherever the database persists.

**Keep-alive.** Turso's free tier archives (puts to sleep) a database that
sees no activity for 10 days — data is not deleted, but the first request
afterwards is slow until it wakes. The app exposes
`GET /api/cron/keep-alive` (a trivial `SELECT 1`) and `vercel.json`
schedules it daily at 05:00 UTC, which keeps the database awake. If
`CRON_SECRET` is set, the endpoint requires
`Authorization: Bearer <CRON_SECRET>` (Vercel sends this automatically for
cron requests). Vercel hobby-plan cron limits: **at most once per day**
(a more frequent schedule fails deployment), the job fires at some point
within the scheduled hour (so the schedule uses minute `0`), times are
UTC, cron runs on production deployments only, and there are no retries —
daily is more than enough for the 10-day archive window.

> Note: Supabase announced the acquisition of Turso in October 2026;
> Turso states that its databases, APIs, and workflows continue as-is.

### Customer login

Customers log in free — no SMS provider is needed. Three methods,
reported by `GET /api/auth/methods` so the login view only shows the
ones that actually work:

1. **Email + password** — always available, no setup. Signup
   (`POST /api/auth/signup`) takes name, email, password, and
   confirmation; passwords must be at least 8 characters with an
   uppercase letter, a lowercase letter, and a number, and are
   bcrypt-hashed (cost 12). Login (`POST /api/auth/login`) returns the
   same generic "Invalid email or password" whether the email does not
   exist, the account is Google-only, or the password is wrong (no
   account enumeration). A forgot-password flow (`POST
   /api/auth/forgot-password`, `POST /api/auth/reset-password`) emails
   a single-use reset link (1-hour expiry, token stored hashed) and
   always returns the same generic success shape — it needs SMTP
   configured, and the forgot link is hidden otherwise.
2. **Google Sign-In** — shown when `GOOGLE_CLIENT_ID` is set. Standard
   OAuth 2.0 code flow (`GET /api/auth/google` →
   `GET /api/auth/google/callback`), plain `fetch`, no extra
   dependencies: a random state cookie is verified before the code is
   exchanged at `oauth2.googleapis.com/token`, the profile is read from
   Google's userinfo endpoint, and the account is matched by `google_id`
   first, then by email (linking the `google_id` to the existing
   account), then created. Setup: create an OAuth client ID in Google
   Cloud (web application), set the authorized redirect URI to
   `https://sai-jyothsna-caterers.vercel.app/api/auth/google/callback`
   (or `GOOGLE_REDIRECT_URI` to override), and set
   `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in Vercel (Production,
   Preview, Development). See `OWNER_SETUP.md` step 3.
3. **Mobile OTP** — optional, shown only when an SMS/WhatsApp provider
   is configured. The OTP flow itself is fully real in all cases:
   6-digit codes are generated with `crypto.randomInt`, bcrypt-hashed
   (cost 12), expire after 5 minutes, allow at most 5 verify attempts,
   enforce a 60-second resend cooldown and a 5-per-hour limit per phone,
   and **no code is ever accepted without a hash check** (there is no
   hardcoded or master code anywhere).

OTP *delivery* depends on configuration, in this priority order:

1. **MSG91** (`MSG91_AUTH_KEY` set) → real SMS.
2. **Twilio** (`TWILIO_SID` / `TWILIO_TOKEN` / `TWILIO_FROM` set) → real SMS.
3. **WhatsApp Cloud API** (`WHATSAPP_CLOUD_TOKEN` +
   `WHATSAPP_PHONE_NUMBER_ID` set) → the code is sent as a WhatsApp
   message using an approved **authentication template** (Meta requires
   OTPs to use this template category, not free text). The template name
   comes from `WHATSAPP_OTP_TEMPLATE` (default `sjc_otp_code`) — the
   owner must create and get this template approved in Meta's WhatsApp
   Manager first (see `OWNER_SETUP.md` step 5).
4. **None configured** → the code is printed to the server console,
   clearly labelled `DEV ONLY — NO SMS PROVIDER CONFIGURED`, and the API
   reports `devMode: true`. This is for local development only — and the
   OTP option is hidden from customers until a provider is configured,
   so nobody is ever stranded on a login that cannot deliver a code.

Phone numbers are normalized on both client and server: leading `+91`,
`91`, or `0` and any spaces are stripped, so `+91 98765 01234`,
`09876501234`, and `9876501234` are all the same customer. Email and
Google accounts are created without a phone (the `users.phone` column
is nullable; databases created before this change are migrated on
startup — see `server/db.js` `migrate()`); the customer enters a phone
at booking time if the business needs one.

### Notifications — honest outbox note

When a booking or inquiry is created, the server builds the complete details
message (customer, phone, event, venue, menu with prices, services, quotation
totals, quote number) and then:

1. **Email** — sent via SMTP to the admin email from Settings *if SMTP is
   configured*; otherwise the notification is recorded in the
   `notifications_outbox` table as `pending` and shown in the admin portal's
   Outbox, where it can be resent once SMTP is set up.
2. **WhatsApp** — the customer always receives a real `wa.me/<owner>` link
   with the full details prefilled (click-to-chat). If the WhatsApp Cloud API
   is configured, the message is *also* sent automatically.
3. A failed notification never fails the booking/inquiry request — the
   failure is recorded in the outbox and the request still succeeds.

Notification recipients (`adminEmail`, `adminWhatsapp`) are editable in the
admin portal under Settings; they default to the business email
`contact@saijyothsnacaterers.com` and WhatsApp `919848022338`.

## Pricing semantics

The quotation math preserves the original app's semantics exactly
(`app.js` in the original project). The server always computes from current
database prices — client-supplied prices are never trusted.

| Step | Rule |
|---|---|
| Food total | Σ `item.price × guests` over selected dishes |
| Services | `number` type: `unitPrice × quantity`; `checkbox` type: **flat** `unitPrice` (no per-guest multiplication — even per-plate-looking consumables such as steel plates, banana leaves, and mineral water are flat in the original code) |
| Transport | The `srv_transport` service is split out into its own total. If transport is selected but computes to ₹0, the default transport price from Settings (₹1500) is used instead |
| Service charge | `servicesTotal × serviceChargeRate` (5%) — charged on **services only**, not on food or transport |
| GST | `(foodTotal + servicesTotal + serviceCharge + transportTotal) × taxRate` (5%) |
| Grand total | `round(food + services + transport + serviceCharge + GST)` |

The tax and service-charge rates in effect at booking time are snapshotted
onto the booking, so later rate changes never rewrite old quotations.
Quote numbers are sequential per year: `SJC-2026-0001`, `SJC-2026-0002`, …

## Features

### Customer site (`/`, hash-routed SPA)

- **Home** — hero banner carousel, quick actions, featured categories,
  how-it-works, review preview, contact section.
- **Menu** — category sidebar (desktop) / tabs (mobile), search, veg /
  non-veg filter, dish cards with DB-driven prices, add-to-cart.
- **Cart** — selected dishes, guest count, services picker, live estimate
  (labelled as an estimate; the binding quotation is computed server-side).
- **Booking wizard** — 5 steps: function type (15 types + custom), date
  (min. tomorrow), guests (min. from Settings, default 20), venue address,
  services → server-side quotation.
- **Quotation** — receipt layout (grouped menu, services, full billing
  breakdown, quote number), Print / Save as PDF via `window.print` + print
  CSS, and a standalone printable page at `/api/quotations/:id`.
- **Login** — email + password (with signup and forgot-password flows),
  Google Sign-In, and mobile OTP (6-box input, timer, resend) when an
  SMS/WhatsApp provider is configured; the login view only shows the
  methods that work (`GET /api/auth/methods`). Guest browsing is open;
  login is required only to book, review, or attach a booking to an
  inquiry.
- **My Bookings, Reviews, Profile/Settings** — bookings with status badges,
  review stats + write-a-review, profile and language settings.
- **Contact Owner** — inquiry form (modal + home section); on submit the
  inquiry is saved and the customer gets WhatsApp (prefilled full booking
  details), Call (`tel:`), and Email (`mailto:`) options.
- **i18n + dark mode** — EN / తెలుగు / हिन्दी switcher (387 keys in each
  language, full parity — every label and placeholder is translated) and
  a dark-theme toggle. `localStorage` holds only the cart, language, and
  dark-mode preference — all business data comes from the API.

### Admin portal (`/admin.html`, separate login)

Sidebar sections: **Dashboard** (stat cards, recent bookings, pending
inquiries, monthly revenue, popular items, upcoming events), **Bookings**
(search / status / date filters, full quotation detail, status + notes),
**Menu Items** (thumbnails, search + category filter, add/edit with EN/TE/HI
names and descriptions, image upload ≤2MB or image URL), **Categories**,
**Services**, **Customers** (booking history), **Inquiries** (status workflow,
WhatsApp / Call / Email quick actions), **Reviews** (show/hide, owner reply),
**Settings** (business info, notification recipients, GST / service-charge /
transport / min-guests), **Admins** (add/remove; the last admin cannot be
deleted), **Outbox** (notification log + resend), **Audit Log**.

Admin login also has a working **forgot-password flow**: the emailed reset
link opens a reset form in the portal (single-use token, 1-hour expiry),
and the new password works immediately after.

The whole admin portal works in **English, हिन्दी and తెలుగు** too — a
language picker sits on the login card and in the top bar (410 keys in
each language, full parity). The language choice is shared with the
customer site (same `localStorage` key, `sjc_lang`), so picking Telugu
on one switches the other as well; English is the default and the
fallback for any missing phrase. Dish and category names are stored in
EN/TE/HI in the database and are managed from the Menu Items screen.

## Seed data

Migrated exactly from the original project's `database.js` (ids preserved),
with names/descriptions resolved from `translations.js` at seed time:

| Data | Count |
|---|---|
| Categories | 13 |
| Food items | 15 |
| Services | 13 |
| Reviews | 3 |
| Settings keys | 13 |
| First-run admin | 1 |

One deliberate data repair: the source image URL `photo-1601050690597`
(Gobi Manchurian, Hot Sambar Rice) returns **404 from Unsplash**, so those two
items use the fallback image URL the original app itself used as its `onerror`
fallback (`photo-1546069901`). Everything else is copied exactly. Dish images
also degrade gracefully in the UI: a failed image is replaced by a styled
placeholder instead of a broken-image icon.

The seeded admin's id is deterministic (SHA-256 of the admin email,
formatted as a UUID), so every freshly seeded database — including each
Vercel serverless instance's `/tmp` database — has the *same* admin row,
which is what lets admin sessions work across instances.

## API overview

JSON envelope: success `{ ok: true, ... }`, errors
`{ ok: false, error: "CODE", message: "..." }`. Sessions are `httpOnly`
cookies (`sjc_session` + a `sjc_csrf` double-submit token sent as the
`X-CSRF-Token` header on mutations). The session cookie holds a stateless
HMAC-SHA256-signed token (`base64url(payload).base64url(signature)`,
payload `{ t, id, exp, csrf }`) — no server-side session store, so auth
works across serverless instances sharing `SESSION_SECRET`. Customer
sessions last 7 days, admin sessions 8 hours.

| Area | Endpoints |
|---|---|
| Public | `GET /api/menu`, `GET /api/services`, `GET /api/business`, `GET /api/reviews`, `GET /api/uploads/:name` (uploaded item images) |
| Customer auth | `GET /api/auth/methods`, `POST /api/auth/signup`, `POST /api/auth/login`, `GET /api/auth/google`, `GET /api/auth/google/callback`, `POST /api/auth/forgot-password`, `POST /api/auth/reset-password`, `POST /api/auth/request-otp`, `POST /api/auth/verify-otp`, `GET /api/auth/me`, `POST /api/auth/logout` |
| Customer | `GET/PUT /api/profile`, `POST /api/bookings`, `GET /api/bookings[/:id]`, `GET /api/quotations/:id` (printable HTML), `POST /api/inquiries`, `POST /api/reviews`, `GET /api/reviews/mine` |
| Admin auth | `POST /api/admin/auth/login`, `POST /api/admin/auth/logout`, `GET /api/admin/auth/me`, `POST /api/admin/auth/change-password`, `POST /api/admin/auth/forgot-password`, `POST /api/admin/auth/reset-password` |
| Admin | `GET /api/admin/dashboard`, CRUD for categories / items / services (incl. `POST /api/admin/items/:id/image`), bookings list/detail/status, customers, inquiries, reviews, `GET/PUT /api/admin/settings`, admins, outbox (+ resend), audit logs |

Test-only: `GET /api/__test__/last-otp?phone=...` returns the latest code
and `GET /api/__test__/last-reset-token?email=...` returns the latest
password-reset token, **only when `NODE_ENV=test`** (404 otherwise; codes
and tokens live in test-mode in-memory maps, never in the database).

## Security

- `helmet` headers, JSON body limits, rate limits (stricter on auth
  endpoints), input validation on every endpoint, parameterised queries
  everywhere (`@libsql/client`), bcrypt cost 12, `httpOnly` session cookies
  (stateless HMAC-SHA256-signed; see `SESSION_SECRET` above),
  CSRF double-submit on all mutations, upload type/size validation
  (jpg/jpeg/png/webp, ≤2MB) and strict filename sanitisation on
  `GET /api/uploads/:name` (path traversal rejected).
- Admin mutations are written to `audit_logs` (with the acting admin's email).
- No secrets in code or examples, except the documented default admin
  password that must be changed on first login. `.env` and `data/*.db`
  are gitignored.

## Project structure

```
.
├── package.json            # express, bcryptjs, helmet, express-rate-limit,
│                           # cookie-parser, multer, nodemailer,
│                           # @libsql/client (all pinned)
├── vercel.json             # /api/* -> api/index.js; maxDuration 10s;
│                           # daily keep-alive cron (05:00 UTC)
├── api/
│   └── index.js            # Vercel serverless entry (guarded lazy init)
├── Dockerfile              # stateful container; /app/data is a volume
├── .env.example            # every variable, documented
├── OWNER_SETUP.md          # plain-language client handover guide
├── server/
│   ├── server.js           # local entry point (PORT or 3000)
│   ├── app.js              # createApp({ dbPath }) — also used by tests;
│   │                       # includes GET /api/cron/keep-alive
│   ├── db.js               # libsql client (Turso or local file), schema,
│   │                       # settings helpers, uploads BLOB table
│   ├── uploads.js          # BLOB upload storage + GET /api/uploads/:name
│   ├── seed.js             # idempotent seed (npm run seed)
│   ├── env.js              # dependency-free .env loader
│   ├── pricing.js          # quotation math (see Pricing semantics)
│   ├── sms.js              # MSG91 / Twilio / WhatsApp / dev-log OTP delivery
│   ├── notify.js           # email + WhatsApp notifications + outbox
│   │                       # (+ WhatsApp template sender, used for OTPs)
│   ├── quotation.js        # printable quotation HTML
│   ├── reset-admin.js      # npm run reset-admin
│   ├── lib.js              # envelope, validation, stateless sessions, CSRF, mappers
│   └── routes/             # public.js, auth.js, customer.js, admin.js
├── public/
│   ├── index.html          # customer SPA shell
│   ├── admin.html          # admin portal shell
│   ├── css/styles.css      # customer styles (emerald/gold, responsive)
│   ├── css/admin.css       # admin styles
│   ├── js/app.js           # customer SPA
│   ├── js/admin.js         # admin portal
│   ├── js/translations.js  # en/te/hi dictionary (also required by the seed)
│   └── assets/             # logo.jpg, banner1.jpg, banner2.jpg
├── tests/api.test.js       # 27 API tests (node:test + node:http)
└── data/                   # sai-jyothsna.db (created + seeded on first run;
                            # on Vercel the DB is Turso, or /tmp in demo mode)
```

## Deployment

### Deploy to Vercel (live, with Turso)

The app is adapted for Vercel serverless (`api/index.js` + `vercel.json`,
Node `24.x`): sessions are stateless signed cookies, uploaded images live
as BLOBs in the database, and the database is a hosted Turso database
when configured (free tier, no card).

1. Push this repo to GitHub, then import it in the Vercel dashboard
   (**Add New → Project → Import**). No build command is needed; Vercel
   detects the Node project, serves `public/` statically, and runs
   `api/index.js` for `/api/*`.
2. Set the environment variables (Project → Settings → Environment
   Variables):
   - **`SESSION_SECRET`** — generate with
     ```bash
     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
     ```
     Without it, logins break across serverless instances (each instance
     would sign with a different random secret).
   - **`TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`** — create a free
     database at [turso.tech](https://turso.tech) and copy its URL and
     auth token. Without these the deployment runs in **demo mode** (see
     below).
   - Optional, as already documented above: `ADMIN_EMAIL` /
     `ADMIN_PASSWORD` (set **before the first deploy** if you want a
     different first-run admin), `GOOGLE_CLIENT_ID` /
     `GOOGLE_CLIENT_SECRET` for Google Sign-In, `SMTP_*` for admin
     notification emails + password-reset emails, `MSG91_*` or
     `TWILIO_*` for real OTP SMS (optional — only if the owner wants
     OTP login), `WHATSAPP_*` for WhatsApp OTP + notifications.
3. Deploy. Every push to the connected branch auto-deploys. The daily
   keep-alive cron (05:00 UTC, see [Database](#database)) is configured
   in `vercel.json` and starts automatically; Vercel sets `CRON_SECRET`
   itself.

**Demo mode (Turso not configured).** Vercel has no persistent disk, so
without Turso the SQLite database lives in `/tmp` and is **per serverless
instance**: bookings, inquiries, customers, and admin changes (including
price edits and uploaded images) are stored temporarily and **may reset
when the server restarts or a new instance spins up**. The menu, prices,
services, and reviews re-seed automatically on every cold start, and the
seeded admin account is the same on every instance (deterministic id), so
admin login always works — but a customer who signed up or logged in on
one instance may need to log in again on another, because their user row
only exists in that instance's database. The admin dashboard shows a dismissible amber
notice saying exactly this whenever the app runs without a persistent
database (the notice is hidden once Turso is configured). Use demo mode
only for evaluation; for the real business, connect Turso (above) or
deploy on a VPS (below).

### VPS / Docker (alternative with permanent storage)

This is a **stateful** app: the SQLite database lives in `data/*.db`
(uploaded images are BLOBs inside it). Deploy it where a persistent disk is
available and **back up `data/` regularly**. Alternatively, point the VPS
at the same hosted Turso database with `TURSO_DATABASE_URL` /
`TURSO_AUTH_TOKEN` and the app becomes stateless.

Recommended: any small VPS with Node.js 24+.

```bash
# with pm2
npm install --omit=dev
pm2 start server/server.js --name sai-jyothsna
pm2 save

# or with systemd (run as a non-root user, WorkingDirectory=<project>)
# ExecStart=/usr/bin/node server/server.js
# EnvironmentFile=<project>/.env
```

Put it behind a reverse proxy (nginx/Caddy) for HTTPS, and set
`NODE_ENV=production` (this also turns on the `Secure` cookie flag — only
correct behind HTTPS).

**Docker:**

```bash
docker build -t sai-jyothsna .
docker run -d --name sai-jyothsna -p 3000:3000 \
  --env-file .env -v sai-jyothsna-data:/app/data sai-jyothsna
```

## Tests

```bash
npm test   # 27/27 passing
```

The suite starts the real server on an ephemeral port with a temporary
database and covers: OTP request + verify (via the test-only endpoint),
wrong/expired/reused code rejection, seeded menu counts, a booking whose
totals are hand-verified (food ₹30,000, services ₹1,600, transport ₹1,500,
service charge ₹80, GST ₹1,659, grand total ₹34,839), auth guards (401/403),
admin CRUD for items/categories/services, inquiry → outbox recording, GST
changes flowing into the next quotation, CSRF rejection, the printable
quotation page, image upload + serving via `GET /api/uploads/:name`
(incl. path-traversal rejection), and stateless sessions working across
two app instances sharing `SESSION_SECRET` (the Vercel serverless shape —
admin token issued by one instance verifies on the other; a customer
token does not load there, because the user row is instance-local — with
Turso configured, both instances share the same database, so customer
sessions work across instances too). Also covered: the keep-alive
endpoint (open without `CRON_SECRET`, bearer-protected with it), phone
normalization at the API level (`+91` / leading `0` accepted), past-date
inquiry rejection, admin emails on audit-log entries, and the WhatsApp
OTP template call (mocked Graph API). Also covered: the
`/api/auth/methods` endpoint reflecting configuration, email/password
signup validation + duplicate-email rejection, the login generic-error
rule (unknown email, wrong password, and Google-only accounts all get
the identical message), the Google OAuth callback with mocked token +
userinfo endpoints (user creation, same-user return, linking to an
existing email account, state mismatch, and denial), the customer
forgot/reset-password flow (generic success for unknown emails,
single-use tokens, old password invalidated), and the `openDb` migration
of a legacy `users` table (phone `NOT NULL`, no auth columns).

A separate Playwright QA pass (customer + admin suites, desktop 1440px
and mobile 390px, EN/TE/HI) lives in `~/workspace/sai-jyothsna-caterers/qa/`
with its report at
`~/workspace/sai-jyothsna-caterers/verification/qa-2026-11-21/QA-REPORT.md`.
