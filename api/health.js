// Health check endpoint — for uptime monitoring (UptimeRobot, Pingdom, etc.)
// and for ourselves to quickly diagnose which dependency is broken.
//
// Returns:
//   200 { ok: true, services: { db: true, stripe: true } } — all good
//   503 { ok: false, services: { db: false, stripe: true } } — something's wrong
//
// Doesn't expose any sensitive info — just up/down per dependency.
// Cached for 30s so a flood of monitoring pings doesn't hit Supabase.
//
// Usage with UptimeRobot:
//   - Monitor type: HTTPS keyword
//   - URL: https://YOUR_DOMAIN/api/health
//   - Keyword: "ok":true
//   - Interval: 5 min (free tier)

import { getSupabaseAdmin } from '../lib/supabase.js';
import { requireMethod } from '../lib/util.js';

// Cache the health result briefly so we don't hammer Supabase. UptimeRobot
// pings every 5 min on free tier; multiple monitors / quick reloads should
// reuse this. Per-instance cache; cold starts get a fresh check.
let cached = { at: 0, body: null, status: 200 };
const CACHE_TTL_MS = 30_000;

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'GET')) return;

  const now = Date.now();
  if (cached.body && now - cached.at < CACHE_TTL_MS) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
    res.status(cached.status).send(cached.body);
    return;
  }

  const services = {
    db: false,
    stripe: !!process.env.STRIPE_SECRET_KEY,  // presence of key is "configured"
    resend: !!process.env.RESEND_API_KEY,
    nowpayments: !!(process.env.NOWPAYMENTS_API_KEY && process.env.NOWPAYMENTS_IPN_SECRET)
  };

  // Active reachability check for Supabase — a tiny query against products.
  // We don't care about the result, just that the call returned without error.
  try {
    const supabase = getSupabaseAdmin();
    const { error } = await supabase
      .from('products')
      .select('id', { count: 'exact', head: true })
      .limit(1);
    services.db = !error;
  } catch {
    services.db = false;
  }

  // nowpayments is optional (crypto checkout) — don't fail health on it
  const allOk = services.db && services.stripe && services.resend;
  const body = JSON.stringify({
    ok: allOk,
    services,
    timestamp: new Date().toISOString()
  });
  const status = allOk ? 200 : 503;

  cached = { at: now, body, status };

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
  res.status(status).send(body);
}
