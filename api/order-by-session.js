// Public lookup of a recently-placed order, used by /success to show
// order details right after checkout. The Stripe Checkout flow
// redirects the customer to /success?session_id={CHECKOUT_SESSION_ID};
// NowPayments redirects to /success?order={order_uuid}.
//
// Two query params accepted:
//   ?session_id=cs_test_...     → look up by stripe_session_id
//   ?order=<uuid>               → look up by id (NowPayments path)
//
// Privacy: returns ONLY what's needed to confirm the order to the
// customer who just placed it — order ID, status, items, totals,
// created_at. Does NOT return email or shipping address (with the
// session_id alone, an attacker shouldn't be able to harvest PII).
//
// Cache: short Cache-Control so revisits are quick but stale data
// doesn't linger if status changes.

import { getSupabaseAdmin } from '../lib/supabase.js';
import { requireMethod, ok, badRequest, serverError, notFound } from '../lib/util.js';

const SESSION_ID_RE = /^[A-Za-z0-9_]{16,256}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'GET')) return;

  const sessionId = (req.query?.session_id || '').toString();
  const orderId = (req.query?.order || '').toString();

  let query;
  let lookupBy;
  try {
    const supabase = getSupabaseAdmin();
    query = supabase
      .from('orders')
      .select('id, status, subtotal_cents, shipping_cents, tax_cents, total_cents, items, created_at, tracking_number');

    if (sessionId) {
      if (!SESSION_ID_RE.test(sessionId)) return badRequest(res, 'Invalid session_id');
      query = query.eq('stripe_session_id', sessionId);
      lookupBy = 'stripe';
    } else if (orderId) {
      if (!UUID_RE.test(orderId)) return badRequest(res, 'Invalid order id');
      query = query.eq('id', orderId);
      lookupBy = 'order';
    } else {
      return badRequest(res, 'session_id or order required');
    }

    const { data, error } = await query.maybeSingle();
    if (error) {
      console.error('Order lookup error:', error);
      return serverError(res, 'Could not look up order.');
    }
    if (!data) {
      // Don't differentiate "not found" from "wrong key" — just 404 either way
      return notFound(res, 'Order not found.');
    }

    // 30-second cache; status changes within minutes when webhook fires
    res.setHeader('Cache-Control', 'private, max-age=15, stale-while-revalidate=60');
    return ok(res, {
      order: {
        id: data.id,
        short_id: data.id.slice(0, 8).toUpperCase(),
        status: data.status,
        subtotal_cents: data.subtotal_cents,
        shipping_cents: data.shipping_cents,
        tax_cents: data.tax_cents,
        total_cents: data.total_cents,
        items: data.items || [],
        created_at: data.created_at,
        tracking_number: data.tracking_number || null,
        payment_method: lookupBy === 'stripe' ? 'card' : 'crypto'
      }
    });
  } catch (err) {
    console.error('Order lookup error:', err);
    return serverError(res);
  }
}
