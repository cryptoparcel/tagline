// User profile (settings) API.
//   GET  /api/profile  → returns the signed-in user's profile row
//   PATCH /api/profile → updates allowed fields (full_name, phone, shipping_address)
//
// All access requires a valid Supabase auth JWT in the Authorization header.
// Server uses the service-role client to read/write — auth.uid() is taken
// from the verified token, never from the request body.

import { getSupabaseAdmin, getUserFromRequest } from '../lib/supabase.js';
import {
  requireMethod, getBody, ok, badRequest, unauthorized, serverError,
  isString, rateLimit, getClientId, requireSameOrigin
} from '../lib/util.js';

export const config = {
  api: {
    bodyParser: { sizeLimit: '4kb' }
  }
};

const ALLOWED_COUNTRIES = ['US', 'CA'];
const US_STATE = /^[A-Z]{2}$/;
const ZIP = /^[A-Za-z0-9 -]{3,12}$/;
const PHONE = /^[+()\-.\s\d]{7,20}$/;

function sanitizeAddress(input) {
  if (!input || typeof input !== 'object') return { error: 'Invalid address' };
  const a = input;

  // Address is stored as a single JSONB column; PATCHing it overwrites the
  // whole thing. Require all four required fields together so a partial
  // body (e.g. {city: 'X'}) doesn't wipe line1/state/zip from the existing
  // address. Country defaults to US if omitted.
  const required = ['line1', 'city', 'state', 'zip'];
  for (const f of required) {
    if (a[f] == null || String(a[f]).trim() === '') {
      return { error: `Missing required address field: ${f}` };
    }
  }

  const out = {};
  if (!isString(String(a.line1), { min: 1, max: 100 })) return { error: 'Invalid line1' };
  out.line1 = String(a.line1).trim();

  if (a.line2 != null && a.line2 !== '') {
    if (!isString(String(a.line2), { min: 0, max: 100 })) return { error: 'Invalid line2' };
    out.line2 = String(a.line2).trim();
  }

  if (!isString(String(a.city), { min: 1, max: 80 })) return { error: 'Invalid city' };
  out.city = String(a.city).trim();

  const s = String(a.state).trim().toUpperCase();
  if (!US_STATE.test(s)) return { error: 'Invalid state (use 2-letter code)' };
  out.state = s;

  const z = String(a.zip).trim();
  if (!ZIP.test(z)) return { error: 'Invalid postal code' };
  out.zip = z;

  const c = a.country != null ? String(a.country).trim().toUpperCase() : 'US';
  if (!ALLOWED_COUNTRIES.includes(c)) return { error: 'Country not supported' };
  out.country = c;

  // Reject any unexpected keys silently — never trust extra input
  return { value: out };
}

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'GET', 'PATCH', 'DELETE')) return;
  if (!requireSameOrigin(req, res)) return;

  const user = await getUserFromRequest(req);
  if (!user) return unauthorized(res, 'Sign in required.');

  const supabase = getSupabaseAdmin();

  if (req.method === 'GET') {
    try {
      const [{ data: profile, error: pErr }, { data: sub }] = await Promise.all([
        supabase
          .from('profiles')
          .select('id, email, full_name, phone, shipping_address, created_at')
          .eq('id', user.id)
          .maybeSingle(),
        // Lookup current newsletter status by email — best-effort.
        supabase
          .from('subscribers')
          .select('active')
          .eq('email', (user.email || '').toLowerCase())
          .maybeSingle()
      ]);
      if (pErr) {
        console.error('Profile fetch error:', pErr);
        return serverError(res, 'Could not load profile.');
      }
      const subscribed = !!(sub && sub.active);
      if (!profile) {
        // Trigger somehow didn't run — fall back to known auth info
        return ok(res, {
          profile: {
            id: user.id,
            email: user.email,
            full_name: user.user_metadata?.full_name || null,
            phone: null,
            shipping_address: null,
            subscribed,
            created_at: user.created_at || null
          }
        });
      }
      return ok(res, { profile: { ...profile, subscribed } });
    } catch (err) {
      console.error('Profile GET error:', err);
      return serverError(res);
    }
  }

  // ========== DELETE — self-service account deletion (GDPR Art. 17) ==========
  // Strategy:
  //   1. Anonymize this user's order rows — keep them for tax / accounting
  //      records, but null out PII (shipping_address) and replace email
  //      with a deleted-marker. user_id naturally goes to null via the
  //      existing FK ON DELETE SET NULL.
  //   2. Mark newsletter subscription inactive (best effort, by email).
  //   3. Delete the auth user — cascades to profiles via FK.
  // Returns 204 on success. Client should clear localStorage session and
  // redirect away.
  if (req.method === 'DELETE') {
    try {
      // Anonymize orders (kept for accounting; PII removed)
      const { error: anonErr } = await supabase
        .from('orders')
        .update({
          email: 'deleted@deleted.local',
          shipping_address: null
        })
        .eq('user_id', user.id);
      if (anonErr) {
        console.error('Order anonymization failed:', anonErr);
        // Don't bail — better to delete the user than leave a half-state
      }

      // Best-effort newsletter unsubscribe (matches the original lower-case email)
      if (user.email) {
        await supabase
          .from('subscribers')
          .update({ active: false, unsubscribed_at: new Date().toISOString() })
          .eq('email', user.email.toLowerCase())
          .then(() => {}, () => {});
      }

      // Delete the auth user. Profiles row cascades via FK (on delete cascade).
      const { error: deleteErr } = await supabase.auth.admin.deleteUser(user.id);
      if (deleteErr) {
        console.error('Auth user delete failed:', deleteErr);
        return serverError(res, 'Could not complete deletion. Please contact support.');
      }

      // 204 no-content
      res.status(204).end();
      return;
    } catch (err) {
      console.error('Account deletion error:', err);
      return serverError(res);
    }
  }

  // PATCH — update allowed fields
  // Rate limit profile writes to discourage scripted abuse
  const clientId = getClientId(req);
  if (!rateLimit(`profile:${user.id}:${clientId}`, { windowMs: 60_000, max: 20 })) {
    return badRequest(res, 'Too many updates. Slow down.');
  }

  const body = getBody(req);
  const updates = { updated_at: new Date().toISOString() };

  if (body.full_name != null) {
    const name = String(body.full_name).trim();
    if (name.length > 0 && (name.length > 80 || /[\r\n\t\x00-\x1f\x7f<>]/.test(name))) {
      return badRequest(res, 'Name contains invalid characters or is too long.');
    }
    updates.full_name = name || null;
  }

  if (body.phone != null) {
    const phone = String(body.phone).trim();
    if (phone.length > 0 && !PHONE.test(phone)) {
      return badRequest(res, 'Invalid phone number.');
    }
    updates.phone = phone || null;
  }

  if (body.shipping_address !== undefined) {
    if (body.shipping_address === null) {
      updates.shipping_address = null;
    } else {
      const result = sanitizeAddress(body.shipping_address);
      if (result.error) return badRequest(res, result.error);
      updates.shipping_address = result.value;
    }
  }

  // Newsletter subscription toggle — orthogonal to the profiles row,
  // so we handle it separately. Upserts the subscribers row keyed on
  // the user's auth email.
  if (body.subscribed !== undefined && user.email) {
    const wantSubscribed = !!body.subscribed;
    const lowerEmail = user.email.toLowerCase();
    if (wantSubscribed) {
      await supabase
        .from('subscribers')
        .upsert(
          { email: lowerEmail, source: 'account', active: true, unsubscribed_at: null },
          { onConflict: 'email' }
        );
    } else {
      await supabase
        .from('subscribers')
        .update({ active: false, unsubscribed_at: new Date().toISOString() })
        .eq('email', lowerEmail);
    }
  }

  // No actual profile fields to update? (subscribed-only PATCH is fine
  // — only fail if there's literally nothing to do.)
  const profileFieldsTouched = Object.keys(updates).length > 1;
  if (!profileFieldsTouched && body.subscribed === undefined) {
    return badRequest(res, 'No fields to update.');
  }
  if (!profileFieldsTouched) {
    // Subscribed-only PATCH — no need to touch profiles row
    return ok(res, { updated: true, subscribed: !!body.subscribed });
  }

  try {
    const { data, error } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', user.id)
      .select('id, email, full_name, phone, shipping_address')
      .maybeSingle();
    if (error) {
      console.error('Profile update error:', error);
      return serverError(res, 'Could not update profile.');
    }
    return ok(res, { profile: data });
  } catch (err) {
    console.error('Profile PATCH error:', err);
    return serverError(res);
  }
}
