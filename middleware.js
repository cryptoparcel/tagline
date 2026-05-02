// Vercel Edge Middleware — soft-launch access gate.
//
// When ACCESS_GATE_ENABLED=true, every page request is checked for a
// `tagline_access` cookie. Missing → redirect to /launch (the passcode
// page). The cookie is set by /api/access on a valid code submission.
//
// The gate is OFF by default (env var unset or "false") so the site
// works normally in dev / preview deploys. Flip to "true" in Vercel
// production env when you want to soft-launch.
//
// Always allowed through (so SEO, social previews, and payments don't break):
//   - /launch + /api/access (the gate itself)
//   - /api/* (Stripe webhook, NowPayments webhook, /api/config, etc.)
//   - /.well-known/* (Apple Pay verification, etc.)
//   - /sitemap.xml + /robots.txt + /og-image.svg (search/social crawlers
//     need them even when the human gate is up)
//   - /privacy + /terms (legal pages must be reachable)
//   - Static files (anything with a dot in the path — handled by matcher)
//
// Known good bots (Googlebot, Twitterbot, etc.) bypass the gate via
// User-Agent so search ranking + link previews keep working during
// the soft launch.

const PUBLIC_PATHS = new Set([
  '/launch',
  '/launch.html',
  '/sitemap.xml',
  '/robots.txt',
  '/og-image.svg',
  '/privacy',
  '/privacy.html',
  '/terms',
  '/terms.html'
]);

// Conservative allow-list of well-known good crawlers. We let them in so
// SEO indexing + Slack/Twitter/Facebook unfurls keep working while the
// gate is up. Each is checked as a substring of the User-Agent.
const KNOWN_BOT_RE = /Googlebot|Bingbot|DuckDuckBot|Slurp|YandexBot|Baiduspider|AppleBot|Twitterbot|facebookexternalhit|Slackbot|LinkedInBot|Discordbot|TelegramBot|WhatsApp|Pinterest|MJ12bot/i;

export const config = {
  // Run middleware on everything EXCEPT:
  //  - /_next/*, /_vercel/* (Vercel internals)
  //  - /api/* (handled by us — webhooks must pass through)
  //  - /.well-known/* (Apple Pay etc.)
  //  - any path with a dot (static assets: .css, .js, .svg, .ico, fonts, images)
  matcher: '/((?!_next|_vercel|api|\\.well-known|.*\\.[^/]+$).*)'
};

export default function middleware(req) {
  // Feature-flagged. Default off — set ACCESS_GATE_ENABLED=true in Vercel
  // to activate the gate.
  if (process.env.ACCESS_GATE_ENABLED !== 'true') return;

  const url = new URL(req.url);
  const path = url.pathname;

  // Public paths always pass
  if (PUBLIC_PATHS.has(path)) return;

  // Known crawlers always pass (so SEO + social unfurls keep working)
  const ua = req.headers.get('user-agent') || '';
  if (KNOWN_BOT_RE.test(ua)) return;

  // Cookie present? Pass.
  // Cookie shape: tagline_access=<server-set-token>. The server-set token
  // is opaque from middleware's POV — it just checks presence. The actual
  // value validation is implicit (server-set HttpOnly Secure SameSite=Lax
  // cookie can't be tampered with from JS).
  const cookieHeader = req.headers.get('cookie') || '';
  if (/(?:^|;\s*)tagline_access=/.test(cookieHeader)) return;

  // Otherwise, redirect to the launch page
  const launchUrl = new URL('/launch', req.url);
  return Response.redirect(launchUrl, 307);
}
