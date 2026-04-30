# TAGLINE — Setup & Deploy Guide

This is your complete e-commerce site. Follow these steps in order. Should take about **30-45 minutes** the first time.

---

## What you're setting up

- **Frontend** — your static HTML pages, served by Vercel for free
- **Backend API** — serverless functions for newsletter, contact, checkout, admin
- **Database** — Supabase (PostgreSQL) free tier
- **Auth** — Supabase Auth for sign in / sign up
- **Payments** — Stripe Checkout (you keep 97% per transaction)
- **Email** — Resend (3000 free emails/month)

All services have generous free tiers. You only pay if you scale up.

---

## Step 1 — Create accounts (15 min)

Sign up for these (free):

1. **GitHub** — https://github.com/signup
2. **Vercel** — https://vercel.com/signup (sign in with GitHub)
3. **Supabase** — https://supabase.com/dashboard/sign-up
4. **Stripe** — https://dashboard.stripe.com/register
5. **Resend** — https://resend.com/signup

---

## Step 2 — Set up Supabase (5 min)

1. In the Supabase dashboard, click **New project**
2. Name it `tagline`. Pick a strong DB password — save it somewhere
3. Pick the region closest to you (US East / US West)
4. Wait ~2 minutes for it to provision
5. Once ready, go to **Settings → API**. Copy these three values:
   - `URL` (e.g. `https://xxxxx.supabase.co`)
   - `anon public` key
   - `service_role secret` key
6. Go to **SQL Editor → New query**, paste the entire contents of `sql/schema.sql`, click **Run**

You should see "Success. No rows returned." — your database is ready.

---

## Step 3 — Set up Stripe (5 min)

1. From Stripe dashboard, **stay in Test mode** (toggle top right). You'll switch to Live mode later when ready for real money.
2. Go to **Developers → API keys**. Copy:
   - `Publishable key` (starts with `pk_test_…`)
   - `Secret key` (starts with `sk_test_…`)
3. The webhook secret comes later — we'll get it after deployment.

---

## Step 4 — Set up Resend (3 min)

1. From Resend dashboard, go to **API Keys → Create API Key**. Copy the key.
2. **Domains → Add Domain** — add your real domain if you have one. Otherwise you can use `onboarding@resend.dev` as `FROM_EMAIL` for testing.

---

## Step 5 — Push to GitHub (5 min)

1. On github.com, click **+ → New repository**, name it `tagline`, public is fine
2. **Don't** check "Add a README" — we already have files
3. After creating, GitHub shows commands. On your computer, in the project folder, run:

```powershell
cd path\to\tagline
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/tagline.git
git push -u origin main
```

---

## Step 6 — Deploy to Vercel (5 min)

1. Vercel dashboard → **Add New → Project**
2. **Import** your `tagline` repo from GitHub
3. **Framework Preset:** Other (Vercel auto-detects)
4. **Root Directory:** leave as `.`
5. Click **Environment Variables**. Add each of these (paste the values you saved):

| Name | Value |
|---|---|
| `SUPABASE_URL` | from Step 2 |
| `SUPABASE_ANON_KEY` | from Step 2 |
| `SUPABASE_SERVICE_ROLE_KEY` | from Step 2 |
| `PUBLIC_SUPABASE_URL` | same as SUPABASE_URL |
| `PUBLIC_SUPABASE_ANON_KEY` | same as SUPABASE_ANON_KEY |
| `STRIPE_SECRET_KEY` | from Step 3 (`sk_test_…`) |
| `PUBLIC_STRIPE_KEY` | from Step 3 (`pk_test_…`) |
| `STRIPE_WEBHOOK_SECRET` | leave empty for now |
| `RESEND_API_KEY` | from Step 4 |
| `FROM_EMAIL` | `orders@yourdomain.com` or `onboarding@resend.dev` |
| `ADMIN_EMAIL` | your personal email (where you'll receive order notifications) |
| `ADMIN_API_KEY` | any random 32-char string. Make one: `openssl rand -hex 32` or use a password generator |
| `SITE_URL` | leave empty for now (we'll fill in after first deploy) |

6. Click **Deploy**. Wait ~1 minute.

7. Once deployed, copy your URL (e.g. `tagline-xxx.vercel.app`).

8. **Update env vars:** go to your project's **Settings → Environment Variables**, edit `SITE_URL`, set to `https://tagline-xxx.vercel.app` (no trailing slash). Click **Redeploy** under Deployments.

---

## Step 7 — Update signin page with public Supabase keys

The signin page needs your public Supabase URL and anon key. Edit `public/signin.html`, find these two lines near the bottom:

```js
window.SUPABASE_URL = 'REPLACE_WITH_PUBLIC_SUPABASE_URL';
window.SUPABASE_ANON_KEY = 'REPLACE_WITH_PUBLIC_SUPABASE_ANON_KEY';
```

Replace with the actual values from Step 2. Commit and push:

```powershell
git add public/signin.html
git commit -m "Add Supabase public keys"
git push
```

Vercel auto-deploys.

---

## Step 8 — Set up Stripe webhook (5 min)

This is critical — without it, paid orders won't be marked as paid in your database.

1. Stripe dashboard → **Developers → Webhooks → Add endpoint**
2. **Endpoint URL:** `https://your-site.vercel.app/api/stripe-webhook`
3. **Listen to:** select these events:
   - `checkout.session.completed`
   - `checkout.session.expired`
   - `charge.refunded`
4. Click **Add endpoint**
5. On the webhook details page, click **Reveal** under "Signing secret". Copy the value (starts with `whsec_…`)
6. Back in Vercel → **Settings → Environment Variables**, edit `STRIPE_WEBHOOK_SECRET`, paste the value
7. Redeploy

---

## Step 9 — Test it (5 min)

1. Visit your site
2. Add an item to cart, click checkout
3. Use Stripe test card: `4242 4242 4242 4242`, any future expiry, any CVC, any zip
4. Complete checkout — you should land on `/success`
5. Check your `/admin` page (use the `ADMIN_API_KEY` you set) — order should appear with status "paid"
6. Check your email — you should get a confirmation

If something doesn't work, check **Vercel → your project → Deployments → click the latest → Functions** for error logs.

---

## Going live

When you're ready for real money:

1. In Stripe, complete account verification (bank info, ID, etc.)
2. Toggle Stripe to **Live mode**, get new live API keys
3. Update Vercel env vars: `STRIPE_SECRET_KEY` → `sk_live_…`, `PUBLIC_STRIPE_KEY` → `pk_live_…`
4. Recreate the webhook with live keys, update `STRIPE_WEBHOOK_SECRET`
5. Redeploy

---

## Custom domain

In Vercel project → **Settings → Domains** → Add your domain. Vercel walks you through the DNS setup. SSL is automatic.

Update `SITE_URL` env var to your real domain after the DNS resolves.

---

## Adding/editing products

Edit them directly in Supabase: **Table editor → products**. Changes appear immediately on `/api/products` (cached for 60 seconds).

To add a brand new product, you also need to add the product card to `index.html` (or migrate to dynamic loading later) and add its name+ID to the `PRODUCT_NAME_TO_ID` map in `tagline-app.js`.

---

## Troubleshooting

- **"Sign in failed"** — check your public Supabase keys in `signin.html` are correct
- **"Could not start checkout"** — check Stripe secret key in Vercel env vars
- **Order stuck on "pending"** — your Stripe webhook isn't reaching your site. Check the webhook endpoint URL is correct, check `STRIPE_WEBHOOK_SECRET` is set
- **No emails** — check `RESEND_API_KEY` and `FROM_EMAIL`. The from email's domain has to be verified in Resend
- **Admin page rejects key** — make sure `ADMIN_API_KEY` is set in Vercel env vars and exactly matches what you type in
