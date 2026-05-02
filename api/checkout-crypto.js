// Crypto checkout via NowPayments — mirrors api/checkout.js but creates
// a NowPayments invoice instead of a Stripe Checkout Session.
//
// Same defensive posture as Stripe checkout:
//   - Same-origin (CSRF) check
//   - Server re-fetches real prices from DB, never trusts client-sent prices
//   - Stock validation
//   - Pending order row created BEFORE payment so the webhook always has
//     a row to update (idempotent).
//
// Returns 503 if NowPayments env vars aren't set, so the cart UI can
// hide the "Pay with crypto" button gracefully.

import { getSupabaseAdmin } from '../lib/supabase.js';
import { getUserFromRequest } from '../lib/supabase.js';
import { createInvoice, isConfigured } from '../lib/nowpayments.js';
import {
  requireMethod, getBody, ok, badRequest, serverError,
  rateLimit, getClientId, requireSameOrigin
} from '../lib/util.js';

export const config = {
  api: {
    bodyParser: { sizeLimit: '8kb' }
  }
};

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  if (!requireSameOrigin(req, res)) return;

  if (!isConfigured()) {
    res.status(503).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ ok: false, error: 'Crypto payment is not configured yet.', not_configured: true }));
    return;
  }

  const clientId = getClientId(req);
  if (!rateLimit(`checkout-crypto:${clientId}`, { windowMs: 60_000, max: 10 })) {
    return badRequest(res, 'Too many checkout attempts. Please slow down.');
  }

  const body = getBody(req);
  const items = Array.isArray(body.items) ? body.items : null;
  if (!items || items.length === 0) return badRequest(res, 'Your cart is empty.');
  if (items.length > 50) return badRequest(res, 'Too many items in cart.');

  // Validate item shape (same rules as api/checkout.js)
  const VALID_SIZES = ['XS','S','M','L','XL','XXL'];
  for (const item of items) {
    if (typeof item.product_id !== 'string' || !/^[a-z0-9-]{1,50}$/.test(item.product_id)) {
      return badRequest(res, 'Invalid product ID.');
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 10) {
      return badRequest(res, 'Invalid quantity (1-10 per item).');
    }
    if (item.size !== undefined && (typeof item.size !== 'string' || VALID_SIZES.indexOf(item.size) === -1)) {
      return badRequest(res, 'Invalid size.');
    }
  }

  const siteUrl = process.env.SITE_URL;
  if (!siteUrl || !/^https:\/\//.test(siteUrl)) {
    console.error('SITE_URL env var missing or not HTTPS');
    return serverError(res, 'Server is not properly configured.');
  }

  try {
    const supabase = getSupabaseAdmin();
    const user = await getUserFromRequest(req); // null if guest

    const productIds = items.map(i => i.product_id);
    const { data: products, error } = await supabase
      .from('products')
      .select('id, name, color, price_cents, stock, active')
      .in('id', productIds);
    if (error) {
      console.error('Products fetch error:', error);
      return serverError(res, 'Could not load products.');
    }

    const productMap = new Map(products.map(p => [p.id, p]));
    const orderItems = [];
    let subtotal = 0;
    for (const item of items) {
      const product = productMap.get(item.product_id);
      if (!product) return badRequest(res, `Product not found: ${item.product_id}`);
      if (!product.active) return badRequest(res, `${product.name} is no longer available.`);
      if (product.stock < item.quantity) return badRequest(res, `Only ${product.stock} of ${product.name} left.`);

      subtotal += product.price_cents * item.quantity;
      const orderItem = {
        product_id: product.id,
        name: product.name,
        color: product.color,
        price_cents: product.price_cents,
        quantity: item.quantity
      };
      if (item.size) orderItem.size = item.size;
      orderItems.push(orderItem);
    }

    // Same shipping logic as Stripe path: free over $150, $8 otherwise
    const shipping = subtotal >= 15000 ? 0 : 800;
    const total = subtotal + shipping;

    let customerEmail = user?.email;
    if (!customerEmail && body.email) {
      const trimmed = String(body.email).trim().toLowerCase();
      if (trimmed.length > 0 && trimmed.length < 255 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
        customerEmail = trimmed;
      }
    }
    // NowPayments doesn't collect email itself, so we require one for crypto orders
    if (!customerEmail) {
      return badRequest(res, 'Email required for crypto checkout.');
    }

    // Create pending order BEFORE the invoice so the IPN webhook can find it
    const { data: orderRow, error: orderError } = await supabase
      .from('orders')
      .insert({
        user_id: user?.id || null,
        email: customerEmail,
        status: 'pending',
        subtotal_cents: subtotal,
        shipping_cents: shipping,
        tax_cents: 0,
        total_cents: total,
        items: orderItems
      })
      .select('id')
      .single();
    if (orderError || !orderRow) {
      console.error('Pending order insert failed:', orderError);
      return serverError(res, 'Could not create order.');
    }
    const orderId = orderRow.id;

    // Create the NowPayments invoice
    const description = `TAGLINE order #${orderId.slice(0, 8).toUpperCase()}`;
    const ipnUrl = `${siteUrl}/api/nowpayments-webhook`;
    let invoice;
    try {
      invoice = await createInvoice({
        priceUsdCents: total,
        orderId,
        description,
        ipnUrl,
        successUrl: `${siteUrl}/success?order=${orderId}`,
        cancelUrl: `${siteUrl}/cart`
      });
    } catch (err) {
      console.error('NowPayments invoice creation failed:', err);
      // Mark the pending order cancelled so it doesn't sit forever
      await supabase.from('orders').update({ status: 'cancelled' }).eq('id', orderId);
      return serverError(res, 'Could not start crypto checkout.');
    }

    // Stash the invoice id on the order so the IPN can find it
    if (invoice.id) {
      await supabase
        .from('orders')
        .update({ nowpayments_invoice_id: String(invoice.id) })
        .eq('id', orderId);
    }

    return ok(res, { url: invoice.invoice_url, invoice_id: invoice.id });
  } catch (err) {
    console.error('Crypto checkout error:', err);
    return serverError(res, 'Could not create crypto checkout.');
  }
}
