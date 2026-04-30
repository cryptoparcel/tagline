# TAGLINE — Security Posture

This doc explains what's been hardened. Read this if you're worried about attacks.

---

## XSS (Cross-Site Scripting)

**The Robinhood-style attack** — attacker submits something with HTML in a name/device-name field, app renders it unescaped into an email or page → script runs in admin's browser.

### What's protected:
- **All `innerHTML` template literals** with dynamic data go through `escapeHtml()` first
- **Email templates** in `lib/email.js`, `api/contact.js`, `api/stripe-webhook.js` escape every dynamic field
- **Admin dashboard** escapes all order data, names, emails, subjects, messages — even though admin sees them
- **Account page** escapes order IDs, status, tracking numbers
- **Alert messages** (sign in errors, contact errors) use `textContent` instead of `innerHTML` — completely XSS-proof
- **Form inputs** with control characters or angle brackets are rejected at the API layer
- **Content Security Policy** header blocks inline event handlers and external scripts as defense-in-depth

### What an attacker can't do:
- Put `<script>` in their contact form name → it gets escaped before reaching the admin email
- Put HTML in their Stripe shipping address name → escaped before hitting webhook admin email
- Tamper with localStorage to inject HTML into the cart page → cart only accepts product IDs matching `^[a-z0-9-]{1,50}$`

---

## Email Header Injection

**Classic attack** — attacker enters `name\r\nBCC: victim@evil.com` to pivot the email to other recipients.

### What's protected:
- `sanitizeForSubject()` strips CR/LF, control chars, HTML, and caps length at 100 chars
- Contact form rejects names containing CR/LF/control chars before they ever reach the email sender
- All email subjects use sanitized values

---

## SQL Injection

### What's protected:
- Supabase client always uses parameterized queries — direct user input never reaches raw SQL
- All UUIDs validated against a strict regex before reaching queries
- All product IDs validated against `^[a-z0-9-]{1,50}$` before queries
- Allow-listed values for status fields, view names, etc.

---

## Authentication & Authorization

### Admin
- Admin key requires **32+ characters minimum**
- Comparison uses `timingSafeEqual()` to prevent timing attacks
- Admin endpoints **never expose the key** to the browser
- Admin dashboard stores key in localStorage (acceptable for an admin-only page)

### Users
- Sessions use Supabase Auth JWTs
- JWT format validated client-side before sending (rejects tampered tokens)
- All user-facing data scoped to `auth.uid()` via Postgres Row Level Security policies
- Server uses service-role key to bypass RLS where needed (newsletter, contact, admin)
- Service role key **never sent to browser**

### Cart
- localStorage cart is validated on every read — tampered data is silently dropped
- Server **re-fetches real prices from DB** at checkout, never trusts cart prices
- Stock levels validated server-side before creating Stripe session

---

## Stripe Webhook

### What's protected:
- Signature verification on every webhook call (`stripe.webhooks.constructEvent`)
- Raw body required for verification (Vercel `bodyParser: false` on the webhook route)
- Idempotent — duplicate events for the same order are ignored
- Atomic stock decrement via Postgres function

---

## Rate Limiting

- Newsletter signup: 5 per IP per minute
- Contact form: 3 per IP per 5 minutes
- Checkout: 10 per IP per minute
- Same IP / same email gets blocked from spamming the database

---

## HTTP Security Headers

Set in `vercel.json` for every response:

| Header | Purpose |
|---|---|
| `Content-Security-Policy` | Locks down what scripts/styles/connections are allowed. Blocks XSS exploitation. |
| `Strict-Transport-Security` | Forces HTTPS for 2 years, including preload list |
| `X-Frame-Options: DENY` | Site can't be loaded in an iframe (clickjacking protection) |
| `X-Content-Type-Options: nosniff` | Browsers must respect declared Content-Type |
| `Referrer-Policy: strict-origin-when-cross-origin` | Don't leak full URLs to other sites |
| `Permissions-Policy` | Blocks camera, mic, geolocation by default |
| `frame-ancestors 'none'` | Modern alternative to X-Frame-Options |

API endpoints additionally get `Cache-Control: no-store` and `X-Robots-Tag: noindex` so search engines don't index API responses.

---

## Email Abuse Prevention

### Newsletter
- **Email normalization** prevents the Gmail dot trick: `j.doe@gmail.com` and `jdoe@gmail.com` are treated as the same inbox for deduplication
- Plus-aliases stripped (`me+anything@gmail.com` → `me@gmail.com`)
- Same normalized email = single subscriber row, no matter how many variations submitted
- Doesn't break legitimate non-Gmail users (only Gmail-family domains get the dot-strip treatment)

### Auth
- Auth deliberately does **not** normalize emails — Supabase Auth tracks them as-given. This is intentional so legitimate users with `me+shopping@gmail.com` can still sign up separately if they want.

---

## What I Did Not Build (and Why)

- **2FA / TOTP** — Supabase Auth supports it but adds complexity. Add if you need it.
- **CAPTCHA on forms** — Rate limiting handles 95% of spam. Add hCaptcha or Turnstile if needed.
- **Webhook IP allowlisting** — Stripe doesn't publish stable IPs; signature verification is the recommended approach (already in place).
- **Audit logging** — orders are logged in DB. For compliance work, add a separate `audit_log` table.
- **Encrypted PII at rest** — Supabase encrypts the disk. For PCI/HIPAA workloads, talk to a security pro.

---

## Where to Be Careful

1. **Don't add inline `onclick=` or `onload=`** to any HTML — CSP blocks them anyway, but you shouldn't write them in the first place
2. **Don't `innerHTML` anything from the API** without escaping — the helpers exist, use them
3. **Never log secrets** — `console.log(process.env.STRIPE_SECRET_KEY)` would put it in Vercel logs forever
4. **Rotate the admin key** if you ever share your laptop or commit it accidentally
5. **Use Stripe TEST keys until you've verified everything works end-to-end**
6. **Review Vercel deployment logs** — your error messages could leak info if you change them

---

## Reporting Issues

If someone tells you they found a security bug: take it seriously, don't argue. A good response: "Thanks. I'll look into this within 24 hours and keep you updated." Then actually do that.
