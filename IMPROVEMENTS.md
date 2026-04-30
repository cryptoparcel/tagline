# TAGLINE — Improvement Audit

A prioritized, sourced backlog of changes that will make the site faster, safer, more accessible, and more profitable — **without changing the visual design or foundational stack**. Every item is tied to authoritative guidance (Baymard, NN/g, web.dev, OWASP, MDN, WCAG 2.2, Stripe, Supabase docs, Resend, Google Search Central). Effort is rough: **S** = under 1 hour, **M** = 1–4 hours, **L** = a day or more.

> **How to use this doc:** Work top-down inside each tier. P0 = ship-blockers / measurable wins / risk reduction. P1 = will move the needle once P0 is clean. P2 = polish + scale.

---

## Sources cited (you can dig deeper into any of these)

- **Baymard Institute** — e-commerce UX research (cart, checkout, product pages)
- **Nielsen Norman Group (NN/g)** — UX heuristics, form usability, navigation
- **web.dev** (Google) — Core Web Vitals, performance, accessibility patterns
- **WCAG 2.2 / WAI-ARIA Authoring Practices** — accessibility standards
- **OWASP ASVS / Cheat Sheet Series** — application security
- **MDN Web Docs** — web platform reference
- **Google Search Central** — SEO + structured data
- **Stripe Docs** — checkout best practices, idempotency, fraud
- **Supabase Docs** — RLS, auth, performance
- **Resend Docs** — deliverability (SPF/DKIM/DMARC)
- **MIT 6.S081 / 6.858 / Stanford CS253** — systems & web security fundamentals
- **HBR / Wharton e-commerce research** — pricing psychology, cart abandonment
- **Mailchimp / Litmus benchmarks** — email open/click rates

---

# P0 — Ship-blockers and high-leverage wins

## Performance / Core Web Vitals

1. **Add `og:image` and `twitter:image`** — currently missing in [index.html](public/index.html). Social shares render as blank cards. Create a 1200×630 PNG hero and reference it in OG/Twitter meta. *Source: Open Graph protocol; Twitter Cards docs.* — **S**
2. **Extract repeated inline CSS from [index.html](public/index.html) into [styles.css](public/styles.css)** — 105 KB HTML is mostly style, sent every navigation. Moving shared rules to the cached external file shrinks the homepage payload and improves repeat-view LCP. *Source: web.dev "Reduce render-blocking resources".* — **M**
3. **Add `<link rel="preload" as="font" crossorigin>` for the two visible Inter weights used above the fold (400, 600).** Combined with `display=swap`, eliminates FOIT. *Source: web.dev "Optimize web fonts".* — **S**
4. **Self-host critical fonts (Inter Variable + Space Grotesk)** instead of Google Fonts. Removes a third-party DNS hop and the third-party CSS round-trip. Bundle as `woff2` subset (Latin only). *Source: web.dev "Avoid critical request chains"; Bunny Fonts / Fontsource as drop-ins.* — **M**
5. **Add `loading="lazy"` and explicit `width`/`height` to all product images** so they don't force CLS when they replace the SVG placeholders. The dynamic injector in [tagline-app.js:705](public/tagline-app.js#L705) sets size via CSS only — set the attributes on the `<img>` element instead. *Source: web.dev "Optimize Cumulative Layout Shift".* — **S**
6. **Serve product images as AVIF/WebP via `<picture>`** when they exist. JPEGs of athletic wear are the single biggest payload you'll add — AVIF cuts ~50% vs JPEG. Vercel can transform on the fly via `next/image`-style URLs or build with sharp. *Source: web.dev "Use modern image formats".* — **M**
7. **Replace the homepage product `for...each` SVG illustrations with deferred rendering** — keep first 6 cards in HTML, render the rest after `requestIdleCallback` or on scroll. 24 cards × inline SVG is most of your DOM weight. *Source: web.dev "Reduce DOM size".* — **M**

## Security & Privacy

8. **Move the in-memory rate limiter in [lib/util.js:91](lib/util.js#L91) to Upstash Redis or Vercel KV.** Serverless instances are ephemeral and per-region — the current limiter is per-cold-instance, so an attacker can trivially exceed it. *Source: OWASP "Denial of Service" cheat sheet; Vercel rate-limiting guide.* — **M**
9. **Add CSRF protection to authenticated POSTs** ([api/checkout.js](api/checkout.js), [api/contact.js](api/contact.js), [api/admin.js](api/admin.js)). Currently any same-origin script (or one that gets past the Origin check, which you don't have) can submit. Add an `Origin`/`Referer` allow-list check at the top of each handler. *Source: OWASP CSRF Prevention Cheat Sheet.* — **S**
10. **Tighten CSP `script-src 'unsafe-inline'`** in [vercel.json:31](vercel.json#L31). Move inline `<script>` blocks to external files with hashes, then drop `unsafe-inline`. The current policy is permissive enough that an XSS in any unescaped sink would still execute. *Source: web.dev "Strict CSP"; Google CSP Evaluator.* — **L**
11. **Generate a CSP nonce per request** for the tiny inline scripts you can't extract (e.g. `window.SUPABASE_URL` in [signin.html](public/signin.html)). Vercel Edge Middleware can inject `script-src 'nonce-xxx'`. *Source: web.dev "Strict CSP".* — **M**
12. **Enable Supabase Auth email confirmation** in dashboard. Right now anyone can sign up with `noone@example.com` and pollute the user table. *Source: Supabase Auth docs "Email confirmations".* — **S**
13. **Set up SPF, DKIM, DMARC on the sending domain** for [lib/email.js](lib/email.js). Without DKIM/DMARC, order confirmations land in Gmail spam ~30% of the time. Resend dashboard verifies these for you. *Source: Resend Deliverability docs; M3AAWG.* — **S**
14. **Add `bot` filter on contact form** with Cloudflare Turnstile (free, privacy-respecting, no ToS issue). Rate limiting catches volume but not slow drip spam. *Source: Cloudflare Turnstile docs; OWASP Automated Threats T-OAT-007.* — **S**
15. **Stripe webhook idempotency key**. [api/stripe-webhook.js:99](api/stripe-webhook.js#L99) deduplicates by checking `status === 'paid'` — but if a duplicate event arrives *while* the first is mid-update, you can double-decrement stock. Persist `event.id` in a `processed_webhook_events` table and check first. *Source: Stripe "Best practices for using webhooks" → idempotency.* — **M**
16. **Wrap the stock decrement loop** in [api/stripe-webhook.js:134](api/stripe-webhook.js#L134) in a single transaction or upgrade `decrement_stock` RPC to take an array. Otherwise a partial failure (e.g. one product missing) leaves stock half-decremented. *Source: Postgres docs; Supabase RPC patterns.* — **M**
17. **Validate the Stripe-Signature header is present** before calling `constructEvent`. Currently if `sig` is undefined, Stripe SDK throws an opaque error logged as 400 — fine but make the failure mode explicit. *Source: Stripe webhooks docs.* — **S**
18. **Add `helmet`-style HSTS preload submission** at hstspreload.org once the site is on a stable domain. Header is already set in [vercel.json:27](vercel.json#L27). *Source: hstspreload.org.* — **S**
19. **Rotate `ADMIN_API_KEY` to a Supabase-Auth admin role check** instead of a shared static key. A leaked key has no audit trail; an admin user has one. Add an `admins` table or `is_admin` claim. *Source: Supabase RBAC patterns; OWASP Authorization Cheat Sheet.* — **L**

## Accessibility (WCAG 2.2 AA)

20. **Add a "Skip to main content" link** as the first focusable element on every page. Required for keyboard users to bypass the nav. *Source: WCAG 2.4.1 "Bypass Blocks".* — **S**
21. **Add visible focus styles for the cart icon and heart button** — `:focus-visible` is set globally in [styles.css:46](public/styles.css#L46) but the heart button injected in [tagline-app.js:725](public/tagline-app.js#L725) has no focus state. *Source: WCAG 2.4.7.* — **S**
22. **Quick-view drawer needs focus trap.** When `openQuickView` runs ([tagline-app.js:498](public/tagline-app.js#L498)), keyboard users can Tab out of the drawer back into the page underneath. Use `inert` on the rest of the page. *Source: WAI-ARIA Authoring Practices "Dialog (Modal)".* — **M**
23. **Add `role="dialog"`, `aria-modal="true"`, `aria-labelledby`** to the QV drawer. The drag handle should be a `<button>` not a div. *Source: ARIA APG.* — **S**
24. **Color contrast audit** — `--muted: #7a7a72` on `--bg: #08080a` yields ~5.0:1 (passes for normal text), but `--ink-soft: #c8c8c0` on `--surface: #111114` only ~9:1 — fine. The 11px `.form-label` uppercase text needs verification at small sizes since uppercase-tracking reduces apparent contrast. Run axe-core. *Source: WCAG 1.4.3.* — **S**
25. **Form errors use `aria-live="polite"`** in [signin.html:68](public/signin.html#L68) — good. Apply the same pattern to [contact.html](public/contact.html) and the cart and account pages. *Source: WCAG 4.1.3 "Status Messages".* — **S**
26. **`alt=""` on decorative SVG, real `alt` text on product images.** The product image injection at [tagline-app.js:707](public/tagline-app.js#L707) sets `img.alt = productName` — good. Audit hand-written SVGs on [index.html](public/index.html) and add `aria-hidden="true"` where they're decorative. *Source: WAI Decision Tree for `alt`.* — **S**
27. **The toast notification needs `role="status"` + `aria-live="polite"`** so screen readers announce "Added to cart". Currently silent. Defined at [tagline-app.js:657](public/tagline-app.js#L657). *Source: WCAG 4.1.3.* — **S**
28. **Touch targets verification** — CSS minimum is 44×44 ([index.html:79](public/index.html#L79) comment), but the cart badge dot at 14×14 isn't a target itself, ok. Verify the qty `+`/`–` buttons are 44px on mobile. WCAG 2.2 added 2.5.8 "Target Size (Minimum)" requiring 24×24. *Source: WCAG 2.5.8.* — **S**

## SEO & Discoverability

29. **Add JSON-LD `Product` schema for every product card** — enables rich results (price, stars, availability) in Google. Critical for e-commerce. Ship one `<script type="application/ld+json">` per product or one `ItemList`. *Source: Google "Product structured data" docs.* — **M**
30. **Add `Organization` and `WebSite` JSON-LD** on homepage with `sameAs` links and search action. *Source: Google Search Central structured data.* — **S**
31. **Add `BreadcrumbList` JSON-LD** to product detail / category pages once they exist. *Source: Google Search Central.* — **S**
32. **Generate sitemap.xml dynamically** instead of the hardcoded [public/sitemap.xml](public/sitemap.xml) — currently misses `/cart`, `/wishlist`, individual product URLs. Build via Vercel build hook or serve from `/api/sitemap.xml`. *Source: sitemaps.org spec.* — **M**
33. **Move `og:url` and canonical to use `process.env.SITE_URL`** — they're hardcoded to `tagline-ten.vercel.app` in [index.html:20](public/index.html#L20), which breaks if you switch domains. Use a build-time replacement. *Source: Google Search Central "Canonical URLs".* — **S**
34. **Per-page meta descriptions** — [cart.html](public/cart.html) and several others either reuse the homepage description or have a generic stub. Each indexable page needs a unique 140–160 char description. *Source: Moz "Meta description tag"; Google Search Central.* — **S**

## Conversion & E-commerce UX (Baymard-sourced)

35. **Persistent cart contents shown on hover/click of the cart icon** — Baymard finds 60% of users want a mini-cart preview without leaving the page. *Source: Baymard "Cart usability" benchmark.* — **M**
36. **Show shipping cost / free-shipping threshold in the cart** before checkout. You charge $8 / free-over-$150 ([api/checkout.js:137](api/checkout.js#L137)) — surface that as "Add $X for free shipping" in the cart. Studies show this lifts AOV ~20%. *Source: Baymard "Threshold-based free shipping".* — **M**
37. **Display total price including shipping inline before checkout button.** Hidden costs are the #1 reason for cart abandonment (49% of abandoners per Baymard 2024). *Source: Baymard cart-abandonment research.* — **M**
38. **Guest checkout prominently offered** — your checkout is already guest-capable ([api/checkout.js:51](api/checkout.js#L51)). Make sure the cart page advertises "Check out as guest — no account needed." Forced account creation is the #2 abandonment driver. *Source: Baymard cart-abandonment.* — **S**
39. **Remove the Stripe metadata items truncation at 500 chars** ([api/checkout.js:155](api/checkout.js#L155)). Drop the `items` field from metadata entirely and rely on your DB row instead — you already have the same data in `orders.items`. *Source: Stripe "Metadata best practices".* — **S**
40. **Add a single-field email-only quick-checkout** — let users punch in just their email at the cart, then go straight to Stripe. Reduces friction. *Source: Baymard "Single-field checkout".* — **M**
41. **Persist cart across sign-in** — currently localStorage only ([tagline-app.js:82](public/tagline-app.js#L82)). After login, sync to a `carts` table keyed on `user_id` so the cart follows them across devices. *Source: NN/g "Cross-device commerce".* — **L**
42. **Add wishlist sync to backend** — same problem as cart. Anonymous wishlist works ([tagline-app.js:198](public/tagline-app.js#L198)) but is lost on device change. *Source: NN/g.* — **M**
43. **Order confirmation page should let users create an account** with one click using the email they already provided. Captures repeat-purchase users. *Source: Baymard "Post-purchase upsell".* — **M**
44. **"Recently viewed" carousel** on homepage and product pages. Persists in localStorage. *Source: Baymard product-discovery research.* — **M**
45. **Trust signals near the checkout button** — payment-method logos, "secure SSL", return policy summary. Baymard finds 22% of users distrust new sites without these. *Source: Baymard "Trust seals".* — **S**

## Email / Lifecycle

46. **Send a "cart abandoned" email at 24h** to users who entered email but didn't checkout. Industry average recovers 10–15% of abandoned carts. *Source: Klaviyo / Mailchimp benchmarks.* — **L**
47. **Order shipped email with tracking URL** — admin updates `tracking_number` ([api/admin.js:97](api/admin.js#L97)), but no email is fired. Hook this in admin.js POST handler. *Source: Resend transactional patterns.* — **S**
48. **Plain-text alternative for every HTML email** in [lib/email.js](lib/email.js). Resend supports `text:` field. Lifts deliverability and accessibility. *Source: Resend docs; RFC 8551.* — **S**
49. **Add `List-Unsubscribe` header** to newsletter sends (when you wire those). Mandatory for Gmail/Yahoo bulk-sender rules effective 2024. *Source: Google "Email sender guidelines"; Yahoo Sender Hub.* — **S**

---

# P1 — Important, do these next

## Performance

50. **Resource hints for Stripe and Supabase** — add `<link rel="dns-prefetch">` and `<link rel="preconnect">` for `js.stripe.com` (cart/checkout pages) and `*.supabase.co` (signin, account). *Source: web.dev "Establish network connections early".* — **S**
51. **HTTP/2 server push or `103 Early Hints`** for [styles.css](public/styles.css) on Vercel. Vercel supports Early Hints natively. *Source: Vercel Edge docs; web.dev "Faster page loads with Early Hints".* — **M**
52. **Cache headers on static assets** — Vercel default for `/public/*` is `public, max-age=0, must-revalidate`. Add a content hash to filenames (e.g. `styles.abc123.css`) and set `max-age=31536000, immutable`. *Source: web.dev "HTTP cache".* — **M**
53. **Set `Cache-Control: public, s-maxage=300, stale-while-revalidate=86400` on `/api/products`** — currently 60s SWR=300 in [api/products.js:20](api/products.js#L20). Tune for your launch traffic. *Source: web.dev "stale-while-revalidate".* — **S**
54. **Defer non-critical JS** — [tagline-app.js](public/tagline-app.js) is 37 KB and loaded synchronously on every page. Add `defer` to all `<script src>` tags and split out the quick-view drawer code (only needed on homepage). *Source: web.dev "Reduce JavaScript execution time".* — **M**
55. **Prerender or static-export key pages.** [about.html](public/about.html), [help.html](public/help.html), [sizing.html](public/sizing.html) are static — already great. Apply same to product cards by snapshotting the JSON to inline JSON-LD at build time. *Source: web.dev "Pre-render".* — **M**
56. **Replace `Image()` probe at [tagline-app.js:701](public/tagline-app.js#L701)** with a build-time manifest of which images exist — checking 24 images on every homepage load is 24 wasted requests when none exist (404s). *Source: general perf practice.* — **M**
57. **Add `<link rel="prefetch">` for `/cart` and `/checkout`** assets when user adds first item to cart. *Source: web.dev "Speculative loading".* — **S**

## Accessibility

58. **Lang attribute is set globally to `en`** but if you add Spanish/French descriptions, set `lang` per element. *Source: WCAG 3.1.2.* — **S**
59. **Form fields need `aria-describedby`** linking to error/help text. Currently the `.form-error` class ([styles.css:234](public/styles.css#L234)) sits next to inputs without programmatic association. *Source: WCAG 3.3.1.* — **S**
60. **Reduced-motion exception in [index.html:84](public/index.html#L84)** keeps the cross animation alive. NN/g research shows users who set reduced-motion want *no* motion. Either remove the exception or gate it behind a separate user preference. *Source: NN/g "Motion sensitivity".* — **S**
61. **`autocomplete` attributes on all forms** — signin has them; verify checkout shipping form, contact form (`autocomplete="name"`, `email`). *Source: WCAG 1.3.5; web.dev "Sign-in form best practices".* — **S**
62. **Heading hierarchy audit** — every page should have exactly one `<h1>`, never skip levels. Run axe-core. *Source: WCAG 1.3.1.* — **S**
63. **Test with screen reader** — VoiceOver (Mac) or NVDA (Windows). Real listening surfaces issues no automated tool catches: confusing reading order, ambiguous link text ("here", "more"). *Source: WebAIM screen reader survey.* — **M**

## Security

64. **Add a `processed_webhook_events` table** — see #15 above for full context. Insert event_id with a unique constraint at the top of every handler. *Source: Stripe idempotency docs.* — **M**
65. **Audit log table** — every admin write (order updates, message status changes) should write a row to `audit_log(actor, action, target_id, before_json, after_json, at)`. *Source: NIST 800-53 AU controls; OWASP ASVS V7.* — **M**
66. **Encrypt PII columns at rest** — Supabase encrypts the disk, but `orders.shipping_address` and `profiles.phone` are particularly sensitive. Use Supabase Vault or pgsodium for column-level encryption if you ever take Apple Pay / pursue compliance. *Source: Supabase Vault docs; PCI DSS guidance.* — **L**
67. **Rotate Resend API key on a schedule** — store key version in env vars, document the rotation in `docs/SECURITY.md`. *Source: NIST 800-57.* — **S**
68. **Enable Stripe Radar rules** for high-risk transactions (multiple cards from one IP, high-value first orders). *Source: Stripe Radar docs.* — **S**
69. **Limit JSON body size** at the API layer — Vercel's default is 4.5 MB. For [api/contact.js](api/contact.js) and [api/newsletter.js](api/newsletter.js), set `bodyParser: { sizeLimit: '4kb' }`. *Source: Vercel API config docs; OWASP "Resource Consumption".* — **S**
70. **`SameSite=Strict` cookies** — Supabase Auth defaults to `Lax`. For an e-commerce site with no cross-site embedding needs, `Strict` reduces CSRF risk further. *Source: OWASP Session Management Cheat Sheet.* — **S**
71. **Sanitize the `tracking_number` in [api/admin.js:99](api/admin.js#L99)** — currently allows any character except `\r\n\t<>`. Tighten to `[A-Z0-9]{8,40}` (most carriers). *Source: defense-in-depth.* — **S**
72. **CORS hardening** — currently no explicit CORS header in [lib/util.js](lib/util.js). Vercel allows same-origin by default but explicit `Access-Control-Allow-Origin: ${SITE_URL}` documents intent. *Source: MDN CORS; OWASP REST Security Cheat Sheet.* — **S**

## Code Quality

73. **Add TypeScript** — even just JSDoc annotations on lib/util.js and lib/email.js catches dozens of bugs. Vercel handles TS natively. *Source: TypeScript handbook; Anders Hejlsberg "Why TS".* — **L**
74. **Replace bespoke `getRawBody` in [api/stripe-webhook.js:12](api/stripe-webhook.js#L12)** with `await buffer(req)` from `micro` or Vercel's built-in. Less surface area to get wrong. *Source: Stripe docs sample.* — **S**
75. **Centralize HTML-escape helper** — `escapeHtml` is redefined in [lib/email.js:81](lib/email.js#L81), [api/stripe-webhook.js:194](api/stripe-webhook.js#L194), [api/contact.js:97](api/contact.js#L97), [tagline-app.js:915](public/tagline-app.js#L915). Move to `lib/html.js` and import. *Source: DRY principle.* — **S**
76. **Replace localStorage cart shape on every read** ([tagline-app.js:83](public/tagline-app.js#L83)) — works fine but parses+filters on every call. Cache parsed result; invalidate on `save`. *Source: general perf.* — **S**
77. **Move product catalog out of [tagline-app.js:415](public/tagline-app.js#L415)** into a JSON file fetched from `/api/products` only. The hardcoded duplicate is a sync hazard — when you change a price in Supabase, the JS still has the old one. *Source: single-source-of-truth principle.* — **M**
78. **Add JSDoc types for handler signatures** — Vercel `(req: VercelRequest, res: VercelResponse)`. Catches `req.method` typos. *Source: Vercel docs; TypeScript JSDoc support.* — **S**
79. **Eslint + Prettier config** in package.json with `eslint-plugin-security` ruleset. *Source: ESLint docs; OWASP NodeGoat.* — **S**
80. **Convert long inline event handler chains in HTML to `addEventListener`** — cleaner CSP story too. *Source: MDN; CSP best practices.* — **M**

## Conversion & UX

81. **Inventory urgency on PDP** — already shown ("Only X left") at [tagline-app.js:561](public/tagline-app.js#L561). Add to homepage cards too. *Source: Baymard "Stock indicators".* — **S**
82. **Sticky add-to-cart on mobile** for the quick-view drawer. *Source: NN/g "Sticky elements on mobile".* — **S**
83. **Cart line-item editing without page reload** — already works via [tagline-app.js](public/tagline-app.js). Add an undo toast for accidental removal. *Source: NN/g "Undo over confirm".* — **S**
84. **Display product weight, dimensions, materials** on every PDP. Apparel-buyer NN/g studies show 64% want fabric composition before buying. *Source: NN/g e-commerce studies.* — **M**
85. **Size guide modal** — you have [sizing.html](public/sizing.html) but it's a separate page. Embed the relevant chart in the quick-view drawer. *Source: Baymard "Sizing on PDP".* — **M**
86. **Reviews / ratings** — even a simple "X people bought this" pulled from your `orders` table is social proof. Full reviews come later. *Source: BrightLocal "Local consumer review survey" — 91% read reviews.* — **M**
87. **Search bar in the nav** — even just a client-side filter over the 24 products. NN/g: 43% of users go straight to search on retail sites. *Source: NN/g "Site search usability".* — **M**
88. **Filter & sort on category pages** (price, color, size) — you have a flat homepage now. Group by `category` field and add filters. *Source: Baymard "Filter usability".* — **L**
89. **PWA manifest + service worker** for "Add to Home Screen" and offline cart. You already have iOS PWA meta tags ([index.html:7](public/index.html#L7)). Ship a `manifest.json` and a Workbox-style SW. *Source: web.dev "PWA checklist".* — **M**

## SEO

90. **Image sitemaps** — add `<image:image>` entries to sitemap once products have real photos. *Source: Google Search Central.* — **S**
91. **Open Graph product tags** — `og:type="product"`, `product:price:amount`, `product:availability`, etc. Used by Pinterest, Facebook Shop. *Source: Open Graph protocol.* — **S**
92. **Internal linking** — homepage should link to category pages, product pages should link to related products. Helps crawl depth. *Source: Google Search Central "URL structure".* — **M**
93. **Server-rendered product cards** instead of JS-injected — Googlebot renders JS but with delay; first-pass HTML wins. Vercel Edge Function or build-time generation. *Source: Google "JavaScript SEO".* — **L**

---

# P2 — Polish, scale, and operational maturity

## Testing & CI/CD

94. **Vitest unit tests** for `lib/util.js` validators (`isEmail`, `normalizeEmail`, `rateLimit`, `isAdmin`). These are pure functions and security-critical. *Source: Kent C. Dodds "Testing trophy".* — **M**
95. **Playwright e2e tests** for the three golden flows: browse → add to cart → checkout (Stripe test mode), sign up → sign in → view orders, contact form submission. *Source: Playwright docs; Microsoft engineering blog.* — **L**
96. **GitHub Actions CI** that runs on PRs: lint, typecheck, unit tests, Lighthouse CI on a Vercel preview. *Source: GitHub Actions docs; web.dev "Lighthouse CI".* — **M**
97. **Visual regression** with Percy or Chromatic on the preview URL. Catches CSS regressions before they ship. *Source: Percy docs.* — **M**
98. **Synthetic monitoring** — schedule a Playwright test against production every 15 minutes that loads the homepage, hits `/api/products`, and reports to Sentry. *Source: Datadog "Synthetic testing"; Sentry docs.* — **M**

## Observability

99. **Sentry for frontend + backend errors** — your `console.error` calls in api/* go to Vercel logs but you'll miss browser errors entirely. *Source: Sentry docs; Vercel integration guide.* — **S**
100. **Structured logging** — replace `console.error('Checkout error:', err)` with `console.error(JSON.stringify({ event: 'checkout_error', err: err.message, stack: err.stack }))`. Vercel Log Drains can ship to a search index. *Source: 12-Factor App § XI.* — **S**
101. **Web Vitals reporting** — `web-vitals` library posts CLS/INP/LCP to `/api/metrics`. Critical for noticing perf regressions in the wild. *Source: web.dev "Measure Core Web Vitals".* — **S**
102. **Uptime monitoring** — UptimeRobot free tier hits `/` every 5 min. *Source: SRE handbook.* — **S**
103. **Stripe webhook delivery dashboard** — bookmark Stripe → Developers → Webhooks → Recent deliveries. Failed deliveries are silent unless you check. *Source: Stripe docs.* — **S**

## Operations

104. **Vercel deployment protection on `main`** — require a GitHub check (CI green) before deploys promote to production. *Source: Vercel "Deployment Protection" docs.* — **S**
105. **Database backups** — Supabase free tier auto-backups daily, retains 7 days. Document the restore procedure. Pay tier extends retention. *Source: Supabase backup docs.* — **S**
106. **Disaster recovery runbook** in `docs/RUNBOOK.md` — what to do if Stripe goes down (queue orders, retry), if Supabase is degraded (read-only mode), if a deploy breaks (`vercel rollback`). *Source: SRE Workbook.* — **M**
107. **Set up status page** on instatus.com (free) so customers can see if you know about an outage before contacting you. *Source: Atlassian incident management guide.* — **S**
108. **Privacy policy + Terms of Service** linked in footer. Required by Stripe, GDPR, CCPA. Termly or iubenda generate compliant text. *Source: Stripe "Terms of service requirements"; GDPR Art 13.* — **M**
109. **Cookie consent banner** if you ever add analytics that aren't first-party. Otherwise GDPR-exempt. *Source: GDPR Art 7; ICO guidance.* — **M**

## Business / Marketing

110. **Returns/refunds workflow** — documented in [docs/SECURITY.md](docs/SECURITY.md) implicitly (you handle `charge.refunded` in webhook). Build admin-side "issue refund" button using `stripe.refunds.create`. *Source: Stripe Refunds docs.* — **M**
111. **Discount codes** — Stripe Checkout supports `discounts: [{ coupon: 'WELCOME10' }]`. Add a coupon-code input to the cart. *Source: Stripe Coupons docs.* — **M**
112. **Tax automation** — `automatic_tax: { enabled: false }` in [api/checkout.js:149](api/checkout.js#L149). Once you have a Stripe Tax registration in your states, flip to true. *Source: Stripe Tax docs.* — **M**
113. **Klaviyo / Loops integration** for lifecycle email beyond transactional. Newsletter signup → Loops audience. *Source: Klaviyo / Loops docs.* — **M**
114. **Google Search Console + Bing Webmaster** verification + sitemap submission. *Source: Google Search Central onboarding.* — **S**
115. **Schema for Article / How-to** on `/sizing` and `/help` pages. Ranks well for "how to measure for an athletic hoodie" long-tail. *Source: Google Search Central.* — **S**

## Code & Architecture

116. **Module-level Supabase singleton** is fine ([lib/supabase.js:6](lib/supabase.js#L6)) but consider per-request user-scoped clients for endpoints that use auth — preserves RLS instead of bypassing with service role. Reduces blast radius of any RLS-bypass bug. *Source: Supabase docs "Server-side auth".* — **M**
117. **Dependency updates** — `package.json` pins `@supabase/supabase-js ^2.45`, `stripe ^17`, `resend ^4`. Run `npm outdated` quarterly; subscribe to Stripe API changelog. *Source: SemVer; OWASP A06 "Vulnerable Components".* — **S**
118. **Dependabot or Renovate** in GitHub for automatic security PRs. *Source: GitHub Dependabot docs.* — **S**
119. **`engines` enforcement** — already declares `node >= 20.x` in package.json. Add `"engineStrict": true`. *Source: npm docs.* — **S**
120. **API versioning strategy** — when you change the cart/checkout API shape, you'll break old browser tabs. Either accept this or version under `/api/v1/checkout`. *Source: REST API design; Stripe API versioning.* — **L**

## Misc

121. **Skeleton loaders** instead of empty space when products load. Reduces perceived latency. *Source: NN/g "Progress indicators".* — **S**
122. **Animated cross logo** has a `prefers-reduced-motion` carve-out — ensure it pauses on `visibilitychange` to save battery on background tabs. *Source: web.dev "Page Visibility API".* — **S**
123. **Preview-mode badge in [tagline-app.js:55](public/tagline-app.js#L55)** is great DX; consider a banner version with "Set up backend" CTA on first visit only. *Source: Stripe / Vercel onboarding patterns.* — **S**
124. **Unify cents formatting** — `(total / 100).toFixed(2)` is repeated everywhere. Extract `formatCents(n, currency)` using `Intl.NumberFormat`. Handles future i18n. *Source: MDN Intl.NumberFormat.* — **S**
125. **Unit tests for the email normalizer** in [lib/util.js:15](lib/util.js#L15) — Gmail-family normalization is subtle (googlemail, plus tags). Pin behavior with tests before any change. *Source: defensive testing.* — **S**

---

## How to attack this list

1. **Week 1**: items 1–19 (one P0 dev cycle). Mostly small, stops the bleeding on perf, security, social previews.
2. **Week 2**: items 20–34 (a11y + SEO). Big SEO win once JSON-LD ships.
3. **Week 3**: items 35–49 (conversion + email). Money-makers.
4. **Month 2**: P1 (50–93). The "real product" tier.
5. **Quarter 2**: P2 (94–125). Maturity / scale.

After each batch, re-run Lighthouse, axe-core, and a Stripe test purchase end-to-end. Don't move to the next tier until the current one is green.
