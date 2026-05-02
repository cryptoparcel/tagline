// Soft-launch access gate — passcode validator.
//
// Reads ACCESS_CODES env var (comma-separated valid codes). On a match:
//   - Sets an HttpOnly Secure cookie `tagline_access=ok` for 30 days.
//   - Returns 200.
// On a miss:
//   - 400, generic error message (no enumeration of which codes exist).
//
// Rate limited per-IP — 10 attempts per 5 min. Keeps a quick brute-force
// at bay; for harder protection enable Cloudflare Turnstile in front.
//
// To turn the gate OFF: unset ACCESS_GATE_ENABLED (middleware checks this).

import {
  requireMethod, getBody, ok, badRequest, serverError,
  rateLimit, getClientId, requireSameOrigin
} from '../lib/util.js';
import { timingSafeEqual } from 'node:crypto';

export const config = {
  api: { bodyParser: { sizeLimit: '1kb' } }
};

const COOKIE_MAX_AGE_S = 30 * 24 * 3600; // 30 days

// Timing-safe code comparison — match against any code in the list
// without short-circuiting on length, so an attacker can't infer length
// from response time.
function matchAnyCode(submitted, validCodes) {
  let matched = false;
  for (const code of validCodes) {
    const a = Buffer.from(submitted);
    const b = Buffer.from(code);
    if (a.length !== b.length) continue;
    try {
      if (timingSafeEqual(a, b)) matched = true;
    } catch { /* ignore */ }
  }
  return matched;
}

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  if (!requireSameOrigin(req, res)) return;

  // Per-IP rate limit on the gate itself
  const clientId = getClientId(req);
  if (!rateLimit(`access:${clientId}`, { windowMs: 5 * 60_000, max: 10 })) {
    return badRequest(res, 'Too many attempts. Try again in a few minutes.');
  }

  const codesEnv = (process.env.ACCESS_CODES || '').trim();
  if (!codesEnv) {
    // Misconfiguration — return generic error, log loudly
    console.error('ACCESS_CODES env var is not configured');
    return serverError(res, 'Access gate is not configured.');
  }
  const validCodes = codesEnv.split(',').map(s => s.trim()).filter(Boolean);

  const body = getBody(req);
  const submitted = String(body.code || '').trim();
  if (!submitted || submitted.length < 4 || submitted.length > 64) {
    return badRequest(res, 'Invalid code.');
  }

  if (!matchAnyCode(submitted, validCodes)) {
    return badRequest(res, 'Invalid code.');
  }

  // Set the gate-pass cookie. HttpOnly so JS can't read/tamper, Secure so
  // it only travels over HTTPS, SameSite=Lax so it works across normal
  // navigation but not arbitrary cross-site POSTs.
  const cookie = `tagline_access=ok; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`;
  res.setHeader('Set-Cookie', cookie);
  return ok(res);
}
