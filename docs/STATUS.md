# Where we left off

Stable snapshot at commit pushed to `main`. Site is functional end-to-end and safe to deploy. Open this doc tomorrow before doing anything else.

---

## ✅ What works right now

### Auth flows
- Sign up (with Supabase email confirmation enabled)
- Email confirmation — when user clicks the link, lands on the site, hash is consumed and session is set automatically (no manual page needed)
- Sign in (generic error messages — no account enumeration)
- Forgot password → email link → `/reset-password` → set new password → sign in
- Sign out
- Settings tab on `/account` — edit profile (name, phone) + default shipping address

### Commerce
- Browse 24 products on `/`
- Quick-view drawer with size + qty pickers (focus-trapped, keyboard-accessible)
- Add to cart (size-aware, with "Cart full" guard at 50 items)
- Wishlist (heart icon on cards, `/wishlist` page)
- Cart with free-shipping threshold display + payment-method icons + return-policy link
- Checkout via Stripe (US/CA shipping, $8 / free over $150, guest checkout supported)
- Stripe webhook is idempotent (won't double-decrement stock or send duplicate emails)
- Order confirmation email
- Order shipped email (when admin sets status='shipped')

### Admin
- `/admin` (requires `ADMIN_API_KEY`)
- View paid orders, subscribers, contact messages
- Update order status + tracking number (validated `^[A-Z0-9]{8,40}$`)

### A11y / SEO
- Skip-to-content link on every page (WCAG 2.4.1)
- Focus trap on quick-view drawer
- JSON-LD: Organization + WebSite (static) + Product ItemList (dynamic from catalog)

---

## ⚠️ One-time tasks YOU need to do before some features work

These are settings on third-party services, not code changes:

1. **Supabase SQL migration** — open Supabase Dashboard → SQL Editor → paste and run:
   ```sql
   create table if not exists processed_webhook_events (
     event_id text primary key,
     event_type text not null,
     processed_at timestamptz default now()
   );
   create index if not exists idx_processed_events_at on processed_webhook_events(processed_at);
   alter table processed_webhook_events enable row level security;
   ```
   Without this, the Stripe webhook returns 500 on every event and Stripe retries forever.

2. **Supabase redirect URL** — Authentication → URL Configuration → Redirect URLs → add `https://YOUR_DOMAIN/reset-password`. Without this, password-reset links won't work.

3. **Vercel env var `SITE_URL`** — must be set to the actual production URL (no trailing slash). The CSRF protection and Stripe checkout success/cancel URLs depend on it.

4. **Optional: Supabase email confirmation** — Authentication → Email Auth → enable. Already done if you followed SETUP.md.

---

## 🛣️ What's next (suggested priority for tomorrow)

### High-value, low-risk (quick wins)
- **Refactor product catalog to single source of truth** — currently triple-duplicated (`tagline-app.js`, `cart.html`, `wishlist.html`). Make cart/wishlist fetch from `/api/products` instead. Eliminates a real drift hazard. (IMPROVEMENTS.md #77)
- **Refactor admin.html to use `Tagline.API` client** — currently duplicates fetch/error handling and doesn't get preview-mode plumbing. (BUGS.md "Known issues")
- **Add `og:image` and `twitter:image` to index.html** — social shares are blank cards right now. Just need a 1200×630 PNG. (IMPROVEMENTS.md #1)

### Bigger features
- **Real product images** — drop JPGs into `/public/images/products/{product-id}.jpg`. The frontend already auto-detects them and falls back to SVG placeholders. (Empty folder right now.)
- **Refunds button in admin** — Stripe's `stripe.refunds.create` API. (IMPROVEMENTS.md #110)
- **Discount codes** — Stripe Checkout supports `discounts: [{ coupon: 'CODE' }]`. (IMPROVEMENTS.md #111)
- **Cart abandonment email** — flag carts that started checkout but didn't complete; email them at 24h. (IMPROVEMENTS.md #46)

### Production hardening (when scaling)
- **Move rate limiter to Vercel KV / Upstash** — current limiter is per-cold-instance, trivially bypassable. (IMPROVEMENTS.md #8)
- **Sentry for error tracking** — `console.error` calls go to Vercel logs, but browser errors are invisible. (IMPROVEMENTS.md #99)
- **GitHub Actions CI** — lint, typecheck, Lighthouse on PRs. (IMPROVEMENTS.md #96)
- **Playwright e2e tests** — three golden flows: browse-add-checkout, sign-up-sign-in, contact form. (IMPROVEMENTS.md #95)

---

## 📂 Where to look

- [IMPROVEMENTS.md](../IMPROVEMENTS.md) — 125 sourced items (P0/P1/P2), prioritized backlog
- [docs/BUGS.md](BUGS.md) — every bug found, what was fixed, what remains
- [docs/SECURITY.md](SECURITY.md) — security posture (already-implemented controls)
- [docs/SETUP.md](SETUP.md) — first-time deploy guide

---

## 🧪 Verifying the stable snapshot

Five-minute end-to-end smoke test in production:

1. Open `/signin`, click "Forgot password?" — form should appear (not "preview mode")
2. Open `/`, click any product — quick-view opens, Tab cycles within the drawer (doesn't escape)
3. Click "Sign in" → sign up with a test email → check inbox → click confirm → land back on site → see "Email confirmed" banner top-center
4. Open `/account` → Settings tab → fill in shipping address → save → reload → values persist
5. Add an item to cart → `/cart` → see "Free returns within 30 days" + payment-method icons → click Checkout → Stripe page loads with the right amount

If all 5 work, the snapshot is solid.
