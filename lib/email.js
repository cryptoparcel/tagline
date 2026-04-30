import { Resend } from 'resend';
import { escapeHtml } from './html.js';

let cached = null;

export function getResend() {
  if (cached) return cached;
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    throw new Error('Missing RESEND_API_KEY env var.');
  }
  cached = new Resend(key);
  return cached;
}

export async function sendEmail({ to, subject, html, replyTo }) {
  const from = process.env.FROM_EMAIL;
  if (!from) {
    console.warn('FROM_EMAIL not set, skipping email.');
    return { skipped: true };
  }

  try {
    const resend = getResend();
    const result = await resend.emails.send({
      from: `TAGLINE <${from}>`,
      to,
      subject,
      html,
      ...(replyTo ? { reply_to: replyTo } : {})
    });
    return result;
  } catch (err) {
    console.error('Email send failed:', err);
    // Don't throw — emails are non-critical for the API response
    return { error: err.message };
  }
}

// Order confirmation HTML — simple, tested in major email clients
export function orderConfirmationHtml(order) {
  const itemsHtml = order.items.map(it => `
    <tr>
      <td style="padding:12px 0;border-bottom:1px solid #eee">
        <div style="font-weight:600;color:#0c1422">${escapeHtml(it.name)}</div>
        <div style="font-size:13px;color:#6b7689">${escapeHtml(it.color || '')} · Qty ${it.quantity}</div>
      </td>
      <td style="padding:12px 0;border-bottom:1px solid #eee;text-align:right;color:#0c1422;font-weight:600">
        $${((it.price_cents * it.quantity) / 100).toFixed(2)}
      </td>
    </tr>
  `).join('');

  return `
<!DOCTYPE html>
<html><body style="font-family:-apple-system,sans-serif;background:#fafaf6;padding:32px;margin:0">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-radius:12px;overflow:hidden">
    <div style="background:#08080a;padding:32px;text-align:center">
      <div style="color:#fafaf7;font-size:18px;font-weight:600;letter-spacing:.24em">TAGLINE</div>
    </div>
    <div style="padding:40px 32px">
      <h1 style="margin:0 0 8px;font-size:24px;color:#0c1422">Thank you for your order.</h1>
      <p style="margin:0 0 24px;color:#6b7689;font-size:15px">
        Order #${order.id.slice(0, 8).toUpperCase()} · We'll send tracking info as soon as it ships.
      </p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
        ${itemsHtml}
      </table>
      <div style="border-top:2px solid #0c1422;padding-top:16px;display:flex;justify-content:space-between">
        <span style="font-weight:600;color:#0c1422">Total</span>
        <span style="font-weight:600;color:#0c1422">$${(order.total_cents / 100).toFixed(2)}</span>
      </div>
    </div>
    <div style="padding:24px 32px;background:#f5f3ee;color:#6b7689;font-size:13px;text-align:center">
      Questions? Reply to this email.
    </div>
  </div>
</body></html>
  `;
}

