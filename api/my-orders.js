import { getSupabaseAdmin, getUserFromRequest } from '../lib/supabase.js';
import { requireMethod, ok, unauthorized, serverError } from '../lib/util.js';

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'GET')) return;

  const user = await getUserFromRequest(req);
  if (!user) return unauthorized(res, 'Sign in required.');

  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('orders')
      .select('id, status, subtotal_cents, shipping_cents, total_cents, items, created_at, tracking_number, shipping_address')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      console.error('Orders fetch error:', error);
      return serverError(res, 'Could not load orders.');
    }

    return ok(res, { orders: data });
  } catch (err) {
    console.error('Orders handler error:', err);
    return serverError(res);
  }
}
