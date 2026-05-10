// Product reviews API — public GET, verified-buyer POST.
//
// GET  /api/reviews?product_id=X
//   Public. Returns approved reviews newest-first plus aggregate stats
//   (count, average, distribution by star). Capped at 50 reviews per
//   request — UI shows "load more" if needed (not yet wired).
//
// POST /api/reviews
//   Auth: signed-in user (Supabase JWT).
//   Body: { product_id, order_id (optional), rating (1-5), title?, body?, display_name? }
//   Server enforces "verified buyer": user must own at least one order
//   with status in (paid, shipped, delivered) whose items[] contains
//   the product_id. Without that, 403. (You can buy a product, get
//   refunded/cancelled, and *not* be able to review — by design.)
//   On success, the review is auto-approved (status='approved') so the
//   buyer doesn't have to wait. Admin can still hide it later.

import { getSupabaseAdmin, getUserFromRequest } from '../lib/supabase.js';
import {
  requireMethod, getBody, ok, badRequest, unauthorized, serverError,
  rateLimit, getClientId, requireSameOrigin, isString
} from '../lib/util.js';

export const config = {
  api: {
    bodyParser: { sizeLimit: '8kb' }
  }
};

const PRODUCT_ID_RE = /^[a-z0-9-]{1,50}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Empty-distribution scaffold — keeps the API shape stable even when no
// reviews exist yet, so the UI never has to special-case absence.
function emptyDistribution() {
  return { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
}

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'GET', 'POST')) return;

  if (req.method === 'GET') {
    const productId = (req.query?.product_id || '').toString();
    if (!PRODUCT_ID_RE.test(productId)) {
      return badRequest(res, 'Invalid product_id.');
    }

    try {
      const supabase = getSupabaseAdmin();
      const { data, error } = await supabase
        .from('product_reviews')
        .select('id, rating, title, body, display_name, created_at')
        .eq('product_id', productId)
        .eq('status', 'approved')
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) {
        console.error('Reviews GET error:', error);
        return serverError(res, 'Could not load reviews.');
      }

      const reviews = data || [];
      const dist = emptyDistribution();
      let sum = 0;
      for (const r of reviews) {
        const k = Math.max(1, Math.min(5, r.rating | 0));
        dist[k]++;
        sum += k;
      }
      const count = reviews.length;
      const average = count > 0 ? Math.round((sum / count) * 10) / 10 : 0;

      return ok(res, {
        reviews,
        summary: { count, average, distribution: dist }
      });
    } catch (err) {
      console.error('Reviews GET handler error:', err);
      return serverError(res);
    }
  }

  // ===== POST =====
  if (!requireSameOrigin(req, res)) return;

  const user = await getUserFromRequest(req);
  if (!user) return unauthorized(res, 'Sign in to leave a review.');

  // 5 reviews per minute per user is plenty even for the chattiest buyer
  if (!rateLimit(`reviews:${user.id}:${getClientId(req)}`, { windowMs: 60_000, max: 5 })) {
    return badRequest(res, 'Too many submissions. Try again in a minute.');
  }

  const body = getBody(req);
  const productId = (body.product_id || '').toString();
  const rating = Number(body.rating);
  const title = body.title != null ? String(body.title).trim() : '';
  const text = body.body != null ? String(body.body).trim() : '';
  const displayName = body.display_name != null ? String(body.display_name).trim() : '';
  const orderIdRaw = body.order_id != null ? String(body.order_id) : '';

  if (!PRODUCT_ID_RE.test(productId)) return badRequest(res, 'Invalid product_id.');
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return badRequest(res, 'Rating must be an integer between 1 and 5.');
  }
  if (title && !isString(title, { min: 1, max: 120 })) {
    return badRequest(res, 'Title must be 1–120 characters.');
  }
  if (text && !isString(text, { min: 1, max: 2000 })) {
    return badRequest(res, 'Review body must be 1–2000 characters.');
  }
  // Strip control chars from any user-supplied text so we don't store
  // \0 / NUL bytes that would break later JSON serialization paths.
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(title + text + displayName)) {
    return badRequest(res, 'Text has invalid control characters.');
  }
  if (displayName && displayName.length > 60) {
    return badRequest(res, 'Display name must be 60 characters or fewer.');
  }
  let orderId = null;
  if (orderIdRaw) {
    if (!UUID_RE.test(orderIdRaw)) return badRequest(res, 'Invalid order_id.');
    orderId = orderIdRaw.toLowerCase();
  }

  const supabase = getSupabaseAdmin();
  try {
    // ===== Verified-buyer check =====
    // Find an order owned by the user, in a "completed" status, that
    // contains this product_id in its items[] jsonb. We accept paid,
    // shipped, or delivered (refunded/cancelled DON'T count).
    const verifiedStatuses = ['paid', 'shipped', 'delivered'];
    let q = supabase
      .from('orders')
      .select('id, status, items')
      .eq('user_id', user.id)
      .in('status', verifiedStatuses)
      .order('created_at', { ascending: false })
      .limit(50);
    if (orderId) q = q.eq('id', orderId);
    const { data: orders, error: orderErr } = await q;
    if (orderErr) {
      console.error('Reviews POST order lookup error:', orderErr);
      return serverError(res);
    }

    const matchingOrder = (orders || []).find(o =>
      Array.isArray(o.items) && o.items.some(i => i && i.product_id === productId)
    );
    if (!matchingOrder) {
      return unauthorized(res,
        'Reviews are limited to verified buyers — we can only find a review path once you have a paid or delivered order with this item.'
      );
    }

    // ===== Insert =====
    // Display name defaults to the first part of the user's name, or a
    // generic "Verified buyer" if the profile has no name set.
    const finalDisplayName = displayName ||
      (user.user_metadata?.full_name?.split(' ')?.[0] || 'Verified buyer');

    const { data: inserted, error: insertErr } = await supabase
      .from('product_reviews')
      .insert({
        product_id: productId,
        user_id: user.id,
        order_id: matchingOrder.id,
        email: (user.email || '').toLowerCase(),
        display_name: finalDisplayName,
        rating,
        title: title || null,
        body: text || null,
        status: 'approved'
      })
      .select('id, rating, title, body, display_name, created_at')
      .maybeSingle();

    if (insertErr) {
      // Unique-violation on (user_id, order_id, product_id) means the
      // user already reviewed this exact line item — don't pretend it
      // succeeded; tell them.
      if (insertErr.code === '23505') {
        return badRequest(res, 'You already reviewed this item. Edit your review from your account page to update it.');
      }
      console.error('Reviews POST insert error:', insertErr);
      return serverError(res, 'Could not save your review.');
    }

    return ok(res, { review: inserted });
  } catch (err) {
    console.error('Reviews POST handler error:', err);
    return serverError(res);
  }
}
