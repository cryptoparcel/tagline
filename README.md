# TAGLINE

Custom athletic wear — full-stack e-commerce site.

## Stack

- **Frontend:** Static HTML/CSS/JS (no build step)
- **Backend:** Vercel serverless functions (Node 20)
- **Database & Auth:** Supabase (PostgreSQL + Supabase Auth)
- **Payments:** Stripe Checkout
- **Email:** Resend

## Project Structure

```
tagline/
├── api/                    # Vercel serverless functions
│   ├── newsletter.js       # POST email signup
│   ├── contact.js          # POST contact form
│   ├── products.js         # GET active products (cached)
│   ├── checkout.js         # POST cart -> Stripe Checkout session
│   ├── stripe-webhook.js   # Stripe webhook (idempotent — paid/refunded/expired)
│   ├── my-orders.js        # GET signed-in user's orders
│   ├── profile.js          # GET / PATCH user profile + shipping address
│   ├── config.js           # GET public Supabase + Stripe keys (used by signin / reset-password)
│   └── admin.js            # GET/POST admin dashboard data; sends shipped email on transition
├── lib/                    # Shared backend modules
│   ├── supabase.js         # Server Supabase client + getUserFromRequest
│   ├── stripe.js           # Stripe singleton
│   ├── email.js            # Resend helper + order-confirmation + order-shipped templates
│   ├── html.js             # escapeHtml — single source of truth
│   └── util.js             # validation, JSON responses, rate limiting, admin auth, CSRF
├── public/                 # Static frontend
│   ├── index.html          # Homepage with all 24 products + JSON-LD structured data
│   ├── cart.html           # Cart page with trust signals + free-shipping threshold
│   ├── signin.html         # Sign in / sign up / forgot-password — config from /api/config
│   ├── reset-password.html # Password-reset landing (handles Supabase recovery hash)
│   ├── account.html        # Order history + Settings tab (profile + default shipping address)
│   ├── contact.html        # Contact form
│   ├── customize.html      # Build-your-own configurator
│   ├── sizing.html         # Size guide
│   ├── help.html           # Help / FAQ
│   ├── about.html          # About
│   ├── wishlist.html       # Saved items
│   ├── success.html        # Post-checkout thank you
│   ├── 404.html            # Not-found page
│   ├── admin.html          # Admin dashboard (admin key required)
│   ├── styles.css          # Shared styles for secondary pages (incl. .skip-link)
│   └── tagline-app.js      # Shared frontend JS — cart, wishlist, auth, quick view,
│                           # email-confirm hash handler, JSON-LD product injection,
│                           # focus-trap on quick-view drawer, preview-mode detection
├── sql/
│   └── schema.sql          # Run in Supabase SQL Editor (incl. processed_webhook_events)
├── docs/
│   ├── SETUP.md            # Step-by-step deployment guide
│   ├── SECURITY.md         # Security posture (XSS, CSRF, header injection, etc.)
│   └── BUGS.md             # Forensic record of fixes + remaining known issues
├── IMPROVEMENTS.md         # Sourced 125-item improvement backlog (P0/P1/P2)
├── .env.example
├── package.json
└── vercel.json             # URL rewrites and security headers
```

## Quick Start

Read `docs/SETUP.md` — it walks you through deployment in ~30 minutes.

## Local Development

```bash
npm install -g vercel
cd tagline
npm install
vercel dev
```

You'll need a `.env.local` file with the variables from `.env.example`.

## Free Tier Limits

These all give you plenty of room to test and even handle real customers:

- **Vercel:** 100 GB bandwidth/month, unlimited deploys
- **Supabase:** 500 MB DB, 50K monthly auth users, 1 GB file storage
- **Stripe:** No monthly fee, takes 2.9% + 30¢ per transaction
- **Resend:** 3000 emails/month, 100/day

## Security Notes

- Server uses `SUPABASE_SERVICE_ROLE_KEY` — never expose to browser
- Browser uses `PUBLIC_SUPABASE_ANON_KEY` — safe to expose, served via `/api/config`
- All API routes are rate-limited (per-IP, in-memory — see IMPROVEMENTS.md #8 for production hardening)
- Stripe webhook verifies signatures AND is idempotent via `processed_webhook_events`
- Admin endpoints check `X-Admin-Key` header (32+ char minimum, timing-safe compare)
- Row-level security (RLS) policies on all tables
- All input validated server-side; HTML escape via single canonical `lib/html.js`
- Cart prices re-fetched server-side at checkout (never trust client)
- CSRF protection: all POST/PATCH require Origin/Referer matching `SITE_URL`
- Sign-up blocks the top common-password list (NIST SP 800-63B Sec 5.1.1.2)
- Sign-in errors are generic — no account-enumeration leak (OWASP ASVS V2.1.12)
- Skip-to-content link + focus trap on quick-view drawer (WCAG 2.4.1, ARIA APG)
- Email recovery token stripped from URL before any auth call (OWASP ASVS V3.5)

See [docs/SECURITY.md](docs/SECURITY.md) for the full posture and [docs/BUGS.md](docs/BUGS.md) for the forensic log.
