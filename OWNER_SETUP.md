# Sai Jyothsna Caterers — Owner Setup Guide

**For the business owner. No technical knowledge needed.**

Your website is already live at **https://sai-jyothsna-caterers.vercel.app**
and your admin portal is at **https://sai-jyothsna-caterers.vercel.app/admin.html**

Right now the site works, but it is running in **demo mode**: bookings,
customer enquiries, and any menu or price changes you make in the admin
portal are **not saved permanently** — they disappear when the server
restarts. This guide walks you through the few free sign-ups that turn it
into a real, permanent business website. The whole thing takes about an
hour, spread over a few days (some registrations need approval).

**How customers log in:** with an email address and a password they choose
— that needs no setup from you at all — or with their Google account
(Step 3). Logging in with a mobile OTP is an *optional extra* (Steps 4–5):
customers never need it, so you can skip those steps entirely if you want.

> **You can ask your developer to do Steps 1–5 for you.** They need your
> login for each service while they set it up, and you should change your
> passwords afterwards. Step 6 (first admin login) and Step 7 (managing
> the menu) are yours either way.

---

## How the setup works (the one thing to understand)

The website runs on Vercel. Vercel needs a few **"environment variables"**
— think of them as secret keys the website reads when it starts: the
database address, the Google login keys, the email password. You paste
them once into the Vercel dashboard, and the site uses them forever after.

**To add a variable in Vercel:**

1. Log in at [vercel.com](https://vercel.com) → open the project
   **sai-jyothsna-caterers**.
2. Go to **Settings → Environment Variables**.
3. Type the **Name** (exactly as written in this guide, e.g.
   `TURSO_DATABASE_URL`), paste the **Value**, click **Add**.
4. After adding variables, go to **Deployments**, click the **⋯** menu on
   the latest deployment, and choose **Redeploy** so the site picks them up.

Nothing in this guide costs anything to sign up for, and with email +
Google login the website's running cost is **₹0 a month**. The only thing
that ever costs money is sending OTP text messages to customers — and that
is optional (see Step 8).

---

## Step 1 — Permanent database (Turso) — REQUIRED, free

This is the one step you **must** do: it makes bookings, enquiries,
customers, and price changes save permanently.

1. Go to [turso.tech](https://turso.tech) and sign up (you can sign in
   with GitHub — free, no card required).
2. Click **Create Database**. Give it a name like `sai-jyothsna`.
   Choose a location near India if asked (e.g. Mumbai).
3. On the database page, copy the **Database URL** — it looks like
   `libsql://sai-jyothsna-xxxx.turso.io`.
4. On the same page, create an **auth token** (look for "Tokens" or
   "Create Token") and copy it. It is a long string of letters and
   numbers — keep it private, like a password.
5. In Vercel (see "How the setup works" above), add two variables:
   - `TURSO_DATABASE_URL` = the database URL you copied
   - `TURSO_AUTH_TOKEN` = the auth token you copied
6. Redeploy the site.

**How to check it worked:** log in to the admin portal. Before this
step, the dashboard shows a yellow notice saying data is temporary.
After a successful setup and redeploy, **that notice is gone** — that
means the database is connected and everything now saves permanently.

> **Note:** Turso's free plan is generous (plenty of space and usage for
> a catering business). A free database that is not used for 10 days is
> "archived" (put to sleep — your data is NOT deleted, and it wakes up
> again when used). To prevent that, the website automatically pings the
> database once a day, so it stays awake on its own. You never need to
> think about this.

---

## Step 2 — Email notifications (Gmail) — RECOMMENDED, free

So that you receive an email with the full details every time a
customer books or sends an enquiry — and so that customers who forget
their password can receive a reset link. (Without this step, the
"Forgot password?" link is hidden from customers.)

1. Use any Gmail account (or create one for the business).
2. Turn on **2-Step Verification** for that Google account
   (Google Account → Security → 2-Step Verification).
3. Then create an **App password**: Google Account → Security →
   **App passwords** → choose "Mail" → Google shows a 16-character
   password. Copy it (spaces don't matter).
4. In Vercel, add:
   - `SMTP_HOST` = `smtp.gmail.com`
   - `SMTP_PORT` = `587`
   - `SMTP_USER` = your Gmail address
   - `SMTP_PASS` = the 16-character app password
   - `SMTP_FROM` = your Gmail address
5. Redeploy the site.

**Cost:** free (Gmail allows 500 emails a day — far more than a catering
business needs). The emails go to the admin email set in the admin
portal under **Settings** (currently `pottahindu@gmail.com` —
change it there if you want notifications at a different address).

> If you skip this step, notifications are not lost: they wait in the
> admin portal under **Outbox**, and you can resend them once email is
> set up. You also always get the WhatsApp link with the full details.

---

## Step 3 — Google Sign-In — RECOMMENDED, free

Lets customers log in with one tap using their Google account — no new
password to remember. (Customers can already log in with email +
password without this step; this just adds the easier Google button.)

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
   and sign in with a Google account. Create a **new project** (any
   name, e.g. `Sai Jyothsna Caterers`).
2. In the left menu, go to **APIs & Services → OAuth consent screen**.
   Choose **External** user type and fill in the app name, your support
   email, and your contact email. You do not need to add any special
   permissions (scopes) — the defaults are enough.
3. On the consent screen page, set the **publishing status to
   Production** (so that any customer can sign in, not just test users).
   No Google verification is needed for the basic sign-in this site uses.
4. In the left menu, go to **APIs & Services → Credentials** → **Create
   Credentials → OAuth client ID**. Choose **Web application** as the
   application type.
5. Under **Authorized redirect URIs**, click **Add URI** and paste
   exactly this (no trailing slash):
   `https://sai-jyothsna-caterers.vercel.app/api/auth/google/callback`
6. Click **Create**. Google shows a **Client ID** and a **Client
   secret** — copy both. Keep the secret private, like a password.
7. In Vercel, add:
   - `GOOGLE_CLIENT_ID` = the Client ID
   - `GOOGLE_CLIENT_SECRET` = the Client secret
8. Redeploy the site.

**How to check it worked:** open the website, click **Login**, and you
should see a **"Continue with Google"** button. (The button only appears
once these two variables are set.)

**Cost:** free — Google Sign-In has no charges.

---

## Step 4 — OTP text messages (MSG91) — OPTIONAL, free to start

Only needed if you want customers to also be able to log in with a
one-time code (OTP) sent to their mobile. **You can skip this entirely**
— email and Google login already work without it.

1. Sign up at [msg91.com](https://msg91.com) — you get **₹250 of free
   credit on signup** (roughly 1,400 OTP messages).
2. Complete **KYC** (identity verification — PAN / business details, as
   asked on the site).
3. Complete **DLT registration** — this is a TRAI rule for all SMS in
   India. MSG91 guides you through it: you register your business
   (entity), a **sender ID** (a 6-letter name customers see, e.g.
   `SAIJYO`), and an **OTP message template** (the wording of the SMS,
   with a placeholder for the code). Approval usually takes 1–3 days.
4. Once approved, find your **auth key** in the MSG91 dashboard and the
   **template ID** of your approved OTP template.
5. In Vercel, add:
   - `MSG91_AUTH_KEY` = your auth key
   - `MSG91_TEMPLATE_ID` = your template ID
   - `MSG91_SENDER_ID` = your sender ID (only if it is not `SAIJYO`)
6. Redeploy the site.

**How to check it worked:** open the website, click **Login**, and you
should see a **"Login with OTP"** button. (It only appears once a
provider is set up.)

**Cost:** after the free ₹250 credit runs out, each OTP costs about
**₹0.15**. For a small catering business (a few dozen logins a month),
the signup credit lasts roughly the first year.

---

## Step 5 — WhatsApp OTP (alternative to Step 4) — OPTIONAL

If you prefer, customers can receive their OTP on **WhatsApp** instead
of SMS. You only need **one** of Step 4 or Step 5 — MSG91 (Step 4) is
simpler and recommended. Do this step only if you specifically want
WhatsApp OTPs. (And like Step 4, you can skip both — email and Google
login already work.)

1. Go to [developers.facebook.com](https://developers.facebook.com),
   create a free developer account, and create an **app** with the
   **WhatsApp** product (WhatsApp Cloud API).
2. In the WhatsApp setup, note your **Phone Number ID** (shown in the
   API setup page).
3. Create a **permanent access token**: in Meta Business Settings,
   create a **System User** with WhatsApp permissions and generate a
   token for it. (The temporary token shown on the API setup page
   expires after 24 hours — do not use that one for a live site.)
4. Create the OTP message template: in **WhatsApp Manager → Message
   Templates**, create a template of category **Authentication** named
   exactly `sjc_otp_code`, with the body text
   `{{1}} is your verification code.` (Meta requires this exact style
   for OTP templates.) Submit it for approval — this usually takes a
   few hours to a day.
5. In Vercel, add:
   - `WHATSAPP_CLOUD_TOKEN` = your permanent token
   - `WHATSAPP_PHONE_NUMBER_ID` = your phone number ID
   - `WHATSAPP_OTP_TEMPLATE` = `sjc_otp_code`
6. Redeploy the site.

**Cost:** about **₹0.12 per OTP** delivered to India. There is no free
OTP tier on WhatsApp (since October 2026), so Step 4 (MSG91) is cheaper
to start with.

> The same WhatsApp connection also powers automatic WhatsApp
> notifications to you when a customer books or enquires. If you skip
> this step, you still get a tap-to-open WhatsApp link with the full
> booking details after every booking.

---

## Step 6 — First admin login (do this first, actually)

You can do this right now, before the other steps.

1. Open **https://sai-jyothsna-caterers.vercel.app/admin.html**
2. Log in with the **email and temporary password your developer gave
   you** (they are in the handover note, not written here — keep them
   private, like a bank password).
3. Right after logging in, change the temporary password to your own:
   click **Change Password** in the left menu, enter the temporary
   password, then your new password twice. Pick a strong one (at least
   8 characters, with a mix of letters and numbers) and keep it safe —
   this is the master key to your business website. (Every password
   box has a small eye icon on the right — tap it to see what you
   typed.)
4. **Signing in with Google:** once your admin email is your real
   email address (your developer sets this up for you), you can also
   sign in by clicking **Continue with Google** on the admin login
   page and choosing your Google account — no password needed. Only
   the Google account whose email matches your admin email can sign
   in this way.
5. **Changing your email:** if your email address ever changes, use
   **Change Email** in the left menu (you will need your current
   password to confirm). After that, sign in with the new email —
   and with Google, use the Google account of the new email.
4. If you ever forget the password, use the **"Forgot password?"** link
   on the login page (it emails a reset link — needs Step 2 to be set
   up), or ask your developer to reset it.

> **Locked out?** If you type the wrong password 5 times, the account
> locks for 15 minutes to stop strangers guessing it. Just wait — the
> lock clears by itself, and the login page tells you how long is left.
>
> You can add more admin accounts later from the portal itself
> (Admins section), so staff can help without sharing your password.

---

## Step 7 — Managing your menu and prices (daily use)

Everything is done in the admin portal — no code, no developer needed.

- **Menu Items:** add a dish, change its price, or hide it (toggle
  "Available" off) — changes show on the website immediately, and every
  new quotation uses the current price. You can upload a photo for a
  dish (JPG/PNG, up to 2 MB).
- **Categories:** add or rename food categories (e.g. "Starters").
- **Services:** add or change services (staff, decoration, transport…)
  and their prices.
- **Settings:** your business details, GST rate, service charge,
  default transport charge, and minimum guests — and the email/WhatsApp
  where you want booking notifications.
- **Bookings / Inquiries / Customers / Reviews:** see every booking
  with its full quotation, reply to reviews, and follow up enquiries.
  Every booking row has a **Delete** button — use it only for test,
  duplicate, or wrongly made bookings, because deleting is permanent.
  For a real booking the customer cancels, open it and change its
  status to **Cancelled** instead, so you keep the record.

**Important:** prices you change apply to *new* bookings only. Quotations
already issued to customers never change — the price at booking time is
locked in.

**Languages:** the website and the admin portal both work in **English,
हिन्दी and తెలుగు**. Customers pick their language from the buttons at
the top of the website; in the admin portal there is a language picker
on the login screen and at the top of every page. The choice is shared,
so if you pick Telugu in the admin portal the website switches to
Telugu too. Dish and category names are shown in all three languages —
when you add a dish, fill in its name in English, Hindi and Telugu.

---

## Step 8 — What stays free, and what it actually costs

| Item | Cost |
|---|---|
| Website hosting (Vercel) | Free |
| Database (Turso) | Free |
| Code hosting (GitHub) | Free |
| Email notifications (Gmail) | Free (500/day) |
| Google Sign-In | Free |
| Email + password login | Free (no setup needed) |
| Website itself | Free |
| **OTP text messages (MSG91) — optional** | **~₹0.15 each after the free ₹250 signup credit** |
| **OTP on WhatsApp (if used instead) — optional** | **~₹0.12 each, no free tier** |

**With email + password and Google login, the website costs ₹0 a month
to run.** The only thing that ever costs money is OTP messages, and
only if you choose to offer OTP login (Steps 4–5).

**An honest note about OTP costs:** no provider in the world sends SMS
or WhatsApp messages free forever — every provider charges per message
eventually. MSG91's ₹250 signup credit covers roughly the first year for
a small catering business at typical volumes (a few dozen customer
logins a month). After that, expect roughly **₹10–₹30 a month** in OTP
costs — or simply don't offer OTP login, and pay nothing.

---

## Quick checklist

- [ ] Step 1 — Turso database connected (yellow "temporary data" notice gone)
- [ ] Step 2 — Gmail notifications working (make a test booking and check your inbox)
- [ ] Step 3 — Google Sign-In working ("Continue with Google" button on the login page)
- [ ] Step 4 — MSG91 OTP (only if you want OTP login)
- [ ] Step 5 — WhatsApp OTP (only if you want it instead of Step 4)
- [ ] Step 6 — Admin password changed from the default
- [ ] Step 7 — Menu and prices reviewed in the admin portal

## If something goes wrong

- **"Data is temporary" notice is back** — the Turso connection broke
  (e.g. the token expired). Re-check Step 1 and redeploy.
- **"Continue with Google" button is missing** — the Google variables
  are not set (or not redeployed after setting them). Re-check Step 3.
  Also check that the redirect URI in Google Cloud matches exactly —
  one wrong character and Google refuses the login.
- **Customers don't receive OTPs** — check the MSG91/WhatsApp credit
  balance and that the template is still approved. Customers can still
  log in with email + password or Google in the meantime.
- **"Forgot password?" link is missing for customers** — email is not
  set up yet (Step 2). Set up Gmail and redeploy.
- **You can't log in to the admin portal** — use "Forgot password?", or
  ask your developer to reset it.
- **Anything else** — contact your developer (Jyothsna) with a
  screenshot of what you see and what you were doing.
