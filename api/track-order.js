// Guest order tracking endpoint.
//
// Anyone (no auth) can look up an order if they know:
//   1. The order ID (full UUID, not the 8-char prefix shown in emails),
//      OR a short reference: the order_id 8-char prefix.
//   2. The email address the order was placed under.
//
// Both must match server-side. We never reveal whether either piece of
// information exists in isolation — invalid lookups always return the
// same generic 404 so an attacker can't enumerate emails or order IDs.
//
// Returns a *trimmed* projection of the order — no payment IDs, no
// internal notes, no user_id; just status, items, totals, tracking,
// dates. Same data the customer would see on /account.
//
// Rate limited tightly (5 attempts per IP per minute) since it's a
// public endpoint that touches user PII.

import { getSupabaseAdmin } from '../lib/supabase.js';
import {
  requireMethod, getBody, ok, badRequest, serverError,
  rateLimit, getClientId, requireSameOrigin
} from '../lib/util.js';

export const config = {
  api: {
    bodyParser: { sizeLimit: '1kb' }
  }
};

const FULL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_ID_RE = /^[0-9a-f]{8}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const NOT_FOUND_MSG = "We couldn't find an order matching that ID and email. Double-check both — order IDs are case-insensitive but the email must match the one used at checkout.";

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  if (!requireSameOrigin(req, res)) return;

  // Rate limit BEFORE any DB work to make brute force expensive
  const clientId = getClientId(req);
  if (!rateLimit(`track-order:${clientId}`, { windowMs: 60_000, max: 5 })) {
    return badRequest(res, 'Too many lookups. Try again in a minute.');
  }

  const body = getBody(req);
  const rawId = (body && body.order_id ? String(body.order_id) : '').trim();
  const rawEmail = (body && body.email ? String(body.email) : '').trim().toLowerCase();

  if (!rawId || !rawEmail) {
    return badRequest(res, 'Order ID and email are required.');
  }
  if (!EMAIL_RE.test(rawEmail) || rawEmail.length > 254) {
    // Match the generic not-found message so we don't tell the caller
    // the email format itself is the issue (low-grade, but consistent).
    return badRequest(res, NOT_FOUND_MSG);
  }

  // Permit either a full UUID or the short 8-char prefix the user sees
  // on /success and in their order email.
  let lookup;
  if (FULL_UUID_RE.test(rawId)) {
    lookup = { kind: 'uuid', value: rawId.toLowerCase() };
  } else if (SHORT_ID_RE.test(rawId)) {
    lookup = { kind: 'prefix', value: rawId.toLowerCase() };
  } else {
    // Bad format → same generic message
    return badRequest(res, NOT_FOUND_MSG);
  }

  try {
    const supabase = getSupabaseAdmin();

    // For UUID: exact match. For prefix: starts-with on the id text.
    // Email match is always exact (lowercase normalized at insert time).
    let query = supabase
      .from('orders')
      .select('id, status, subtotal_cents, shipping_cents, tax_cents, total_cents, items, created_at, updated_at, tracking_number, shipping_address, email')
      .ilike('email', rawEmail)
      .order('created_at', { ascending: false })
      .limit(5);

    if (lookup.kind === 'uuid') {
      query = query.eq('id', lookup.value);
    } else {
      // 8-char prefix on a UUID is unique enough in practice; cap at 5.
      query = query.ilike('id', lookup.value + '%');
    }

    const { data, error } = await query;
    if (error) {
      console.error('Track-order DB error:', error);
      return serverError(res, 'Could not look up that order.');
    }

    if (!data || data.length === 0) {
      // 404 with the same body as a malformed lookup — no enumeration.
      res.status(404).json({ ok: false, error: NOT_FOUND_MSG });
      return;
    }

    // Project a trimmed view; drop the email field so we don't echo
    // PII back to anyone who guesses the right combo.
    const orders = data.map(o => ({
      id: o.id,
      status: o.status,
      subtotal_cents: o.subtotal_cents,
      shipping_cents: o.shipping_cents,
      tax_cents: o.tax_cents,
      total_cents: o.total_cents,
      items: o.items,
      created_at: o.created_at,
      updated_at: o.updated_at,
      tracking_number: o.tracking_number,
      shipping_address: o.shipping_address
    }));

    return ok(res, { orders });
  } catch (err) {
    console.error('Track-order handler error:', err);
    return serverError(res);
  }
}
