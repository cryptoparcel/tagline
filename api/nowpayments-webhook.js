// NowPayments IPN (webhook) handler.
//
// Mirrors api/stripe-webhook.js architecture:
//   1. Read raw body (bodyParser disabled — needed for HMAC verification)
//   2. Verify HMAC-SHA512 signature against IPN_SECRET
//   3. Insert event_id into processed_webhook_events (idempotency)
//   4. Process based on payment_status
//   5. On handler error, DELETE the idempotency row so retries re-process
//
// IPN payload shape (per NowPayments docs):
//   {
//     payment_id, payment_status, pay_address, price_amount,
//     price_currency, pay_amount, pay_currency, order_id,
//     order_description, ipn_id, invoice_id, ...
//   }
//
// payment_status values we care about:
//   - finished              → mark order paid, decrement stock, send email
//   - failed / expired      → mark order cancelled
//   - confirming / waiting  → no action (interim states)

import { getSupabaseAdmin } from '../lib/supabase.js';
import { sendEmail, orderConfirmationHtml } from '../lib/email.js';
import { verifyIPN, isConfigured } from '../lib/nowpayments.js';
import { escapeHtml } from '../lib/html.js';

export const config = {
  api: { bodyParser: false }
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

  if (!isConfigured()) {
    console.error('NowPayments env vars not configured — webhook fired anyway?');
    res.status(503).end();
    return;
  }

  const sig = req.headers['x-nowpayments-sig'];
  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (err) {
    res.status(400).send('Could not read body');
    return;
  }

  const verified = verifyIPN(rawBody, sig);
  if (!verified.ok) {
    console.error('NowPayments IPN signature failed:', verified.error);
    res.status(400).send(`IPN verification failed`);
    return;
  }
  const payload = verified.payload;

  // NowPayments doesn't have a stable event-id like Stripe, but `payment_id +
  // updated_at` (or just payment_id + status) gives us a unique-enough key
  // for idempotent dedup. Use payment_id + status — NP can re-deliver the
  // same status update, but a transition from "confirming" → "finished" is
  // a different event we want to process.
  const eventKey = `np:${payload.payment_id || payload.invoice_id || ''}:${payload.payment_status || ''}`;
  if (!payload.payment_id && !payload.invoice_id) {
    console.error('NowPayments IPN missing payment_id / invoice_id', payload);
    res.status(400).send('Missing identifiers');
    return;
  }

  const supabase = getSupabaseAdmin();

  // ============ IDEMPOTENCY ============
  const { error: dedupeError } = await supabase
    .from('processed_webhook_events')
    .insert({ event_id: eventKey, event_type: `nowpayments.${payload.payment_status}` });
  if (dedupeError) {
    if (dedupeError.code === '23505') {
      res.status(200).send('OK (duplicate, ignored)');
      return;
    }
    console.error('Idempotency insert failed:', dedupeError);
    res.status(500).send('DB error');
    return;
  }

  try {
    const status = payload.payment_status;

    if (status === 'finished') {
      await handlePaid(payload, supabase);
    } else if (status === 'failed' || status === 'expired' || status === 'refunded') {
      // refunded / failed / expired → mark cancelled (refunded handled separately if we ever issue them)
      const newStatus = status === 'refunded' ? 'refunded' : 'cancelled';
      await supabase
        .from('orders')
        .update({ status: newStatus })
        .eq('nowpayments_invoice_id', String(payload.invoice_id || ''))
        .neq('status', 'paid'); // don't overwrite a paid order
    }
    // confirming / waiting / partially_paid → no action
  } catch (err) {
    // Roll back idempotency row so Stripe-style retry actually re-processes
    await supabase
      .from('processed_webhook_events')
      .delete()
      .eq('event_id', eventKey)
      .then(() => {}, () => {});
    console.error('NowPayments IPN handler error:', err);
    res.status(500).send('Handler error');
    return;
  }

  res.status(200).send('OK');
}

async function handlePaid(payload, supabase) {
  const invoiceId = String(payload.invoice_id || '');
  if (!invoiceId) return;

  const { data: order, error: fetchError } = await supabase
    .from('orders')
    .select('*')
    .eq('nowpayments_invoice_id', invoiceId)
    .maybeSingle();
  if (fetchError || !order) {
    console.error('Order not found for invoice', invoiceId, fetchError);
    return;
  }
  if (order.status === 'paid') return; // already done

  // Mark paid
  const { error: updateError } = await supabase
    .from('orders')
    .update({ status: 'paid', updated_at: new Date().toISOString() })
    .eq('id', order.id);
  if (updateError) {
    console.error('Failed to mark order paid:', updateError);
    return;
  }

  // Decrement stock atomically (same RPC the Stripe webhook uses).
  // RPC returns boolean — flag oversold cases for manual handling.
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
      console.error('OVERSOLD (crypto)', { order_id: order.id, product_id: item.product_id, qty: item.quantity });
      oversold.push({ product_id: item.product_id, qty: item.quantity, reason: 'insufficient_stock' });
    }
  }
  if (oversold.length > 0) {
    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail) {
      const lines = oversold.map(o => `- ${escapeHtml(o.product_id)} x${o.qty} (${o.reason})`).join('<br/>');
      sendEmail({
        to: adminEmail,
        subject: `[TAGLINE] OVERSOLD (crypto) — order ${escapeHtml(order.id)}`,
        html: `
          <p><strong>Manual action required.</strong> One or more items in a paid crypto order could not be decremented from stock.</p>
          <p>Order: ${escapeHtml(order.id)}</p>
          <p>Customer: ${escapeHtml(order.email || '')}</p>
          <p>Affected items:<br/>${lines}</p>
        `
      }).catch(err => console.error('Oversell notification failed:', err));
    }
  }

  // Add to subscribers (best effort)
  if (order.email) {
    await supabase
      .from('subscribers')
      .upsert(
        { email: order.email.toLowerCase(), source: 'checkout-crypto', active: true },
        { onConflict: 'email' }
      );
  }

  // Confirmation email (best effort)
  if (order.email) {
    sendEmail({
      to: order.email,
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
      subject: `[TAGLINE] New crypto order — $${(order.total_cents / 100).toFixed(2)}`,
      html: `
        <p>New crypto order from ${escapeHtml(order.email)}</p>
        <p>Order ID: ${escapeHtml(order.id)}</p>
        <p>Total: $${(order.total_cents / 100).toFixed(2)}</p>
        <p>Items: ${itemsList}</p>
        <p>Paid in: ${escapeHtml(payload.pay_currency || 'crypto')}</p>
      `
    }).catch(err => console.error('Admin notify failed:', err));
  }
}
