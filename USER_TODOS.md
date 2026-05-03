# Things you need to do

This is the **one running list** of action items that depend on you (configuring third-party services, dropping in image files, adding env vars, etc.). Work through it whenever you have time. Items are sorted by urgency — top is most blocking.

> **Why a separate file:** the code keeps moving forward and assumes these will get done. If a feature seems broken in production, check this file first — it's probably waiting on one of these.

---

## 🔴 Blocking — features below are coded but won't activate until done

### 1. Run the SQL migrations in Supabase

**Why:** several recent fixes need DB changes. Without these:
- Stripe webhooks return 500 and Stripe retries forever (idempotency table)
- The atomic stock-decrement function still uses the old silently-clamping version (oversell risk on limited items)

**How:** Supabase Dashboard → SQL Editor → New query → paste and run all three:

```sql
-- 1. Idempotency table (Stripe + NowPayments webhooks)
create table if not exists processed_webhook_events (
  event_id text primary key,
  event_type text not null,
  processed_at timestamptz default now()
);
create index if not exists idx_processed_events_at on processed_webhook_events(processed_at);
alter table processed_webhook_events enable row level security;

-- 2. NowPayments invoice column (only needed if you'll enable crypto)
alter table orders add column if not exists nowpayments_invoice_id text unique;
create index if not exists idx_orders_np_invoice on orders(nowpayments_invoice_id);

-- 3. Atomic decrement_stock — replaces the old silently-clamping version.
--    Drop is required because we changed the return type (void → boolean)
--    and Postgres won't let CREATE OR REPLACE change return types.
drop function if exists decrement_stock(text, integer);
create function decrement_stock(product_id text, qty integer)
returns boolean
language plpgsql
security definer
as $$
declare rows_affected integer;
begin
  update products
  set stock = stock - qty, updated_at = now()
  where id = product_id and stock >= qty;
  get diagnostics rows_affected = row_count;
  return rows_affected > 0;
end;
$$;
```

(Alternative: re-run the entire `sql/schema.sql` — it's idempotent.)

---

### 2. Add the password-reset URL to Supabase's redirect allow-list

**Why:** when a user clicks the password-reset email link, Supabase will refuse to redirect them back unless the URL is allow-listed. Without this, "Forgot password?" produces a dead-end error.

**How:** Supabase Dashboard → Authentication → URL Configuration → Redirect URLs → add:

```
https://YOUR_DOMAIN/reset-password
```

(replace `YOUR_DOMAIN` with your actual production domain — e.g. `tagline-ten.vercel.app`)

---

### 3. Set the `SITE_URL` env var in Vercel

**Why:** the new CSRF protection rejects POSTs whose `Origin` doesn't match `SITE_URL`, and Stripe's success/cancel URLs use it. If unset, CSRF passes everything (less safe) and Stripe will fail to redirect after checkout.

**How:** Vercel Dashboard → your project → Settings → Environment Variables → add:

| Name | Value |
|---|---|
| `SITE_URL` | `https://YOUR_DOMAIN` (no trailing slash) |

Then **redeploy** for it to take effect.

---

### 4. Enable email confirmations in Supabase

**Why:** without this, anyone can sign up with `not-mine@example.com` and pollute your user table.

**How:** Supabase Dashboard → Authentication → Providers → Email → toggle **"Confirm email"** on.

(The email-confirm landing flow on the site already handles the click-from-email step — you just need to flip this switch.)

---

## 🟢 Optional — feature flag, off by default

### 4a. Soft-launch access gate (rocket page) — code is in, gate stays off until you flip it

**Why:** lets you launch live but keep the site invite-only. Gives you a controlled trial with a small group before going public. Hand out codes to friends, family, founding customers.

**How to activate when ready:**

1. **Pick your access codes** — you can use anything (e.g. `FOUNDER-001`, `BETA-002`, `VIP-CRYPTOPARCEL`). Aim for one per person so you can revoke individually by removing it from the list.

2. **Set Vercel env vars:**
   - `ACCESS_GATE_ENABLED` = `true`
   - `ACCESS_CODES` = `CODE1,CODE2,CODE3` (comma-separated, no spaces)

3. **Redeploy.** Anyone hitting the site is redirected to `/launch`. They enter their code, get an HttpOnly 30-day cookie, then land on the homepage.

4. **To go fully public later:** just flip `ACCESS_GATE_ENABLED` back to `false` and redeploy. No further code changes.

**What's allowed through the gate** (so SEO + payments + support don't break):
- Known crawlers (Googlebot, Twitterbot, Slackbot, etc.) — link previews still work
- `/api/*` — Stripe + NowPayments webhooks must reach our endpoints
- `/privacy`, `/terms` — legal pages must be reachable
- `/sitemap.xml`, `/robots.txt`, `/og-image.svg` — search engine and social-card crawlers

**Brute-force protection:** the `/api/access` endpoint is rate-limited to 10 attempts per IP per 5 minutes. Add Cloudflare Turnstile later if you want stronger protection.

---

## 🟡 Recommended — features work without these but are better with them

### 5. Replace `og-image.svg` with a real PNG

**Why:** I dropped a placeholder SVG at `/public/og-image.svg`. It works on Slack, Facebook, LinkedIn — but **Twitter doesn't render SVGs**, so Twitter previews stay blank until you swap it for a PNG.

**How:**
- Make a 1200 × 630 PNG (Figma, Canva, Photoshop — or screenshot the SVG and export).
- Save as `public/og-image.png`.
- In `public/index.html`, change the four lines that say `og-image.svg` → `og-image.png`.

The placeholder design uses the gold cross + "TAGLINE" wordmark so it's already on-brand. Replacing later is purely a quality upgrade.

---

### 6. Drop real product photos into `/public/images/products/`

**Why:** the homepage and quick-view drawer currently render letter placeholders ("A" for Ascend Hoodie, "H" for Halo Zip, etc.). The frontend already auto-detects real images and swaps them in seamlessly — you just need to drop the files.

**How:** save each product photo as `/public/images/products/{product-id}.jpg`. The product IDs are in `sql/schema.sql` (lines starting with `('ascend-hoodie', ...)`). Square-ish ratio (1:1.1 ideally) since that's the card aspect ratio.

You can do this one at a time — the placeholder stays for products without an image yet.

---

### 7. Create Stripe promotion codes (optional)

**Why:** the cart's Stripe Checkout page now shows an "Add promotion code" link. Customers can enter codes you've created in Stripe Dashboard. If you don't create any, the field just stays empty — no harm done.

**How:** Stripe Dashboard → Products → Coupons → Create coupon → set discount type (% off, $ off, free shipping, etc.) → save. Then create a Promotion Code that customers can actually type (e.g. `WELCOME10`).

---

### 7a. Enable additional payment methods in Stripe (FREE — just toggles)

**Why:** the cart's payment-method icons advertise Visa/Mastercard/Amex/Discover/Apple Pay/Google Pay/PayPal — but only the cards work until you flip these on. All are free with Stripe Checkout (no separate processor needed). The icons are aspirational until you enable them.

**How:**
1. **Stripe Dashboard → Settings → Payment methods** (in the gear icon)
2. Find each method below and click **Turn on**:
   - **Apple Pay** — works on iOS Safari automatically once enabled. No domain verification needed since we use Stripe Checkout (Stripe handles it on `checkout.stripe.com`).
   - **Google Pay** — works on Chrome Android automatically once enabled.
   - **PayPal** — Stripe acts as your PayPal merchant. Stripe will walk you through PayPal Business onboarding (~5 min). Once approved, PayPal appears as an option on the Stripe Checkout page.
   - *(optional)* **Klarna / Afterpay / Cash App** — buy-now-pay-later options. Same toggle pattern. Boost AOV ~30% per Stripe data.

3. Customers see whichever methods are enabled, on the device that supports them, automatically. **No code changes needed** — Stripe Checkout adapts.

---

### 7b. Crypto payments via NowPayments — code is built, needs activation

**Why:** crypto is a separate processor — different webhooks, different reconciliation. The full scaffold is in the repo (`api/checkout-crypto.js`, `api/nowpayments-webhook.js`, `lib/nowpayments.js`, cart UI). It's currently inert because the env vars aren't set — the cart's "Pay with crypto" button stays hidden until you flip it on. Recommended to wait until Stripe has handled real production traffic for 2-4 weeks before activating.

**How to activate (when ready):**

1. **Run this SQL migration** in Supabase → SQL Editor (one-time):
   ```sql
   alter table orders add column if not exists nowpayments_invoice_id text unique;
   create index if not exists idx_orders_np_invoice on orders(nowpayments_invoice_id);
   ```
   (Or re-run all of `sql/schema.sql` — it's idempotent.)

2. **Sign up** at https://nowpayments.io → Account → **Store Settings**:
   - Copy the **API Key**
   - Copy the **IPN Secret** (Settings → IPN)
   - Enable **Auto-conversion to USD** ⚠️ critical — avoids holding crypto + US state money-transmitter rules

3. **Set the IPN URL** in NowPayments dashboard → Settings → IPN:
   ```
   https://YOUR_DOMAIN/api/nowpayments-webhook
   ```

4. **Add Vercel env vars** (Settings → Environment Variables):
   - `NOWPAYMENTS_API_KEY` = the API key from step 2
   - `NOWPAYMENTS_IPN_SECRET` = the IPN secret from step 2

5. **Redeploy.** The "Pay with crypto" button will now appear on the cart page.

6. **Test** with a small order — NowPayments has a sandbox; use it before going live.

---

### 7c. Discount banners (veterans / first responders / students / teachers) — code is built, needs activation

**Why:** GovX is retail-grade verification (used by Under Armour, Yeti, North Face). Free to integrate, ~$0.50 per redemption. They cover **veterans, first responders, students, teachers, and military families** — each group as a separate "campaign" in your GovX dashboard.

The integration uses GovX's recommended pattern: their hosted page issues a one-time discount code to a verified user; the customer pastes it into Stripe Checkout's promo-code field. **No backend integration needed beyond exposing the URLs.** Each group with a URL set gets its own small banner on the cart page.

**How to activate (when ready):**

1. **Sign up** at https://www.govx.com/merchants → onboarding flow.

2. **In Stripe Dashboard** → Products → Coupons → for each group you want to support, create a coupon + matching promotion code. Examples:
   - `VETERANS10` → 10% off
   - `FIRSTRESP10` → 10% off
   - `STUDENT10` → 10% off
   - `TEACHER10` → 10% off
   - (Mix percentages as you like — `VETERANS15` for veterans only, etc.)

3. **In GovX merchant dashboard** → create one campaign per group. Set each campaign's discount code to the matching Stripe promotion code.

4. **Grab the verification URL for each campaign** (looks like `https://app.govx.com/verify/YOUR_VENDOR_ID/veterans`).

5. **Add Vercel env vars** — only set the ones you've configured. Unset = banner stays hidden:
   - `GOVX_VETERAN_URL` / `VETERAN_DISCOUNT_PERCENT` (default 10)
   - `GOVX_FIRSTRESP_URL` / `FIRSTRESP_DISCOUNT_PERCENT`
   - `GOVX_STUDENT_URL` / `STUDENT_DISCOUNT_PERCENT`
   - `GOVX_TEACHER_URL` / `TEACHER_DISCOUNT_PERCENT`
   - (Legacy: `GOVX_VERIFY_URL` is still accepted as an alias for `GOVX_VETERAN_URL`)

6. **Redeploy.** The configured banners appear on the cart page automatically — one per group, stacked.

**Customer flow:** click banner → verify on GovX hosted page (opens new tab) → GovX shows them the code → they paste it on Stripe Checkout → discount auto-applies.

---

### 7d. Set `CRON_SECRET` env var in Vercel (10 sec)

**Why:** the daily pending-order cleanup cron (`/api/cleanup-pending`) authenticates via this. Without it set, the cron either fails (auth required) or runs unprotected. Vercel automatically sends it as `Authorization: Bearer ${CRON_SECRET}` when scheduled.

**How:**
- Generate a random secret: `openssl rand -hex 32`
- Vercel Dashboard → Project → Settings → Environment Variables → add:
  - `CRON_SECRET` = the value you generated
- Redeploy. The cron runs daily at 4am UTC and marks any order still `pending` after 24h as `cancelled`. Keeps the admin orders view tidy as abandoned checkouts pile up.

---

### 7e. Hook UptimeRobot to `/api/health` (free, 5 min setup)

**Why:** the `/api/health` endpoint pings Supabase + checks Stripe/Resend env vars. UptimeRobot pings it every 5 min and emails you if it's not 200. Catches outages before customers complain.

**How:**
- Sign up at https://uptimerobot.com (free tier — 50 monitors, 5-min checks)
- Add monitor:
  - Type: **HTTPS keyword**
  - URL: `https://YOUR_DOMAIN/api/health`
  - Keyword: `"ok":true`
  - Interval: 5 minutes
  - Alert contacts: your email
- Optionally add their free status page so customers can check during incidents

---

### 8. Set up DKIM / DMARC for `FROM_EMAIL` in Resend

**Why:** without these, ~30% of order confirmation emails land in Gmail/Yahoo spam folders. With them, deliverability is near 99%.

**How:** Resend Dashboard → Domains → Add Domain → follow the DNS records they give you. Once verified, your `FROM_EMAIL` (e.g. `orders@yourdomain.com`) is properly authenticated.

---

## 🟢 Eventually — production hardening when you scale

### 9. Move the rate limiter to Vercel KV / Upstash Redis

**Why:** the current limiter is in-memory per cold-start instance. An attacker hitting different serverless regions can multiply their effective rate against you. Fine at low traffic; not fine at scale.

**How:** Vercel Dashboard → Storage → Create KV database → grab credentials → swap `lib/util.js`'s `rateLimit()` to read/write from Vercel KV. (~M effort)

---

### 10. Hook up Sentry for error tracking

**Why:** browser errors (the kind users actually see) currently go nowhere — you only see backend errors via Vercel logs. Sentry catches both.

**How:** sentry.io → free plan → add Sentry Browser SDK to `tagline-app.js` and Sentry Node SDK to API handlers. ~30 min.

---

### 11. Add a 1200×630 PNG OG image generator (alternative to #5)

If you want a fully automatic OG image, install `@vercel/og` and add an `/api/og.png` endpoint that renders the SVG to PNG on demand. More code; works for any future product page too. Skip if you're fine with #5.

---

## ✅ Reference — what's already done and verified working

These are no-action items — listed here just so you know what's behind you:

- Sign in / sign up / forgot-password flow
- User settings (profile + shipping address)
- Email-confirmation landing
- Cart + checkout (Stripe, US/CA, free over $150)
- Stripe webhook (idempotent — assuming #1 above is done)
- Order confirmation email
- Order shipped email (when admin sets status='shipped')
- Trust signals at checkout (returns + payment-method icons)
- Skip-to-content link, focus trap on quick-view drawer
- JSON-LD structured data for SEO
- CSP, HSTS, frame-ancestors, all the security headers
- CSRF protection on all mutating endpoints (gated on #3 above)
- Stripe-hosted promotion codes (gated on #7 above)
- Order status timeline on the Account page
- Single source of truth for product catalog (no more drift)
