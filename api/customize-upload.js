// Public design-upload endpoint for the /customize builder. A visitor
// who's putting their own design on a basic hoodie/tee/sweatpants
// uploads it here; we drop it into the same Supabase Storage bucket
// that admin product photos use, but under a `customs/` prefix so
// they stay tidy and easy to clean up.
//
// Differences vs /api/admin-upload:
//   - PUBLIC (no auth) — anyone shopping can upload a design
//   - Tighter rate limit (5 per 10 min per IP) to discourage abuse
//   - Smaller body cap (1.5 MB after decode — these are user designs,
//     usually a small PNG with transparency, not full-res photography)
//   - File path uses crypto.randomUUID() so guesses can't collide

import { getSupabaseAdmin } from '../lib/supabase.js';
import {
  requireMethod, getBody, ok, badRequest,
  serverError, requireSameOrigin, rateLimit, getClientId
} from '../lib/util.js';
import { randomUUID } from 'node:crypto';

const BUCKET = 'product-images';
const PREFIX = 'customs/';
const MAX_BYTES = 1.5 * 1024 * 1024; // 1.5 MB

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  if (!requireSameOrigin(req, res)) return;

  const clientId = getClientId(req);
  if (!rateLimit(`customize-upload:${clientId}`, { windowMs: 10 * 60_000, max: 5 })) {
    return badRequest(res, 'Too many uploads. Take a breather and try again in a few minutes.');
  }

  try {
    const body = getBody(req);
    const data_url = body && body.data_url;

    if (!data_url || typeof data_url !== 'string' || data_url.length > 4 * 1024 * 1024) {
      return badRequest(res, 'Image is required (and must be under 4 MB encoded).');
    }

    // Parse data URI: "data:image/<type>;base64,<payload>"
    const match = data_url.match(/^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) {
      return badRequest(res, 'Unsupported image format. Use JPEG, PNG, or WebP.');
    }
    const mimeType = match[1];
    const ext = match[2] === 'jpeg' ? 'jpg' : match[2];
    const base64 = match[3];

    let buffer;
    try {
      buffer = Buffer.from(base64, 'base64');
    } catch {
      return badRequest(res, 'Could not decode image data.');
    }
    if (buffer.length === 0) return badRequest(res, 'Empty image.');
    if (buffer.length > MAX_BYTES) {
      return badRequest(res, 'Image too large — keep your design under 1.5 MB.');
    }

    // Random filename so URLs aren't guessable / enumerable.
    const filename = `${PREFIX}${randomUUID()}.${ext}`;

    const supabase = getSupabaseAdmin();
    const { data: uploadData, error: uploadErr } = await supabase
      .storage
      .from(BUCKET)
      .upload(filename, buffer, {
        contentType: mimeType,
        upsert: false,
        cacheControl: '31536000'
      });

    if (uploadErr) {
      console.error('Customize upload error:', uploadErr);
      const msg = (uploadErr.message || '').toLowerCase();
      if (msg.includes('not found') || msg.includes('bucket')) {
        return serverError(res,
          'Image storage isn\'t set up yet. Tell us at /contact — we\'ll get back to you fast.'
        );
      }
      return serverError(res, 'Upload failed: ' + (uploadErr.message || 'unknown'));
    }

    const { data: urlData } = supabase
      .storage
      .from(BUCKET)
      .getPublicUrl(uploadData.path);

    return ok(res, { url: urlData.publicUrl, path: uploadData.path });
  } catch (err) {
    console.error('Customize upload handler error:', err);
    return serverError(res);
  }
}
