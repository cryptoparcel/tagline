import { getSupabaseAdmin } from '../lib/supabase.js';
import { requireMethod, ok, serverError } from '../lib/util.js';

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'GET')) return;

  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('products')
      .select('id, name, color, price_cents, category, tag, stock')
      .eq('active', true)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Products fetch error:', error);
      return serverError(res, 'Could not load products.');
    }

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return ok(res, { products: data });
  } catch (err) {
    console.error('Products handler error:', err);
    return serverError(res);
  }
}
