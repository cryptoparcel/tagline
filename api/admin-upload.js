// Admin photo upload — accepts a base64-encoded JPEG/PNG/WebP, uploads
// it to the Supabase Storage 'product-images' bucket, returns a public
// URL that the admin form fills into the product's image_url field.
//
// The browser does the cropping client-side (canvas → toDataURL) so we
// only see the already-cropped 1000x1000 output. That keeps payloads
// small (~150KB JPEG) and well under Vercel's 4.5MB body limit.
//
// Auth: same as /api/admin — X-Admin-Key header + same-origin check.
// Bucket setup: see sql/schema.sql (creates the bucket + public-read
// policy if not already present).

import { getSupabaseAdmin } from '../lib/supabase.js';
import {
  requireMethod, getBody, ok, badRequest,
  serverError, requireAdmin, requireSameOrigin
} from '../lib/util.js';

const BUCKET = 'product-images';
const MAX_BYTES = 3 * 1024 * 1024; // 3MB after base64 decode (very generous)

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  if (!requireSameOrigin(req, res)) return;
  if (!await requireAdmin(req, res)) return;

  try {
    const body = getBody(req);
    const product_id = body && body.product_id;
    const data_url = body && body.data_url;

    if (!product_id || typeof product_id !== 'string' || !/^[a-z0-9-]{1,50}$/.test(product_id)) {
      return badRequest(res, 'Invalid product_id');
    }
    if (!data_url || typeof data_url !== 'string' || data_url.length > 8 * 1024 * 1024) {
      return badRequest(res, 'data_url is required and must be under 8MB encoded');
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
      return badRequest(res, 'Could not decode image data');
    }
    if (buffer.length === 0) return badRequest(res, 'Empty image');
    if (buffer.length > MAX_BYTES) {
      return badRequest(res, 'Image too large after compression — try cropping smaller');
    }

    // Filename: <product-id>-<timestamp>.<ext>
    // Timestamp prevents stale CDN cache when re-uploading the same product.
    const filename = `${product_id}-${Date.now()}.${ext}`;

    const supabase = getSupabaseAdmin();
    const { data: uploadData, error: uploadErr } = await supabase
      .storage
      .from(BUCKET)
      .upload(filename, buffer, {
        contentType: mimeType,
        upsert: true,
        cacheControl: '31536000' // 1 year — filenames already include a timestamp
      });

    if (uploadErr) {
      console.error('Storage upload error:', uploadErr);
      const msg = (uploadErr.message || '').toLowerCase();
      if (msg.includes('not found') || msg.includes('bucket')) {
        return serverError(res,
          'Image bucket not configured. Re-run sql/schema.sql in Supabase to set up the product-images bucket.'
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
    console.error('Admin upload handler error:', err);
    return serverError(res);
  }
}
