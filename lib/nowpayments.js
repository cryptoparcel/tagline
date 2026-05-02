// NowPayments crypto integration helpers.
//
// Two operations:
//   1. createInvoice(...) — POST to NowPayments Invoices API, get a
//      hosted-checkout URL we redirect the user to.
//   2. verifyIPN(rawBody, signature) — confirm a webhook came from
//      NowPayments by re-computing HMAC-SHA512 over the sorted JSON
//      body using IPN_SECRET. Same signature-verification pattern as
//      Stripe's webhook (just different algorithm + sort step).
//
// Auto-conversion to USD is configured in your NowPayments dashboard,
// NOT here. Always enable it — avoids holding crypto, avoids US state
// money-transmitter regulations.

import { createHmac, timingSafeEqual } from 'node:crypto';

const NP_API_BASE = 'https://api.nowpayments.io/v1';

function getApiKey() {
  const k = process.env.NOWPAYMENTS_API_KEY;
  if (!k) throw new Error('NOWPAYMENTS_API_KEY is not configured');
  return k;
}

function getIpnSecret() {
  const s = process.env.NOWPAYMENTS_IPN_SECRET;
  if (!s) throw new Error('NOWPAYMENTS_IPN_SECRET is not configured');
  return s;
}

// True iff the env vars are present — used by /api/checkout-crypto to
// 503 cleanly if the merchant hasn't set things up yet.
export function isConfigured() {
  return !!(process.env.NOWPAYMENTS_API_KEY && process.env.NOWPAYMENTS_IPN_SECRET);
}

// Create a NowPayments invoice. Returns the parsed JSON response from
// NowPayments (which includes `id` and `invoice_url`). Throws on error.
//
// Args:
//   priceUsdCents — total order amount in cents (e.g. 14800 = $148.00)
//   orderId       — our internal order UUID, used as their order_id
//   description   — short human label for the invoice
//   ipnUrl        — full https URL where NP will POST status updates
//   successUrl    — where NP redirects the user after payment
//   cancelUrl     — where NP redirects on cancel
export async function createInvoice({
  priceUsdCents, orderId, description, ipnUrl, successUrl, cancelUrl
}) {
  const body = {
    price_amount: (priceUsdCents / 100).toFixed(2),
    price_currency: 'usd',
    order_id: orderId,
    order_description: description,
    ipn_callback_url: ipnUrl,
    success_url: successUrl,
    cancel_url: cancelUrl,
    is_fixed_rate: true,    // lock USD price; NP eats price drift mid-payment
    is_fee_paid_by_user: false
  };
  const res = await fetch(`${NP_API_BASE}/invoice`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': getApiKey()
    },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.message || data?.error || `NowPayments API ${res.status}`;
    throw new Error(`NowPayments createInvoice failed: ${msg}`);
  }
  return data;
}

// ============ IPN signature verification ============
//
// NowPayments signs every IPN payload with HMAC-SHA512 using the
// merchant's IPN secret. To verify, we sort the JSON keys
// alphabetically (recursively for nested objects), serialize with
// no spaces, then compute HMAC-SHA512(sortedJson, secret) and
// compare to the value in the x-nowpayments-sig header.
function sortKeysDeep(obj) {
  if (Array.isArray(obj)) return obj.map(sortKeysDeep);
  if (obj && typeof obj === 'object') {
    return Object.keys(obj).sort().reduce((acc, k) => {
      acc[k] = sortKeysDeep(obj[k]);
      return acc;
    }, {});
  }
  return obj;
}

// Returns { ok: true, payload } if signature checks out, else { ok: false, error }.
// Pass the *raw* body (Buffer or string) — re-parsing here keeps it pure.
export function verifyIPN(rawBody, signature) {
  if (typeof signature !== 'string' || !signature) {
    return { ok: false, error: 'Missing x-nowpayments-sig header' };
  }
  let payload;
  try {
    payload = typeof rawBody === 'string' ? JSON.parse(rawBody) : JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { ok: false, error: 'Invalid JSON body' };
  }
  const sortedJson = JSON.stringify(sortKeysDeep(payload));
  const computed = createHmac('sha512', getIpnSecret()).update(sortedJson).digest('hex');
  // Timing-safe comparison
  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(signature, 'hex');
  if (a.length !== b.length) return { ok: false, error: 'Signature mismatch' };
  try {
    if (!timingSafeEqual(a, b)) return { ok: false, error: 'Signature mismatch' };
  } catch {
    return { ok: false, error: 'Signature mismatch' };
  }
  return { ok: true, payload };
}
