import { getStripe } from '../lib/stripe.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { sendEmail, orderConfirmationHtml } from '../lib/email.js';
import { escapeHtml } from '../lib/html.js';

// Vercel needs raw body for signature verification
export const config = {
  api: {
    bodyParser: false
  }
};

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).end();
    return;
  }

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET not configured');
    res.status(500).end();
    return;
  }

  let event;
  try {
    const stripe = getStripe();
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  const supabase = getSupabaseAdmin();

  // ============ IDEMPOTENCY ============
  // Stripe can re-deliver the same event (network blips, our 5xx replies).
  // Insert event.id into processed_webhook_events first; if the insert
  // collides on the primary key, this event was already handled and we
  // ack with 200 immediately. Prevents double stock decrement, duplicate
  // confirmation emails, etc.
  //
  // Reference: Stripe docs — "Best practices for using webhooks" →
  // "Make your event processing idempotent".
  const { error: dedupeError } = await supabase
    .from('processed_webhook_events')
    .insert({ event_id: event.id, event_type: event.type });

  if (dedupeError) {
    // Postgres unique_violation = already processed
    if (dedupeError.code === '23505') {
      res.status(200).send('OK (duplicate, ignored)');
      return;
    }
    // Some other DB error — return 500 so Stripe retries.
    // The retry will hit the same path; either it'll succeed (transient
    // DB error) or collide (we managed to insert + process anyway).
    console.error('Idempotency insert failed:', dedupeError);
    res.status(500).send('DB error');
    return;
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        await handleCheckoutCompleted(session, supabase);
        break;
      }
      case 'checkout.session.expired': {
        const session = event.data.object;
        await supabase
          .from('orders')
          .update({ status: 'cancelled' })
          .eq('stripe_session_id', session.id)
          .eq('status', 'pending');
        break;
      }
      case 'charge.refunded': {
        const charge = event.data.object;
        await supabase
          .from('orders')
          .update({ status: 'refunded' })
          .eq('stripe_payment_intent', charge.payment_intent);
        break;
      }
      default:
        // Unhandled event types are fine — Stripe sends many we don't need
        break;
    }
  } catch (err) {
    // Processing failed. Roll back the idempotency insert so Stripe's
    // retry actually re-processes (instead of seeing a "duplicate" we
    // never finished). Best-effort delete — if it fails, the worst case
    // is the event is lost; the original error is still the priority.
    await supabase
      .from('processed_webhook_events')
      .delete()
      .eq('event_id', event.id)
      .then(() => {}, () => {});
    console.error(`Error handling ${event.type}:`, err);
    // Return 500 so Stripe retries
    res.status(500).send('Handler error');
    return;
  }

  res.status(200).send('OK');
}

async function handleCheckoutCompleted(session, supabase) {
  // Find the pending order
  const { data: order, error: fetchError } = await supabase
    .from('orders')
    .select('*')
    .eq('stripe_session_id', session.id)
    .single();

  if (fetchError || !order) {
    console.error('Order not found for session', session.id, fetchError);
    return;
  }

  if (order.status === 'paid') {
    // Already processed (Stripe sometimes sends duplicate events)
    return;
  }

  const customerEmail = session.customer_details?.email || order.email;
  const shippingAddress = session.shipping_details?.address || null;

  // Mark order paid
  const { error: updateError } = await supabase
    .from('orders')
    .update({
      status: 'paid',
      email: customerEmail,
      stripe_payment_intent: session.payment_intent,
      shipping_address: shippingAddress
        ? {
            name: session.shipping_details.name,
            line1: shippingAddress.line1,
            line2: shippingAddress.line2,
            city: shippingAddress.city,
            state: shippingAddress.state,
            zip: shippingAddress.postal_code,
            country: shippingAddress.country
          }
        : null,
      updated_at: new Date().toISOString()
    })
    .eq('id', order.id);

  if (updateError) {
    console.error('Failed to mark order paid:', updateError);
    return;
  }

  // Decrement stock for each item using the atomic RPC. The RPC returns
  // boolean — true if it decremented, false if stock was insufficient
  // (oversold case). When oversold, log loudly and notify admin so they
  // can refund + email the customer manually. Don't try to refund here:
  // partial refunds for partial overdraws need human judgment, and we
  // don't want to mishandle a successful payment in webhook code.
  const oversold = [];
  for (const item of order.items) {
    const { data: ok, error: stockError } = await supabase.rpc('decrement_stock', {
      product_id: item.product_id,
      qty: item.quantity
    });
    if (stockError) {
      console.error('decrement_stock RPC error', { product_id: item.product_id, qty: item.quantity, err: stockError });
      oversold.push({ product_id: item.product_id, qty: item.quantity, reason: 'rpc_error' });
      continue;
    }
    if (ok === false) {
      console.error('OVERSOLD', { order_id: order.id, product_id: item.product_id, qty: item.quantity });
      oversold.push({ product_id: item.product_id, qty: item.quantity, reason: 'insufficient_stock' });
    }
  }
  if (oversold.length > 0) {
    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail) {
      const lines = oversold.map(o => `- ${escapeHtml(o.product_id)} x${o.qty} (${o.reason})`).join('<br/>');
      sendEmail({
        to: adminEmail,
        subject: `[TAGLINE] OVERSOLD — order ${escapeHtml(order.id)}`,
        html: `
          <p><strong>Manual action required.</strong> One or more line items in a paid order could not be decremented from stock.</p>
          <p>Order: ${escapeHtml(order.id)}</p>
          <p>Customer: ${escapeHtml(customerEmail || order.email)}</p>
          <p>Affected items:<br/>${lines}</p>
          <p>You'll likely want to refund the affected items and email the customer.</p>
        `
      }).catch(err => console.error('Oversell notification failed:', err));
    }
  }

  // Add to subscribers (best effort)
  if (customerEmail) {
    await supabase
      .from('subscribers')
      .upsert(
        { email: customerEmail.toLowerCase(), source: 'checkout', active: true },
        { onConflict: 'email' }
      );
  }

  // Send confirmation email (best effort)
  if (customerEmail) {
    sendEmail({
      to: customerEmail,
      subject: `Order confirmed — TAGLINE`,
      html: orderConfirmationHtml(order)
    }).catch(err => console.error('Confirmation email failed:', err));
  }

  // Notify admin
  const adminEmail = process.env.ADMIN_EMAIL;
  if (adminEmail) {
    const itemsList = order.items
      .map(i => `${escapeHtml(i.name)} x${escapeHtml(String(i.quantity))}`)
      .join(', ');
    sendEmail({
      to: adminEmail,
      subject: `[TAGLINE] New order — $${(order.total_cents / 100).toFixed(2)}`,
      html: `
        <p>New order from ${escapeHtml(customerEmail)}</p>
        <p>Order ID: ${escapeHtml(order.id)}</p>
        <p>Total: $${(order.total_cents / 100).toFixed(2)}</p>
        <p>Items: ${itemsList}</p>
      `
    }).catch(err => console.error('Admin notify failed:', err));
  }
}

