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
  const TOKEN_KEY = 'tagline_token';
  const USER_KEY = 'tagline_user';

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
      try {
        const raw = localStorage.getItem(CART_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        // Defensive: if anyone tampered with localStorage, reject anything
        // that isn't an array of clean { product_id, quantity, size? } objects.
        if (!Array.isArray(parsed)) return [];
        const VALID_SIZES = ['XS','S','M','L','XL','XXL'];
        return parsed
          .filter(item =>
            item &&
            typeof item.product_id === 'string' &&
            // product_id format: lowercase letters, digits, hyphens only
            /^[a-z0-9-]{1,50}$/.test(item.product_id) &&
            Number.isInteger(item.quantity) &&
            item.quantity > 0 &&
            item.quantity <= 10 &&
            // size, if present, must be one of the known sizes
            (item.size === undefined || VALID_SIZES.indexOf(item.size) !== -1)
          )
          .map(item => {
            const out = {
              product_id: item.product_id,
              quantity: Math.min(10, Math.max(1, item.quantity))
            };
            if (item.size && VALID_SIZES.indexOf(item.size) !== -1) {
              out.size = item.size;
            }
            return out;
          })
          .slice(0, 50); // cap cart at 50 line items
      } catch {
        return [];
      }
    },
    save(items) {
      try {
        localStorage.setItem(CART_KEY, JSON.stringify(items));
      } catch {}
      this.updateBadge();
      window.dispatchEvent(new CustomEvent('cart:updated'));
    },
    add(productId, quantity = 1, options = {}) {
      // Validate inputs before storing — defense in depth.
      // get() also filters on read, but rejecting bad input here
      // means we never save garbage in the first place.
      if (typeof productId !== 'string' || !/^[a-z0-9-]{1,50}$/.test(productId)) {
        return false;
      }
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
        return false;
      }
      const VALID_SIZES = ['XS','S','M','L','XL','XXL'];
      const size = (options && typeof options.size === 'string' && VALID_SIZES.indexOf(options.size) !== -1)
        ? options.size : null;

      const items = this.get();
      // Same product+size = stack quantities, different size = new line
      const existing = items.find(i =>
        i.product_id === productId && (i.size || null) === size
      );
      if (existing) {
        existing.quantity = Math.min(10, existing.quantity + quantity);
      } else {
        if (items.length >= 50) return false; // honor 50-item cap
        const item = { product_id: productId, quantity: Math.min(10, quantity) };
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
        item.quantity = Math.min(10, quantity);
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
  // Saves products the user "hearted" via localStorage. Persists across
  // sessions. Updates count badge on nav heart icon. Same defensive
  // validation as Cart — only allows clean product_id strings.
  const Wishlist = {
    get() {
      try {
        const raw = localStorage.getItem(WISHLIST_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
          .filter(id => typeof id === 'string' && /^[a-z0-9-]{1,50}$/.test(id))
          .slice(0, 100); // cap at 100 wishlisted items
      } catch {
        return [];
      }
    },
    save(items) {
      try {
        localStorage.setItem(WISHLIST_KEY, JSON.stringify(items));
        this.updateBadge();
        this.updateHearts();
      } catch {}
    },
    has(productId) {
      return this.get().indexOf(productId) !== -1;
    },
    toggle(productId) {
      // Validate productId before storing — defense in depth.
      // get() also filters on read, but rejecting bad input here
      // means we never save garbage in the first place.
      if (typeof productId !== 'string' || !/^[a-z0-9-]{1,50}$/.test(productId)) {
        return false;
      }
      const items = this.get();
      const idx = items.indexOf(productId);
      if (idx === -1) {
        if (items.length >= 100) return false; // honor the 100-item cap
        items.push(productId);
      } else {
        items.splice(idx, 1);
      }
      this.save(items);
      return idx === -1; // true if just added, false if removed
    },
    count() {
      return this.get().length;
    },
    updateBadge() {
      const count = this.count();
      document.querySelectorAll('.wishlist-badge, [data-wishlist-count]').forEach(el => {
        el.textContent = String(count);
        el.style.display = count > 0 ? '' : 'none';
      });
    },
    updateHearts() {
      // Update all visible heart buttons to reflect current state
      const items = this.get();
      document.querySelectorAll('.heart-btn').forEach(btn => {
        const id = btn.dataset.productId;
        if (!id) return;
        btn.classList.toggle('active', items.indexOf(id) !== -1);
      });
    }
  };

  // ============ AUTH ============
  const Auth = {
    getToken() {
      const t = localStorage.getItem(TOKEN_KEY);
      // JWT format: 3 base64url segments separated by dots
      if (typeof t !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t)) {
        return null;
      }
      return t;
    },
    getUser() {
      try {
        const raw = localStorage.getItem(USER_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        // Only return whitelisted fields (don't trust anything else)
        return {
          id: typeof parsed.id === 'string' ? parsed.id : null,
          email: typeof parsed.email === 'string' ? parsed.email : null
        };
      } catch {
        return null;
      }
    },
    setSession(token, user) {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
      this.updateUI();
    },
    clear() {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
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
  // Full data for each product, used by quick-view drawer
  const PRODUCTS = {
    'ascend-hoodie':  { name:'Ascend Hoodie',   color:'Cream',         price:148, stock:50,  category:'Outerwear',   tag:'New',     description:'Pullover hoodie in heavyweight cream cotton. Cut for everyday wear with a relaxed shoulder and ribbed cuffs.' },
    'halo-zip':       { name:'Halo Zip',        color:'Bone',          price:165, stock:40,  category:'Outerwear',   tag:'',        description:'Full-zip hoodie with metal hardware and brushed cotton interior. Made to layer.' },
    'origin-tee':     { name:'Origin Tee',      color:'Ivory',         price:58,  stock:100, category:'Tops',        tag:'',        description:'Heavyweight tee in soft ivory. Pre-shrunk, garment-dyed, made to break in over time.' },
    'sigil-tank':     { name:'Sigil Tank',      color:'White',         price:78,  stock:80,  category:'Tops',        tag:'',        description:'Performance tank with embroidered cross detail. Mesh-back panel for breathability.' },
    'vesper-long':    { name:'Vesper Long',     color:'Pearl',         price:92,  stock:60,  category:'Tops',        tag:'Restock', description:'Long-sleeve top in pearl white. Modal-cotton blend with a clean drape.' },
    'path-jogger':    { name:'Path Jogger',     color:'Bone',          price:118, stock:45,  category:'Bottoms',     tag:'',        description:'Tapered jogger with side pockets. Mid-rise fit, elastic waist with drawcord.' },
    'trial-short':    { name:'Trial Short',     color:'Ivory',         price:72,  stock:70,  category:'Bottoms',     tag:'',        description:'Lined training short with built-in liner. 7-inch inseam, hidden zip pocket.' },
    'cloud-crew':     { name:'Cloud Crew',      color:'Fog',           price:128, stock:50,  category:'Outerwear',   tag:'',        description:'Crew-neck sweater in fog white. Heavy french terry, ribbed collar and cuffs.' },
    'crown-cap':      { name:'Crown Cap',       color:'White',         price:48,  stock:120, category:'Accessories', tag:'',        description:'Six-panel cap with embroidered logo. Adjustable strap, cotton twill.' },
    'halo-runner':    { name:'Halo Runner',     color:'Triple White',  price:215, stock:25,  category:'Footwear',    tag:'Limited', description:'Limited-edition runner in triple white. Mesh upper, cushioned midsole, leather heel counter.' },
    'aether-bra':     { name:'Aether Bra',      color:'Pearl',         price:68,  stock:75,  category:'Tops',        tag:'',        description:'Medium-support sports bra. Removable pads, racerback design, moisture-wicking fabric.' },
    'aether-legging': { name:'Aether Legging',  color:'White',         price:98,  stock:60,  category:'Bottoms',     tag:'',        description:'High-rise legging with side pockets. Compression fit, four-way stretch.' },
    'reign-bomber':   { name:'Reign Bomber',    color:'Bone',          price:245, stock:30,  category:'Outerwear',   tag:'New',     description:'Lightweight bomber with elastic trim. Satin lining, hidden inner pocket.' },
    'velocity-track': { name:'Velocity Track',  color:'Ivory',         price:185, stock:35,  category:'Outerwear',   tag:'',        description:'Track jacket with side stripes. Quarter-zip, athletic cut, ribbed hem.' },
    'vow-beanie':     { name:'Vow Beanie',      color:'Cream',         price:42,  stock:150, category:'Accessories', tag:'',        description:'Ribbed knit beanie. Wool-cotton blend, embroidered cross at front.' },
    'anthem-polo':    { name:'Anthem Polo',     color:'White',         price:88,  stock:55,  category:'Tops',        tag:'',        description:'Knit polo with three-button placket. Pima cotton, classic collar.' },
    'lumen-crop':     { name:'Lumen Crop',      color:'Pearl',         price:54,  stock:70,  category:'Tops',        tag:'',        description:'Cropped fit tee. Soft jersey, slightly boxy cut, raw hem detail.' },
    'pilgrim-pant':   { name:'Pilgrim Pant',    color:'Ivory',         price:128, stock:40,  category:'Bottoms',     tag:'',        description:'Wide-leg track pant. Cotton-poly blend, side pockets, drawcord waist.' },
    'spirit-shell':   { name:'Spirit Shell',    color:'White',         price:198, stock:30,  category:'Outerwear',   tag:'',        description:'Lightweight windbreaker. Water-resistant, packable, reflective accents.' },
    'echo-vest':      { name:'Echo Vest',       color:'Bone',          price:155, stock:35,  category:'Outerwear',   tag:'',        description:'Quilted vest with snap closure. Down-alternative fill, deep zip pockets.' },
    'verse-henley':   { name:'Verse Henley',    color:'Cream',         price:84,  stock:55,  category:'Tops',        tag:'',        description:'Three-button henley in cream. Slub jersey, vintage-feel cotton.' },
    'sole-sock':      { name:'Sole Sock',       color:'White Pair',    price:24,  stock:200, category:'Accessories', tag:'',        description:'Crew sock, pack of one pair. Cushioned footbed, ribbed shaft, embroidered logo at ankle.' },
    'pulse-band':     { name:'Pulse Band',      color:'White',         price:22,  stock:180, category:'Accessories', tag:'',        description:'Sweat headband. Stretch terry cotton, comfortable for long workouts.' },
    'quill-tote':     { name:'Quill Tote',      color:'Canvas White',  price:38,  stock:0,   category:'Accessories', tag:'Sold Out', description:'Heavy canvas tote with embroidered logo. Reinforced bottom, leather handles.' }
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
      addBtn: document.getElementById('qvAddBtn')
    };
  }

  function openQuickView(productId) {
    const product = PRODUCTS[productId];
    if (!product) return;
    const els = getQvElements();
    if (!els.drawer) return;

    qvCurrentProduct = { id: productId, ...product };
    qvCurrentSize = null;
    qvCurrentQty = 1;

    // Populate drawer with product data (using textContent for XSS safety)
    els.imageLetter.textContent = product.name.charAt(0);
    els.name.textContent = product.name;
    els.color.textContent = product.color;
    els.price.textContent = '$' + product.price;
    els.description.textContent = product.description;

    // Try to load real product image; fall back to letter placeholder
    const imageEl = document.getElementById('qvImage');
    if (imageEl) {
      // Remove any previously injected image
      const oldImg = imageEl.querySelector('img.qv-real-image');
      if (oldImg) oldImg.remove();
      els.imageLetter.style.display = '';
      // Try loading real image
      const testImg = new Image();
      testImg.onload = function() {
        // Hide letter placeholder and inject real image
        els.imageLetter.style.display = 'none';
        const img = document.createElement('img');
        img.src = `/images/products/${productId}.jpg`;
        img.alt = product.name;
        img.className = 'qv-real-image';
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;position:absolute;inset:0';
        imageEl.insertBefore(img, imageEl.firstChild);
      };
      testImg.src = `/images/products/${productId}.jpg`;
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
      // Try to load /images/products/{id}.jpg. If it loads successfully,
      // replace the SVG illustration with a real image. If 404, keep SVG.
      // This lets you drop real photos in /public/images/products/ anytime
      // (named like 'ascend-hoodie.jpg') without changing any HTML.
      const illu = card.querySelector('.product-illu');
      if (illu) {
        const productName = nameEl.textContent.trim();
        const testImg = new Image();
        testImg.onload = function() {
          // Image exists — replace SVG with real photo using DOM API (XSS-safe)
          while (illu.firstChild) illu.removeChild(illu.firstChild);
          const img = document.createElement('img');
          img.src = `/images/products/${productId}.jpg`;
          img.alt = productName;
          img.loading = 'lazy';
          img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block';
          illu.appendChild(img);
          illu.classList.add('has-image');
        };
        testImg.onerror = function() {
          // No image, leave SVG illustration — silent failure is fine
        };
        testImg.src = `/images/products/${productId}.jpg`;
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
        showConfirmBanner(params.type === 'signup'
          ? 'Email confirmed — you\'re signed in.'
          : 'Email updated.');
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

  // Expose for use on individual pages
  window.Tagline = {
    Cart, Wishlist, Auth, API, escapeHtml,
    isPreviewMode: () => isPreviewMode,
    checkPreviewMode
  };
})();
