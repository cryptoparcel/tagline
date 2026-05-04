// =================================================================
// TAGLINE — Shared frontend JS
// =================================================================
// Loaded on every page. Handles:
//   - localStorage cart (persists across sessions)
//   - Supabase auth state via JWT in localStorage
//   - Newsletter signup
//   - Cart badge updates
//   - Sign-in link adapts to logged-in state
//   - Preview mode (graceful fallbacks when backend isn't connected)
// =================================================================

(function() {
  'use strict';

  const CART_KEY = 'tagline_cart_v1';
  const WISHLIST_KEY = 'tagline_wishlist_v1';
  const RECENT_KEY = 'tagline_recent_v1';
  const TOKEN_KEY = 'tagline_token';
  const USER_KEY = 'tagline_user';

  // Centralized limits — prevents drift between defensive validators
  // (read-side caps in get(), write-side caps in add()) and gives a
  // single place to tune.
  const LIMITS = Object.freeze({
    CART_LINES: 50,        // distinct line items in cart
    CART_QTY_MAX: 10,      // max qty per line item
    WISHLIST: 100,         // saved items
    RECENT: 8,             // recently-viewed history
  });

  const VALID_SIZES = ['XS','S','M','L','XL','XXL'];

  // Shared validators — used in Cart/Wishlist/Recent get-time filters AND
  // in their public add/toggle methods (defense in depth).
  const isValidProductId = (s) =>
    typeof s === 'string' && /^[a-z0-9-]{1,50}$/.test(s);

  const isValidCartItem = (item) =>
    item && typeof item === 'object' &&
    isValidProductId(item.product_id) &&
    Number.isInteger(item.quantity) &&
    item.quantity > 0 && item.quantity <= LIMITS.CART_QTY_MAX &&
    (item.size === undefined || VALID_SIZES.indexOf(item.size) !== -1);

  // ============ IMAGE-PROBE CACHE ============
  // The homepage probes /images/products/{id}.jpg for each of the 24
  // product cards on every page load. With most images missing, that
  // was 24+ wasted 404s per visit. Cache the result per-session so we
  // probe each id at most ONCE — and skip future probes for known-404s.
  //   sessionStorage value: 'ok' (image exists) or '404' (doesn't)
  // Resolves a product's display image. Each product entry can have an
  // `image_url` (real product photo) which takes precedence; otherwise
  // falls back to /images/products/{id}.jpg for self-hosted images.
  // The onFound callback receives the URL that loaded successfully so
  // callers can set img.src to it.
  function getProductImageUrl(productId) {
    const p = (typeof PRODUCTS !== 'undefined') ? PRODUCTS[productId] : null;
    if (p && p.image_url && /^https?:\/\//i.test(p.image_url)) return p.image_url;
    return `/images/products/${productId}.jpg`;
  }
  function probeProductImage(productId, onFound) {
    const key = 'tagline_img_' + productId;
    const targetUrl = getProductImageUrl(productId);
    let cached = null;
    try { cached = sessionStorage.getItem(key); } catch {}
    if (cached === '404') return;        // known-missing, skip
    if (cached && cached !== '404' && cached === targetUrl) { onFound(targetUrl); return; }

    const test = new Image();
    test.onload = () => {
      try { sessionStorage.setItem(key, targetUrl); } catch {}
      onFound(targetUrl);
    };
    test.onerror = () => {
      try { sessionStorage.setItem(key, '404'); } catch {}
    };
    test.src = targetUrl;
  }

  // localStorage helpers — read/parse/validate/cap in one shot.
  // Returns [] on any failure (missing, malformed, tampered).
  function readList(key, validateItem, max) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(validateItem).slice(0, max);
    } catch { return []; }
  }
  function writeList(key, items) {
    try { localStorage.setItem(key, JSON.stringify(items)); } catch {}
  }

  // ============ PREVIEW MODE DETECTION ============
  // Cache result per-session. We probe /api/products once on first page load.
  // If it fails, the site goes into "preview mode" — backend features show
  // friendly "coming soon" messages instead of erroring.
  let previewModeChecked = false;
  let isPreviewMode = false;

  async function checkPreviewMode() {
    if (previewModeChecked) return isPreviewMode;
    try {
      const cached = sessionStorage.getItem('tagline_preview_mode');
      if (cached !== null) {
        isPreviewMode = cached === 'true';
        previewModeChecked = true;
        return isPreviewMode;
      }
    } catch {}

    try {
      const res = await fetch('/api/products', { method: 'GET' });
      // 200 = backend works. 404/500/network error = preview mode.
      isPreviewMode = !res.ok;
    } catch {
      isPreviewMode = true;
    }

    previewModeChecked = true;
    try { sessionStorage.setItem('tagline_preview_mode', String(isPreviewMode)); } catch {}

    if (isPreviewMode) showPreviewBadge();
    return isPreviewMode;
  }

  function showPreviewBadge() {
    if (document.querySelector('.preview-badge')) return;
    const badge = document.createElement('div');
    badge.className = 'preview-badge';
    badge.textContent = 'Preview mode';
    badge.title = 'Backend not connected. Forms and checkout are disabled.';
    Object.assign(badge.style, {
      position: 'fixed',
      bottom: '14px',
      right: '14px',
      padding: '6px 12px',
      background: 'rgba(184,137,61,.15)',
      border: '1px solid rgba(184,137,61,.4)',
      color: '#d4a558',
      fontSize: '10px',
      fontWeight: '600',
      letterSpacing: '0.16em',
      textTransform: 'uppercase',
      borderRadius: '999px',
      zIndex: '99',
      backdropFilter: 'blur(8px)',
      pointerEvents: 'none',
      fontFamily: 'Inter, sans-serif'
    });
    document.body.appendChild(badge);
  }

  // ============ CART ============
  const Cart = {
    get() {
      // Read + validate via shared helper, then normalize each item.
      // Normalization re-clamps quantity in case any older client wrote
      // looser values before the cap existed.
      return readList(CART_KEY, isValidCartItem, LIMITS.CART_LINES).map(item => {
        const out = {
          product_id: item.product_id,
          quantity: Math.min(LIMITS.CART_QTY_MAX, Math.max(1, item.quantity))
        };
        if (item.size && VALID_SIZES.indexOf(item.size) !== -1) out.size = item.size;
        return out;
      });
    },
    save(items) {
      writeList(CART_KEY, items);
      this.updateBadge();
      window.dispatchEvent(new CustomEvent('cart:updated'));
    },
    add(productId, quantity = 1, options = {}) {
      // Validate inputs before storing — defense in depth.
      if (!isValidProductId(productId)) return false;
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > LIMITS.CART_QTY_MAX) return false;
      const size = (options && typeof options.size === 'string' && VALID_SIZES.indexOf(options.size) !== -1)
        ? options.size : null;

      const items = this.get();
      // Same product+size = stack quantities, different size = new line
      const existing = items.find(i =>
        i.product_id === productId && (i.size || null) === size
      );
      if (existing) {
        existing.quantity = Math.min(LIMITS.CART_QTY_MAX, existing.quantity + quantity);
      } else {
        if (items.length >= LIMITS.CART_LINES) return false;
        const item = { product_id: productId, quantity: Math.min(LIMITS.CART_QTY_MAX, quantity) };
        if (size) item.size = size;
        items.push(item);
      }
      this.save(items);
      return true;
    },
    remove(productId, size) {
      // If size given, remove only that variant. Otherwise remove all variants.
      const items = this.get().filter(i => {
        if (i.product_id !== productId) return true;
        if (size !== undefined && (i.size || null) !== (size || null)) return true;
        return false;
      });
      this.save(items);
    },
    updateQuantity(productId, quantity, size) {
      const items = this.get();
      const item = items.find(i =>
        i.product_id === productId &&
        (size === undefined || (i.size || null) === (size || null))
      );
      if (!item) return;
      if (quantity <= 0) {
        this.remove(productId, size);
      } else {
        item.quantity = Math.min(LIMITS.CART_QTY_MAX, quantity);
        this.save(items);
      }
    },
    clear() {
      this.save([]);
    },
    count() {
      return this.get().reduce((sum, i) => sum + i.quantity, 0);
    },
    updateBadge() {
      const count = this.count();
      document.querySelectorAll('.cart-badge, [data-cart-count]').forEach(el => {
        el.textContent = String(count);
        el.style.display = count > 0 ? '' : 'none';
      });
    }
  };

  // ============ WISHLIST ============
  // Saved products ("hearted"), persists across sessions. Same defensive
  // validation as Cart — only allows clean product_id strings.
  const Wishlist = {
    get() { return readList(WISHLIST_KEY, isValidProductId, LIMITS.WISHLIST); },
    save(items) {
      writeList(WISHLIST_KEY, items);
      this.updateBadge();
      this.updateHearts();
    },
    has(productId) { return this.get().indexOf(productId) !== -1; },
    toggle(productId) {
      if (!isValidProductId(productId)) return false;
      const items = this.get();
      const idx = items.indexOf(productId);
      if (idx === -1) {
        if (items.length >= LIMITS.WISHLIST) return false;
        items.push(productId);
      } else {
        items.splice(idx, 1);
      }
      this.save(items);
      return idx === -1; // true if just added
    },
    count() { return this.get().length; },
    updateBadge() {
      const count = this.count();
      document.querySelectorAll('.wishlist-badge, [data-wishlist-count]').forEach(el => {
        el.textContent = String(count);
        el.style.display = count > 0 ? '' : 'none';
      });
    },
    updateHearts() {
      const items = this.get();
      document.querySelectorAll('.heart-btn').forEach(btn => {
        const id = btn.dataset.productId;
        if (!id) return;
        btn.classList.toggle('active', items.indexOf(id) !== -1);
      });
    }
  };

  // ============ RECENTLY VIEWED ============
  // Tracks the last LIMITS.RECENT product IDs the user opened in quick
  // view. Rendered as a small carousel on the homepage if 3+ entries.
  const Recent = {
    get() { return readList(RECENT_KEY, isValidProductId, LIMITS.RECENT); },
    add(id) {
      if (!isValidProductId(id)) return;
      const list = this.get().filter(x => x !== id); // dedupe
      list.unshift(id);                              // most-recent first
      writeList(RECENT_KEY, list.slice(0, LIMITS.RECENT));
    }
  };

  // ============ AUTH ============
  // Supports "Remember me" via a session-only mode:
  //   setSession(token, user, { sessionOnly: false })  → localStorage (persists)
  //   setSession(token, user, { sessionOnly: true })   → sessionStorage (cleared on tab close)
  // getToken / getUser look in both; clear wipes both.
  function readBoth(key) {
    try {
      return localStorage.getItem(key) || sessionStorage.getItem(key);
    } catch { return null; }
  }
  function writeOne(key, value, sessionOnly) {
    try {
      // Always remove from the other store to avoid stale state
      if (sessionOnly) {
        localStorage.removeItem(key);
        sessionStorage.setItem(key, value);
      } else {
        sessionStorage.removeItem(key);
        localStorage.setItem(key, value);
      }
    } catch {}
  }
  function clearBoth(key) {
    try { localStorage.removeItem(key); } catch {}
    try { sessionStorage.removeItem(key); } catch {}
  }

  const Auth = {
    getToken() {
      const t = readBoth(TOKEN_KEY);
      // JWT format: 3 base64url segments separated by dots
      if (typeof t !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t)) {
        return null;
      }
      return t;
    },
    getUser() {
      try {
        const raw = readBoth(USER_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        return {
          id: typeof parsed.id === 'string' ? parsed.id : null,
          email: typeof parsed.email === 'string' ? parsed.email : null
        };
      } catch {
        return null;
      }
    },
    setSession(token, user, options = {}) {
      const sessionOnly = !!options.sessionOnly;
      if (token) writeOne(TOKEN_KEY, token, sessionOnly);
      if (user) writeOne(USER_KEY, JSON.stringify(user), sessionOnly);
      this.updateUI();
    },
    clear() {
      clearBoth(TOKEN_KEY);
      clearBoth(USER_KEY);
      this.updateUI();
    },
    isLoggedIn() {
      return !!this.getToken();
    },
    updateUI() {
      const isLoggedIn = this.isLoggedIn();
      const user = this.getUser();
      document.querySelectorAll('.signin-link, .mobile-signin').forEach(el => {
        if (isLoggedIn) {
          el.textContent = 'Account';
          el.setAttribute('href', '/account');
        } else {
          el.textContent = 'Sign in';
          el.setAttribute('href', '/signin');
        }
      });
      document.querySelectorAll('[data-user-email]').forEach(el => {
        el.textContent = user?.email || '';
      });
    }
  };

  // ============ API CLIENT ============
  // Mark a session as "preview mode" only on the FIRST probe that fails.
  // Once we've established the backend is alive (any successful call), a
  // transient network blip should never demote the user back to preview —
  // they just see "Network error, try again" and can retry.
  function maybeFlipToPreview(reason) {
    if (previewModeChecked) return false;
    isPreviewMode = true;
    previewModeChecked = true;
    showPreviewBadge();
    return true;
  }

  const API = {
    async request(path, { method = 'GET', body, auth = false } = {}) {
      const headers = { 'Content-Type': 'application/json' };
      if (auth) {
        const token = Auth.getToken();
        if (token) headers['Authorization'] = `Bearer ${token}`;
      }
      try {
        const res = await fetch(path, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined
        });
        // 404 = route not deployed. If we haven't checked preview mode yet,
        // treat this as the probe and flip. Otherwise just return the error.
        if (res.status === 404) {
          if (maybeFlipToPreview('404')) {
            return { ok: false, error: 'This feature isn\'t live yet — coming soon.', preview: true };
          }
          return { ok: false, error: 'Endpoint not found.' };
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          // 500 with "not configured" → backend env vars missing → preview
          // (only on first probe though — same logic as 404)
          if (res.status === 500 && data.error && /not.*configured|missing.*env|SUPABASE/i.test(data.error)) {
            if (maybeFlipToPreview('500-misconfig')) {
              return { ok: false, error: 'This feature isn\'t live yet — coming soon.', preview: true };
            }
          }
          // Once we've confirmed backend is alive, mark it so future blips
          // don't demote the session to preview mode.
          previewModeChecked = true;
          return { ok: false, error: data.error || `Request failed (${res.status})` };
        }
        // Success implies the backend exists; lock the determination.
        previewModeChecked = true;
        return { ok: true, ...data };
      } catch (err) {
        // Network failure. If we haven't determined yet, this is the probe
        // and we flip to preview. Otherwise it's just a transient blip —
        // surface a real error so the user can retry.
        if (maybeFlipToPreview('network')) {
          return { ok: false, error: 'This feature isn\'t live yet — coming soon.', preview: true };
        }
        return { ok: false, error: 'Network error. Please try again.' };
      }
    }
  };

  // ============ PASSWORD SHOW/HIDE TOGGLES ============
  // Auto-wires every <input type="password" data-pw-toggle> with an eye
  // button on the right that toggles type=password ↔ type=text. Built
  // via DOM API so it composes with any styling. Idempotent.
  const EYE_OPEN = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF  = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.7 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a18 18 0 0 1-3.1 3.9"/><path d="M6.6 6.6A18 18 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 4.5-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

  function wirePasswordToggles() {
    const inputs = document.querySelectorAll('input[type="password"][data-pw-toggle]');
    inputs.forEach(input => {
      if (input.dataset.pwWired) return;
      input.dataset.pwWired = '1';

      // Wrap the input so the toggle can be absolutely positioned.
      // We DON'T move the input out of the existing form-group — just
      // wrap it in place.
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:relative;display:block';
      input.parentNode.insertBefore(wrap, input);
      wrap.appendChild(input);
      // Add right padding to the input so the eye button doesn't overlap text
      const oldPaddingRight = input.style.paddingRight;
      input.style.paddingRight = '44px';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pw-toggle-btn';
      btn.setAttribute('aria-label', 'Show password');
      btn.style.cssText = 'position:absolute;right:8px;top:50%;transform:translateY(-50%);background:transparent;border:none;color:var(--muted,#7a7a72);cursor:pointer;padding:8px;display:flex;align-items:center;line-height:1;border-radius:4px';
      btn.innerHTML = EYE_OPEN;
      wrap.appendChild(btn);

      btn.addEventListener('click', () => {
        const isText = input.type === 'text';
        input.type = isText ? 'password' : 'text';
        btn.innerHTML = isText ? EYE_OPEN : EYE_OFF;
        btn.setAttribute('aria-label', isText ? 'Show password' : 'Hide password');
      });
      btn.addEventListener('mouseenter', () => { btn.style.color = 'var(--ink,#fafaf7)'; });
      btn.addEventListener('mouseleave', () => { btn.style.color = 'var(--muted,#7a7a72)'; });
    });
    // Restore original padding marker so it can be reset if needed
    void inputs.length;
  }

  // ============ NEWSLETTER FORM ============
  function wireNewsletterForms() {
    document.querySelectorAll('.newsletter-form').forEach(form => {
      // Skip if already wired
      if (form.dataset.wired) return;
      form.dataset.wired = '1';

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = form.querySelector('input[type="email"]');
        const button = form.querySelector('button');
        if (!input || !button) return;

        const email = input.value.trim();
        if (!email) return;

        const originalText = button.textContent;
        button.disabled = true;
        button.textContent = 'Sending…';

        const result = await API.request('/api/newsletter', {
          method: 'POST',
          body: { email }
        });

        if (result.ok) {
          button.textContent = 'Joined ✓';
          input.value = '';
          input.blur();
          setTimeout(() => {
            button.textContent = originalText;
            button.disabled = false;
          }, 3000);
        } else if (result.preview) {
          // Friendly preview-mode message
          button.textContent = 'Coming soon';
          input.value = '';
          input.placeholder = 'Live at launch';
          setTimeout(() => {
            button.textContent = originalText;
            button.disabled = false;
            input.placeholder = 'your@email.com';
          }, 3000);
        } else {
          button.textContent = 'Try again';
          alert(result.error || 'Could not subscribe. Please try again.');
          setTimeout(() => {
            button.textContent = originalText;
            button.disabled = false;
          }, 2000);
        }
      });
    });
  }

  // ============ PRODUCT DATA ============
  // Full data for each product, used by quick-view drawer.
  // `description` is the editorial brand-voice copy — also flows into
  // JSON-LD product schema, so it doubles as SEO surface.
  // 24 product slots from the original homepage design, each populated
  // with real Tagline Apparel data. Original IDs preserved (so they
  // stay aligned with the cards' SVG illustrations + cart/wishlist
  // localStorage). image_url overlays the SVG when probeProductImage
  // confirms the URL loads.
  const PRODUCTS = {
    'ascend-hoodie':  { name:'TL Winter Hoodie',         color:null, price:45, stock:50,  category:'Outerwear', tag:'',
      description:'Heavyweight winter pullover with the TL signature. Built for cold mornings and casual nights.',
      image_url:'https://taglineapparel.myshopify.com/cdn/shop/files/rn-image_picker_lib_temp_8db61751-179f-4792-94db-fa33145c04eb.jpg?v=1768915828&width=1000' },
    'halo-zip':       { name:'TTM Quarter-Zip',          color:null, price:35, stock:40,  category:'Tops',      tag:'',
      description:'Quarter-zip pullover with the TTM detail. Athletic cut, brushed inside, pairs with anything.',
      image_url:'https://taglineapparel.myshopify.com/cdn/shop/files/B2796E1A-0A02-4370-BC1A-87BDFE471E5A.png?v=1762482462&width=1000' },
    'origin-tee':     { name:'"Everyday" Shirt',         color:null, price:25, stock:100, category:'Tops',      tag:'',
      description:'The shirt you grab without thinking. Soft cotton, classic fit, made for daily rotation.',
      image_url:'https://taglineapparel.myshopify.com/cdn/shop/files/rn-image_picker_lib_temp_8c64d9c2-9284-4019-b2f5-cb4ef82f3df6.png?v=1768914448&width=1000' },
    'sigil-tank':     { name:'Gym Shirt',                color:null, price:25, stock:80,  category:'Tops',      tag:'',
      description:'Lightweight performance shirt with a mesh-back panel. Built to move, dries fast.',
      image_url:'https://taglineapparel.myshopify.com/cdn/shop/files/rn-image_picker_lib_temp_65a0576e-dbba-443f-a04a-5d91f6d91d20.jpg?v=1775552279&width=1000' },
    'vesper-long':    { name:'Drawstring Long Sleeve',   color:null, price:25, stock:60,  category:'Tops',      tag:'',
      description:'Long sleeve tee with adjustable drawstring hem. Layer it open or pull it tight.',
      image_url:'https://taglineapparel.myshopify.com/cdn/shop/files/4898461D-4ABC-445E-92D5-6D19078CD198.jpg?v=1761724512&width=1000' },
    'path-jogger':    { name:'Cargo Sweatpants',         color:null, price:55, stock:45,  category:'Bottoms',   tag:'',
      description:'Sweatpants meet cargo pockets. Tapered leg, drawcord waist, six functional pockets.',
      image_url:'https://taglineapparel.myshopify.com/cdn/shop/files/rn-image_picker_lib_temp_7c4f5b99-50af-43eb-ac4e-81ff780a2b4b.jpg?v=1768725457&width=1000' },
    'trial-short':    { name:'2-in-1 Compression Shorts',color:null, price:40, stock:70,  category:'Bottoms',   tag:'',
      description:'Compression liner inside, training short outside. The pair that handles the gym AND the run.',
      image_url:'https://taglineapparel.myshopify.com/cdn/shop/files/IMG-0022.jpg?v=1761716083&width=1000' },
    'cloud-crew':     { name:'Slim Sweatshirt',          color:null, price:50, stock:50,  category:'Outerwear', tag:'',
      description:'Slim-cut crewneck sweatshirt. Tailored shoulder, ribbed cuffs, brushed inside.',
      image_url:'https://taglineapparel.myshopify.com/cdn/shop/files/IMG-0038.jpg?v=1761716083&width=1000' },
    'crown-cap':      { name:'TL "Rocket" Shirt',        color:null, price:25, stock:70,  category:'Tops',      tag:'Featured',
      description:'The Rocket tee. Soft, structured, statement-piece embroidery.',
      image_url:'https://taglineapparel.myshopify.com/cdn/shop/files/rn-image_picker_lib_temp_95ca150e-60c6-4308-90f2-6310c8096b6a.jpg?v=1768722286&width=1000' },
    'halo-runner':    { name:'TL "Rocket" Hoodie',       color:null, price:55, stock:30,  category:'Outerwear', tag:'Featured',
      description:'The Rocket hoodie. Heavyweight, embroidered, and unmistakably ours.',
      image_url:'https://taglineapparel.myshopify.com/cdn/shop/files/rn-image_picker_lib_temp_b5276775-498d-4315-8251-37c7234be6b4.jpg?v=1768722983&width=1000' },
    'aether-bra':     { name:'Irregular Bra',            color:null, price:25, stock:60,  category:'Tops',      tag:'',
      description:'Asymmetric strap design with light support and removable pads. Different on purpose.',
      image_url:'https://taglineapparel.myshopify.com/cdn/shop/files/B723BBA2-B00A-4C9A-8283-226AFEB8C698.jpg?v=1761548691&width=1000' },
    'aether-legging': { name:'High-Waist Scrunch Leggings',color:null,price:25, stock:75,  category:'Bottoms',   tag:'',
      description:'High-rise scrunch-back leggings with four-way stretch. Lifts and supports.',
      image_url:'https://taglineapparel.myshopify.com/cdn/shop/files/10E1634C-49D7-4DD4-807E-47C10E802785.jpg?v=1762342748&width=1000' },
    'reign-bomber':   { name:'3-D Embroidery Hoodie',    color:null, price:45, stock:35,  category:'Outerwear', tag:'New',
      description:'Heavyweight hoodie with raised 3-D embroidery. Premium feel, statement detail.',
      image_url:'https://taglineapparel.myshopify.com/cdn/shop/files/rn-image_picker_lib_temp_4981aa0e-9864-43bd-9e9e-c30e28e472b3.jpg?v=1775531157&width=1000' },
    'velocity-track': { name:'Runner Vest',              color:null, price:45, stock:30,  category:'Outerwear', tag:'',
      description:'Lightweight running vest with hi-vis trim. Holds your essentials without the bounce.',
      image_url:'https://taglineapparel.myshopify.com/cdn/shop/files/rn-image_picker_lib_temp_0a5e02aa-8e81-4e92-963d-cee6741b086c.jpg?v=1775536851&width=1000' },
    'vow-beanie':     { name:'Box\'e Tee',               color:null, price:20, stock:90,  category:'Tops',      tag:'',
      description:'Boxy-cut tee in heavyweight cotton. Loose through the chest and shoulders, slightly cropped.',
      image_url:'https://taglineapparel.myshopify.com/cdn/shop/files/rn-image_picker_lib_temp_935aa918-1d27-4cb2-96fb-e191e14f38f3.jpg?v=1775552279&width=1000' },
    'anthem-polo':    { name:'Quarter-Zip Long Sleeve',  color:null, price:35, stock:45,  category:'Tops',      tag:'',
      description:'Quarter-zip long sleeve in soft jersey. Layer-friendly, runs true to size.',
      image_url:'https://taglineapparel.myshopify.com/cdn/shop/files/IMG-0025.jpg?v=1761716083&width=1000' },
    'lumen-crop':     { name:'Open-Back Top',            color:null, price:15, stock:65,  category:'Tops',      tag:'',
      description:'Strappy open-back top for studio workouts. Light support, ample airflow.',
      image_url:'https://taglineapparel.myshopify.com/cdn/shop/files/12F0C544-CB97-40D1-88BC-116B7BEBE75E.jpg?v=1762498096&width=1000' },
    'pilgrim-pant':   { name:'Sport Pants',              color:null, price:55, stock:30,  category:'Bottoms',   tag:'',
      description:'Premium sport pant with side stripes. Tapered fit, drawcord waist, finished hem.',
      image_url:'https://taglineapparel.myshopify.com/cdn/shop/files/BD848E54-21F0-4255-B1F1-7D0A533C1E35.jpg?v=1761554034&width=1000' },
    'spirit-shell':   { name:'Autumn Hoodie',            color:null, price:40, stock:45,  category:'Outerwear', tag:'',
      description:'Mid-weight pullover for transitional weather. Soft inside, structured outside.',
      image_url:'https://taglineapparel.myshopify.com/cdn/shop/files/F927811C-A783-41CF-8491-3BB00D16D998.jpg?v=1762497681&width=1000' },
    'echo-vest':      { name:'Oversized Light Sweater',  color:null, price:65, stock:25,  category:'Outerwear', tag:'',
      description:'Soft-weave oversized sweater. Drapes long, layers easy, finishes any outfit.',
      image_url:'https://taglineapparel.myshopify.com/cdn/shop/files/F329367F-4612-4CBE-A66D-A7BD3BC84DC1.jpg?v=1761553089&width=1000' },
    'verse-henley':   { name:'Quick-Dry Shirt',          color:null, price:20, stock:80,  category:'Tops',      tag:'',
      description:'Performance shirt that dries in minutes. Anti-odor finish, low-profile fit.',
      image_url:'https://taglineapparel.myshopify.com/cdn/shop/files/7E62E8C7-9832-4D8F-B46A-AE8249EDD544.jpg?v=1761546662&width=1000' },
    'sole-sock':      { name:'Women\'s Gym Shorts',      color:null, price:20, stock:80,  category:'Bottoms',   tag:'',
      description:'Light, breathable gym shorts with built-in liner. Quick-drying, doesn\'t ride.',
      image_url:'https://taglineapparel.myshopify.com/cdn/shop/files/rn-image_picker_lib_temp_1210f229-9c09-47f0-9203-2aa876bb70fb.jpg?v=1775552279&width=1000' },
    'pulse-band':     { name:'Women\'s Sport Bra',       color:null, price:30, stock:60,  category:'Tops',      tag:'',
      description:'Medium-support sport bra. Removable pads, racerback design, moisture-wicking.',
      image_url:'https://taglineapparel.myshopify.com/cdn/shop/files/rn-image_picker_lib_temp_70148a65-ac5c-4e67-b9c8-10d2ad789c1c.jpg?v=1775552279&width=1000' },
    'quill-tote':     { name:'Women\'s "Butter-Soft" Leggings',color:null,price:30,stock:70,category:'Bottoms', tag:'New',
      description:'Butter-soft fabric, high rise, pocket-equipped. The leggings you\'ll forget you\'re wearing.',
      image_url:'https://taglineapparel.myshopify.com/cdn/shop/files/AEEB6281-985A-423A-AAA8-097D87601F6D.jpg?v=1762231785&width=1000' }
  };

  // Hand-curated outfit pairings — what to wear with each piece.
  // Shown in the quick-view drawer as a "Style this with" carousel.
  // Curate-don't-compute: at 24 products, hand-picking beats any
  // recommendation algorithm. Edit freely as the catalog evolves.
  const PRODUCT_PAIRINGS = {
    'ascend-hoodie':  ['path-jogger',    'crown-cap',     'sole-sock'],
    'halo-zip':       ['origin-tee',     'path-jogger',   'crown-cap'],
    'origin-tee':     ['path-jogger',    'crown-cap',     'sole-sock'],
    'sigil-tank':     ['trial-short',    'pulse-band',    'sole-sock'],
    'vesper-long':    ['pilgrim-pant',   'vow-beanie',    'crown-cap'],
    'path-jogger':    ['origin-tee',     'halo-zip',      'sole-sock'],
    'trial-short':    ['sigil-tank',     'pulse-band',    'sole-sock'],
    'cloud-crew':     ['pilgrim-pant',   'vow-beanie',    'crown-cap'],
    'crown-cap':      ['ascend-hoodie',  'origin-tee',    'path-jogger'],
    'halo-runner':    ['sole-sock',      'trial-short',   'sigil-tank'],
    'aether-bra':     ['aether-legging', 'pulse-band',    'sole-sock'],
    'aether-legging': ['aether-bra',     'sigil-tank',    'sole-sock'],
    'reign-bomber':   ['origin-tee',     'pilgrim-pant',  'vow-beanie'],
    'velocity-track': ['path-jogger',    'origin-tee',    'crown-cap'],
    'vow-beanie':     ['cloud-crew',     'vesper-long',   'pilgrim-pant'],
    'anthem-polo':    ['pilgrim-pant',   'crown-cap',     'sole-sock'],
    'lumen-crop':     ['aether-legging', 'crown-cap',     'sole-sock'],
    'pilgrim-pant':   ['vesper-long',    'vow-beanie',    'crown-cap'],
    'spirit-shell':   ['origin-tee',     'path-jogger',   'sole-sock'],
    'echo-vest':      ['verse-henley',   'pilgrim-pant',  'vow-beanie'],
    'verse-henley':   ['pilgrim-pant',   'vow-beanie',    'sole-sock'],
    'sole-sock':      ['trial-short',    'halo-runner',   'pulse-band'],
    'pulse-band':     ['sigil-tank',     'trial-short',   'sole-sock'],
    'quill-tote':     ['origin-tee',     'crown-cap',     'sole-sock']
  };

  // Maps product name to DB product ID
  const PRODUCT_NAME_TO_ID = {};
  Object.keys(PRODUCTS).forEach(id => {
    PRODUCT_NAME_TO_ID[PRODUCTS[id].name] = id;
  });

  // ============ ADD TO CART BUTTONS (data-add-to-cart) ============
  // For any inline "Add to cart" button that exists in HTML
  function wireAddToCart() {
    document.querySelectorAll('[data-add-to-cart]').forEach(btn => {
      if (btn.dataset.wired) return;
      btn.dataset.wired = '1';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const productId = btn.dataset.addToCart;
        if (!productId) return;
        const original = btn.textContent;
        const added = Cart.add(productId, 1);
        if (!added) {
          // Hit the 50-item cap or invalid input — tell the user instead
          // of silently lying with "Added ✓".
          btn.textContent = 'Cart full';
          btn.disabled = true;
          setTimeout(() => {
            btn.textContent = original;
            btn.disabled = false;
          }, 1800);
          return;
        }
        btn.textContent = 'Added ✓';
        btn.disabled = true;
        showToast(PRODUCTS[productId]);
        setTimeout(() => {
          btn.textContent = original;
          btn.disabled = false;
        }, 1500);
      });
    });
  }

  // ============ QUICK VIEW DRAWER ============
  // Internal state of the currently-open product
  let qvCurrentProduct = null;
  let qvCurrentSize = null;
  let qvCurrentQty = 1;
  let qvLastFocus = null; // element to restore focus to on close

  // Focus trap via the `inert` attribute. When set on an element,
  // it and all its descendants become unfocusable and invisible to
  // assistive tech. Setting it on the drawer's siblings means
  // keyboard users can't Tab out of the drawer, satisfying
  // WAI-ARIA APG "Dialog (Modal)" focus-trap requirement.
  function lockBackground() {
    const drawer = document.getElementById('qvDrawer');
    const backdrop = document.getElementById('qvBackdrop');
    Array.from(document.body.children).forEach(el => {
      if (el === drawer || el === backdrop) return;
      // Don't double-set or accidentally trap our own toast announcements
      if (!el.hasAttribute('inert')) {
        el.setAttribute('inert', '');
        el.dataset.qvInertSet = '1';
      }
    });
  }
  function unlockBackground() {
    document.querySelectorAll('[data-qv-inert-set]').forEach(el => {
      el.removeAttribute('inert');
      delete el.dataset.qvInertSet;
    });
  }

  function getQvElements() {
    return {
      backdrop: document.getElementById('qvBackdrop'),
      drawer: document.getElementById('qvDrawer'),
      closeBtn: document.getElementById('qvClose'),
      imageLetter: document.getElementById('qvImageLetter'),
      tagBadge: document.getElementById('qvTagBadge'),
      name: document.getElementById('qvName'),
      color: document.getElementById('qvColor'),
      price: document.getElementById('qvPrice'),
      description: document.getElementById('qvDescription'),
      sizes: document.getElementById('qvSizes'),
      qtyDisplay: document.getElementById('qvQty'),
      qtyMinus: document.getElementById('qvQtyMinus'),
      qtyPlus: document.getElementById('qvQtyPlus'),
      stock: document.getElementById('qvStock'),
      addBtn: document.getElementById('qvAddBtn'),
      pairings: document.getElementById('qvPairings'),
      pairingsRow: document.getElementById('qvPairingsRow'),
      kitBtn: document.getElementById('qvKitBtn'),
      kitLabel: document.getElementById('qvKitLabel'),
      kitPrice: document.getElementById('qvKitPrice')
    };
  }

  // Build the "Style this with" carousel for the open product. Hides the
  // section if no pairings exist or all paired products are sold out.
  function renderQvPairings(productId, els) {
    if (!els.pairings || !els.pairingsRow) return;
    const pairs = (PRODUCT_PAIRINGS[productId] || [])
      .map(id => ({ id, p: PRODUCTS[id] }))
      .filter(x => x.p);
    if (pairs.length === 0) {
      els.pairings.hidden = true;
      return;
    }

    // "Add the kit" button — current product + all in-stock pairings.
    // We only count in-stock pairings in the kit price; sold-out items
    // are still shown as cards but excluded from the bundle add.
    const inStockPairs = pairs.filter(x => x.p.stock > 0);
    const currentProduct = PRODUCTS[productId];
    if (els.kitBtn && currentProduct) {
      // Disable kit button if current product is sold out OR no pairings
      // in stock (nothing meaningful to add).
      const kitHasItems = currentProduct.stock > 0 && inStockPairs.length > 0;
      els.kitBtn.hidden = !kitHasItems;
      if (kitHasItems) {
        const total = currentProduct.price + inStockPairs.reduce((s, x) => s + x.p.price, 0);
        const count = 1 + inStockPairs.length;
        els.kitLabel.textContent = `Add ${count}-piece kit`;
        els.kitPrice.textContent = '$' + total;
        els.kitBtn.disabled = false;
        els.kitBtn.classList.remove('added');
        // Replace the click handler each open (closure captures fresh state)
        els.kitBtn.onclick = () => addKitToCart(productId, inStockPairs.map(x => x.id), els);
      }
    }
    // Build cards via DOM API (XSS-safe — no string interpolation into HTML)
    els.pairingsRow.innerHTML = '';
    for (const { id, p } of pairs) {
      const card = document.createElement('a');
      card.className = 'qv-pair-card';
      card.href = '#shop';
      card.setAttribute('aria-label', `View ${p.name}`);
      card.dataset.pairId = id;

      const imgWrap = document.createElement('div');
      imgWrap.className = 'qv-pair-img';
      imgWrap.textContent = p.name.charAt(0).toUpperCase();
      card.appendChild(imgWrap);

      // Try real image — uses session-cached probe
      probeProductImage(id, (url) => {
        imgWrap.textContent = '';
        const img = document.createElement('img');
        img.src = url;
        img.alt = p.name;
        img.loading = 'lazy';
        imgWrap.appendChild(img);
      });

      const info = document.createElement('div');
      info.className = 'qv-pair-info';
      const nameEl = document.createElement('div');
      nameEl.className = 'qv-pair-name';
      nameEl.textContent = p.name;
      const priceEl = document.createElement('div');
      priceEl.className = 'qv-pair-price';
      priceEl.textContent = '$' + p.price;
      info.appendChild(nameEl);
      info.appendChild(priceEl);
      card.appendChild(info);

      // Clicking a pair swaps the drawer's product without closing it
      card.addEventListener('click', (e) => {
        e.preventDefault();
        openQuickView(id);
      });

      els.pairingsRow.appendChild(card);
    }
    els.pairings.hidden = false;
  }

  function openQuickView(productId) {
    const product = PRODUCTS[productId];
    if (!product) return;
    const els = getQvElements();
    if (!els.drawer) return;

    qvCurrentProduct = { id: productId, ...product };
    qvCurrentSize = null;
    qvCurrentQty = 1;

    // Track for "recently viewed" carousel on the homepage
    Recent.add(productId);

    // Populate drawer with product data (using textContent for XSS safety)
    els.imageLetter.textContent = product.name.charAt(0);
    els.name.textContent = product.name;
    els.color.textContent = product.color;
    els.price.textContent = '$' + product.price;
    els.description.textContent = product.description;

    // Try to load real product image; fall back to letter placeholder.
    // probeProductImage caches per-session so re-opens are instant and
    // we never re-probe known-missing images.
    const imageEl = document.getElementById('qvImage');
    if (imageEl) {
      const oldImg = imageEl.querySelector('img.qv-real-image');
      if (oldImg) oldImg.remove();
      els.imageLetter.style.display = '';
      probeProductImage(productId, (url) => {
        els.imageLetter.style.display = 'none';
        const img = document.createElement('img');
        img.src = url;
        img.alt = product.name;
        img.className = 'qv-real-image';
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;position:absolute;inset:0';
        imageEl.insertBefore(img, imageEl.firstChild);
      });
    }

    // Tag badge (New, Restock, Limited, Sold Out)
    if (product.tag) {
      els.tagBadge.textContent = product.tag;
      els.tagBadge.hidden = false;
    } else {
      els.tagBadge.hidden = true;
    }

    // Reset size selection
    els.sizes.querySelectorAll('.qv-size').forEach(btn => {
      btn.classList.remove('selected');
      btn.disabled = product.stock === 0;
    });

    // Reset quantity display
    els.qtyDisplay.textContent = '1';
    els.qtyMinus.disabled = true;
    els.qtyPlus.disabled = product.stock <= 1;

    // Stock indicator
    if (product.stock === 0) {
      els.stock.textContent = 'Sold out';
      els.stock.classList.remove('low');
    } else if (product.stock <= 10) {
      els.stock.textContent = `Only ${product.stock} left`;
      els.stock.classList.add('low');
    } else {
      els.stock.textContent = 'In stock';
      els.stock.classList.remove('low');
    }

    // Add button initial state
    if (product.stock === 0) {
      els.addBtn.textContent = 'Sold out';
      els.addBtn.disabled = true;
      els.addBtn.classList.remove('added');
    } else {
      els.addBtn.textContent = 'Select a size';
      els.addBtn.disabled = true;
      els.addBtn.classList.remove('added');
    }

    // Style-this-with pairings
    renderQvPairings(productId, els);

    // Remember where focus was before the drawer opened (we'll restore on close)
    qvLastFocus = document.activeElement;

    // Show drawer
    els.backdrop.removeAttribute('hidden');
    els.drawer.removeAttribute('hidden');
    requestAnimationFrame(() => {
      els.backdrop.classList.add('open');
      els.drawer.classList.add('open');
    });
    document.body.classList.add('qv-open');
    lockBackground();

    // Focus close button for keyboard accessibility
    setTimeout(() => els.closeBtn && els.closeBtn.focus(), 100);
  }

  function closeQuickView() {
    const els = getQvElements();
    if (!els.drawer) return;
    els.backdrop.classList.remove('open');
    els.drawer.classList.remove('open');
    document.body.classList.remove('qv-open');
    unlockBackground();
    setTimeout(() => {
      els.backdrop.setAttribute('hidden', '');
      els.drawer.setAttribute('hidden', '');
    }, 400);
    qvCurrentProduct = null;
    // Restore focus to the element that opened the drawer
    if (qvLastFocus && typeof qvLastFocus.focus === 'function') {
      try { qvLastFocus.focus(); } catch {}
    }
    qvLastFocus = null;
  }

  function selectSize(size) {
    qvCurrentSize = size;
    const els = getQvElements();
    els.sizes.querySelectorAll('.qv-size').forEach(btn => {
      btn.classList.toggle('selected', btn.dataset.size === size);
    });
    // Enable add button now that size is selected
    if (qvCurrentProduct && qvCurrentProduct.stock > 0) {
      els.addBtn.textContent = `Add to cart — $${qvCurrentProduct.price * qvCurrentQty}`;
      els.addBtn.disabled = false;
    }
  }

  function changeQty(delta) {
    if (!qvCurrentProduct) return;
    const newQty = qvCurrentQty + delta;
    const max = Math.min(10, qvCurrentProduct.stock);
    if (newQty < 1 || newQty > max) return;
    qvCurrentQty = newQty;
    const els = getQvElements();
    els.qtyDisplay.textContent = String(newQty);
    els.qtyMinus.disabled = newQty <= 1;
    els.qtyPlus.disabled = newQty >= max;
    // Update price on add button
    if (qvCurrentSize) {
      els.addBtn.textContent = `Add to cart — $${qvCurrentProduct.price * qvCurrentQty}`;
    }
  }

  function addQuickViewToCart() {
    if (!qvCurrentProduct || !qvCurrentSize || qvCurrentProduct.stock === 0) return;

    // Add to cart with size info
    const added = Cart.add(qvCurrentProduct.id, qvCurrentQty, { size: qvCurrentSize });

    const els = getQvElements();
    if (!added) {
      // Hit the cart-line cap or some validation; tell the user.
      els.addBtn.textContent = 'Cart is full';
      els.addBtn.disabled = true;
      return;
    }

    // Visual confirmation
    els.addBtn.classList.add('added');
    els.addBtn.textContent = 'Added ✓';
    els.addBtn.disabled = true;

    // Show toast
    showToast(qvCurrentProduct, qvCurrentSize, qvCurrentQty);

    // Close drawer after a short delay
    setTimeout(() => {
      closeQuickView();
    }, 600);
  }

  // ============ MODAL HELPER ============
  // Drop-in replacement for confirm() / alert() — styled, accessible
  // (role=dialog, aria-modal, focus-trapped, Esc-closable, restores
  // focus on close). Build the DOM lazily on first call.
  //
  //   Tagline.modal.confirm({ title, message, confirmLabel, cancelLabel, danger })
  //     → returns a Promise<boolean>
  //   Tagline.modal.alert({ title, message, okLabel })
  //     → returns a Promise<void>
  let modalEl = null;
  let modalLastFocus = null;
  let modalEscHandler = null;

  function ensureModalDom() {
    if (modalEl) return modalEl;
    modalEl = document.createElement('div');
    modalEl.className = 'tg-modal';
    modalEl.setAttribute('role', 'dialog');
    modalEl.setAttribute('aria-modal', 'true');
    modalEl.hidden = true;
    modalEl.innerHTML = `
      <div class="tg-modal-backdrop"></div>
      <div class="tg-modal-card" role="document">
        <h3 class="tg-modal-title" id="tgModalTitle"></h3>
        <p class="tg-modal-message" id="tgModalMessage"></p>
        <div class="tg-modal-actions">
          <button type="button" class="tg-modal-cancel"></button>
          <button type="button" class="tg-modal-confirm"></button>
        </div>
      </div>
    `;
    modalEl.setAttribute('aria-labelledby', 'tgModalTitle');
    modalEl.setAttribute('aria-describedby', 'tgModalMessage');

    // Inject CSS once
    if (!document.getElementById('tg-modal-styles')) {
      const style = document.createElement('style');
      style.id = 'tg-modal-styles';
      style.textContent = `
        .tg-modal{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:18px;font-family:'Inter',-apple-system,sans-serif}
        .tg-modal[hidden]{display:none}
        .tg-modal-backdrop{position:absolute;inset:0;background:rgba(8,8,10,.7);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);opacity:0;transition:opacity .2s}
        .tg-modal.open .tg-modal-backdrop{opacity:1}
        .tg-modal-card{position:relative;max-width:420px;width:100%;background:linear-gradient(160deg,#16161a 0%,#0d0c0a 100%);border:1px solid rgba(255,255,250,.14);padding:28px 26px;color:#fafaf7;box-shadow:0 20px 60px -10px rgba(0,0,0,.7);transform:translateY(8px) scale(.98);opacity:0;transition:transform .25s ease,opacity .2s}
        .tg-modal.open .tg-modal-card{transform:translateY(0) scale(1);opacity:1}
        .tg-modal-title{font-family:'Space Grotesk',sans-serif;font-size:18px;font-weight:600;letter-spacing:-0.01em;color:#fafaf7;margin:0 0 8px;padding:0}
        .tg-modal-message{font-size:14px;line-height:1.55;color:#c8c8c0;margin:0 0 22px;padding:0}
        .tg-modal-actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
        .tg-modal-cancel,.tg-modal-confirm{min-height:42px;padding:12px 22px;font-family:inherit;font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;border:1px solid transparent;background:transparent;color:#fafaf7;transition:background-color .2s,border-color .2s,color .2s}
        .tg-modal-cancel{border-color:rgba(255,255,250,.14)}
        .tg-modal-cancel:hover{background:rgba(255,255,250,.05)}
        .tg-modal-confirm{background:#fafaf7;color:#08080a;border-color:#fafaf7}
        .tg-modal-confirm:hover{background:#b8893d;border-color:#b8893d;color:#08080a}
        .tg-modal.danger .tg-modal-confirm{background:#e57373;border-color:#e57373;color:#0c0c0e}
        .tg-modal.danger .tg-modal-confirm:hover{background:#cb5e5e;border-color:#cb5e5e}
        .tg-modal-cancel:focus-visible,.tg-modal-confirm:focus-visible{outline:2px solid #b8893d;outline-offset:2px}
        @media (max-width:420px){.tg-modal-card{padding:24px 20px} .tg-modal-actions{flex-direction:column-reverse}.tg-modal-cancel,.tg-modal-confirm{width:100%}}
      `;
      document.head.appendChild(style);
    }
    document.body.appendChild(modalEl);
    return modalEl;
  }

  function openModal({ title, message, confirmLabel = 'OK', cancelLabel, danger = false, onResolve }) {
    const el = ensureModalDom();
    el.querySelector('#tgModalTitle').textContent = title || '';
    el.querySelector('#tgModalMessage').textContent = message || '';
    const confirmBtn = el.querySelector('.tg-modal-confirm');
    const cancelBtn = el.querySelector('.tg-modal-cancel');
    confirmBtn.textContent = confirmLabel;
    if (cancelLabel) {
      cancelBtn.textContent = cancelLabel;
      cancelBtn.style.display = '';
    } else {
      cancelBtn.style.display = 'none';
    }
    el.classList.toggle('danger', !!danger);

    modalLastFocus = document.activeElement;
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('open'));
    setTimeout(() => confirmBtn.focus(), 50);

    function close(result) {
      el.classList.remove('open');
      setTimeout(() => { el.hidden = true; }, 200);
      confirmBtn.onclick = null;
      cancelBtn.onclick = null;
      el.querySelector('.tg-modal-backdrop').onclick = null;
      if (modalEscHandler) document.removeEventListener('keydown', modalEscHandler);
      modalEscHandler = null;
      if (modalLastFocus && modalLastFocus.focus) {
        try { modalLastFocus.focus(); } catch {}
      }
      onResolve(result);
    }

    confirmBtn.onclick = () => close(true);
    cancelBtn.onclick = () => close(false);
    el.querySelector('.tg-modal-backdrop').onclick = () => cancelLabel ? close(false) : close(true);
    modalEscHandler = (e) => { if (e.key === 'Escape') close(false); };
    document.addEventListener('keydown', modalEscHandler);
  }

  const Modal = {
    confirm({ title = 'Confirm', message = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = {}) {
      return new Promise(resolve => {
        openModal({ title, message, confirmLabel, cancelLabel, danger, onResolve: resolve });
      });
    },
    alert({ title = '', message = '', okLabel = 'OK' } = {}) {
      return new Promise(resolve => {
        openModal({ title, message, confirmLabel: okLabel, cancelLabel: null, danger: false, onResolve: () => resolve() });
      });
    }
  };

  // Add the current QV product + its in-stock pairings to the cart in
  // one shot. Items without a defined size on the QV require the user
  // to have selected one for the lead product; the pairings are added
  // without size (most are accessories/socks/caps where size doesn't
  // matter). If a pairing IS sized (rare for the curated kits), it's
  // added unsized — user can adjust on the cart page.
  function addKitToCart(leadId, pairingIds, els) {
    if (!els.kitBtn) return;
    let added = 0;

    // Lead product respects the user's size selection if they made one.
    const leadOpts = qvCurrentSize ? { size: qvCurrentSize } : {};
    if (Cart.add(leadId, qvCurrentQty || 1, leadOpts)) added++;

    // Pairings added one each, no size
    for (const id of pairingIds) {
      if (Cart.add(id, 1)) added++;
    }

    // Visual feedback — match the existing "Added ✓" pattern
    els.kitBtn.classList.add('added');
    els.kitBtn.disabled = true;
    els.kitLabel.textContent = `Added ${added} ✓`;
    els.kitPrice.textContent = '';

    // Toast — reuse the existing one
    showToast(
      { name: PRODUCTS[leadId]?.name || 'Kit' },
      null,
      added // showToast formats "× n" when qty > 1
    );

    // Close drawer after a short delay so user can see the confirmation
    setTimeout(() => {
      closeQuickView();
    }, 700);
  }

  // ============ TOAST NOTIFICATION ============
  let toastTimeout = null;
  function showToast(product, size, qty) {
    const toast = document.getElementById('toast');
    const sub = document.getElementById('toastSub');
    if (!toast || !product) return;

    const parts = [product.name];
    if (size) parts.push(size);
    if (qty && qty > 1) parts.push('×' + qty);
    sub.textContent = parts.join(' · ');

    toast.classList.add('show');
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      toast.classList.remove('show');
    }, 3500);
  }

  // ============ PRODUCT CARD CLICK → OPEN QUICK VIEW ============
  function autoWireProductCards() {
    const wishlistItems = Wishlist.get();
    document.querySelectorAll('.product-card').forEach(card => {
      if (card.dataset.wired) return;
      const nameEl = card.querySelector('.product-meta .name');
      if (!nameEl) return;
      const productId = PRODUCT_NAME_TO_ID[nameEl.textContent.trim()];
      if (!productId) return;
      card.dataset.wired = '1';
      card.dataset.productId = productId;

      // Mark sold out
      const product = PRODUCTS[productId];
      const isSoldOut = product && product.stock === 0;
      if (isSoldOut) {
        card.classList.add('sold-out');
      }

      // ============ REAL IMAGE SUPPORT ============
      // Try to load /images/products/{id}.jpg. probeProductImage caches
      // results in sessionStorage so each card is probed at most once
      // per session — vs 24 probes on every page load before.
      const illu = card.querySelector('.product-illu');
      if (illu) {
        const productName = nameEl.textContent.trim();
        probeProductImage(productId, (url) => {
          while (illu.firstChild) illu.removeChild(illu.firstChild);
          const img = document.createElement('img');
          img.src = url;
          img.alt = productName;
          img.loading = 'lazy';
          img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block';
          illu.appendChild(img);
          illu.classList.add('has-image');
        });
      }

      // Make whole card clickable
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.setAttribute('aria-label', `View ${nameEl.textContent.trim()}`);

      // Add heart button (wishlist) - top-right corner of card
      const heartBtn = document.createElement('button');
      heartBtn.type = 'button';
      heartBtn.className = 'heart-btn';
      heartBtn.dataset.productId = productId;
      heartBtn.setAttribute('aria-label', `Add ${nameEl.textContent.trim()} to wishlist`);
      if (wishlistItems.indexOf(productId) !== -1) {
        heartBtn.classList.add('active');
      }
      heartBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';
      heartBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        Wishlist.toggle(productId);
        heartBtn.classList.add('pulse');
        setTimeout(() => heartBtn.classList.remove('pulse'), 300);
      });
      card.appendChild(heartBtn);

      // Click → open quick view
      card.addEventListener('click', (e) => {
        // Don't intercept clicks on actual links inside the card
        if (e.target.closest('a, .heart-btn')) return;
        if (isSoldOut) return;
        openQuickView(productId);
      });

      // Keyboard accessibility
      card.addEventListener('keydown', (e) => {
        if (isSoldOut) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openQuickView(productId);
        }
      });
    });
  }

  // ============ WIRE QUICK VIEW DRAWER EVENTS ============
  function wireQuickViewDrawer() {
    const els = getQvElements();
    if (!els.drawer || els.drawer.dataset.wired) return;
    els.drawer.dataset.wired = '1';

    // Close button
    if (els.closeBtn) {
      els.closeBtn.addEventListener('click', closeQuickView);
    }
    // Backdrop click closes
    if (els.backdrop) {
      els.backdrop.addEventListener('click', closeQuickView);
    }
    // Size buttons
    if (els.sizes) {
      els.sizes.querySelectorAll('.qv-size').forEach(btn => {
        btn.addEventListener('click', () => selectSize(btn.dataset.size));
      });
    }
    // Quantity stepper
    if (els.qtyMinus) els.qtyMinus.addEventListener('click', () => changeQty(-1));
    if (els.qtyPlus) els.qtyPlus.addEventListener('click', () => changeQty(1));
    // Add to cart
    if (els.addBtn) els.addBtn.addEventListener('click', addQuickViewToCart);
    // Escape key closes drawer
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && qvCurrentProduct) closeQuickView();
    });

    // ============ SWIPE-DOWN-TO-CLOSE (mobile) ============
    // Native bottom sheets close when you swipe down on the drag handle.
    // We detect touchstart on the handle/header, track movement, and
    // close if the user pulls the drawer down by more than 80px.
    let touchStartY = null;
    let touchCurrentY = null;
    let isDragging = false;
    const dragHandle = els.drawer.querySelector('.qv-drag-handle');
    const head = els.drawer.querySelector('.qv-head');
    // Only enable on touch devices and only when drawer is in mobile bottom-sheet mode
    function isMobileDrawer() {
      return window.matchMedia('(max-width: 640px)').matches;
    }

    function onTouchStart(e) {
      if (!isMobileDrawer()) return;
      // Don't capture if user is interacting with a button or input
      if (e.target.closest('button, input, a, .qv-foot')) return;
      touchStartY = e.touches[0].clientY;
      touchCurrentY = touchStartY;
      isDragging = true;
    }

    function onTouchMove(e) {
      if (!isDragging || touchStartY === null) return;
      touchCurrentY = e.touches[0].clientY;
      const dy = touchCurrentY - touchStartY;
      // Only track DOWNWARD movement
      if (dy > 0) {
        // Apply transform to drawer (visual feedback)
        els.drawer.style.transform = `translate3d(0, ${dy}px, 0)`;
        els.drawer.style.transition = 'none';
        // Fade backdrop in proportion to swipe distance
        const opacity = Math.max(0, 1 - dy / 300);
        els.backdrop.style.opacity = String(opacity);
      }
    }

    function onTouchEnd() {
      if (!isDragging || touchStartY === null) return;
      const dy = (touchCurrentY || touchStartY) - touchStartY;
      els.drawer.style.transition = '';
      els.drawer.style.transform = '';
      els.backdrop.style.opacity = '';
      // If swiped down more than 80px, close drawer
      if (dy > 80) {
        closeQuickView();
      }
      touchStartY = null;
      touchCurrentY = null;
      isDragging = false;
    }

    // Attach to drag handle and head only (so scrolling content doesn't trigger)
    if (dragHandle) {
      dragHandle.addEventListener('touchstart', onTouchStart, { passive: true });
      dragHandle.addEventListener('touchmove', onTouchMove, { passive: true });
      dragHandle.addEventListener('touchend', onTouchEnd);
    }
    if (head) {
      head.addEventListener('touchstart', onTouchStart, { passive: true });
      head.addEventListener('touchmove', onTouchMove, { passive: true });
      head.addEventListener('touchend', onTouchEnd);
    }
  }

  // ============ EMAIL CONFIRMATION HANDLER ============
  // Supabase email-confirmation links (sign-up + email-change) bring the
  // user back with a hash like:
  //   #access_token=eyJ...&refresh_token=...&type=signup
  // We capture the token, save the session, strip the hash, and show
  // a brief confirmation banner. Runs on every page load so the user
  // can land anywhere and still get confirmed.
  function handleAuthHash() {
    const hash = window.location.hash.startsWith('#')
      ? window.location.hash.slice(1) : '';
    if (!hash || hash.indexOf('access_token=') === -1) return;

    const params = {};
    for (const pair of hash.split('&')) {
      const [k, v] = pair.split('=');
      if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || '');
    }
    if (!params.access_token || !params.type) return;

    // Recovery hashes are handled by /reset-password — leave them alone
    if (params.type === 'recovery') return;

    // Validate JWT shape before trusting it
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(params.access_token)) {
      return;
    }

    // Strip the token from the URL immediately — even before we attempt
    // auth — so refresh / share / screenshot doesn't keep the token around.
    history.replaceState(null, '', window.location.pathname + window.location.search);

    // Fetch the user object so the navbar and account page have it.
    fetch('/api/config').then(r => r.ok ? r.json() : null).then(cfg => {
      if (!cfg || !cfg.ok || !cfg.supabaseUrl) return;
      return fetch(cfg.supabaseUrl + '/auth/v1/user', {
        headers: {
          'apikey': cfg.supabaseAnonKey,
          'Authorization': 'Bearer ' + params.access_token
        }
      }).then(r => r.ok ? r.json() : null).then(user => {
        if (!user || !user.id) return;
        Auth.setSession(params.access_token, { id: user.id, email: user.email });
        const messages = {
          signup: 'Email confirmed — you\'re signed in.',
          magiclink: 'Signed in via email link.',
          email_change: 'Email updated.',
          invite: 'You\'re in — welcome.'
        };
        showConfirmBanner(messages[params.type] || 'You\'re signed in.');
      });
    }).catch(() => {});
  }

  function showConfirmBanner(text) {
    const banner = document.createElement('div');
    banner.textContent = text;
    banner.setAttribute('role', 'status');
    Object.assign(banner.style, {
      position: 'fixed',
      top: '14px',
      left: '50%',
      transform: 'translateX(-50%) translateY(-150%)',
      transition: 'transform .3s ease',
      padding: '10px 18px',
      background: 'rgba(184,137,61,.95)',
      color: '#08080a',
      fontSize: '13px',
      fontWeight: '600',
      letterSpacing: '0.04em',
      borderRadius: '999px',
      zIndex: '999',
      fontFamily: 'Inter, sans-serif',
      boxShadow: '0 8px 24px rgba(0,0,0,0.4)'
    });
    document.body.appendChild(banner);
    requestAnimationFrame(() => {
      banner.style.transform = 'translateX(-50%) translateY(0)';
    });
    setTimeout(() => {
      banner.style.transform = 'translateX(-50%) translateY(-150%)';
      setTimeout(() => banner.remove(), 400);
    }, 3500);
  }

  // ============ RECENTLY VIEWED RENDERER ============
  // Only runs on pages that have the #recentlyViewed section (homepage).
  // Hidden by default; shown only if the user has 3+ items in history.
  function renderRecentlyViewed() {
    const section = document.getElementById('recentlyViewed');
    const grid = document.getElementById('recentlyViewedGrid');
    if (!section || !grid) return;
    const ids = Recent.get();
    if (ids.length < 3) return; // nothing to show

    const cards = ids
      .map(id => {
        const p = PRODUCTS[id];
        if (!p) return null;
        const initial = p.name.charAt(0).toUpperCase();
        const safeId = id.replace(/[^a-z0-9-]/g, '');
        return `
          <a class="product-card-mini" href="#shop" data-recent-id="${safeId}" aria-label="${escapeHtml(p.name)}">
            <div class="pcm-image" data-letter="${escapeHtml(initial)}">${escapeHtml(initial)}</div>
            <div class="pcm-info">
              <div class="pcm-name">${escapeHtml(p.name)}</div>
              <div class="pcm-price">$${p.price}</div>
            </div>
          </a>
        `;
      })
      .filter(Boolean)
      .join('');

    if (!cards) return;
    grid.innerHTML = cards;
    section.removeAttribute('hidden');

    // Click → open quick view (so users can re-add without scrolling)
    grid.querySelectorAll('[data-recent-id]').forEach(card => {
      const id = card.dataset.recentId;
      card.addEventListener('click', (e) => {
        e.preventDefault();
        openQuickView(id);
      });
      // Swap in real product images via the shared cache
      const imageEl = card.querySelector('.pcm-image');
      probeProductImage(id, (url) => {
        imageEl.textContent = '';
        const img = document.createElement('img');
        img.src = url;
        img.alt = PRODUCTS[id]?.name || '';
        img.loading = 'lazy';
        img.style.cssText = 'width:100%;height:100%;object-fit:cover';
        imageEl.appendChild(img);
      });
    });
  }

  // ============ STRUCTURED DATA (JSON-LD) ============
  // Build a Product ItemList from the PRODUCTS catalog and inject it as
  // a JSON-LD script tag. Helps Google show price, availability, and
  // image data in product search results.
  // Only runs on the homepage (where the .product-card grid exists).
  function injectProductJsonLd() {
    if (!document.querySelector('.product-card')) return;
    if (document.getElementById('jsonLdProducts')) return; // idempotent
    const origin = window.location.origin;
    const items = Object.keys(PRODUCTS).map((id, idx) => {
      const p = PRODUCTS[id];
      return {
        "@type": "ListItem",
        "position": idx + 1,
        "item": {
          "@type": "Product",
          "name": p.name,
          "description": p.description,
          "sku": id,
          "category": p.category,
          "color": p.color,
          "brand": { "@type": "Brand", "name": "TAGLINE" },
          "image": `${origin}/images/products/${id}.jpg`,
          "offers": {
            "@type": "Offer",
            "url": `${origin}/#shop`,
            "priceCurrency": "USD",
            "price": p.price.toFixed(2),
            "availability": p.stock > 0
              ? "https://schema.org/InStock"
              : "https://schema.org/OutOfStock",
            "itemCondition": "https://schema.org/NewCondition"
          }
        }
      };
    });
    const data = {
      "@context": "https://schema.org",
      "@type": "ItemList",
      "name": "TAGLINE collection",
      "numberOfItems": items.length,
      "itemListElement": items
    };
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.id = 'jsonLdProducts';
    script.textContent = JSON.stringify(data);
    document.head.appendChild(script);
  }

  // ============ INIT ============
  // Each step is wrapped in try/catch so a failure in one feature
  // doesn't break the rest of the page. Errors logged silently.
  function safeInit(name, fn) {
    try { fn(); }
    catch (err) {
      // Log to console for debugging but don't break the page
      if (typeof console !== 'undefined' && console.error) {
        console.error('[Tagline init: ' + name + ']', err);
      }
    }
  }

  function init() {
    safeInit('updateBadge', () => Cart.updateBadge());
    safeInit('updateWishlistBadge', () => Wishlist.updateBadge());
    safeInit('updateAuthUI', () => Auth.updateUI());
    safeInit('newsletterForms', () => wireNewsletterForms());
    safeInit('addToCart', () => wireAddToCart());
    safeInit('productCards', () => autoWireProductCards());
    safeInit('quickViewDrawer', () => wireQuickViewDrawer());
    safeInit('jsonLdProducts', () => injectProductJsonLd());
    safeInit('emailConfirm', () => handleAuthHash());
    safeInit('recentlyViewed', () => renderRecentlyViewed());
    safeInit('pwToggles', () => wirePasswordToggles());

    // Update other tabs when cart/wishlist changes
    safeInit('storageEvents', () => {
      window.addEventListener('storage', (e) => {
        if (e.key === CART_KEY) Cart.updateBadge();
        if (e.key === WISHLIST_KEY) {
          Wishlist.updateBadge();
          Wishlist.updateHearts();
        }
        if (e.key === TOKEN_KEY) Auth.updateUI();
      });
    });

    // Check if we're in preview mode (backend not connected).
    // If so, hide auth UI elements that won't work.
    safeInit('previewMode', () => {
      checkPreviewMode().then(preview => {
        if (preview) {
          // Hide sign-in link since auth doesn't work
          document.querySelectorAll('.signin-link, .mobile-signin').forEach(el => {
            el.style.display = 'none';
          });
        }
      }).catch(() => {});
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // HTML escape helper - critical for safely rendering user-controlled
  // strings into innerHTML. Always wrap any value that could contain
  // user input (names, emails, IDs, server errors) in this.
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Expose for use on individual pages.
  // PRODUCTS is now the single source of truth — cart.html and wishlist.html
  // read from this instead of maintaining their own copies. PRODUCT_NAME_TO_ID
  // is a derived map for homepage card → id resolution.
  window.Tagline = {
    Cart, Wishlist, Auth, API, Modal, escapeHtml,
    PRODUCTS, PRODUCT_NAME_TO_ID,
    wirePasswordToggles,
    isPreviewMode: () => isPreviewMode,
    checkPreviewMode
  };
})();
