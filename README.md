# Sai Jyothsna Caterers & Suppliers — Web Application

A real full-stack catering web application, rebuilt from the original
mobile-style project (splash screen + 480px phone-frame shell) into a
responsive web app with a real database, real authentication, and a real
backend. No Firebase, no mock data, no mock OTP.

**Customers** browse the menu, build a cart, plan an event through a 5-step
booking wizard, and receive an automatic quotation computed server-side from
live database prices. They log in with a real mobile OTP, view their bookings
and quotations, write reviews, and contact the owner — inquiries are saved to
the database and forwarded to the owner's email / WhatsApp.

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

Requires **Node.js 24+** (uses the built-in `node:sqlite` module — no native
build tools needed).

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
npm test        # API test suite (node:test, 15 tests)
npm run seed    # Re-run the idempotent seed manually
npm run reset-admin   # Reset an admin password from the terminal
```

## First-run admin login

| Field | Value |
|---|---|
| URL | <http://localhost:3000/admin.html> |
| Email | `admin@saijyothsna.local` |
| Password | `ChangeMe123!` |

The seeded admin **must change this password on first login** — the portal
forces the change before showing the dashboard. Change the defaults with
`ADMIN_EMAIL` / `ADMIN_PASSWORD` in `.env` *before* the first start, or reset
later with:

```bash
ADMIN_EMAIL=owner@example.com ADMIN_PASSWORD='NewPass123' npm run reset-admin
# or: node server/reset-admin.js --email owner@example.com --password 'NewPass123'
```

## Configuration (`.env`)

Copy `.env.example` to `.env` and fill in values. The app reads `.env`
automatically (a small built-in loader in `server/env.js` — no dotenv
dependency). Real environment variables always win over `.env` values.

| Variable | Purpose |
|---|---|
| `PORT` | Port to listen on (default `3000`) |
| `NODE_ENV` | `development` / `production` / `test` |
| `DB_PATH` | SQLite file (default `data/sai-jyothsna.db`; on Vercel the DB lives in `/tmp` automatically — do not set `DB_PATH` there) |
| `SESSION_SECRET` | **Required on Vercel.** Secret for signing session cookies (see below) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | First-run admin (defaults above) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | SMTP for admin notification emails + admin password-reset emails |
| `MSG91_AUTH_KEY`, `MSG91_SENDER_ID`, `MSG91_TEMPLATE_ID` | MSG91 SMS for OTP delivery |
| `TWILIO_SID`, `TWILIO_TOKEN`, `TWILIO_FROM` | Twilio SMS for OTP delivery (used if MSG91 is not set) |
| `WHATSAPP_CLOUD_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp Cloud API for automatic owner notifications |

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

### OTP delivery — honest dev-mode note

The OTP flow itself is fully real in all cases: 6-digit codes are generated
with `crypto.randomInt`, bcrypt-hashed (cost 12), expire after 5 minutes,
allow at most 5 verify attempts, enforce a 60-second resend cooldown and a
5-per-hour limit per phone, and **no code is ever accepted without a hash
check** (there is no hardcoded or master code anywhere).

What depends on configuration is only *delivery*:

- **MSG91 or Twilio configured** → the code is sent by real SMS.
- **Neither configured** → the code is printed to the server console,
  clearly labelled `DEV ONLY — NO SMS PROVIDER CONFIGURED`, and the API
  reports `devMode: true`. This is for local development only — configure an
  SMS provider before going live.

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
- **Login** — mobile OTP (6-box input, timer, resend). Guest browsing is
  open; login is required only to book, review, or attach a booking to an
  inquiry.
- **My Bookings, Reviews, Profile/Settings** — bookings with status badges,
  review stats + write-a-review, profile and language settings.
- **Contact Owner** — inquiry form (modal + home section); on submit the
  inquiry is saved and the customer gets WhatsApp (prefilled full booking
  details), Call (`tel:`), and Email (`mailto:`) options.
- **i18n + dark mode** — EN / తెలుగు / हिन्दी switcher (338 en / 313 te /
  313 hi keys; missing keys fall back to English) and a dark-theme toggle.
  `localStorage` holds only the cart, language, and dark-mode preference —
  all business data comes from the API.

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
| Customer auth | `POST /api/auth/request-otp`, `POST /api/auth/verify-otp`, `GET /api/auth/me`, `POST /api/auth/logout` |
| Customer | `GET/PUT /api/profile`, `POST /api/bookings`, `GET /api/bookings[/:id]`, `GET /api/quotations/:id` (printable HTML), `POST /api/inquiries`, `POST /api/reviews`, `GET /api/reviews/mine` |
| Admin auth | `POST /api/admin/auth/login`, `POST /api/admin/auth/logout`, `GET /api/admin/auth/me`, `POST /api/admin/auth/change-password`, `POST /api/admin/auth/forgot-password`, `POST /api/admin/auth/reset-password` |
| Admin | `GET /api/admin/dashboard`, CRUD for categories / items / services (incl. `POST /api/admin/items/:id/image`), bookings list/detail/status, customers, inquiries, reviews, `GET/PUT /api/admin/settings`, admins, outbox (+ resend), audit logs |

Test-only: `GET /api/__test__/last-otp?phone=...` returns the latest code
**only when `NODE_ENV=test`** (404 otherwise; codes live in a test-mode
in-memory map, never in the database).

## Security

- `helmet` headers, JSON body limits, rate limits (stricter on auth
  endpoints), input validation on every endpoint, prepared statements
  everywhere (`node:sqlite`), bcrypt cost 12, `httpOnly` session cookies
  (stateless HMAC-SHA256-signed; see `SESSION_SECRET` above),
  CSRF double-submit on all mutations, upload type/size validation
  (jpg/jpeg/png/webp, ≤2MB) and strict filename sanitisation on
  `GET /api/uploads/:name` (path traversal rejected).
- Admin mutations are written to `audit_logs`.
- No secrets in code or examples, except the documented default admin
  password that must be changed on first login. `.env`, `data/*.db`, and
  `public/uploads/*` are gitignored.

## Project structure

```
.
├── package.json            # express, bcryptjs, helmet, express-rate-limit,
│                           # cookie-parser, multer, nodemailer (all pinned)
├── vercel.json             # /api/* -> api/index.js; maxDuration 10s
├── api/
│   └── index.js            # Vercel serverless entry (guarded lazy init)
├── Dockerfile              # stateful container; /app/data is a volume
├── .env.example            # every variable, documented
├── server/
│   ├── server.js           # local entry point (PORT or 3000)
│   ├── app.js              # createApp({ dbPath }) — also used by tests
│   ├── db.js               # schema + settings helpers (/tmp DB on Vercel)
│   ├── uploads.js          # upload storage + safe GET /api/uploads/:name
│   ├── seed.js             # idempotent seed (npm run seed)
│   ├── env.js              # dependency-free .env loader
│   ├── pricing.js          # quotation math (see Pricing semantics)
│   ├── sms.js              # MSG91 / Twilio / dev-log OTP delivery
│   ├── notify.js           # email + WhatsApp notifications + outbox
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
│   ├── assets/             # logo.jpg, banner1.jpg, banner2.jpg
│   └── uploads/            # admin-uploaded item images, local only
│                           # (served via GET /api/uploads/:name)
├── tests/api.test.js       # 15 API tests (node:test + node:http)
└── data/                   # sai-jyothsna.db (created + seeded on first run;
                            # on Vercel the DB lives in /tmp instead)
```

## Deployment

### Deploy to Vercel (demo)

The app is adapted for Vercel serverless (`api/index.js` + `vercel.json`,
Node `24.x`): the database is created and auto-seeded in `/tmp` on cold
start, sessions are stateless signed cookies, and uploads go to `/tmp`.

1. Push this repo to GitHub, then import it in the Vercel dashboard
   (**Add New → Project → Import**). No build command is needed; Vercel
   detects the Node project, serves `public/` statically, and runs
   `api/index.js` for `/api/*`.
2. Set the environment variable **`SESSION_SECRET`** (Project → Settings →
   Environment Variables). Generate a value with:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   Without it, logins break across serverless instances (each instance
   would sign with a different random secret).
3. Optional, as already documented above: `ADMIN_EMAIL` / `ADMIN_PASSWORD`
   (set **before the first deploy** if you want a different first-run
   admin), `MSG91_*` or `TWILIO_*` for real OTP SMS, `SMTP_*` for admin
   notification emails, `WHATSAPP_CLOUD_TOKEN` /
   `WHATSAPP_PHONE_NUMBER_ID` for automatic WhatsApp notifications.
4. Deploy. Every push to the connected branch auto-deploys.

**Honest ephemeral-data note — read this before relying on the Vercel
deployment.** Vercel has no persistent disk: the SQLite database lives in
`/tmp` and is **per serverless instance**, so bookings, inquiries,
customers, and admin changes (including price edits and uploaded images)
are stored temporarily and **may reset when the server restarts or a new
instance spins up**. The menu, prices, services, and reviews re-seed
automatically on every cold start, and the seeded admin account is the
same on every instance (deterministic id), so admin login always works —
but a customer who verified OTP on one instance may need to re-verify on
another, because their user row only exists in that instance's database.
The admin dashboard shows a dismissible amber notice saying exactly this
whenever the app runs on Vercel. Use the Vercel deployment as a **live
demo**; for the real business, deploy on a VPS (below) or connect a hosted
database.

### VPS / Docker (recommended for permanent storage)

This is a **stateful** app: the SQLite database lives in `data/*.db` and
uploaded images in `public/uploads/`. Deploy it where a persistent disk is
available and **back up `data/` regularly**.

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
npm test   # 15/15 passing
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
token does not load there, because the user row is instance-local).
