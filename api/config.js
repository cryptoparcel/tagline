// Public client config — what the browser needs to talk to Supabase Auth
// directly. These values are safe to expose:
//   - SUPABASE_URL is your project URL, public by definition
//   - SUPABASE_ANON_KEY is enforced by Postgres RLS, never bypasses policies
//
// Serving them from this endpoint (instead of hand-editing signin.html)
// keeps env vars as the single source of truth.

import { requireMethod, ok, serverError } from '../lib/util.js';

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'GET')) return;

  const url = process.env.PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const anonKey = process.env.PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
  const stripeKey = process.env.PUBLIC_STRIPE_KEY;

  if (!url || !anonKey) {
    return serverError(res, 'Backend not configured.');
  }

  // Cache aggressively — these change ~never
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');

  // Discount-verification banners (GovX or any provider that issues
  // a one-time code on verification). Each entry the cart shows as a
  // small banner with a "Verify with X" link. Customer pastes the code
  // they get into Stripe Checkout's promo-code field (already enabled).
  // Only banners with a configured URL are returned — unset env vars
  // mean the banner stays hidden.
  const intPct = (envName, fallback) => {
    const raw = process.env[envName];
    if (!raw) return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 && n < 100 ? n : fallback;
  };

  const discountBanners = [
    { id: 'veteran',         label: 'Veterans & military',  percent: intPct('VETERAN_DISCOUNT_PERCENT', 10),
      url: process.env.GOVX_VETERAN_URL || process.env.GOVX_VERIFY_URL || null },
    { id: 'first_responder', label: 'First responders',     percent: intPct('FIRSTRESP_DISCOUNT_PERCENT', 10),
      url: process.env.GOVX_FIRSTRESP_URL || null },
    { id: 'student',         label: 'Students',             percent: intPct('STUDENT_DISCOUNT_PERCENT', 10),
      url: process.env.GOVX_STUDENT_URL || null },
    { id: 'teacher',         label: 'Teachers',             percent: intPct('TEACHER_DISCOUNT_PERCENT', 10),
      url: process.env.GOVX_TEACHER_URL || null }
  ].filter(b => b.url);

  return ok(res, {
    supabaseUrl: url,
    supabaseAnonKey: anonKey,
    stripeKey: stripeKey || null,
    discountBanners,
    // Legacy fields — kept for any cached client; new clients use
    // discountBanners. Will be removed in a future version.
    veteranVerifyUrl: discountBanners.find(b => b.id === 'veteran')?.url || null,
    veteranDiscountPercent: discountBanners.find(b => b.id === 'veteran')?.percent || 10
  });
}
