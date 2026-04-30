import { getSupabaseAdmin } from '../lib/supabase.js';
import { getStripe } from '../lib/stripe.js';
import { getUserFromRequest } from '../lib/supabase.js';
import {
  requireMethod, getBody, ok, badRequest, serverError,
  rateLimit, getClientId
} from '../lib/util.js';

// Body shape:
// { items: [{ product_id: 'ascend-hoodie', quantity: 1 }, ...] }
//
// Why we re-fetch products from the DB instead of trusting the cart:
// Never trust prices from the browser. A user could submit { price_cents: 1 }
// and you'd lose money. We look up real prices server-side.

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  const clientId = getClientId(req);
  if (!rateLimit(`checkout:${clientId}`, { windowMs: 60_000, max: 10 })) {
    return badRequest(res, 'Too many checkout attempts. Please slow down.');
  }

  const body = getBody(req);
  const items = Array.isArray(body.items) ? body.items : null;
  if (!items || items.length === 0) {
    return badRequest(res, 'Your cart is empty.');
  }
  if (items.length > 50) {
    return badRequest(res, 'Too many items in cart.');
  }

  // Validate item shape
  const VALID_SIZES = ['XS','S','M','L','XL','XXL'];
  for (const item of items) {
    if (typeof item.product_id !== 'string' || !/^[a-z0-9-]{1,50}$/.test(item.product_id)) {
      return badRequest(res, 'Invalid product ID.');
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 10) {
      return badRequest(res, 'Invalid quantity (1-10 per item).');
    }
    // Size is optional but must be one of the allowed values if present
    if (item.size !== undefined && (typeof item.size !== 'string' || VALID_SIZES.indexOf(item.size) === -1)) {
      return badRequest(res, 'Invalid size.');
    }
  }

  try {
    const supabase = getSupabaseAdmin();
    const stripe = getStripe();
    const user = await getUserFromRequest(req); // null if guest checkout

    // Fetch the real products
    const productIds = items.map(i => i.product_id);
    const { data: products, error } = await supabase
      .from('products')
      .select('id, name, color, price_cents, stock, active')
      .in('id', productIds);

    if (error) {
      console.error('Products fetch error:', error);
      return serverError(res, 'Could not load products.');
    }

    // Build a price map and check stock
    const productMap = new Map(products.map(p => [p.id, p]));
    const lineItems = [];
    const orderItems = [];
    let subtotal = 0;

    for (const item of items) {
      const product = productMap.get(item.product_id);
      if (!product) {
        return badRequest(res, `Product not found: ${item.product_id}`);
      }
      if (!product.active) {
        return badRequest(res, `${product.name} is no longer available.`);
      }
      if (product.stock < item.quantity) {
        return badRequest(res, `Only ${product.stock} of ${product.name} left.`);
      }

      const lineTotal = product.price_cents * item.quantity;
      subtotal += lineTotal;

      // Build description with size if present
      const descParts = [];
      if (product.color) descParts.push(product.color);
      if (item.size) descParts.push('Size ' + item.size);
      const description = descParts.length ? descParts.join(' · ') : undefined;

      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: product.name,
            description: description
          },
          unit_amount: product.price_cents
        },
        quantity: item.quantity
      });

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

    const siteUrl = process.env.SITE_URL;
    if (!siteUrl || !/^https:\/\//.test(siteUrl)) {
      console.error('SITE_URL env var missing or not HTTPS');
      return serverError(res, 'Server is not properly configured.');
    }
    let customerEmail = user?.email;
    if (!customerEmail && body.email) {
      const trimmed = String(body.email).trim().toLowerCase();
      if (trimmed.length > 0 && trimmed.length < 255 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
        customerEmail = trimmed;
      }
    }

    // Create the Checkout Session
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: lineItems,
      // Free shipping over $150, $8 otherwise
      shipping_options: [
        {
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: { amount: subtotal >= 15000 ? 0 : 800, currency: 'usd' },
            display_name: subtotal >= 15000 ? 'Free shipping' : 'Standard shipping (5-7 business days)',
            delivery_estimate: {
              minimum: { unit: 'business_day', value: 5 },
              maximum: { unit: 'business_day', value: 7 }
            }
          }
        }
      ],
      shipping_address_collection: {
        allowed_countries: ['US', 'CA']
      },
      automatic_tax: { enabled: false }, // turn on once you set up tax in Stripe
      success_url: `${siteUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/cart`,
      customer_email: customerEmail,
      metadata: {
        user_id: user?.id || '',
        items: JSON.stringify(orderItems).slice(0, 500) // metadata has 500 char limit per field
      },
      payment_intent_data: {
        metadata: {
          user_id: user?.id || ''
        }
      }
    });

    // Create a pending order so we have a record even before payment completes
    const { error: orderError } = await supabase
      .from('orders')
      .insert({
        user_id: user?.id || null,
        email: customerEmail || 'unknown@pending.local',
        status: 'pending',
        stripe_session_id: session.id,
        subtotal_cents: subtotal,
        shipping_cents: subtotal >= 15000 ? 0 : 800,
        tax_cents: 0,
        total_cents: subtotal + (subtotal >= 15000 ? 0 : 800),
        items: orderItems
      });

    if (orderError) {
      console.error('Pending order insert failed:', orderError);
      // Don't block - we'll still recover via webhook
    }

    return ok(res, { url: session.url, session_id: session.id });
  } catch (err) {
    console.error('Checkout error:', err);
    return serverError(res, 'Could not create checkout session.');
  }
}
