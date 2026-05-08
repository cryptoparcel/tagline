// Admin setup-status endpoint.
//
// Returns a structured checklist of every integration the site uses,
// flagging which env vars / connectivity tests are configured + working.
// Admin-only. The /admin Setup tab renders this as a step-by-step
// list so the founder can see at a glance what's left to set up.
//
// Live tests where possible:
//   - Supabase: a no-op query (already wired in /api/health)
//   - Stripe: list 1 product (verifies the key is real, not just present)
//   - Resend: just checks env vars (no test send — would spam)
//   - NowPayments: env-var check only (their API would need a real call)

import { getSupabaseAdmin } from '../lib/supabase.js';
import { getStripe } from '../lib/stripe.js';
import {
  requireMethod, ok, requireAdmin, serverError
} from '../lib/util.js';

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'GET')) return;
  if (!await requireAdmin(req, res)) return;

  const env = process.env;

  const items = [];

  // -------- Core: Supabase (REQUIRED) --------
  {
    const missing = [];
    if (!env.SUPABASE_URL && !env.PUBLIC_SUPABASE_URL) missing.push('SUPABASE_URL');
    if (!env.SUPABASE_ANON_KEY && !env.PUBLIC_SUPABASE_ANON_KEY) missing.push('SUPABASE_ANON_KEY');
    if (!env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');

    let connected = false;
    let connectError = null;
    if (missing.length === 0) {
      try {
        const supabase = getSupabaseAdmin();
        const { error } = await supabase
          .from('products')
          .select('id', { count: 'exact', head: true })
          .limit(1);
        connected = !error;
        connectError = error ? error.message : null;
      } catch (err) {
        connectError = err.message;
      }
    }

    items.push({
      key: 'supabase',
      name: 'Database (Supabase)',
      required: true,
      ok: missing.length === 0 && connected,
      missing,
      live: missing.length === 0 ? { connected, error: connectError } : null,
      hint: missing.length
        ? 'Vercel → Settings → Environment Variables. Get values from Supabase Dashboard → Project Settings → API.'
        : (connected ? 'Connected.' : `Couldn't reach Supabase: ${connectError}`),
      docs_url: 'https://supabase.com/dashboard/project/_/settings/api'
    });
  }

  // -------- Site URL (REQUIRED for checkout success/cancel redirects) --------
  {
    const present = !!env.SITE_URL && /^https:\/\//.test(env.SITE_URL);
    items.push({
      key: 'site_url',
      name: 'Site URL',
      required: true,
      ok: present,
      missing: present ? [] : ['SITE_URL'],
      hint: present
        ? `Set to ${env.SITE_URL}`
        : 'Set SITE_URL to your live domain (e.g. https://tagline.clothing). Stripe success/cancel URLs use it.',
      docs_url: 'https://vercel.com/docs/projects/environment-variables'
    });
  }

  // -------- Stripe (REQUIRED for card payments) --------
  {
    const missing = [];
    if (!env.STRIPE_SECRET_KEY) missing.push('STRIPE_SECRET_KEY');
    if (!env.STRIPE_WEBHOOK_SECRET) missing.push('STRIPE_WEBHOOK_SECRET');

    let connected = false;
    let connectError = null;
    let mode = null;
    if (env.STRIPE_SECRET_KEY) {
      mode = env.STRIPE_SECRET_KEY.startsWith('sk_live_') ? 'live'
           : env.STRIPE_SECRET_KEY.startsWith('sk_test_') ? 'test'
           : 'unknown';
      try {
        const stripe = getStripe();
        await stripe.products.list({ limit: 1 });
        connected = true;
      } catch (err) {
        connectError = err.message;
      }
    }

    items.push({
      key: 'stripe',
      name: 'Stripe (card payments)',
      required: true,
      ok: missing.length === 0 && connected,
      missing,
      live: env.STRIPE_SECRET_KEY ? { connected, error: connectError, mode } : null,
      hint: missing.length
        ? '1) Create a Stripe account at dashboard.stripe.com\n2) Get your secret key (sk_live_… or sk_test_…) from Developers → API keys\n3) Add a webhook at Developers → Webhooks → Add endpoint with URL ${SITE_URL}/api/stripe-webhook listening for checkout.session.completed, checkout.session.expired, charge.refunded\n4) Copy the signing secret (whsec_…)\n5) Add both to Vercel env'
        : (connected ? `Connected (${mode} mode).` : `Stripe API call failed: ${connectError}`),
      docs_url: 'https://dashboard.stripe.com/apikeys'
    });
  }

  // -------- NowPayments (OPTIONAL — enables crypto checkout) --------
  {
    const missing = [];
    if (!env.NOWPAYMENTS_API_KEY) missing.push('NOWPAYMENTS_API_KEY');
    if (!env.NOWPAYMENTS_IPN_SECRET) missing.push('NOWPAYMENTS_IPN_SECRET');
    items.push({
      key: 'nowpayments',
      name: 'NowPayments (crypto, optional)',
      required: false,
      ok: missing.length === 0,
      missing,
      hint: missing.length
        ? '1) Sign up at nowpayments.io\n2) Get your API key from Settings → API key\n3) Set an IPN Secret in Settings → IPN\n4) Set the IPN callback URL to ${SITE_URL}/api/nowpayments-webhook\n5) Add NOWPAYMENTS_API_KEY + NOWPAYMENTS_IPN_SECRET to Vercel env\nLeave blank to disable crypto and only use Stripe.'
        : 'Configured.',
      docs_url: 'https://account.nowpayments.io/store-settings'
    });
  }

  // -------- Resend (transactional emails, recommended) --------
  {
    const missing = [];
    if (!env.RESEND_API_KEY) missing.push('RESEND_API_KEY');
    if (!env.FROM_EMAIL) missing.push('FROM_EMAIL');
    items.push({
      key: 'resend',
      name: 'Resend (order emails)',
      required: false,
      ok: missing.length === 0,
      missing,
      hint: missing.length
        ? '1) Sign up at resend.com (free tier 3000/mo)\n2) Verify your sending domain (DNS records)\n3) Create an API key\n4) Set RESEND_API_KEY + FROM_EMAIL (e.g. orders@yourdomain.com) in Vercel env\nWithout this, order confirmation + shipping emails are silently skipped.'
        : `Will send from ${env.FROM_EMAIL}`,
      docs_url: 'https://resend.com/api-keys'
    });
  }

  // -------- Admin API key (optional fallback) --------
  {
    const present = !!env.ADMIN_API_KEY && env.ADMIN_API_KEY.length >= 32;
    items.push({
      key: 'admin_api_key',
      name: 'Admin API key (optional fallback)',
      required: false,
      ok: present,
      missing: present ? [] : ['ADMIN_API_KEY'],
      hint: present
        ? 'Configured. (Backup login if email auth fails.)'
        : 'Optional. Generate a 32+ char random string and set ADMIN_API_KEY in Vercel for emergency / shared admin access. Email-based admin (profiles.is_admin) works without this.',
      docs_url: null
    });
  }

  // -------- Cron secret (REQUIRED for daily pending-order cleanup) --------
  {
    const present = !!env.CRON_SECRET && env.CRON_SECRET.length >= 16;
    items.push({
      key: 'cron_secret',
      name: 'Cron secret (cleanup job)',
      required: false,
      ok: present,
      missing: present ? [] : ['CRON_SECRET'],
      hint: present
        ? 'Cron job will run daily at 04:00 UTC.'
        : 'Generate a 16+ char random string and set CRON_SECRET in Vercel. The daily cleanup endpoint stays disabled without it.',
      docs_url: 'https://vercel.com/docs/cron-jobs'
    });
  }

  // -------- Admin email (where order/oversell notifications go) --------
  {
    const present = !!env.ADMIN_EMAIL && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.ADMIN_EMAIL);
    items.push({
      key: 'admin_email',
      name: 'Admin notification email',
      required: false,
      ok: present,
      missing: present ? [] : ['ADMIN_EMAIL'],
      hint: present
        ? `New-order + oversold alerts go to ${env.ADMIN_EMAIL}.`
        : 'Set ADMIN_EMAIL to receive new-order + oversell alerts. Without this, they\'re silently logged to Vercel Functions logs only.',
      docs_url: null
    });
  }

  try {
    const requiredOk = items.filter(i => i.required).every(i => i.ok);
    const allOk = items.every(i => i.ok);
    return ok(res, {
      complete: requiredOk,
      all_complete: allOk,
      items
    });
  } catch (err) {
    console.error('Setup status error:', err);
    return serverError(res);
  }
}
