// Pending order cleanup — marks abandoned 'pending' orders as 'expired'.
//
// An order is created with status='pending' before the user pays. Most
// transition to 'paid' via the webhook within a minute. Some never do —
// the user closed the tab, their card was declined, etc. Without cleanup
// these accumulate forever in the admin orders view.
//
// Triggered by Vercel Cron (configured in vercel.json) once a day. The
// CRON_SECRET env var protects the endpoint — Vercel auto-sends it as
// `Authorization: Bearer ${CRON_SECRET}` when CRON_SECRET is set in env.
// Other callers (manual curl, attackers) can't run cleanup without
// knowing the secret.
//
// Threshold: 24h. A pending order older than 24h is essentially dead —
// Stripe checkout sessions expire after 24h on Stripe's side anyway.

import { getSupabaseAdmin } from '../lib/supabase.js';
import { requireMethod, ok, unauthorized, serverError } from '../lib/util.js';
import { timingSafeEqual } from 'node:crypto';

const PENDING_TTL_HOURS = 24;

function isAuthorizedCron(req) {
  const expected = process.env.CRON_SECRET;
  if (!expected || expected.length < 16) return false;

  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!provided) return false;

  // Timing-safe comparison
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'GET', 'POST')) return;
  if (!isAuthorizedCron(req)) return unauthorized(res, 'Cron auth required.');

  try {
    const supabase = getSupabaseAdmin();
    const cutoff = new Date(Date.now() - PENDING_TTL_HOURS * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from('orders')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('status', 'pending')
      .lt('created_at', cutoff)
      .select('id');

    if (error) {
      console.error('Pending cleanup error:', error);
      return serverError(res, 'Cleanup failed.');
    }

    const count = (data || []).length;
    if (count > 0) console.log(`Cleaned up ${count} stale pending order(s).`);

    return ok(res, { cleaned: count });
  } catch (err) {
    console.error('Pending cleanup error:', err);
    return serverError(res);
  }
}
