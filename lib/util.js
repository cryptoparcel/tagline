// Tiny validation helpers — keep things consistent across endpoints
// without pulling in a big library.

export function isEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length < 255;
}

// Normalize an email so two variants of the same Gmail inbox are treated equally.
// This prevents the "Gmail dot trick" deception (j.doe@gmail.com vs jdoe@gmail.com
// land in the same inbox but look different) and plus-aliasing tricks
// (jdoe+anything@gmail.com).
//
// Use this for storage/deduplication keys. Keep the original-cased version
// for sending email so providers don't reject it.
export function normalizeEmail(email) {
  if (typeof email !== 'string') return '';
  const s = email.trim().toLowerCase();
  const at = s.lastIndexOf('@');
  if (at < 1) return s;

  let local = s.slice(0, at);
  const domain = s.slice(at + 1);

  // Plus-alias: drop everything after the first +
  const plus = local.indexOf('+');
  if (plus !== -1) local = local.slice(0, plus);

  // Gmail-family: dots in the local part are ignored
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.replace(/\./g, '');
    return `${local}@gmail.com`;
  }

  return `${local}@${domain}`;
}

export function isString(s, { min = 1, max = 5000 } = {}) {
  return typeof s === 'string' && s.length >= min && s.length <= max;
}

export function isInt(n, { min = -Infinity, max = Infinity } = {}) {
  return Number.isInteger(n) && n >= min && n <= max;
}

// Standard JSON responses with proper headers and CORS
export function json(res, status, body) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).send(JSON.stringify(body));
}

export function ok(res, body = {}) {
  json(res, 200, { ok: true, ...body });
}

export function badRequest(res, message = 'Invalid request') {
  json(res, 400, { ok: false, error: message });
}

export function unauthorized(res, message = 'Unauthorized') {
  json(res, 401, { ok: false, error: message });
}

export function notFound(res, message = 'Not found') {
  json(res, 404, { ok: false, error: message });
}

export function serverError(res, message = 'Server error') {
  json(res, 500, { ok: false, error: message });
}

// Method guard - call at top of handler. Returns true if method matched, false otherwise.
export function requireMethod(req, res, ...allowed) {
  if (!allowed.includes(req.method)) {
    res.setHeader('Allow', allowed.join(', '));
    json(res, 405, { ok: false, error: `Method ${req.method} not allowed` });
    return false;
  }
  return true;
}

// Parse JSON body safely (Vercel parses by default but defensive)
export function getBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

// Simple in-memory rate limiter (best-effort across one serverless instance)
const buckets = new Map();
export function rateLimit(key, { windowMs = 60_000, max = 10 } = {}) {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now > bucket.reset) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  if (bucket.count >= max) return false;
  bucket.count++;
  return true;
}

// Get a rough client identifier for rate limiting
export function getClientId(req) {
  const fwd = req.headers['x-forwarded-for'];
  const ip = (fwd && fwd.split(',')[0].trim()) || req.headers['x-real-ip'] || 'unknown';
  return ip;
}

// Admin auth check (timing-safe comparison)
import { timingSafeEqual } from 'node:crypto';

export function isAdmin(req) {
  const provided = req.headers['x-admin-key'];
  const expected = process.env.ADMIN_API_KEY;
  // Reject if no key is configured, or it's too short (32 char minimum)
  if (!expected || expected.length < 32 || typeof provided !== 'string') return false;
  // Buffers must be the same length for timingSafeEqual
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
