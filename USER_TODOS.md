# Things you need to do

This is the **one running list** of action items that depend on you (configuring third-party services, dropping in image files, adding env vars, etc.). Work through it whenever you have time. Items are sorted by urgency — top is most blocking.

> **Why a separate file:** the code keeps moving forward and assumes these will get done. If a feature seems broken in production, check this file first — it's probably waiting on one of these.

---

## 🔴 Blocking — features below are coded but won't activate until done

### 1. Run the SQL migration in Supabase

**Why:** the Stripe webhook idempotency check needs the `processed_webhook_events` table. Without it, every Stripe webhook returns 500 and Stripe retries forever.

**How:** Supabase Dashboard → SQL Editor → New query → paste and run:

```sql
create table if not exists processed_webhook_events (
  event_id text primary key,
  event_type text not null,
  processed_at timestamptz default now()
);
create index if not exists idx_processed_events_at on processed_webhook_events(processed_at);
alter table processed_webhook_events enable row level security;
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
