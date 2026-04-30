# Bug log — what was found, what was fixed

This file tracks specific bugs discovered during code review and what was done about them. Use it as a forensic record. The broader improvement backlog lives in [../IMPROVEMENTS.md](../IMPROVEMENTS.md).

---

## Fixed in this pass

### 1. CRITICAL — "Network error. Please try again." on sign-up / sign-in

**Symptom:** clicking the sign-in or create-account button always returned the generic *"Network error. Please try again."* alert, regardless of valid credentials.

**Root cause:** load-order bug in [public/signin.html](../public/signin.html). The script tag that defined `window.SUPABASE_URL = 'REPLACE_WITH_PUBLIC_SUPABASE_URL'` was placed *after* the IIFE that read it. So at the time the preview-mode guard ran, `window.SUPABASE_URL` was `undefined`, the guard fell through, and the form was wired up. When the user submitted, `window.SUPABASE_URL` had since been assigned the literal string `'REPLACE_WITH_PUBLIC_SUPABASE_URL'`. The browser treats that as a *relative* URL, fetched `${origin}/REPLACE_WITH_PUBLIC_SUPABASE_URL/auth/v1/signup`, got a 404 HTML page, `res.json()` threw, and the catch handler showed "Network error".

**Fix:** added a new [api/config.js](../api/config.js) endpoint that returns the public Supabase URL + anon key from server env vars. [public/signin.html](../public/signin.html) now fetches this config on page load before enabling the form. No more hand-editing keys, no more placeholder strings to forget. SETUP.md Step 7 was updated to match.

**Sources:**
- OWASP ASVS V14.4 — "Verify that all components are loaded with integrity"
- 12-Factor App § III "Config" — store config in the environment, not in code

---

### 2. Information disclosure in sign-in error messages

**Symptom:** the sign-in error message would relay Supabase's `error_description`, which can differentiate "Invalid email" vs "Wrong password" vs "User not found." That lets an attacker enumerate which email addresses have accounts.

**Fix:** the catch path in [public/signin.html](../public/signin.html) now shows a single generic message: *"Email or password is incorrect."* — regardless of which field was actually wrong.

**Sources:**
- OWASP ASVS V2.1.12 — "Verify that the application does not disclose whether a user account exists or not"
- NIST SP 800-63B § 5.2.2 — "Throttling" / generic failure responses
- Stanford CS253 (Web Security) "Authentication" lecture — username enumeration

---

### 3. No client-side block on common weak passwords

**Symptom:** sign-up only enforced an 8-character minimum. A user could create an account with `password`, `12345678`, etc. The rest of the system would dutifully store and authenticate that.

**Fix:** [public/signin.html](../public/signin.html) sign-up handler now blocks the top-9 most common bad passwords client-side before submission. Server-side counterpart should be added on the Supabase Auth side (or via a custom Edge Function).

**Sources:**
- NIST SP 800-63B § 5.1.1.2 — "Memorized Secret Verifiers": MUST compare against a list of commonly-used, expected, or compromised values
- OWASP ASVS V2.1.7 — "Verify that passwords submitted during account registration are checked against a set of breached passwords"
- HaveIBeenPwned API — for full breach-corpus checks (deferred — needs a server endpoint)

---

### 4. Three duplicate copies of `escapeHtml` across the backend

**Symptom:** [lib/email.js](../lib/email.js), [api/contact.js](../api/contact.js), and [api/stripe-webhook.js](../api/stripe-webhook.js) each had their own `escapeHtml` function. Drift risk: a security-relevant fix to one wouldn't propagate to the others.

**Fix:** new [lib/html.js](../lib/html.js) exports a single canonical `escapeHtml`; the three other files now import from it.

**Source:** DRY principle; OWASP "Defense in Depth" cheat sheet (single canonical sanitizer).

---

### 5. No request-body size limit on contact / newsletter endpoints

**Symptom:** Vercel's default body limit is 4.5 MB. An attacker could pump 4 MB of JSON into [api/contact.js](../api/contact.js) or [api/newsletter.js](../api/newsletter.js) and exhaust memory before validation rejected the payload.

**Fix:** added `export const config = { api: { bodyParser: { sizeLimit: '8kb' } } }` to contact.js and `'2kb'` to newsletter.js — well above what a legitimate request needs, well below what abusive clients want.

**Sources:**
- OWASP ASVS V13.2.5 — "Verify that REST services explicitly check the incoming Content-Type to be the expected one"
- OWASP "Resource Consumption" / DoS cheat sheet
- Vercel Functions docs — `bodyParser.sizeLimit`

---

### 6. Loose tracking-number validation on admin endpoint

**Symptom:** [api/admin.js](../api/admin.js) accepted any string up to 100 chars as a tracking number, only rejecting CR/LF/`<`/`>`. A typo or paste error would silently store garbage.

**Fix:** tightened to `^[A-Z0-9]{8,40}$` (case-insensitive, then upper-cased on store). Covers UPS / FedEx / USPS / DHL formats; rejects junk.

**Source:** carrier-format references; defense-in-depth on top of existing CR/LF/`<>` filter.

---

### 7. Missing user-settings UI

**Symptom:** [public/account.html](../public/account.html) showed only the order list. There was no way for a signed-in user to set their name, phone, or default shipping address — even though the [profiles](../sql/schema.sql) table has columns for them.

**Fix:** added a new `/api/profile` endpoint (GET + PATCH) and a Settings tab on the Account page with profile + default shipping address forms. Inputs use proper `autocomplete` attributes (WCAG 1.3.5; web.dev "Sign-in form best practices") and the form is validated server-side via a strict whitelist sanitizer.

**Sources:**
- WCAG 1.3.5 — "Identify Input Purpose"
- Baymard Institute — "Address form usability"
- web.dev — "Sign-up form best practices"

---

---

## Fixed in second-pass audit

### 8. CRITICAL — cart.html event-listener leak caused multi-step quantity changes

**Symptom:** after a few interactions on the cart page, clicking the "+" button on a line item would advance the quantity by 2, then 3, then 4 in a single click. Same for "−" and Remove.

**Root cause:** [public/cart.html](../public/cart.html) `render()` re-attached a `click` listener to `#cartContent` on every render. Each cart change triggered `cart:updated` → `render()` → another listener added on top of the existing ones. After N renders, a single click fired N handlers, each calling `cart.updateQuantity(...)` independently.

**Fix:** moved the listener attachment to a one-time `init()` function. The container's listener uses event delegation (`e.target` checks) so it survives `innerHTML` replacements.

**Source:** Classic event-listener leak pattern; see MDN "EventTarget.addEventListener" — "Multiple identical event listeners".

---

### 9. api/profile.js partial-address PATCH wiped the existing address

**Symptom:** if a client sent `{shipping_address: {city: 'NYC'}}` to PATCH /api/profile, the entire shipping_address column got overwritten with `{city: 'NYC'}` — losing line1, state, zip.

**Root cause:** the column is a JSONB blob; we replace it on update. The sanitizer let any subset of fields through.

**Fix:** [api/profile.js](../api/profile.js) `sanitizeAddress` now requires `line1, city, state, zip` together (country defaults to 'US' if omitted). The UI in [account.html](../public/account.html) already enforced this client-side; this hardens the server too (defense in depth).

**Source:** OWASP ASVS V8.3.6 — "Verify that data validators are present at the application boundary."

---

### 10. customize.html had a broken `#sizing` link

**Symptom:** "Need help? Size guide" link on /customize did nothing — anchor `#sizing` doesn't exist on the customize page.

**Fix:** changed to `/sizing` (the actual size-guide page).

---

### 11. Email-confirmation handler didn't strip token from URL on auth failure

**Symptom:** if Supabase's `/auth/v1/user` call failed (network blip, expired token), the URL still contained `#access_token=...&type=signup`. A page refresh would re-trigger the attempt; sharing the URL or screenshotting it would leak the token.

**Fix:** [tagline-app.js](../public/tagline-app.js) `handleAuthHash` now strips the hash *before* calling Supabase — the token is consumed regardless of whether auth succeeds. If auth fails, the user just sees the page they landed on without any session set.

**Source:** OWASP ASVS V3.5 — "Verify that tokens are not exposed in URLs unless absolutely necessary."

---

### 12. Add-to-cart silently lied about success when cart was full

**Symptom:** `Cart.add()` returns `false` when the 50-item cap is hit or input is invalid, but two callers (`wireAddToCart` and `addQuickViewToCart` in [tagline-app.js](../public/tagline-app.js)) ignored the return value and showed "Added ✓" anyway. User thinks they added an item; cart is unchanged.

**Fix:** both callers now check the return; on `false` they show "Cart full" / "Cart is full" instead of the success state.

**Source:** Defensive UI; NN/g "Visibility of system status" heuristic.

---

## Known issues — not yet fixed

These are tracked in [IMPROVEMENTS.md](../IMPROVEMENTS.md) but flagged here so you don't deploy unaware.

### Auth / sessions

- **No second-factor (2FA/TOTP)** on accounts. Supabase Auth supports it; we haven't surfaced the UI. *Mitigation: rate limiting + breach-password block, plus generic error messages.*
- **No email-based account recovery flow** in the UI. Supabase Auth supports password reset endpoints; we don't have a "Forgot password?" link yet. **Action item: add `/auth/recover` UI on signin page.**
- **No session-timeout warning.** Supabase tokens last an hour by default; the UI doesn't tell the user when their token is about to expire.
- **Sign-in does not refresh tokens.** Long-running sessions go stale. Use Supabase's `auth.refreshSession()` on a timer.

### Server-side

- **In-memory rate limiter is per-cold-instance.** [lib/util.js:91](../lib/util.js#L91). An attacker hitting different serverless regions can multiply their effective rate. *Move to Vercel KV or Upstash Redis. (IMPROVEMENTS #8.)*
- **No CSRF protection** on POST endpoints. *Add Origin/Referer allow-list. (IMPROVEMENTS #9.)*
- **Stripe webhook idempotency** relies on `status === 'paid'` check; concurrent duplicate events could double-decrement stock. *Add `processed_webhook_events` table. (IMPROVEMENTS #15, #16.)*
- **Supabase email confirmation may not be enabled** in the project dashboard. If it isn't, anyone can sign up with `notmine@example.com` and pollute users. **Action item: in Supabase Dashboard → Authentication → Email Auth → Enable email confirmations.** (IMPROVEMENTS #12.)

### Frontend

- **`window.confirm()` for sign-out** ([public/account.html](../public/account.html)) is functional but ugly and not accessible across all platforms equally.
- **Admin dashboard uses raw `fetch`** ([public/admin.html](../public/admin.html)) instead of the shared `Tagline.API` client — duplicated error handling and no preview-mode plumbing. Also: `res.json()` on a 404 HTML response would throw and break the dashboard.
- **`o.id.slice(0,8)` in [public/account.html](../public/account.html)** assumes `o.id` is non-null. The DB schema makes this true (`uuid not null`), so this is a latent issue at most — but worth noting.
- **Triple-duplicated product catalog**: [public/tagline-app.js](../public/tagline-app.js), [public/cart.html](../public/cart.html), and [public/wishlist.html](../public/wishlist.html) each maintain their own copy of the 24-product map. A price change has to be made in three places (plus Supabase). High drift hazard — see IMPROVEMENTS.md #77.
- **`API.request` marks the whole session as preview mode on any network error** ([public/tagline-app.js:351](../public/tagline-app.js#L351)). A real user with a transient blip stays in preview mode until they refresh. Should retry once before declaring preview, or scope to the failed call only.
- **`stripe-webhook.js` stock decrement fallback is racy** if the RPC fails — does `select` then `update` with no transaction. Already in IMPROVEMENTS.md #16.

---

## How to find more

When auditing, follow this loop:
1. **Read every API handler top-to-bottom** asking: "what if `body` is a 5 MB JSON of nested arrays?" "what if the user sends `id: 'admin'` instead of a UUID?" "what if they replay this request 1000 times in 1 second?"
2. **Read every `localStorage` and `sessionStorage` access** asking: "what if it's `null`? what if it's malformed JSON? what if it's tampered with?"
3. **Read every `innerHTML` assignment** asking: "is every interpolated value escaped?"
4. **Read every redirect** asking: "is the destination user-controlled?"

OWASP's [ASVS Level 1 checklist](https://owasp.org/www-project-application-security-verification-standard/) is a 200-item version of this, and worth running through at least once.
