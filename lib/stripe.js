import Stripe from 'stripe';

let cached = null;

export function getStripe() {
  if (cached) return cached;

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      'Missing STRIPE_SECRET_KEY env var. Set it in Vercel: Settings → Environment Variables.'
    );
  }

  cached = new Stripe(key, {
    apiVersion: '2024-12-18.acacia',
    typescript: false
  });

  return cached;
}
