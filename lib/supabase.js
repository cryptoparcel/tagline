// Server-side Supabase client (uses service role key, bypasses RLS).
// ONLY use from /api/ routes — NEVER ship the service role key to browsers.
import { createClient } from '@supabase/supabase-js';

let cached = null;

export function getSupabaseAdmin() {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars. ' +
      'Set them in Vercel: Settings → Environment Variables.'
    );
  }

  cached = createClient(url, serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });

  return cached;
}

// Short-lived in-memory cache of Bearer-token → user. Each authenticated
// API request (e.g. /account loading orders + profile = 2 calls) used to
// hit Supabase Auth's /auth/v1/user endpoint independently. With this
// cache, the same token only goes over the wire once per TTL window.
//
// TTL is short (30s) so a sign-out / token rotation propagates within
// that window. Cap is defensive — serverless instances are short-lived
// so unbounded growth is unlikely, but a hard cap prevents pathological
// cases. Map iterates in insertion order, so the oldest entry is at the
// front of .keys().
const USER_CACHE_TTL_MS = 30_000;
const USER_CACHE_MAX = 1000;
const userCache = new Map();

function setCachedUser(token, user) {
  if (userCache.size >= USER_CACHE_MAX) {
    const firstKey = userCache.keys().next().value;
    userCache.delete(firstKey);
  }
  userCache.set(token, { user, expiresAt: Date.now() + USER_CACHE_TTL_MS });
}

// Get the user object from a Supabase auth token (sent in Authorization header).
// Returns null if no valid token. Does NOT throw.
export async function getUserFromRequest(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;

  // Cache hit?
  const cached = userCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.user;
  }

  try {
    const admin = getSupabaseAdmin();
    const { data, error } = await admin.auth.getUser(token);
    const user = (error || !data?.user) ? null : data.user;
    setCachedUser(token, user);
    return user;
  } catch {
    return null;
  }
}
