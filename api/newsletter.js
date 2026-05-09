import { getSupabaseAdmin } from '../lib/supabase.js';
import {
  requireMethod, getBody, ok, badRequest, serverError,
  isEmail, normalizeEmail, rateLimit, getClientId, requireSameOrigin
} from '../lib/util.js';

export const config = {
  api: {
    bodyParser: { sizeLimit: '2kb' }
  }
};

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  if (!requireSameOrigin(req, res)) return;

  // Rate limit: 5 signups per IP per minute
  const clientId = getClientId(req);
  if (!rateLimit(`newsletter:${clientId}`, { windowMs: 60_000, max: 5 })) {
    return badRequest(res, 'Too many requests. Try again in a moment.');
  }

  const body = getBody(req);
  const rawEmail = (body.email || '').trim();
  // `source` is free-form (footer, hero, /customize, etc.) but we don't want
  // to let callers stuff arbitrary text into the column — DB analytics
  // reports group on it. Allow a tight charset only.
  const source = typeof body.source === 'string' && /^[a-z0-9_-]{1,50}$/i.test(body.source)
    ? body.source : 'website';

  if (!isEmail(rawEmail)) {
    return badRequest(res, 'Please enter a valid email address.');
  }

  // Use normalized email as the dedup key so dot-tricks and plus-aliases
  // can't be used to sign up the same Gmail inbox a hundred times.
  const normalized = normalizeEmail(rawEmail);

  try {
    const supabase = getSupabaseAdmin();

    // Upsert: if already exists, just reactivate
    const { error } = await supabase
      .from('subscribers')
      .upsert(
        { email: normalized, source, active: true, unsubscribed_at: null },
        { onConflict: 'email' }
      );

    if (error) {
      console.error('Newsletter insert error:', error);
      return serverError(res, 'Could not save email. Please try again.');
    }

    return ok(res, { message: 'Subscribed' });
  } catch (err) {
    console.error('Newsletter handler error:', err);
    return serverError(res);
  }
}
