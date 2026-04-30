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
│   ├── products.js         # GET active products
│   ├── checkout.js         # POST cart -> Stripe Checkout session
│   ├── stripe-webhook.js   # Stripe webhook (mark order paid, decrement stock, send email)
│   ├── my-orders.js        # GET signed-in user's orders
│   └── admin.js            # GET/POST admin dashboard data
├── lib/                    # Shared backend modules
│   ├── supabase.js         # Server Supabase client
│   ├── stripe.js           # Stripe singleton
│   ├── email.js            # Resend helper + email templates
│   └── util.js             # validation, responses, rate limiting, admin auth
├── public/                 # Static frontend
│   ├── index.html          # Homepage with all 24 products
│   ├── cart.html           # Cart page
│   ├── signin.html         # Sign in / sign up
│   ├── account.html        # Order history (auth required)
│   ├── contact.html        # Contact form
│   ├── success.html        # Post-checkout thank you
│   ├── admin.html          # Admin dashboard (admin key required)
│   ├── styles.css          # Shared styles for secondary pages
│   └── tagline-app.js      # Shared frontend JS (cart, auth, newsletter)
├── sql/
│   └── schema.sql          # Run in Supabase SQL Editor
├── docs/
│   └── SETUP.md            # Step-by-step deployment guide
├── .env.example            # Environment variables documentation
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
- Browser uses `PUBLIC_SUPABASE_ANON_KEY` — safe to expose
- All API routes are rate-limited
- Stripe webhook verifies signatures
- Admin endpoints check `X-Admin-Key` header
- Row-level security (RLS) policies on all tables
- All input validated server-side
- Cart prices re-fetched server-side at checkout (never trust client)
