// Daily low-stock email — runs as a Vercel cron job at 06:00 UTC.
//
// Scans the products table for active SKUs whose stock has fallen
// below LOW_STOCK_THRESHOLD (default 3). Emails ADMIN_EMAIL with a
// summary so the owner can restock before the SKU goes fully out
// (which is when sales actually stop).
//
// Threshold rationale: 3 is conservative enough to flag pretty much
// every "almost gone" item but high enough that it's not noisy on a
// catalog of ~30 SKUs. Override with LOW_STOCK_THRESHOLD env var.
//
// If ADMIN_EMAIL is not set, this endpoint is a no-op (returns 200 with
// `skipped: 'no_admin_email'` so the cron doesn't keep retrying).
//
// Auth: same Bearer-token pattern as cleanup-pending — Vercel Cron
// auto-sends `Authorization: Bearer ${CRON_SECRET}` when the secret is
// configured. Other callers can't fire alerts without the secret.

import { getSupabaseAdmin } from '../lib/supabase.js';
import { sendEmail } from '../lib/email.js';
import { escapeHtml } from '../lib/html.js';
import { requireMethod, ok, unauthorized, serverError } from '../lib/util.js';
import { timingSafeEqual } from 'node:crypto';

function isAuthorizedCron(req) {
  const expected = process.env.CRON_SECRET;
  if (!expected || expected.length < 16) return false;
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'GET', 'POST')) return;
  if (!isAuthorizedCron(req)) return unauthorized(res, 'Cron auth required.');

  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) {
    return ok(res, { skipped: 'no_admin_email' });
  }

  // Threshold: 3 by default, allow operator override via env
  const threshold = (() => {
    const raw = parseInt(process.env.LOW_STOCK_THRESHOLD || '3', 10);
    return Number.isInteger(raw) && raw >= 0 && raw <= 100 ? raw : 3;
  })();

  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('products')
      .select('id, name, color, stock, category, price_cents')
      .eq('active', true)
      .lte('stock', threshold)
      .order('stock', { ascending: true })
      .order('name', { ascending: true });

    if (error) {
      console.error('Low-stock query error:', error);
      return serverError(res, 'Could not query stock.');
    }

    const items = data || [];
    if (items.length === 0) {
      return ok(res, { ok: true, count: 0, message: 'No low-stock items today.' });
    }

    // Split out true zeros vs near-zero so the email leads with the
    // urgent stuff. ("Out of stock" sells nothing; "low" is a heads-up.)
    const out = items.filter(i => (i.stock || 0) === 0);
    const low = items.filter(i => (i.stock || 0) > 0);

    const renderRow = (i) => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e5e5;font-size:13px;color:#0c1422">
          <strong>${escapeHtml(i.name || i.id)}</strong>
          ${i.color ? `<span style="color:#6b7689"> · ${escapeHtml(i.color)}</span>` : ''}
        </td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e5e5;font-size:13px;color:#6b7689;text-align:left">
          ${escapeHtml(i.category || '')}
        </td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e5e5;font-size:13px;text-align:right;font-weight:600;color:${(i.stock | 0) === 0 ? '#c43b3b' : '#b8893d'}">
          ${escapeHtml(String(i.stock | 0))}
        </td>
      </tr>
    `;

    const tableSection = (title, rows, isOut) => rows.length === 0 ? '' : `
      <h2 style="margin:24px 0 8px;font-size:15px;color:${isOut ? '#c43b3b' : '#0c1422'}">
        ${title} (${rows.length})
      </h2>
      <table style="width:100%;border-collapse:collapse;background:#fafaf6;border:1px solid #e5e5e5">
        <thead>
          <tr style="background:#fff">
            <th style="padding:8px 12px;border-bottom:1px solid #e5e5e5;font-size:11px;text-transform:uppercase;letter-spacing:.12em;text-align:left;color:#6b7689">Product</th>
            <th style="padding:8px 12px;border-bottom:1px solid #e5e5e5;font-size:11px;text-transform:uppercase;letter-spacing:.12em;text-align:left;color:#6b7689">Category</th>
            <th style="padding:8px 12px;border-bottom:1px solid #e5e5e5;font-size:11px;text-transform:uppercase;letter-spacing:.12em;text-align:right;color:#6b7689">Stock</th>
          </tr>
        </thead>
        <tbody>${rows.map(renderRow).join('')}</tbody>
      </table>
    `;

    const html = `
<!DOCTYPE html>
<html><body style="font-family:-apple-system,sans-serif;background:#fff;padding:24px;margin:0">
  <div style="max-width:640px;margin:0 auto">
    <div style="font-size:18px;font-weight:600;letter-spacing:.18em;color:#08080a;margin-bottom:12px">TAGLINE · STOCK</div>
    <h1 style="margin:0 0 4px;font-size:20px;color:#0c1422">Low-stock alert</h1>
    <p style="margin:0 0 16px;color:#6b7689;font-size:13px">
      ${out.length} out of stock · ${low.length} at or below ${threshold} unit${threshold === 1 ? '' : 's'}.
    </p>
    ${tableSection('Out of stock', out, true)}
    ${tableSection('Running low', low, false)}
    <p style="margin:24px 0 0;font-size:12px;color:#9098a8">
      Manage stock from <a href="${escapeHtml(process.env.SITE_URL || '')}/admin" style="color:#b8893d">/admin → Products</a>.
      You can adjust the alert threshold by setting LOW_STOCK_THRESHOLD in Vercel env (default 3, max 100).
    </p>
  </div>
</body></html>`;

    await sendEmail({
      to: adminEmail,
      subject: `[TAGLINE] Stock alert — ${out.length} out, ${low.length} low`,
      html
    });

    return ok(res, { ok: true, out: out.length, low: low.length });
  } catch (err) {
    console.error('Low-stock alert error:', err);
    return serverError(res);
  }
}
