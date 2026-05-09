// Customer self-service: cancel a pending order before it's been paid.
//
// Flow:
//   - Auth: signed-in user (Supabase JWT). Guests can't cancel; their
//     stale pending orders get swept by api/cleanup-pending.
//   - Body: { order_id }
//   - Allowed only when status='pending' AND user_id matches the caller.
//   - For Stripe orders: best-effort expire the checkout session so the
//     user can't accidentally pay an already-cancelled order from a
//     stale tab. We don't fail the cancel if Stripe rejects (session
//     might already be expired or non-existent).
//   - For NowPayments crypto orders: just mark cancelled locally.
//     NowPayments invoices auto-expire on their side.
//
// Returns 200 + { cancelled: true } on success.

import { getSupabaseAdmin, getUserFromRequest } from '../lib/supabase.js';
import {
  requireMethod, getBody, ok, badRequest, unauthorized, serverError,
  rateLimit, getClientId, requireSameOrigin
} from '../lib/util.js';
import { getStripe } from '../lib/stripe.js';

export const config = {
  api: {
    bodyParser: { sizeLimit: '1kb' }
  }
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  if (!requireSameOrigin(req, res)) return;

  const user = await getUserFromRequest(req);
  if (!user) return unauthorized(res, 'Sign in required.');

  // Light rate limit — cancellation is per-user but spamming the endpoint
  // would still hit Stripe; cap at 10 / minute per (user, IP).
  if (!rateLimit(`cancel-order:${user.id}:${getClientId(req)}`, { windowMs: 60_000, max: 10 })) {
    return badRequest(res, 'Too many requests. Try again in a minute.');
  }

  const body = getBody(req);
  const orderId = body && body.order_id;
  if (!orderId || typeof orderId !== 'string' || !UUID_RE.test(orderId)) {
    return badRequest(res, 'Invalid order_id');
  }

  const supabase = getSupabaseAdmin();
  try {
    const { data: order, error: fetchErr } = await supabase
      .from('orders')
      .select('id, user_id, status, stripe_session_id, nowpayments_invoice_id')
      .eq('id', orderId)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!order) return badRequest(res, 'Order not found.');
    if (order.user_id !== user.id) return unauthorized(res, 'Not your order.');
    if (order.status !== 'pending') {
      return badRequest(res, `Only pending orders can be cancelled. This order is ${order.status}.`);
    }

    // Best-effort Stripe session expiry. Don't block cancellation on it.
    if (order.stripe_session_id) {
      try {
        const stripe = getStripe();
        await stripe.checkout.sessions.expire(order.stripe_session_id);
      } catch (err) {
        // Session may already be expired or paid (race). Log but continue.
        console.warn('Stripe session expire skipped:', err.message);
      }
    }

    const { error: updateErr } = await supabase
      .from('orders')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', orderId)
      .eq('status', 'pending'); // Re-check to avoid racing the webhook
    if (updateErr) throw updateErr;

    return ok(res, { cancelled: true });
  } catch (err) {
    console.error('Cancel order error:', err);
    return serverError(res);
  }
}
