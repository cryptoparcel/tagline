import { getSupabaseAdmin } from '../lib/supabase.js';
import { requireMethod, ok, serverError } from '../lib/util.js';

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'GET')) return;

  try {
    const supabase = getSupabaseAdmin();

    // Run product fetch + reviews aggregate in parallel. Reviews is a
    // partial index on (status='approved') so this is cheap even at
    // scale; for a fresh shop with no reviews it's a single index seek.
    const [productsRes, reviewsRes] = await Promise.all([
      supabase
        .from('products')
        .select('id, name, color, price_cents, category, tag, stock, description, image_url')
        .eq('active', true)
        .order('created_at', { ascending: true }),
      // We want count + avg per product. Supabase JS doesn't expose
      // SQL aggregates ergonomically, so we pull the (product_id, rating)
      // pairs and aggregate in JS. Bounded by 5000 rows — once you grow
      // past that, swap this for a server-side `product_review_summary`
      // view + a join.
      supabase
        .from('product_reviews')
        .select('product_id, rating')
        .eq('status', 'approved')
        .limit(5000)
    ]);

    if (productsRes.error) {
      console.error('Products fetch error:', productsRes.error);
      return serverError(res, 'Could not load products.');
    }
    if (reviewsRes.error) {
      // Reviews table may not exist yet on a freshly-deployed DB —
      // that's fine, just serve products without aggregates.
      console.warn('Reviews aggregate skipped:', reviewsRes.error.message);
    }

    // Build the per-product summary
    const summary = {};
    for (const row of (reviewsRes.data || [])) {
      const id = row.product_id;
      if (!summary[id]) summary[id] = { sum: 0, count: 0 };
      summary[id].sum += (row.rating | 0);
      summary[id].count += 1;
    }

    const products = (productsRes.data || []).map(p => {
      const s = summary[p.id];
      return {
        ...p,
        review_count: s ? s.count : 0,
        review_avg: s && s.count > 0 ? Math.round((s.sum / s.count) * 10) / 10 : 0
      };
    });

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return ok(res, { products });
  } catch (err) {
    console.error('Products handler error:', err);
    return serverError(res);
  }
}
