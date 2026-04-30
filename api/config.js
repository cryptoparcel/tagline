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

  return ok(res, {
    supabaseUrl: url,
    supabaseAnonKey: anonKey,
    stripeKey: stripeKey || null
  });
}
