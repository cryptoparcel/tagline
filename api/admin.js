import { getSupabaseAdmin } from '../lib/supabase.js';
import { sendEmail, orderShippedHtml } from '../lib/email.js';
import { getStripe } from '../lib/stripe.js';
import {
  requireMethod, getBody, ok, badRequest, serverError, requireAdmin, requireSameOrigin
} from '../lib/util.js';

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'GET', 'POST')) return;
  if (!requireSameOrigin(req, res)) return;
  // Accept either ADMIN_API_KEY (legacy) or a signed-in user with
  // profiles.is_admin = true.
  if (!await requireAdmin(req, res)) return;

  const supabase = getSupabaseAdmin();

  // GET: dashboard data
  if (req.method === 'GET') {
    try {
      const allowedViews = ['orders', 'subscribers', 'messages', 'stats', 'products'];
      const view = (req.query?.view || 'orders').toString();
      if (!allowedViews.includes(view)) {
        return badRequest(res, 'Unknown view');
      }

      if (view === 'products') {
        const { data, error } = await supabase
          .from('products')
          .select('id, name, color, price_cents, category, tag, stock, active, description, image_url, updated_at')
          .order('category', { ascending: true })
          .order('name', { ascending: true });
        if (error) throw error;
        return ok(res, { products: data });
      }

      if (view === 'orders') {
        const { data, error } = await supabase
          .from('orders')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(200);
        if (error) throw error;
        return ok(res, { orders: data });
      }

      if (view === 'subscribers') {
        const { data, error } = await supabase
          .from('subscribers')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(500);
        if (error) throw error;
        return ok(res, { subscribers: data });
      }

      if (view === 'messages') {
        const { data, error } = await supabase
          .from('contact_messages')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(200);
        if (error) throw error;
        return ok(res, { messages: data });
      }

      if (view === 'stats') {
        const [orders, subs, msgs] = await Promise.all([
          supabase.from('orders').select('total_cents, status', { count: 'exact' }).eq('status', 'paid'),
          supabase.from('subscribers').select('id', { count: 'exact', head: true }).eq('active', true),
          supabase.from('contact_messages').select('id', { count: 'exact', head: true }).eq('status', 'new')
        ]);

        const revenue = (orders.data || []).reduce((s, o) => s + (o.total_cents || 0), 0);

        return ok(res, {
          stats: {
            paid_orders: orders.count || 0,
            revenue_cents: revenue,
            active_subscribers: subs.count || 0,
            unread_messages: msgs.count || 0
          }
        });
      }

      return badRequest(res, 'Unknown view');
    } catch (err) {
      console.error('Admin GET error:', err);
      return serverError(res);
    }
  }

  // POST: update an order's status or add tracking
  if (req.method === 'POST') {
    try {
      const body = getBody(req);
      const { action, order_id, status, tracking_number, message_id, message_status } = body;

      // UUID v4 format check
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      if (action === 'update_order') {
        if (!order_id || typeof order_id !== 'string' || !uuidRegex.test(order_id)) {
          return badRequest(res, 'Invalid order_id');
        }
        const updates = { updated_at: new Date().toISOString() };
        if (status && ['pending','paid','shipped','delivered','cancelled','refunded'].includes(status)) {
          updates.status = status;
        }
        if (tracking_number) {
          // Common carrier formats are alphanumeric (UPS, FedEx, USPS, DHL).
          // Allow 8-40 chars of [A-Z0-9] (case-insensitive) to cover them all.
          if (typeof tracking_number !== 'string' || !/^[A-Z0-9]{8,40}$/i.test(tracking_number)) {
            return badRequest(res, 'Invalid tracking number');
          }
          updates.tracking_number = tracking_number.toUpperCase();
        }
        // Internal notes — admin-only annotations on the order. 4kb cap so a
        // pasted essay doesn't blow up the row size; not surfaced to customer.
        if (body.notes !== undefined) {
          if (body.notes === null || body.notes === '') {
            updates.notes = null;
          } else if (typeof body.notes === 'string' && body.notes.length <= 4000) {
            updates.notes = body.notes;
          } else {
            return badRequest(res, 'Notes must be a string under 4000 characters.');
          }
        }

        // Read the order's prior status so we only fire the "shipped" email
        // on the actual transition (not on subsequent edits to a shipped order).
        const { data: prior } = await supabase
          .from('orders')
          .select('status, email, tracking_number')
          .eq('id', order_id)
          .maybeSingle();

        const { error } = await supabase.from('orders').update(updates).eq('id', order_id);
        if (error) throw error;

        // Fire the shipped email on transition to 'shipped' (best-effort,
        // never blocks the API response).
        const becomingShipped =
          updates.status === 'shipped' && prior && prior.status !== 'shipped';
        if (becomingShipped && prior.email) {
          sendEmail({
            to: prior.email,
            subject: 'Your TAGLINE order has shipped',
            html: orderShippedHtml({
              id: order_id,
              tracking_number: updates.tracking_number || prior.tracking_number || ''
            })
          }).catch(err => console.error('Shipped email failed:', err));
        }

        return ok(res, { updated: true });
      }

      if (action === 'update_product') {
        const { product_id, name, color, price_cents, category, tag, stock, description, image_url, active } = body;
        if (!product_id || typeof product_id !== 'string' || !/^[a-z0-9-]{1,50}$/.test(product_id)) {
          return badRequest(res, 'Invalid product_id');
        }

        const updates = { updated_at: new Date().toISOString() };

        if (typeof name === 'string') {
          const trimmed = name.trim();
          if (trimmed.length === 0 || trimmed.length > 200) {
            return badRequest(res, 'Name must be 1-200 chars');
          }
          if (/[\r\n\t\x00-\x1f\x7f]/.test(trimmed)) {
            return badRequest(res, 'Name has invalid characters');
          }
          updates.name = trimmed;
        }

        if (color !== undefined) {
          if (color === null || color === '') {
            updates.color = null;
          } else if (typeof color === 'string' && color.length <= 50) {
            updates.color = color.trim();
          } else {
            return badRequest(res, 'Invalid color');
          }
        }

        if (price_cents !== undefined) {
          if (!Number.isInteger(price_cents) || price_cents < 0 || price_cents > 100000000) {
            return badRequest(res, 'price_cents must be a non-negative integer (in cents)');
          }
          updates.price_cents = price_cents;
        }

        if (category !== undefined) {
          if (typeof category !== 'string' || category.trim().length === 0 || category.length > 50) {
            return badRequest(res, 'Invalid category');
          }
          updates.category = category.trim();
        }

        if (tag !== undefined) {
          if (tag === null || tag === '') {
            updates.tag = null;
          } else if (typeof tag === 'string' && tag.length <= 50) {
            updates.tag = tag.trim();
          } else {
            return badRequest(res, 'Invalid tag');
          }
        }

        if (stock !== undefined) {
          if (!Number.isInteger(stock) || stock < 0 || stock > 1000000) {
            return badRequest(res, 'stock must be a non-negative integer');
          }
          updates.stock = stock;
        }

        if (description !== undefined) {
          if (description === null || description === '') {
            updates.description = null;
          } else if (typeof description === 'string' && description.length <= 2000) {
            updates.description = description;
          } else {
            return badRequest(res, 'Invalid description');
          }
        }

        if (image_url !== undefined) {
          if (image_url === null || image_url === '') {
            updates.image_url = null;
          } else if (typeof image_url === 'string') {
            // Allow http(s) only — defense vs javascript:/data: schemes
            if (!/^https?:\/\//i.test(image_url) || image_url.length > 1000) {
              return badRequest(res, 'image_url must be an http(s) URL');
            }
            updates.image_url = image_url;
          } else {
            return badRequest(res, 'Invalid image_url');
          }
        }

        if (active !== undefined) {
          if (typeof active !== 'boolean') return badRequest(res, 'active must be true/false');
          updates.active = active;
        }

        if (Object.keys(updates).length === 1) {
          return badRequest(res, 'No fields to update.');
        }

        const { error } = await supabase.from('products').update(updates).eq('id', product_id);
        if (error) throw error;
        return ok(res, { updated: true });
      }

      if (action === 'update_message') {
        if (!message_id || typeof message_id !== 'string' || !uuidRegex.test(message_id)) {
          return badRequest(res, 'Invalid message_id');
        }
        const valid = ['new', 'read', 'replied', 'archived'];
        if (!valid.includes(message_status)) return badRequest(res, 'invalid status');

        const { error } = await supabase
          .from('contact_messages')
          .update({ status: message_status })
          .eq('id', message_id);
        if (error) throw error;
        return ok(res, { updated: true });
      }

      // ============ REFUND ============
      // Issues a Stripe refund for the order's underlying payment intent.
      // Optional `amount_cents` for partial refunds; omit for full.
      // The Stripe webhook (charge.refunded) will also fire and write
      // status=refunded on the order, but we set it here too so the admin
      // gets immediate feedback even if the webhook is delayed.
      //
      // For NowPayments (crypto) orders, Stripe can't refund — return a
      // helpful error directing the admin to refund manually.
      if (action === 'refund_order') {
        if (!order_id || typeof order_id !== 'string' || !uuidRegex.test(order_id)) {
          return badRequest(res, 'Invalid order_id');
        }

        const { data: order, error: fetchErr } = await supabase
          .from('orders')
          .select('id, status, email, total_cents, stripe_payment_intent, nowpayments_invoice_id')
          .eq('id', order_id)
          .maybeSingle();
        if (fetchErr) throw fetchErr;
        if (!order) return badRequest(res, 'Order not found');

        if (order.status === 'refunded') {
          return badRequest(res, 'Order is already refunded.');
        }
        if (order.status === 'cancelled') {
          return badRequest(res, 'Cancelled orders have no charge to refund.');
        }
        // Crypto orders go through NowPayments — Stripe can't refund them.
        if (order.nowpayments_invoice_id && !order.stripe_payment_intent) {
          return badRequest(res, 'This order was paid in crypto via NowPayments. Refund the wallet manually and then mark the order Refunded with the status update above.');
        }
        if (!order.stripe_payment_intent) {
          return badRequest(res, 'No Stripe payment intent recorded — refund manually in the Stripe dashboard, then mark the order Refunded.');
        }

        // Optional partial-refund amount, otherwise full
        let amountCents = null;
        if (body.amount_cents !== undefined && body.amount_cents !== null && body.amount_cents !== '') {
          if (!Number.isInteger(body.amount_cents) || body.amount_cents <= 0 || body.amount_cents > order.total_cents) {
            return badRequest(res, 'amount_cents must be a positive integer no greater than the order total.');
          }
          amountCents = body.amount_cents;
        }

        try {
          const stripe = getStripe();
          const refundParams = {
            payment_intent: order.stripe_payment_intent,
            reason: 'requested_by_customer'
          };
          if (amountCents !== null) refundParams.amount = amountCents;
          const refund = await stripe.refunds.create(refundParams);

          // Mark refunded immediately (webhook will be a no-op).
          await supabase
            .from('orders')
            .update({ status: 'refunded', updated_at: new Date().toISOString() })
            .eq('id', order_id);

          return ok(res, {
            refunded: true,
            refund_id: refund.id,
            amount_cents: refund.amount,
            full_refund: amountCents === null
          });
        } catch (err) {
          console.error('Stripe refund error:', err);
          // Stripe errors carry a `message` we can show admins safely
          return serverError(res, 'Refund failed: ' + (err.message || 'Stripe API error'));
        }
      }

      return badRequest(res, 'Unknown action');
    } catch (err) {
      console.error('Admin POST error:', err);
      return serverError(res);
    }
  }
}
