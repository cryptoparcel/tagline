// Dynamic sitemap.xml — replaces the static public/sitemap.xml.
// Pulls active products from the DB and generates a sitemap entry for
// every /products/<id> URL plus the static pages. Crawlers (Google,
// Bing) hit /sitemap.xml which Vercel rewrites here.
//
// Falls back to just the static pages if the DB is unreachable, so a
// transient Supabase blip doesn't 500 the sitemap and tank indexing.

import { getSupabaseAdmin } from '../lib/supabase.js';

const STATIC_URLS = [
  { loc: '/',          changefreq: 'weekly',  priority: '1.0' },
  { loc: '/about',     changefreq: 'monthly', priority: '0.7' },
  { loc: '/customize', changefreq: 'monthly', priority: '0.9' },
  { loc: '/sizing',    changefreq: 'monthly', priority: '0.5' },
  { loc: '/help',      changefreq: 'monthly', priority: '0.5' },
  { loc: '/contact',   changefreq: 'monthly', priority: '0.6' },
  { loc: '/privacy',   changefreq: 'yearly',  priority: '0.2' },
  { loc: '/terms',     changefreq: 'yearly',  priority: '0.2' }
];

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).end();
    return;
  }

  const siteUrl = (process.env.SITE_URL || 'https://tagline.clothing').replace(/\/$/, '');

  // Try to load product list. If Supabase fails, sitemap still works
  // with static pages only.
  let productEntries = [];
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('products')
      .select('id, updated_at')
      .eq('active', true)
      .order('updated_at', { ascending: false });
    if (!error && Array.isArray(data)) {
      productEntries = data
        .filter(p => /^[a-z0-9-]{1,50}$/.test(p.id))
        .map(p => ({
          loc: `/products/${p.id}`,
          changefreq: 'weekly',
          priority: '0.8',
          lastmod: p.updated_at ? new Date(p.updated_at).toISOString() : null
        }));
    }
  } catch (err) {
    // Don't fail the whole sitemap on DB error — log + keep static
    console.error('Sitemap product fetch failed:', err);
  }

  const allUrls = [
    ...STATIC_URLS.map(u => ({ ...u, loc: siteUrl + u.loc })),
    ...productEntries.map(u => ({ ...u, loc: siteUrl + u.loc }))
  ];

  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    allUrls.map(u => {
      const lines = [`  <url>`, `    <loc>${escapeXml(u.loc)}</loc>`];
      if (u.lastmod) lines.push(`    <lastmod>${u.lastmod}</lastmod>`);
      if (u.changefreq) lines.push(`    <changefreq>${u.changefreq}</changefreq>`);
      if (u.priority) lines.push(`    <priority>${u.priority}</priority>`);
      lines.push(`  </url>`);
      return lines.join('\n');
    }).join('\n') +
    '\n</urlset>\n';

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  // Cache hint — search-engine crawlers don't honor this much, but
  // edges + stale-while-revalidate shave server load.
  res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=86400');
  // Override the default /api/* X-Robots-Tag header (which says
  // noindex) — crawlers MUST be able to fetch the sitemap.
  res.setHeader('X-Robots-Tag', 'noindex');
  res.status(200).send(xml);
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
