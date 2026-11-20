/* app.js — Sai Jyothsna Caterers & Suppliers (Customer Web App)
 *
 * Vanilla-JS single-page app with hash routing. All customer data comes from
 * the same-origin JSON API — there is NO mock/local database in this file.
 * localStorage holds ONLY:
 *   sjc_cart      { items: {dishId: true}, services: {srvId: qty|true}, guests, transport }
 *   sjc_lang      'en' | 'te' | 'hi'
 *   sjc_dark_mode 'true' | 'false'
 * (transport is cart state: the cart and the booking wizard share one picker.)
 *
 * Routes: #/home #/menu #/booking #/cart #/quotation/:id #/bookings
 *         #/reviews #/settings #/login
 */
'use strict';

/* ============================== Helpers ============================== */

/** Shorthand for getElementById. */
const $ = (id) => document.getElementById(id);

/** Escape user/API-supplied text before it goes into HTML. */
function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Indian numbering with the rupee symbol. */
function fmtINR(n) {
  const num = Number(n);
  return '₹' + (Number.isFinite(num) ? num : 0).toLocaleString('en-IN');
}

/** Format an ISO date (YYYY-MM-DD) for display in the current language. */
function fmtDate(iso, lang) {
  if (!iso) return '';
  const d = new Date(iso + (iso.length === 10 ? 'T00:00:00' : ''));
  if (Number.isNaN(d.getTime())) return String(iso);
  const locale = lang === 'te' ? 'te-IN' : (lang === 'hi' ? 'hi-IN' : 'en-IN');
  return d.toLocaleDateString(locale, { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Pick the localized string from an {en, te, hi} object, English fallback. */
function locText(obj, lang) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  return obj[lang] || obj.en || Object.values(obj)[0] || '';
}

/** Read a cookie value by name (used for the CSRF token). */
function getCookie(name) {
  const parts = document.cookie.split(';');
  for (const part of parts) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

/** Tomorrow's date as YYYY-MM-DD (minimum event date). */
function tomorrowISO() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

/* ============================== API client ============================== */

class ApiError extends Error {
  constructor(code, message, status) {
    super(message || code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status || 0;
  }
}

/**
 * Single fetch helper for the whole app.
 * - Same-origin, cookies included (session cookie).
 * - For POST/PUT/PATCH/DELETE reads cookie `sjc_csrf` and sends X-CSRF-Token.
 * - Parses JSON; throws ApiError with the server message on !ok.
 * - 401 becomes code 'unauthorized' so callers can redirect to #/login.
 */
async function api(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = { 'Content-Type': 'application/json' };
  if (method !== 'GET' && method !== 'HEAD') {
    const csrf = getCookie('sjc_csrf');
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: options.body ? JSON.stringify(options.body) : undefined
    });
  } catch (e) {
    throw new ApiError('network_error', 'Could not reach the server. Please check your connection.');
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* non-JSON body */ }

  if (res.status === 401) {
    throw new ApiError('unauthorized', (data && data.message) || 'Please log in to continue.', 401);
  }
  if (!res.ok || (data && data.ok === false)) {
    throw new ApiError(
      (data && data.error) || 'request_failed',
      (data && data.message) || ('Request failed (' + res.status + ')'),
      res.status
    );
  }
  return data || {};
}

/* ============================== Constants ============================== */

/** Function types for the booking wizard (step 1 pills). */
const FUNCTION_TYPES = [
  'fn_marriage', 'fn_reception', 'fn_housewarming', 'fn_birthday',
  'fn_naming', 'fn_engagement', 'fn_anniversary', 'fn_corporate',
  'fn_festival', 'fn_temple', 'fn_political', 'fn_college',
  'fn_farewell', 'fn_baby_shower', 'fn_other'
];

/* Business facts (also served by /api/business; these are the fallbacks). */
const OWNER_PHONE = '9848022338';
const OWNER_PHONE_TEL = '+919848022338';
const OWNER_EMAIL = 'contact@saijyothsnacaterers.com';
const OWNER_ADDRESS = 'H.No. 4-12, Main Road, Hyderabad, Telangana - 500001';

const DEFAULT_MIN_GUESTS = 20;
const DEFAULT_GUESTS = 100;
const OTP_COOLDOWN_SECONDS = 60;

/* ============================== ApplicationController ============================== */

class ApplicationController {
  constructor() {
    this.lang = this.readLang();
    this.darkMode = this.readDarkMode();
    this.user = null;            // { id, name, phone, language } once logged in
    this.authChecked = false;
    this.business = null;        // /api/business payload
    this.categories = [];        // /api/menu categories (each with items[])
    this.services = [];          // /api/services
    this.reviewsData = null;     // { reviews, stats } from /api/reviews
    this.bookingsCache = null;   // /api/bookings list, loaded lazily
    this.cart = this.loadCart();
    this.menuUI = { categoryId: null, search: '', veg: 'all' };
    this.wizard = this.freshWizard();
    this.reviewRating = 5;
    this.returnTo = null;        // hash to go back to after login
    this.currentRoute = '';
    this.heroTimer = null;
    this.heroIndex = 0;
    this.otpTimer = null;
    this.otpSeconds = 0;
    this.contactBookingId = null; // booking pre-attached to the contact form
    this.dialogResolver = null;
  }

  freshWizard() {
    return {
      step: 1,
      functionType: '',
      customFunction: '',
      date: '',
      address: { line: '', landmark: '', city: 'Hyderabad', district: 'Hyderabad', state: 'Telangana', pincode: '' },
      notes: ''
    };
  }

  /* ---------------- preferences ---------------- */

  readLang() {
    try {
      const v = localStorage.getItem('sjc_lang');
      return (v === 'te' || v === 'hi') ? v : 'en';
    } catch (e) { return 'en'; }
  }

  readDarkMode() {
    try { return localStorage.getItem('sjc_dark_mode') === 'true'; } catch (e) { return false; }
  }

  /** Translate via translations.js (window.t), English fallback built in. */
  t(key) {
    if (typeof window.t === 'function') return window.t(key, this.lang);
    return key;
  }

  setLanguage(lang) {
    if (!['en', 'te', 'hi'].includes(lang)) lang = 'en';
    this.lang = lang;
    try { localStorage.setItem('sjc_lang', lang); } catch (e) { /* private mode */ }
    document.documentElement.lang = lang;
    this.applyShellI18n();
    this.updateLangButtons();
    this.updateAuthUI();
    this.route(); // re-render the current view in the new language
  }

  setDarkMode(on) {
    this.darkMode = !!on;
    document.body.classList.toggle('dark-mode', this.darkMode);
    try { localStorage.setItem('sjc_dark_mode', this.darkMode ? 'true' : 'false'); } catch (e) { /* private mode */ }
    const btn = $('dark-mode-btn');
    if (btn) btn.innerHTML = '<i class="fa-solid ' + (this.darkMode ? 'fa-sun' : 'fa-moon') + '"></i>';
    const settingsToggle = $('settings-dark-toggle');
    if (settingsToggle) settingsToggle.checked = this.darkMode;
  }

  /** Apply data-i18n / data-i18n-placeholder to the static shell (header/footer/modals). */
  applyShellI18n() {
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = this.t(el.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      el.setAttribute('placeholder', this.t(el.getAttribute('data-i18n-placeholder')));
    });
  }

  updateLangButtons() {
    document.querySelectorAll('.lang-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.lang === this.lang);
    });
  }

  /* ---------------- lifecycle ---------------- */

  async init() {
    document.documentElement.lang = this.lang;
    document.body.classList.toggle('dark-mode', this.darkMode);
    const yearEl = $('footer-year');
    if (yearEl) yearEl.textContent = String(new Date().getFullYear());

    this.bindShellEvents();
    this.applyShellI18n();
    this.updateLangButtons();
    this.updateCartBadge();

    // Dish photos are remote URLs: if one fails to load (host down, offline),
    // swap it for the styled placeholder instead of a broken-image icon.
    document.addEventListener('error', (e) => {
      const el = e.target;
      if (el && el.tagName === 'IMG' && el.classList.contains('dish-img')) {
        const ph = document.createElement('div');
        ph.className = 'dish-img-placeholder';
        ph.innerHTML = '<i class="fa-solid fa-utensils"></i>';
        el.replaceWith(ph);
      }
    }, true);

    // Load public data in parallel; the backend may be briefly unavailable —
    // each failure is tolerated here and surfaced by the view that needs it.
    const [biz, menu, services, reviews] = await Promise.allSettled([
      api('/api/business'),
      api('/api/menu'),
      api('/api/services'),
      api('/api/reviews')
    ]);
    if (biz.status === 'fulfilled') this.business = biz.value.business || null;
    if (menu.status === 'fulfilled') this.categories = menu.value.categories || [];
    if (services.status === 'fulfilled') this.services = services.value.services || [];
    if (reviews.status === 'fulfilled') this.reviewsData = reviews.value;

    // Session check: 401 simply means "not logged in".
    await this.refreshAuth();

    window.addEventListener('hashchange', () => this.route());
    this.route();
  }

  async refreshAuth() {
    try {
      const data = await api('/api/auth/me');
      this.user = data.user || null;
    } catch (e) {
      this.user = null;
    }
    this.authChecked = true;
    this.updateAuthUI();
  }

  /** Header auth area: Login button, or user name + Logout. */
  updateAuthUI() {
    const area = $('auth-area');
    if (!area) return;
    if (this.user) {
      area.innerHTML =
        '<a href="#/settings" class="auth-user-name" title="' + esc(this.user.name || '') + '">' +
          '<i class="fa-solid fa-circle-user"></i> ' + esc(this.user.name || '') +
        '</a>' +
        '<button type="button" class="btn btn-sm btn-secondary" data-action="logout">' +
          '<i class="fa-solid fa-right-from-bracket"></i> ' +
          this.t('logout_btn') +
        '</button>';
    } else {
      area.innerHTML =
        '<a href="#/login" class="btn btn-sm btn-primary"><i class="fa-solid fa-right-to-bracket"></i> ' +
          esc(this.t('login_btn')) +
        '</a>';
    }
    this.setDarkMode(this.darkMode); // refresh the toggle icon
  }

  /* ---------------- shell events (delegated) ---------------- */

  bindShellEvents() {
    // One delegated click handler for every [data-action] in the app
    // (header, footer, drawer, modals and all dynamically rendered views).
    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      const action = el.dataset.action;
      const id = el.dataset.id || '';
      switch (action) {
        case 'set-lang': this.setLanguage(el.dataset.lang); break;
        case 'toggle-dark': this.setDarkMode(!this.darkMode); break;
        case 'logout': this.logout(); break;
        case 'toggle-mobile-nav': this.toggleMobileNav(true); break;
        case 'close-mobile-nav': this.toggleMobileNav(false); break;
        case 'open-cart': this.openCartDrawer(); break;
        case 'close-cart': this.closeCartDrawer(); break;
        case 'open-contact': this.openContactModal(el.dataset.bookingId || null); break;
        case 'close-contact': this.closeContactModal(); break;
        case 'toggle-dish': this.toggleDish(id); break;
        case 'remove-dish': this.removeDish(id); break;
        case 'select-category': this.selectCategory(id || null); break;
        case 'set-veg': this.setVegFilter(el.dataset.value || 'all'); break;
        case 'toggle-service': this.toggleService(id); break;
        case 'service-add': this.addNumberService(id); break;
        case 'service-inc': this.changeServiceQty(id, 1); break;
        case 'service-dec': this.changeServiceQty(id, -1); break;
        case 'toggle-transport': this.toggleTransport(); break;
        case 'clear-cart': this.clearCart(); break;
        case 'adjust-guests': this.adjustGuests(parseInt(el.dataset.amount || '0', 10), el.dataset.context || 'cart'); break;
        case 'select-function': this.selectFunction(el.dataset.value || ''); break;
        case 'wizard-prev': this.navigateWizard(-1); break;
        case 'wizard-next': this.navigateWizard(1); break;
        case 'wizard-submit': this.submitBooking(); break;
        case 'print-quote': window.print(); break;
        case 'hero-dot': this.showHeroSlide(parseInt(el.dataset.index || '0', 10)); break;
        case 'hero-prev': this.stepHeroSlide(-1); break;
        case 'hero-next': this.stepHeroSlide(1); break;
        case 'set-rating': this.setReviewRating(parseInt(el.dataset.value || '5', 10)); break;
        case 'retry-view': this.route(true); break;
        case 'goto': if (el.dataset.href) location.hash = el.dataset.href; break;
        default: break;
      }
    });

    // Close modals/drawer with Escape.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      this.closeContactModal();
      this.closeCartDrawer();
      this.toggleMobileNav(false);
      if (this.dialogResolver) this.closeDialog(false);
    });

    // Clicking a modal backdrop closes it.
    const contactOverlay = $('contact-modal-overlay');
    if (contactOverlay) {
      contactOverlay.addEventListener('click', (e) => {
        if (e.target === contactOverlay) this.closeContactModal();
      });
    }
    const dialogOverlay = $('dialog-overlay');
    if (dialogOverlay) {
      dialogOverlay.addEventListener('click', (e) => {
        if (e.target === dialogOverlay && this.dialogResolver) this.closeDialog(false);
      });
    }
  }

  toggleMobileNav(open) {
    const nav = $('mobile-nav');
    const overlay = $('mobile-nav-overlay');
    if (!nav || !overlay) return;
    nav.classList.toggle('open', open);
    overlay.classList.toggle('open', open);
  }

  /* ---------------- router ---------------- */

  parseRoute() {
    const raw = (location.hash || '#/home').replace(/^#/, '');
    const [pathPart, queryPart] = raw.split('?');
    const parts = pathPart.split('/').filter(Boolean);
    const query = {};
    if (queryPart) {
      queryPart.split('&').forEach((pair) => {
        const [k, v] = pair.split('=');
        if (k) query[decodeURIComponent(k)] = decodeURIComponent(v || '');
      });
    }
    return { name: parts[0] || 'home', param: parts[1] || null, query };
  }

  /** Render the view for the current hash. `force` re-runs even for the same route. */
  async route(force) {
    const { name, param, query } = this.parseRoute();
    this.stopHeroCarousel();
    this.stopOtpCountdown();
    this.toggleMobileNav(false);
    this.closeCartDrawer();
    this.currentRoute = name;
    this.updateNavActive(name);
    window.scrollTo(0, 0);

    const view = $('view');
    if (!view) return;

    try {
      switch (name) {
        case 'home': this.renderHome(); break;
        case 'menu':
          if (query.cat) this.menuUI.categoryId = query.cat;
          this.renderMenu();
          break;
        case 'booking': this.renderBooking(); break;
        case 'cart': this.renderCart(); break;
        case 'quotation': await this.renderQuotation(param); break;
        case 'bookings': await this.renderBookings(); break;
        case 'reviews': await this.renderReviews(); break;
        case 'settings': await this.renderSettings(); break;
        case 'login': this.renderLogin(); break;
        default:
          location.hash = '#/home';
          return;
      }
    } catch (e) {
      console.error('Route render failed:', e);
      view.innerHTML = this.errorStateHTML(this.t('error_loading_msg'));
    }
  }

  updateNavActive(routeName) {
    document.querySelectorAll('[data-nav]').forEach((el) => {
      el.classList.toggle('active', el.dataset.nav === routeName);
    });
  }

  /** Send the user to login, remembering where to return afterwards. */
  requireLogin(returnHash) {
    this.returnTo = returnHash || ('#/' + (this.currentRoute || 'home'));
    try { sessionStorage.setItem('sjc_return_to', this.returnTo); } catch (e) { /* ignore */ }
    location.hash = '#/login';
  }

  consumeReturnTo() {
    let target = this.returnTo;
    try { target = target || sessionStorage.getItem('sjc_return_to'); } catch (e) { /* ignore */ }
    this.returnTo = null;
    try { sessionStorage.removeItem('sjc_return_to'); } catch (e) { /* ignore */ }
    return (target && target.startsWith('#/')) ? target : '#/home';
  }

  /* ---------------- shared view helpers ---------------- */

  loadingStateHTML(message) {
    return (
      '<div class="container"><div class="loading-state">' +
        '<div class="spinner"></div><p>' + esc(message || this.t('loading_msg')) + '</p>' +
      '</div></div>'
    );
  }

  errorStateHTML(message) {
    return (
      '<div class="container"><div class="error-state">' +
        '<i class="fa-solid fa-triangle-exclamation"></i>' +
        '<p>' + esc(message || this.t('error_loading_msg')) + '</p>' +
        '<button type="button" class="btn btn-primary" data-action="retry-view">' +
          '<i class="fa-solid fa-rotate-right"></i> ' + esc(this.t('retry_btn')) +
        '</button>' +
      '</div></div>'
    );
  }

  emptyStateHTML(icon, title, sub, ctaLabel, ctaHref) {
    return (
      '<div class="empty-state">' +
        '<i class="fa-solid ' + icon + '"></i>' +
        '<h3>' + esc(title) + '</h3>' +
        (sub ? '<p>' + esc(sub) + '</p>' : '') +
        (ctaLabel && ctaHref
          ? '<a href="' + esc(ctaHref) + '" class="btn btn-primary">' + esc(ctaLabel) + '</a>'
          : '') +
      '</div>'
    );
  }

  showToast(message, type) {
    const container = $('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast' + (type ? ' ' + type : '');
    const icon = type === 'success' ? 'fa-circle-check'
      : type === 'error' ? 'fa-circle-exclamation' : 'fa-circle-info';
    toast.innerHTML = '<i class="fa-solid ' + icon + '"></i><span></span>';
    toast.querySelector('span').textContent = message;
    container.appendChild(toast);
    setTimeout(() => { toast.remove(); }, 4000);
  }

  /** Promise-based alert/confirm dialog. Resolves true on OK, false on Cancel. */
  showDialog({ title, body, okText, cancelText, showCancel }) {
    return new Promise((resolve) => {
      this.dialogResolver = resolve;
      $('dialog-title').textContent = title || '';
      $('dialog-body').textContent = body || '';
      const okBtn = $('dialog-btn-ok');
      const cancelBtn = $('dialog-btn-cancel');
      okBtn.textContent = okText || this.t('ok_btn');
      cancelBtn.textContent = cancelText || this.t('cancel_btn');
      cancelBtn.style.display = showCancel === false ? 'none' : '';
      okBtn.onclick = () => this.closeDialog(true);
      cancelBtn.onclick = () => this.closeDialog(false);
      $('dialog-overlay').classList.add('active');
    });
  }

  closeDialog(result) {
    $('dialog-overlay').classList.remove('active');
    if (this.dialogResolver) {
      const resolve = this.dialogResolver;
      this.dialogResolver = null;
      resolve(!!result);
    }
  }

  /* ---------------- cart (localStorage sjc_cart) ---------------- */

  loadCart() {
    const fallback = { items: {}, services: {}, guests: DEFAULT_GUESTS, transport: false };
    try {
      const raw = localStorage.getItem('sjc_cart');
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return {
        items: (parsed && typeof parsed.items === 'object' && parsed.items) || {},
        services: (parsed && typeof parsed.services === 'object' && parsed.services) || {},
        guests: Number(parsed.guests) > 0 ? Math.floor(Number(parsed.guests)) : DEFAULT_GUESTS,
        transport: !!parsed.transport
      };
    } catch (e) {
      return fallback;
    }
  }

  saveCart() {
    try { localStorage.setItem('sjc_cart', JSON.stringify(this.cart)); } catch (e) { /* private mode */ }
    this.updateCartBadge();
  }

  updateCartBadge() {
    const badge = $('cart-count');
    if (!badge) return;
    const count = this.selectedDishIds().length;
    badge.textContent = String(count);
    badge.hidden = count === 0;
  }

  selectedDishIds() {
    return Object.keys(this.cart.items).filter((id) => this.cart.items[id]);
  }

  findDish(id) {
    for (const cat of this.categories) {
      const dish = (cat.items || []).find((d) => String(d.id) === String(id));
      if (dish) return { dish, category: cat };
    }
    return null;
  }

  findService(id) {
    return this.services.find((s) => String(s.id) === String(id)) || null;
  }

  toggleDish(id) {
    if (this.cart.items[id]) delete this.cart.items[id];
    else this.cart.items[id] = true;
    this.saveCart();
    this.refreshMenuSelection();
    this.refreshCartViews();
  }

  removeDish(id) {
    delete this.cart.items[id];
    this.saveCart();
    this.refreshCartViews();
  }

  /** Re-render the menu grid + sticky bar after a selection change. */
  refreshMenuSelection() {
    if (this.currentRoute !== 'menu') return;
    this.renderMenuGrid();
    this.renderMenuStickyBar();
  }

  /** Re-render whichever cart surfaces are currently visible. */
  refreshCartViews() {
    if (this.currentRoute === 'cart') this.renderCart();
    if (this.currentRoute === 'booking') this.renderWizardSummary();
    if ($('cart-drawer') && $('cart-drawer').classList.contains('open')) this.renderCartDrawer();
  }

  toggleService(id) {
    const service = this.findService(id);
    if (!service) return;
    if (service.type === 'number') {
      if (this.cart.services[id]) delete this.cart.services[id];
      else this.cart.services[id] = Math.max(1, Number(service.defaultQuantity) || 1);
    } else {
      if (this.cart.services[id]) delete this.cart.services[id];
      else this.cart.services[id] = true;
    }
    this.saveCart();
    this.refreshServicesUI();
  }

  addNumberService(id) {
    const service = this.findService(id);
    if (!service) return;
    this.cart.services[id] = Math.max(1, Number(service.defaultQuantity) || 1);
    this.saveCart();
    this.refreshServicesUI();
  }

  changeServiceQty(id, delta) {
    const service = this.findService(id);
    if (!service || service.type !== 'number') return;
    const current = Number(this.cart.services[id]) || 0;
    const next = current + delta;
    if (next <= 0) delete this.cart.services[id];
    else this.cart.services[id] = next;
    this.saveCart();
    this.refreshServicesUI();
  }

  toggleTransport() {
    this.cart.transport = !this.cart.transport;
    this.saveCart();
    this.refreshServicesUI();
  }

  /** After a service/transport change, refresh the picker + totals in view. */
  refreshServicesUI() {
    const picker = $('services-picker');
    if (picker) picker.innerHTML = this.servicesPickerHTML();
    if (this.currentRoute === 'cart') {
      const box = $('estimate-box');
      if (box) box.innerHTML = this.estimateHTML(this.computeEstimate());
      const toggle = $('transport-toggle');
      if (toggle) toggle.checked = !!this.cart.transport;
    }
    if (this.currentRoute === 'booking') this.renderWizardSummary();
    if ($('cart-drawer') && $('cart-drawer').classList.contains('open')) this.renderCartDrawer();
  }

  clearCart() {
    this.cart.items = {};
    this.cart.services = {};
    this.cart.transport = false;
    this.saveCart();
    this.refreshCartViews();
    if (this.currentRoute === 'menu') this.refreshMenuSelection();
    this.showToast(this.t('cart_drawer_empty'), 'success');
  }

  setGuests(n) {
    const min = this.minGuests();
    const value = Math.max(min, Math.floor(Number(n) || min));
    this.cart.guests = value;
    this.saveCart();
    return value;
  }

  adjustGuests(amount, context) {
    const next = this.setGuests((this.cart.guests || DEFAULT_GUESTS) + amount);
    const input = context === 'wizard' ? $('booking-guests') : $('cart-guests-input');
    if (input) input.value = String(next);
    this.refreshCartViews();
    if (context === 'wizard') this.renderWizardSummary();
  }

  minGuests() {
    return (this.business && Number(this.business.minGuestsForBooking)) || DEFAULT_MIN_GUESTS;
  }

  taxRate() {
    return this.business && Number.isFinite(Number(this.business.taxRate))
      ? Number(this.business.taxRate) : 5;
  }

  serviceChargeRate() {
    return this.business && Number.isFinite(Number(this.business.serviceChargeRate))
      ? Number(this.business.serviceChargeRate) : 5;
  }

  transportPrice() {
    return this.business && Number.isFinite(Number(this.business.defaultTransportPrice))
      ? Number(this.business.defaultTransportPrice) : 0;
  }

  /**
   * LIVE ESTIMATE for the cart / wizard summary, computed from DB prices
   * fetched via the API. Mirrors the original app's billing formula:
   *   food    = sum(dish price) × guests
   *   services = checkbox unitPrice, or unitPrice × qty for number services
   *   service charge = services × serviceChargeRate%
   *   GST     = (food + services + service charge + transport) × taxRate%
   * The FINAL quotation is computed server-side at booking time; this is
   * always labelled an estimate in the UI.
   */
  computeEstimate() {
    const guests = this.cart.guests || DEFAULT_GUESTS;
    let perPlate = 0;
    let dishCount = 0;
    for (const id of this.selectedDishIds()) {
      const found = this.findDish(id);
      if (found) { perPlate += Number(found.dish.price) || 0; dishCount += 1; }
    }
    const foodTotal = perPlate * guests;

    let servicesTotal = 0;
    for (const [srvId, val] of Object.entries(this.cart.services)) {
      const service = this.findService(srvId);
      if (!service) continue;
      const unit = Number(service.unitPrice) || 0;
      servicesTotal += service.type === 'number' ? unit * (Number(val) || 0) : unit;
    }

    const transportTotal = this.cart.transport ? this.transportPrice() : 0;
    const serviceCharge = servicesTotal * (this.serviceChargeRate() / 100);
    const gstAmount = (foodTotal + servicesTotal + serviceCharge + transportTotal) * (this.taxRate() / 100);
    const grandTotal = foodTotal + servicesTotal + serviceCharge + transportTotal + gstAmount;

    return {
      guests, perPlate, dishCount, foodTotal, servicesTotal,
      serviceCharge, transportTotal, gstAmount, grandTotal,
      taxRate: this.taxRate(), serviceChargeRate: this.serviceChargeRate()
    };
  }

  /** Shared estimate breakdown markup (cart page + wizard summary). */
  estimateHTML(est) {
    return (
      '<h3>' + esc(this.t('estimate_title')) + '</h3>' +
      '<p class="estimate-note"><i class="fa-solid fa-circle-info"></i> ' + esc(this.t('estimate_note')) + '</p>' +
      '<div class="estimate-row"><span>' + esc(this.t('food_total_label')) +
        ' <small>(' + fmtINR(est.perPlate) + ' × ' + est.guests + ' ' + esc(this.t('guests_label').toLowerCase()) + ')</small></span>' +
        '<span>' + fmtINR(est.foodTotal) + '</span></div>' +
      '<div class="estimate-row"><span>' + esc(this.t('services_total_label')) + '</span>' +
        '<span>' + fmtINR(est.servicesTotal) + '</span></div>' +
      '<div class="estimate-row"><span>' + esc(this.t('service_charge_label')) + ' (' + est.serviceChargeRate + '%)</span>' +
        '<span>' + fmtINR(est.serviceCharge) + '</span></div>' +
      '<div class="estimate-row"><span>' + esc(this.t('transport_label')) + '</span>' +
        '<span>' + fmtINR(est.transportTotal) + '</span></div>' +
      '<div class="estimate-row"><span>' + esc(this.t('gst_label')) + ' (' + est.taxRate + '%)</span>' +
        '<span>' + fmtINR(est.gstAmount) + '</span></div>' +
      '<div class="estimate-total"><span>' + esc(this.t('grand_total_label')) + '</span>' +
        '<span>' + fmtINR(Math.round(est.grandTotal)) + '</span></div>'
    );
  }

  /**
   * Services picker shared by the cart page and booking wizard step 5.
   * Checkbox services toggle on/off; number services get a stepper whose
   * initial quantity is the API defaultQuantity.
   */
  servicesPickerHTML() {
    const available = this.services.filter((s) => s.isAvailable !== false);
    if (!available.length) {
      return '<p class="muted">' + esc(this.t('no_dishes_sub')) + '</p>';
    }
    return available.map((service) => {
      const name = locText(service.name, this.lang);
      const unit = Number(service.unitPrice) || 0;
      const selected = this.cart.services[service.id];
      let control = '';
      let lineTotal = '';
      if (service.type === 'number') {
        const qty = typeof selected === 'number' ? selected : 0;
        if (qty > 0) {
          lineTotal = '<span class="service-line-total">' + fmtINR(unit * qty) + '</span>';
          control =
            '<span class="quantity-stepper">' +
              '<button type="button" class="stepper-btn" data-action="service-dec" data-id="' + esc(service.id) + '" aria-label="Decrease">−</button>' +
              '<span class="stepper-value">' + qty + '</span>' +
              '<button type="button" class="stepper-btn" data-action="service-inc" data-id="' + esc(service.id) + '" aria-label="Increase">+</button>' +
            '</span>';
        } else {
          control = '<button type="button" class="service-add-btn" data-action="service-add" data-id="' + esc(service.id) + '">' +
            '<i class="fa-solid fa-plus"></i> ' + esc(this.t('add_btn')) + '</button>';
        }
      } else {
        if (selected) lineTotal = '<span class="service-line-total">' + fmtINR(unit) + '</span>';
        control =
          '<label class="switch">' +
            '<input type="checkbox" data-service-toggle="' + esc(service.id) + '"' + (selected ? ' checked' : '') + '>' +
            '<span class="slider"></span>' +
          '</label>';
      }
      const priceDesc = service.type === 'number'
        ? fmtINR(unit) + ' ' + esc(this.t('per_unit_label'))
        : fmtINR(unit) + ' · ' + esc(this.t('fixed_fee_label'));
      return (
        '<div class="service-row">' +
          '<div class="service-info"><div class="service-name">' + esc(name) + '</div>' +
          '<div class="service-price">' + esc(priceDesc) + '</div></div>' +
          '<div class="service-control">' + lineTotal + control + '</div>' +
        '</div>'
      );
    }).join('');
  }

  /** Bind the checkbox toggles inside a services picker (change events). */
  bindServicesPicker(container) {
    if (!container) return;
    container.querySelectorAll('[data-service-toggle]').forEach((input) => {
      input.addEventListener('change', () => this.toggleService(input.dataset.serviceToggle));
    });
  }

  /* ---------------- cart drawer ---------------- */

  openCartDrawer() {
    this.renderCartDrawer();
    $('cart-drawer').classList.add('open');
    $('cart-drawer-overlay').classList.add('open');
  }

  closeCartDrawer() {
    const drawer = $('cart-drawer');
    const overlay = $('cart-drawer-overlay');
    if (drawer) drawer.classList.remove('open');
    if (overlay) overlay.classList.remove('open');
  }

  renderCartDrawer() {
    const body = $('cart-drawer-body');
    const footer = $('cart-drawer-footer');
    if (!body || !footer) return;
    const ids = this.selectedDishIds();
    if (!ids.length) {
      body.innerHTML =
        '<div class="drawer-empty"><i class="fa-solid fa-cart-shopping"></i>' +
        '<p>' + esc(this.t('cart_drawer_empty')) + '</p></div>';
      footer.innerHTML =
        '<a href="#/menu" class="btn btn-primary btn-block" data-action="close-cart">' +
          esc(this.t('browse_menu_btn')) + '</a>';
      return;
    }
    const est = this.computeEstimate();
    body.innerHTML = ids.map((id) => {
      const found = this.findDish(id);
      if (!found) return '';
      const price = Number(found.dish.price) || 0;
      return (
        '<div class="cart-item-row">' +
          '<div class="cart-item-info">' +
            '<div class="cart-item-name">' + esc(locText(found.dish.name, this.lang)) + '</div>' +
            '<div class="cart-item-meta">' + fmtINR(price) + ' × ' + est.guests + ' ' +
              esc(this.t('guests_label').toLowerCase()) + '</div>' +
          '</div>' +
          '<span class="cart-item-total">' + fmtINR(price * est.guests) + '</span>' +
          '<button type="button" class="cart-item-remove" data-action="remove-dish" data-id="' + esc(id) + '" aria-label="' + esc(this.t('remove_btn')) + '">' +
            '<i class="fa-solid fa-trash-can"></i></button>' +
        '</div>'
      );
    }).join('');
    footer.innerHTML =
      '<div class="estimate-total" style="border-top:none;margin-top:0;padding-top:0;">' +
        '<span>' + esc(this.t('grand_total_label')) + '</span><span>' + fmtINR(Math.round(est.grandTotal)) + '</span></div>' +
      '<p class="estimate-note" style="margin:0;">' + esc(this.t('estimate_note')) + '</p>' +
      '<a href="#/cart" class="btn btn-secondary btn-block">' + esc(this.t('view_cart_btn')) + '</a>' +
      '<a href="#/booking" class="btn btn-primary btn-block">' + esc(this.t('proceed_booking_btn')) + '</a>';
  }

  /* ---------------- Contact Owner (modal + home section) ---------------- */

  openContactModal(bookingId) {
    this.contactBookingId = bookingId || null;
    this.toggleMobileNav(false);
    const body = $('contact-modal-body');
    body.innerHTML = this.contactFormHTML('modal');
    this.bindContactForm('modal');
    this.populateContactBookings('modal');
    $('contact-modal-overlay').classList.add('active');
  }

  closeContactModal() {
    const overlay = $('contact-modal-overlay');
    if (overlay) overlay.classList.remove('active');
    this.contactBookingId = null;
  }

  eventTypeOptionsHTML(selected) {
    let html = '<option value="">—</option>';
    for (const fn of FUNCTION_TYPES) {
      html += '<option value="' + fn + '"' + (fn === selected ? ' selected' : '') + '>' +
        esc(this.t(fn)) + '</option>';
    }
    return html;
  }

  /** Shared contact/inquiry form markup; `prefix` keeps ids unique (modal/home). */
  contactFormHTML(prefix) {
    const user = this.user || {};
    return (
      '<form id="' + prefix + '-contact-form" novalidate>' +
        '<p class="modal-sub">' + esc(this.t('contact_home_sub')) + '</p>' +
        '<div class="form-error" id="' + prefix + '-contact-error"></div>' +
        '<div class="form-row">' +
          '<div class="form-group"><label class="form-label" for="' + prefix + '-contact-name">' + esc(this.t('name_label')) + '</label>' +
            '<input type="text" id="' + prefix + '-contact-name" class="form-input" value="' + esc(user.name || '') + '" required minlength="3"></div>' +
          '<div class="form-group"><label class="form-label" for="' + prefix + '-contact-phone">' + esc(this.t('phone_label')) + '</label>' +
            '<input type="tel" id="' + prefix + '-contact-phone" class="form-input" value="' + esc(user.phone || '') + '" inputmode="numeric" maxlength="10" required></div>' +
        '</div>' +
        '<div class="form-row">' +
          '<div class="form-group"><label class="form-label" for="' + prefix + '-contact-event-type">' + esc(this.t('event_type_label')) + '</label>' +
            '<select id="' + prefix + '-contact-event-type" class="form-input">' + this.eventTypeOptionsHTML('') + '</select></div>' +
          '<div class="form-group"><label class="form-label" for="' + prefix + '-contact-event-date">' + esc(this.t('event_date_label')) + '</label>' +
            '<input type="date" id="' + prefix + '-contact-event-date" class="form-input" min="' + tomorrowISO() + '"></div>' +
        '</div>' +
        '<div class="form-row">' +
          '<div class="form-group"><label class="form-label" for="' + prefix + '-contact-guests">' + esc(this.t('guests_label')) + '</label>' +
            '<input type="number" id="' + prefix + '-contact-guests" class="form-input" min="1" placeholder="100"></div>' +
          '<div class="form-group"><label class="form-label" for="' + prefix + '-contact-booking">' + esc(this.t('attach_booking_label')) + '</label>' +
            '<select id="' + prefix + '-contact-booking" class="form-input">' +
              '<option value="">' + esc(this.t('no_booking_option')) + '</option>' +
            '</select></div>' +
        '</div>' +
        '<div class="form-group"><label class="form-label" for="' + prefix + '-contact-message">' + esc(this.t('message_label')) + '</label>' +
          '<textarea id="' + prefix + '-contact-message" class="form-input" placeholder="' + esc(this.t('message_placeholder')) + '"></textarea></div>' +
        '<button type="submit" class="btn btn-primary btn-block" id="' + prefix + '-contact-submit">' +
          '<i class="fa-solid fa-paper-plane"></i> ' + esc(this.t('send_inquiry_btn')) + '</button>' +
      '</form>'
    );
  }

  bindContactForm(prefix) {
    const form = $(prefix + '-contact-form');
    if (!form) return;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.submitInquiry(prefix);
    });
  }

  /** Fill the "attach booking" select for logged-in users (best effort). */
  async populateContactBookings(prefix) {
    const select = $(prefix + '-contact-booking');
    if (!select || !this.user) return;
    try {
      if (!this.bookingsCache) {
        const data = await api('/api/bookings');
        this.bookingsCache = data.bookings || [];
      }
      for (const b of this.bookingsCache) {
        const label = (b.quoteNumber || ('#' + String(b.id).slice(-6))) + ' — ' +
          this.eventTypeLabel(b) + ' · ' + fmtDate(b.eventDate, this.lang);
        const opt = document.createElement('option');
        opt.value = b.id;
        opt.textContent = label;
        if (this.contactBookingId && String(b.id) === String(this.contactBookingId)) opt.selected = true;
        select.appendChild(opt);
      }
      if (this.contactBookingId) select.value = this.contactBookingId;
    } catch (e) {
      /* attaching a booking is optional; a failed list must not block the form */
    }
  }

  async submitInquiry(prefix) {
    const name = $(prefix + '-contact-name').value.trim();
    const phone = $(prefix + '-contact-phone').value.trim();
    const errorEl = $(prefix + '-contact-error');
    const submitBtn = $(prefix + '-contact-submit');
    errorEl.classList.remove('show');
    errorEl.textContent = '';

    if (name.length < 3) {
      errorEl.textContent = this.t('err_name');
      errorEl.classList.add('show');
      return;
    }
    if (!/^[6-9][0-9]{9}$/.test(phone)) {
      errorEl.textContent = this.t('err_phone');
      errorEl.classList.add('show');
      return;
    }

    const payload = { name, phone };
    const eventType = $(prefix + '-contact-event-type').value;
    const eventDate = $(prefix + '-contact-event-date').value;
    const guests = parseInt($(prefix + '-contact-guests').value, 10);
    const message = $(prefix + '-contact-message').value.trim();
    const bookingId = $(prefix + '-contact-booking').value;
    if (eventType) payload.eventType = eventType;
    if (eventDate) payload.eventDate = eventDate;
    if (guests > 0) payload.guests = guests;
    if (message) payload.message = message;
    if (bookingId) payload.bookingId = bookingId;

    submitBtn.disabled = true;
    try {
      const data = await api('/api/inquiries', { method: 'POST', body: payload });
      const container = prefix === 'modal' ? $('contact-modal-body') : $('home-contact-form-wrap');
      if (container) container.innerHTML = this.contactSuccessHTML(data);
    } catch (e) {
      errorEl.textContent = e.message || this.t('error_loading_msg');
      errorEl.classList.add('show');
    } finally {
      submitBtn.disabled = false;
    }
  }

  /** Success state after an inquiry: WhatsApp (server-built URL), Call, Email. */
  contactSuccessHTML(data) {
    const waUrl = (data && data.whatsappUrl) || this.whatsappOwnerUrl('');
    const biz = this.business || {};
    const phoneTel = 'tel:+91' + (biz.phone || OWNER_PHONE);
    const email = biz.email || OWNER_EMAIL;
    return (
      '<div class="text-center" style="padding:12px 0;">' +
        '<i class="fa-solid fa-circle-check" style="font-size:48px;color:var(--success);margin-bottom:14px;"></i>' +
        '<h3 style="font-family:var(--font-display);font-size:21px;margin-bottom:8px;">' + esc(this.t('inquiry_success_title')) + '</h3>' +
        '<p class="muted" style="margin-bottom:22px;">' + esc(this.t('inquiry_success_sub')) + '</p>' +
        '<div style="display:flex;flex-direction:column;gap:10px;">' +
          '<a class="btn btn-whatsapp btn-block" href="' + esc(waUrl) + '" target="_blank" rel="noopener">' +
            '<i class="fa-brands fa-whatsapp"></i> ' + esc(this.t('whatsapp_owner_btn')) + '</a>' +
          '<a class="btn btn-primary btn-block" href="' + esc(phoneTel) + '">' +
            '<i class="fa-solid fa-phone"></i> ' + esc(this.t('call_owner_btn')) + '</a>' +
          '<a class="btn btn-secondary btn-block" href="mailto:' + esc(email) + '">' +
            '<i class="fa-solid fa-envelope"></i> ' + esc(this.t('email_owner_btn')) + '</a>' +
        '</div>' +
      '</div>'
    );
  }

  /** WhatsApp link to the owner with an optional prefilled message. */
  whatsappOwnerUrl(message) {
    const biz = this.business || {};
    const wa = String(biz.whatsapp || ('91' + (biz.phone || OWNER_PHONE))).replace(/[^0-9]/g, '');
    return 'https://wa.me/' + wa + (message ? '?text=' + encodeURIComponent(message) : '');
  }

  /** Human label for a booking's event type (custom text for fn_other). */
  eventTypeLabel(booking) {
    if (!booking) return '';
    if (booking.eventType === 'fn_other') return booking.customEventType || this.t('fn_other');
    return this.t(booking.eventType) || booking.eventType || '';
  }

  /* ---------------- home view ---------------- */

  renderHome() {
    const view = $('view');
    const reviews = (this.reviewsData && this.reviewsData.reviews) || [];
    const topReviews = reviews.slice(0, 3);
    const categories = this.categories.slice(0, 6);

    view.innerHTML =
      // Hero carousel
      '<section class="hero">' +
        '<div class="hero-slides" id="hero-slides">' +
          '<div class="hero-slide active"><img src="assets/banner1.jpg" alt="Sai Jyothsna Caterers — festive spread"></div>' +
          '<div class="hero-slide"><img src="assets/banner2.jpg" alt="Sai Jyothsna Caterers — traditional dishes"></div>' +
        '</div>' +
        '<div class="hero-content">' +
          '<p class="hero-eyebrow">' + esc(this.t('sub_tagline')) + '</p>' +
          '<h1 class="hero-title">' + esc(this.t('hero_title')) + '</h1>' +
          '<p class="hero-sub">' + esc(this.t('hero_sub')) + '</p>' +
          '<div class="hero-ctas">' +
            '<a href="#/booking" class="btn btn-gold"><i class="fa-solid fa-calendar-check"></i> ' + esc(this.t('hero_cta_book')) + '</a>' +
            '<a href="#/menu" class="btn btn-secondary"><i class="fa-solid fa-utensils"></i> ' + esc(this.t('hero_cta_menu')) + '</a>' +
          '</div>' +
        '</div>' +
        '<button type="button" class="icon-btn hero-arrow prev" data-action="hero-prev" aria-label="Previous banner"><i class="fa-solid fa-chevron-left"></i></button>' +
        '<button type="button" class="icon-btn hero-arrow next" data-action="hero-next" aria-label="Next banner"><i class="fa-solid fa-chevron-right"></i></button>' +
        '<div class="hero-dots" id="hero-dots">' +
          '<button type="button" class="hero-dot active" data-action="hero-dot" data-index="0" aria-label="Banner 1"></button>' +
          '<button type="button" class="hero-dot" data-action="hero-dot" data-index="1" aria-label="Banner 2"></button>' +
        '</div>' +
      '</section>' +

      '<div class="container">' +
        // Quick actions
        '<div class="quick-grid">' +
          '<a href="#/booking" class="glass-card quick-card"><i class="fa-solid fa-calendar-check"></i><h3>' + esc(this.t('card_book')) + '</h3><p>' + esc(this.t('home_subtitle')) + '</p></a>' +
          '<a href="#/menu" class="glass-card quick-card"><i class="fa-solid fa-utensils"></i><h3>' + esc(this.t('card_view_menus')) + '</h3><p>' + esc(this.t('menu_title')) + '</p></a>' +
          '<a href="#/cart" class="glass-card quick-card"><i class="fa-solid fa-calculator"></i><h3>' + esc(this.t('card_generate_menu')) + '</h3><p>' + esc(this.t('estimate_title')) + '</p></a>' +
          '<button type="button" class="glass-card quick-card" data-action="open-contact"><i class="fa-solid fa-phone-volume"></i><h3>' + esc(this.t('card_contact')) + '</h3><p>' + esc(this.t('whatsapp_btn')) + '</p></button>' +
        '</div>' +

        // Featured categories (from API)
        '<section class="section">' +
          '<h2 class="section-title">' + esc(this.t('featured_cats_title')) + '</h2>' +
          '<p class="section-sub">' + esc(this.t('featured_cats_sub')) + '</p>' +
          (categories.length
            ? '<div class="cat-grid">' + categories.map((cat) => {
                const count = (cat.items || []).filter((d) => d.isAvailable !== false).length;
                return (
                  '<a class="cat-card" href="#/menu?cat=' + encodeURIComponent(cat.id) + '">' +
                    '<span class="cat-card-icon"><i class="fa-solid fa-utensils"></i></span>' +
                    '<span><h3>' + esc(locText(cat.name, this.lang)) + '</h3>' +
                    '<p>' + count + ' ' + esc(this.t('dishes_label')) + '</p></span>' +
                    '<i class="fa-solid fa-chevron-right cat-arrow"></i>' +
                  '</a>'
                );
              }).join('') + '</div>'
            : '<p class="muted">' + esc(this.t('error_loading_msg')) + '</p>') +
        '</section>' +

        // How it works
        '<section class="section" style="padding-top:0;">' +
          '<h2 class="section-title">' + esc(this.t('how_it_works_title')) + '</h2>' +
          '<div class="steps-grid" style="margin-top:20px;">' +
            '<div class="glass-card step-card"><div class="step-num">1</div><h3>' + esc(this.t('how_step1_title')) + '</h3><p>' + esc(this.t('how_step1_desc')) + '</p></div>' +
            '<div class="glass-card step-card"><div class="step-num">2</div><h3>' + esc(this.t('how_step2_title')) + '</h3><p>' + esc(this.t('how_step2_desc')) + '</p></div>' +
            '<div class="glass-card step-card"><div class="step-num">3</div><h3>' + esc(this.t('how_step3_title')) + '</h3><p>' + esc(this.t('how_step3_desc')) + '</p></div>' +
          '</div>' +
        '</section>' +

        // Reviews preview (top 3 from API)
        '<section class="section" style="padding-top:0;">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;">' +
            '<h2 class="section-title" style="margin-bottom:0;">' + esc(this.t('reviews_preview_title')) + '</h2>' +
            '<a href="#/reviews" class="btn btn-sm btn-secondary">' + esc(this.t('view_all_reviews')) + ' <i class="fa-solid fa-arrow-right"></i></a>' +
          '</div>' +
          '<div style="margin-top:20px;">' +
            (topReviews.length
              ? '<div class="reviews-grid">' + topReviews.map((r) => this.reviewCardHTML(r)).join('') + '</div>'
              : '<p class="muted">' + esc(this.t('no_reviews_msg')) + '</p>') +
          '</div>' +
        '</section>' +

        // Contact section (full inquiry form, same as the modal)
        '<section class="section" style="padding-top:0;" id="home-contact">' +
          '<div class="contact-section"><div class="contact-grid">' +
            '<div>' +
              '<h2 class="section-title">' + esc(this.t('contact_home_title')) + '</h2>' +
              '<p class="section-sub">' + esc(this.t('contact_home_sub')) + '</p>' +
              '<div class="contact-direct">' +
                '<a class="btn btn-primary" href="tel:+91' + esc((this.business && this.business.phone) || OWNER_PHONE) + '"><i class="fa-solid fa-phone"></i> ' + esc(this.t('call_owner_btn')) + ' — +91 ' + esc((this.business && this.business.phone) || OWNER_PHONE) + '</a>' +
                '<a class="btn btn-whatsapp" href="' + esc(this.whatsappOwnerUrl('')) + '" target="_blank" rel="noopener"><i class="fa-brands fa-whatsapp"></i> ' + esc(this.t('whatsapp_owner_btn')) + '</a>' +
                '<a class="btn btn-secondary" href="mailto:' + esc((this.business && this.business.email) || OWNER_EMAIL) + '"><i class="fa-solid fa-envelope"></i> ' + esc((this.business && this.business.email) || OWNER_EMAIL) + '</a>' +
              '</div>' +
            '</div>' +
            '<div class="card" id="home-contact-form-wrap">' + this.contactFormHTML('home') + '</div>' +
          '</div></div>' +
        '</section>' +
      '</div>';

    this.bindContactForm('home');
    this.populateContactBookings('home');
    this.startHeroCarousel();
  }

  startHeroCarousel() {
    this.stopHeroCarousel();
    this.heroIndex = 0;
    this.heroTimer = setInterval(() => this.stepHeroSlide(1), 5000);
  }

  stopHeroCarousel() {
    if (this.heroTimer) { clearInterval(this.heroTimer); this.heroTimer = null; }
  }

  stepHeroSlide(delta) {
    this.showHeroSlide(this.heroIndex + delta);
  }

  showHeroSlide(index) {
    const slides = document.querySelectorAll('#hero-slides .hero-slide');
    const dots = document.querySelectorAll('#hero-dots .hero-dot');
    if (!slides.length) return;
    const total = slides.length;
    this.heroIndex = ((index % total) + total) % total;
    slides.forEach((s, i) => s.classList.toggle('active', i === this.heroIndex));
    dots.forEach((d, i) => d.classList.toggle('active', i === this.heroIndex));
  }

  /* ---------------- menu view ---------------- */

  renderMenu() {
    const view = $('view');
    view.innerHTML =
      '<div class="container page">' +
        '<div class="page-head">' +
          '<h1>' + esc(this.t('menu_title')) + '</h1>' +
          '<p>' + esc(this.t('home_subtitle')) + '</p>' +
        '</div>' +
        '<div class="menu-toolbar">' +
          '<div class="search-box">' +
            '<i class="fa-solid fa-magnifying-glass"></i>' +
            '<input type="text" id="menu-search-input" class="form-input" placeholder="' + esc(this.t('menu_search_placeholder')) + '" value="' + esc(this.menuUI.search) + '">' +
          '</div>' +
          '<div class="filter-pills" id="veg-filter-pills">' +
            '<button type="button" class="filter-pill" data-action="set-veg" data-value="all">' + esc(this.t('filter_all')) + '</button>' +
            '<button type="button" class="filter-pill" data-action="set-veg" data-value="veg">' + esc(this.t('filter_veg')) + '</button>' +
            '<button type="button" class="filter-pill" data-action="set-veg" data-value="nonveg">' + esc(this.t('filter_nonveg')) + '</button>' +
          '</div>' +
        '</div>' +
        '<div class="cat-tabs-mobile" id="menu-category-tabs"></div>' +
        '<div class="menu-layout">' +
          '<nav class="category-sidebar" id="menu-category-sidebar" aria-label="Categories"></nav>' +
          '<div class="dishes-area">' +
            '<p class="muted" id="menu-count" style="margin-bottom:14px;"></p>' +
            '<div class="dishes-grid" id="menu-grid"></div>' +
            '<div id="menu-sticky-bar-wrap"></div>' +
          '</div>' +
        '</div>' +
      '</div>';

    const searchInput = $('menu-search-input');
    searchInput.addEventListener('input', () => {
      this.menuUI.search = searchInput.value;
      this.renderMenuGrid();
    });

    this.renderMenuCategories();
    this.renderVegPills();
    this.renderMenuGrid();
    this.renderMenuStickyBar();
  }

  renderMenuCategories() {
    const sidebar = $('menu-category-sidebar');
    const tabs = $('menu-category-tabs');
    const all = { id: null, label: this.t('all_categories'), count: this.availableDishes().length };
    const cats = this.categories.map((cat) => ({
      id: cat.id,
      label: locText(cat.name, this.lang),
      count: (cat.items || []).filter((d) => d.isAvailable !== false).length
    }));
    const items = [all, ...cats];
    const html = items.map((c) => {
      const active = String(this.menuUI.categoryId || '') === String(c.id || '');
      return (
        '<button type="button" class="cat-tab' + (active ? ' active' : '') + '" data-action="select-category" data-id="' + esc(c.id || '') + '">' +
          '<span>' + esc(c.label) + '</span><span class="cat-count">' + c.count + '</span>' +
        '</button>'
      );
    }).join('');
    if (sidebar) sidebar.innerHTML = html;
    if (tabs) tabs.innerHTML = html;
  }

  renderVegPills() {
    document.querySelectorAll('#veg-filter-pills .filter-pill').forEach((b) => {
      b.classList.toggle('active', b.dataset.value === this.menuUI.veg);
    });
  }

  availableDishes() {
    const out = [];
    for (const cat of this.categories) {
      for (const dish of (cat.items || [])) {
        if (dish.isAvailable !== false) out.push(dish);
      }
    }
    return out;
  }

  menuFilteredDishes() {
    let dishes = this.availableDishes();
    if (this.menuUI.categoryId) {
      dishes = dishes.filter((d) => String(d.categoryId) === String(this.menuUI.categoryId));
    }
    if (this.menuUI.veg === 'veg') dishes = dishes.filter((d) => d.isVeg);
    if (this.menuUI.veg === 'nonveg') dishes = dishes.filter((d) => !d.isVeg);
    const q = this.menuUI.search.trim().toLowerCase();
    if (q) {
      dishes = dishes.filter((d) => {
        const hay = (locText(d.name, this.lang) + ' ' + locText(d.name, 'en') + ' ' +
          locText(d.desc, this.lang) + ' ' + locText(d.desc, 'en')).toLowerCase();
        return hay.includes(q);
      });
    }
    return dishes;
  }

  renderMenuGrid() {
    const grid = $('menu-grid');
    const countEl = $('menu-count');
    if (!grid) return;
    if (!this.categories.length) {
      grid.innerHTML = '';
      if (countEl) countEl.textContent = '';
      const area = grid.parentElement;
      if (area) {
        const existing = area.querySelector('.error-state');
        if (!existing) area.insertAdjacentHTML('beforeend', this.errorStateHTML(this.t('error_loading_msg')));
      }
      return;
    }
    const dishes = this.menuFilteredDishes();
    if (countEl) {
      countEl.textContent = dishes.length + ' ' + this.t('dishes_label');
    }
    if (!dishes.length) {
      grid.innerHTML = this.emptyStateHTML('fa-magnifying-glass', this.t('no_dishes_title'), this.t('no_dishes_sub'));
      return;
    }
    grid.innerHTML = dishes.map((dish) => {
      const selected = !!this.cart.items[dish.id];
      const img = dish.imageUrl
        ? '<img class="dish-img" src="' + esc(dish.imageUrl) + '" alt="' + esc(locText(dish.name, this.lang)) + '" loading="lazy">'
        : '<div class="dish-img-placeholder"><i class="fa-solid fa-utensils"></i></div>';
      return (
        '<article class="dish-card' + (selected ? ' selected' : '') + '">' +
          '<div class="dish-img-wrap">' + img +
            '<span class="dish-badge ' + (dish.isVeg ? 'dish-badge-veg' : 'dish-badge-nonveg') + '">' +
              esc(dish.isVeg ? this.t('veg_tag') : this.t('nonveg_tag')) + '</span>' +
          '</div>' +
          '<div class="dish-body">' +
            '<h3 class="dish-name">' + esc(locText(dish.name, this.lang)) + '</h3>' +
            '<p class="dish-desc">' + esc(locText(dish.desc, this.lang)) + '</p>' +
            '<div class="dish-footer">' +
              '<span class="dish-price">' + fmtINR(dish.price) + ' <small>/ ' + esc(this.t('plate_price')) + '</small></span>' +
              '<button type="button" class="dish-add-btn' + (selected ? ' selected' : '') + '" data-action="toggle-dish" data-id="' + esc(dish.id) + '">' +
                (selected
                  ? '<i class="fa-solid fa-check"></i> ' + esc(this.t('selected_label'))
                  : '<i class="fa-solid fa-plus"></i> ' + esc(this.t('add_btn'))) +
              '</button>' +
            '</div>' +
          '</div>' +
        '</article>'
      );
    }).join('');
  }

  renderMenuStickyBar() {
    const wrap = $('menu-sticky-bar-wrap');
    if (!wrap) return;
    const count = this.selectedDishIds().length;
    if (!count) { wrap.innerHTML = ''; return; }
    const est = this.computeEstimate();
    wrap.innerHTML =
      '<div class="menu-sticky-bar">' +
        '<div class="bar-count">' + count + ' ' + esc(this.t('dishes_selected_label')) +
          '<small>' + esc(this.t('estimate_title')) + ': ' + fmtINR(Math.round(est.grandTotal)) + '</small></div>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap;">' +
          '<a href="#/cart" class="btn btn-gold"><i class="fa-solid fa-cart-shopping"></i> ' + esc(this.t('view_cart_btn')) + '</a>' +
          '<a href="#/booking" class="btn btn-secondary" style="color:#fff;border-color:#fff;">' + esc(this.t('card_generate_menu')) + ' <i class="fa-solid fa-arrow-right"></i></a>' +
        '</div>' +
      '</div>';
  }

  selectCategory(id) {
    this.menuUI.categoryId = id || null;
    this.renderMenuCategories();
    this.renderMenuGrid();
  }

  setVegFilter(value) {
    this.menuUI.veg = value;
    this.renderVegPills();
    this.renderMenuGrid();
  }

  /* ---------------- cart view ---------------- */

  renderCart() {
    const view = $('view');
    const ids = this.selectedDishIds();
    if (!ids.length) {
      view.innerHTML =
        '<div class="container page"><div class="page-head"><h1>' + esc(this.t('cart_title')) + '</h1></div>' +
        this.emptyStateHTML('fa-cart-shopping', this.t('cart_empty_title'), this.t('cart_empty_sub'),
          this.t('browse_menu_btn'), '#/menu') + '</div>';
      return;
    }

    const est = this.computeEstimate();
    const dishesHTML = ids.map((id) => {
      const found = this.findDish(id);
      if (!found) return '';
      const price = Number(found.dish.price) || 0;
      return (
        '<div class="cart-item-row">' +
          '<div class="cart-item-info">' +
            '<div class="cart-item-name">' + esc(locText(found.dish.name, this.lang)) + '</div>' +
            '<div class="cart-item-meta">' + fmtINR(price) + ' ' + esc(this.t('plate_price')) +
              ' × ' + est.guests + ' ' + esc(this.t('guests_label').toLowerCase()) + '</div>' +
          '</div>' +
          '<span class="cart-item-total">' + fmtINR(price * est.guests) + '</span>' +
          '<button type="button" class="cart-item-remove" data-action="remove-dish" data-id="' + esc(id) + '">' +
            '<i class="fa-solid fa-trash-can"></i> ' + esc(this.t('remove_btn')) + '</button>' +
        '</div>'
      );
    }).join('');

    const transportPrice = this.transportPrice();
    view.innerHTML =
      '<div class="container page">' +
        '<div class="page-head"><h1>' + esc(this.t('cart_title')) + '</h1>' +
        '<p>' + ids.length + ' ' + esc(this.t('dishes_selected_label')) + '</p></div>' +
        '<div class="cart-layout">' +
          '<div style="display:flex;flex-direction:column;gap:20px;">' +
            '<div class="card"><h3 style="margin-bottom:8px;">' + esc(this.t('selected_dishes_title')) + '</h3>' + dishesHTML + '</div>' +
            '<div class="card">' +
              '<h3 style="margin-bottom:14px;">' + esc(this.t('evt_guests')) + '</h3>' +
              '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">' +
                '<button type="button" class="guests-step-btn" data-action="adjust-guests" data-amount="-10" data-context="cart">−10</button>' +
                '<input type="number" id="cart-guests-input" class="form-input guests-input" value="' + est.guests + '" min="' + this.minGuests() + '" style="width:110px;text-align:center;font-size:20px;font-weight:700;">' +
                '<button type="button" class="guests-step-btn" data-action="adjust-guests" data-amount="10" data-context="cart">+10</button>' +
                '<span class="muted" style="font-size:13px;">' + esc(this.t('err_guests_min').replace('{min}', String(this.minGuests()))) + '</span>' +
              '</div>' +
            '</div>' +
            '<div class="card"><h3 style="margin-bottom:8px;">' + esc(this.t('add_services_title')) + '</h3>' +
              '<div id="services-picker">' + this.servicesPickerHTML() + '</div>' +
              '<div class="service-row" style="border-bottom:none;">' +
                '<div class="service-info"><div class="service-name">' + esc(this.t('transport_toggle_label')) + '</div>' +
                '<div class="service-price">' + (transportPrice > 0 ? fmtINR(transportPrice) + ' · ' + esc(this.t('fixed_fee_label')) : esc(this.t('transport_label'))) + '</div></div>' +
                '<label class="switch"><input type="checkbox" id="transport-toggle"' + (this.cart.transport ? ' checked' : '') + '><span class="slider"></span></label>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="card estimate-card"><div id="estimate-box">' + this.estimateHTML(est) + '</div>' +
            '<div style="display:flex;flex-direction:column;gap:10px;margin-top:18px;">' +
              '<a href="#/booking" class="btn btn-primary btn-block">' + esc(this.t('proceed_booking_btn')) + ' <i class="fa-solid fa-arrow-right"></i></a>' +
              '<button type="button" class="btn btn-secondary btn-block" data-action="clear-cart"><i class="fa-solid fa-trash-can"></i> ' + esc(this.t('clear_cart_btn')) + '</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    this.bindServicesPicker($('services-picker'));
    const transportToggle = $('transport-toggle');
    if (transportToggle) transportToggle.addEventListener('change', () => this.toggleTransport());
    const guestsInput = $('cart-guests-input');
    if (guestsInput) {
      guestsInput.addEventListener('change', () => {
        const next = this.setGuests(guestsInput.value);
        guestsInput.value = String(next);
        this.renderCart();
      });
    }
  }

  /* ---------------- booking wizard ---------------- */

  renderBooking() {
    const view = $('view');
    const w = this.wizard;
    const minGuests = this.minGuests();
    const stepLabels = [
      this.t('step_1_header'), this.t('step_2_header'), this.t('step_3_header'),
      this.t('step_4_header'), this.t('step_5_header')
    ];

    view.innerHTML =
      '<div class="container page"><div class="wizard-wrap">' +
        '<div class="page-head"><h1>' + esc(this.t('book_title')) + '</h1>' +
        '<p>' + esc(this.t('home_subtitle')) + '</p></div>' +

        '<div class="stepper-header">' +
          [1, 2, 3, 4, 5].map((n) =>
            '<div class="step-node" id="node-' + n + '">' + n + '</div>').join('') +
        '</div>' +
        '<div class="step-labels">' +
          stepLabels.map((label, i) =>
            '<span class="step-label" id="label-' + (i + 1) + '">' + esc(label.replace(/^Step \d+:\s*/i, '')) + '</span>').join('') +
        '</div>' +

        '<div class="form-error" id="wizard-error"></div>' +

        // Step 1 — function type
        '<div class="wizard-step" id="wizard-step-1">' +
          '<h3>' + esc(this.t('step_1_header')) + '</h3>' +
          '<div class="option-pill-grid" id="function-type-grid">' +
            FUNCTION_TYPES.map((fn) =>
              '<button type="button" class="option-pill" data-action="select-function" data-value="' + fn + '">' +
                esc(this.t(fn)) + '</button>').join('') +
          '</div>' +
          '<div class="form-group" id="custom-function-group" style="display:none;">' +
            '<input type="text" id="booking-custom-function" class="form-input" placeholder="' + esc(this.t('other_fn_placeholder')) + '" value="' + esc(w.customFunction) + '">' +
          '</div>' +
        '</div>' +

        // Step 2 — date
        '<div class="wizard-step" id="wizard-step-2">' +
          '<h3>' + esc(this.t('step_2_header')) + '</h3>' +
          '<div class="glass-card">' +
            '<div class="form-group"><label class="form-label" for="booking-date">' + esc(this.t('evt_date')) + '</label>' +
            '<input type="date" id="booking-date" class="form-input" min="' + tomorrowISO() + '" value="' + esc(w.date) + '"></div>' +
            '<div class="error-msg" id="booking-date-error">' + esc(this.t('err_future_date')) + '</div>' +
          '</div>' +
        '</div>' +

        // Step 3 — guests
        '<div class="wizard-step" id="wizard-step-3">' +
          '<h3>' + esc(this.t('step_3_header')) + '</h3>' +
          '<div class="glass-card guests-picker">' +
            '<p class="muted">' + esc(this.t('evt_guests')) + '</p>' +
            '<div class="guests-controls">' +
              '<button type="button" class="guests-step-btn" data-action="adjust-guests" data-amount="-50" data-context="wizard">−50</button>' +
              '<button type="button" class="guests-step-btn" data-action="adjust-guests" data-amount="-10" data-context="wizard">−10</button>' +
              '<input type="number" id="booking-guests" class="form-input guests-input" value="' + this.cart.guests + '" min="' + minGuests + '">' +
              '<button type="button" class="guests-step-btn" data-action="adjust-guests" data-amount="10" data-context="wizard">+10</button>' +
              '<button type="button" class="guests-step-btn" data-action="adjust-guests" data-amount="50" data-context="wizard">+50</button>' +
            '</div>' +
            '<p class="muted" style="font-size:13px;">' + esc(this.t('err_guests_min').replace('{min}', String(minGuests))) + '</p>' +
            '<div class="error-msg" id="booking-guests-error">' + esc(this.t('err_guests_min').replace('{min}', String(minGuests))) + '</div>' +
          '</div>' +
        '</div>' +

        // Step 4 — venue address
        '<div class="wizard-step" id="wizard-step-4">' +
          '<h3>' + esc(this.t('step_4_header')) + '</h3>' +
          '<div class="glass-card">' +
            '<div class="form-group"><label class="form-label" for="booking-addr-line">' + esc(this.t('addr_line')) + '</label>' +
              '<input type="text" id="booking-addr-line" class="form-input" value="' + esc(w.address.line) + '"></div>' +
            '<div class="form-group"><label class="form-label" for="booking-landmark">' + esc(this.t('landmark')) + '</label>' +
              '<input type="text" id="booking-landmark" class="form-input" value="' + esc(w.address.landmark) + '"></div>' +
            '<div class="form-row">' +
              '<div class="form-group"><label class="form-label" for="booking-city">' + esc(this.t('city')) + '</label>' +
                '<input type="text" id="booking-city" class="form-input" value="' + esc(w.address.city) + '"></div>' +
              '<div class="form-group"><label class="form-label" for="booking-district">' + esc(this.t('district')) + '</label>' +
                '<input type="text" id="booking-district" class="form-input" value="' + esc(w.address.district) + '"></div>' +
            '</div>' +
            '<div class="form-row">' +
              '<div class="form-group"><label class="form-label" for="booking-state">' + esc(this.t('state')) + '</label>' +
                '<input type="text" id="booking-state" class="form-input" value="' + esc(w.address.state) + '"></div>' +
              '<div class="form-group"><label class="form-label" for="booking-pincode">' + esc(this.t('pincode')) + '</label>' +
                '<input type="text" id="booking-pincode" class="form-input" inputmode="numeric" maxlength="6" value="' + esc(w.address.pincode) + '"></div>' +
            '</div>' +
            '<div class="error-msg" id="booking-address-error">' + esc(this.t('err_address')) + '</div>' +
          '</div>' +
        '</div>' +

        // Step 5 — services + summary + submit
        '<div class="wizard-step" id="wizard-step-5">' +
          '<h3>' + esc(this.t('step_5_header')) + '</h3>' +
          '<div class="glass-card"><div id="services-picker">' + this.servicesPickerHTML() + '</div>' +
            '<div class="service-row" style="border-bottom:none;">' +
              '<div class="service-info"><div class="service-name">' + esc(this.t('transport_toggle_label')) + '</div>' +
              '<div class="service-price">' + (this.transportPrice() > 0 ? fmtINR(this.transportPrice()) + ' · ' + esc(this.t('fixed_fee_label')) : esc(this.t('transport_label'))) + '</div></div>' +
              '<label class="switch"><input type="checkbox" id="transport-toggle"' + (this.cart.transport ? ' checked' : '') + '><span class="slider"></span></label>' +
            '</div>' +
          '</div>' +
          '<div class="glass-card" style="margin-top:16px;">' +
            '<div class="form-group" style="margin-bottom:0;"><label class="form-label" for="booking-notes">' + esc(this.t('notes_label')) + '</label>' +
            '<textarea id="booking-notes" class="form-input" placeholder="' + esc(this.t('notes_placeholder')) + '">' + esc(w.notes) + '</textarea></div>' +
          '</div>' +
          '<div class="glass-card wizard-summary-box" id="wizard-summary"></div>' +
        '</div>' +

        '<div class="wizard-nav">' +
          '<button type="button" class="btn btn-secondary" id="btn-wizard-prev" data-action="wizard-prev" style="display:none;">' +
            '<i class="fa-solid fa-arrow-left"></i> ' + esc(this.t('prev_btn')) + '</button>' +
          '<button type="button" class="btn btn-primary" id="btn-wizard-next" data-action="wizard-next">' +
            esc(this.t('next_btn')) + ' <i class="fa-solid fa-arrow-right"></i></button>' +
          '<button type="button" class="btn btn-gold" id="btn-wizard-submit" data-action="wizard-submit" style="display:none;">' +
            '<i class="fa-solid fa-receipt"></i> ' + esc(this.t('submit_booking_btn')) + '</button>' +
        '</div>' +
      '</div></div>';

    this.bindServicesPicker($('services-picker'));
    const transportToggle = $('transport-toggle');
    if (transportToggle) transportToggle.addEventListener('change', () => this.toggleTransport());

    const dateInput = $('booking-date');
    if (dateInput) dateInput.addEventListener('change', () => { this.wizard.date = dateInput.value; });
    const guestsInput = $('booking-guests');
    if (guestsInput) {
      guestsInput.addEventListener('change', () => {
        const next = this.setGuests(guestsInput.value);
        guestsInput.value = String(next);
        this.renderWizardSummary();
      });
    }
    const customInput = $('booking-custom-function');
    if (customInput) customInput.addEventListener('input', () => { this.wizard.customFunction = customInput.value; });
    const notesInput = $('booking-notes');
    if (notesInput) notesInput.addEventListener('input', () => { this.wizard.notes = notesInput.value; });

    this.renderWizardStep();
  }

  renderWizardStep() {
    const step = this.wizard.step;
    for (let n = 1; n <= 5; n++) {
      const stepEl = $('wizard-step-' + n);
      const node = $('node-' + n);
      const label = $('label-' + n);
      if (stepEl) stepEl.classList.toggle('active', n === step);
      if (node) {
        node.classList.toggle('active', n === step);
        node.classList.toggle('completed', n < step);
        node.innerHTML = n < step ? '<i class="fa-solid fa-check"></i>' : String(n);
      }
      if (label) label.classList.toggle('active', n === step);
    }
    const prevBtn = $('btn-wizard-prev');
    const nextBtn = $('btn-wizard-next');
    const submitBtn = $('btn-wizard-submit');
    if (prevBtn) prevBtn.style.display = step > 1 ? '' : 'none';
    if (nextBtn) nextBtn.style.display = step < 5 ? '' : 'none';
    if (submitBtn) submitBtn.style.display = step === 5 ? '' : 'none';

    // Restore the selected function pill + custom input visibility.
    document.querySelectorAll('#function-type-grid .option-pill').forEach((pill) => {
      pill.classList.toggle('selected', pill.dataset.value === this.wizard.functionType);
    });
    const customGroup = $('custom-function-group');
    if (customGroup) customGroup.style.display = this.wizard.functionType === 'fn_other' ? '' : 'none';

    if (step === 5) this.renderWizardSummary();
  }

  renderWizardSummary() {
    const box = $('wizard-summary');
    if (!box) return;
    const est = this.computeEstimate();
    const dishCount = est.dishCount;
    box.innerHTML =
      '<h3 style="margin-bottom:4px;">' + esc(this.t('booking_summary_title')) + '</h3>' +
      '<p class="muted" style="font-size:14px;margin-bottom:12px;">' +
        (this.wizard.functionType ? esc(this.wizard.functionType === 'fn_other'
          ? (this.wizard.customFunction || this.t('fn_other')) : this.t(this.wizard.functionType)) + ' · ' : '') +
        (this.wizard.date ? esc(fmtDate(this.wizard.date, this.lang)) + ' · ' : '') +
        est.guests + ' ' + esc(this.t('guests_label').toLowerCase()) + ' · ' +
        dishCount + ' ' + esc(this.t('dishes_label')) +
      '</p>' +
      (dishCount === 0
        ? '<p class="form-error show" style="margin-bottom:12px;">' + esc(this.t('err_no_dishes')) +
          ' <a href="#/menu">' + esc(this.t('browse_menu_btn')) + '</a></p>'
        : '') +
      this.estimateHTML(est);
  }

  selectFunction(value) {
    this.wizard.functionType = value;
    document.querySelectorAll('#function-type-grid .option-pill').forEach((pill) => {
      pill.classList.toggle('selected', pill.dataset.value === value);
    });
    const customGroup = $('custom-function-group');
    if (customGroup) customGroup.style.display = value === 'fn_other' ? '' : 'none';
    this.hideWizardError();
  }

  showWizardError(message) {
    const el = $('wizard-error');
    if (!el) return;
    el.textContent = message;
    el.classList.add('show');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  hideWizardError() {
    const el = $('wizard-error');
    if (el) el.classList.remove('show');
  }

  navigateWizard(direction) {
    if (direction === 1) {
      if (!this.validateWizardStep()) return;
      if (this.wizard.step < 5) {
        this.wizard.step += 1;
        this.renderWizardStep();
      }
    } else if (this.wizard.step > 1) {
      this.wizard.step -= 1;
      this.renderWizardStep();
    }
  }

  validateWizardStep() {
    const step = this.wizard.step;
    this.hideWizardError();

    if (step === 1) {
      if (!this.wizard.functionType) {
        this.showWizardError(this.t('err_select_function'));
        return false;
      }
      if (this.wizard.functionType === 'fn_other') {
        const custom = ($('booking-custom-function') && $('booking-custom-function').value.trim()) || this.wizard.customFunction.trim();
        if (!custom) {
          this.showWizardError(this.t('err_custom_function'));
          return false;
        }
        this.wizard.customFunction = custom;
      }
      return true;
    }

    if (step === 2) {
      const dateInput = $('booking-date');
      const errEl = $('booking-date-error');
      const val = dateInput ? dateInput.value : '';
      if (!val) {
        if (errEl) { errEl.textContent = this.t('err_select_date'); errEl.classList.add('show'); }
        return false;
      }
      if (val < tomorrowISO()) {
        if (errEl) { errEl.textContent = this.t('err_future_date'); errEl.classList.add('show'); }
        return false;
      }
      if (errEl) errEl.classList.remove('show');
      this.wizard.date = val;
      return true;
    }

    if (step === 3) {
      const guestsInput = $('booking-guests');
      const errEl = $('booking-guests-error');
      const guests = parseInt(guestsInput ? guestsInput.value : '', 10) || 0;
      if (guests < this.minGuests()) {
        if (errEl) errEl.classList.add('show');
        return false;
      }
      if (errEl) errEl.classList.remove('show');
      this.setGuests(guests);
      return true;
    }

    if (step === 4) {
      const line = ($('booking-addr-line') && $('booking-addr-line').value.trim()) || '';
      const city = ($('booking-city') && $('booking-city').value.trim()) || '';
      const pin = ($('booking-pincode') && $('booking-pincode').value.trim()) || '';
      const errEl = $('booking-address-error');
      if (!line || !city || !/^[0-9]{6}$/.test(pin)) {
        if (errEl) errEl.classList.add('show');
        this.showWizardError(this.t('err_address'));
        return false;
      }
      if (errEl) errEl.classList.remove('show');
      this.wizard.address = {
        line,
        landmark: ($('booking-landmark') && $('booking-landmark').value.trim()) || '',
        city,
        district: ($('booking-district') && $('booking-district').value.trim()) || '',
        state: ($('booking-state') && $('booking-state').value.trim()) || '',
        pincode: pin
      };
      return true;
    }

    return true;
  }

  async submitBooking() {
    // Step 5 re-validates the whole draft (user may have edited nothing).
    if (!this.validateWizardStep()) return;

    if (!this.user) {
      this.showToast(this.t('login_to_book_msg'));
      this.requireLogin('#/booking');
      return;
    }

    const itemIds = this.selectedDishIds();
    if (!itemIds.length) {
      this.showWizardError(this.t('err_no_dishes'));
      return;
    }

    const servicesPayload = Object.entries(this.cart.services).map(([serviceId, val]) => {
      const service = this.findService(serviceId);
      if (service && service.type === 'number') return { serviceId, quantity: Number(val) || 1 };
      return { serviceId };
    });

    const payload = {
      eventType: this.wizard.functionType,
      eventDate: this.wizard.date,
      guests: this.cart.guests,
      venueAddress: this.wizard.address.line,
      landmark: this.wizard.address.landmark || undefined,
      city: this.wizard.address.city,
      district: this.wizard.address.district || undefined,
      state: this.wizard.address.state || undefined,
      pincode: this.wizard.address.pincode || undefined,
      items: itemIds,
      services: servicesPayload,
      transport: !!this.cart.transport,
      notes: this.wizard.notes.trim() || undefined
    };
    if (this.wizard.functionType === 'fn_other') {
      payload.customEventType = this.wizard.customFunction.trim();
    }

    const submitBtn = $('btn-wizard-submit');
    if (submitBtn) submitBtn.disabled = true;
    this.showToast(this.t('booking_submitting_msg'));
    try {
      const data = await api('/api/bookings', { method: 'POST', body: payload });
      const booking = data.booking || {};
      // The booking is now server-side: clear the cart so it cannot be
      // submitted twice, but keep the guest count for the next event.
      this.cart.items = {};
      this.cart.services = {};
      this.cart.transport = false;
      this.saveCart();
      this.bookingsCache = null;
      this.wizard = this.freshWizard();
      this.showToast(this.t('booking_created_msg'), 'success');
      location.hash = '#/quotation/' + encodeURIComponent(booking.id || '');
    } catch (e) {
      if (e.code === 'unauthorized') {
        this.requireLogin('#/booking');
      } else {
        this.showWizardError(e.message || this.t('error_loading_msg'));
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  /* ---------------- quotation view ---------------- */

  /**
   * Resolve one booking item entry into { name, price, categoryId }.
   * The server may send item ids, {itemId} refs, or full item objects —
   * all three are handled, resolving through the menu cache when needed.
   */
  resolveBookingItem(entry) {
    if (typeof entry === 'string') {
      const found = this.findDish(entry);
      if (found) {
        return { name: locText(found.dish.name, this.lang), price: Number(found.dish.price) || 0, categoryId: found.dish.categoryId };
      }
      return { name: String(entry), price: 0, categoryId: null };
    }
    if (entry && typeof entry === 'object') {
      const refId = entry.itemId || entry.dishId;
      if (refId && !entry.name) {
        const found = this.findDish(refId);
        if (found) {
          return { name: locText(found.dish.name, this.lang), price: Number(entry.price ?? found.dish.price) || 0, categoryId: found.dish.categoryId };
        }
      }
      return {
        name: locText(entry.name, this.lang) || String(entry.itemId || entry.id || ''),
        price: Number(entry.price) || 0,
        categoryId: entry.categoryId || null
      };
    }
    return { name: '', price: 0, categoryId: null };
  }

  resolveBookingService(entry) {
    if (typeof entry === 'string') {
      const found = this.findService(entry);
      if (found) return { name: locText(found.name, this.lang), unitPrice: Number(found.unitPrice) || 0, quantity: 1, type: found.type };
      return { name: String(entry), unitPrice: 0, quantity: 1, type: 'checkbox' };
    }
    if (entry && typeof entry === 'object') {
      const refId = entry.serviceId || entry.id;
      const found = refId ? this.findService(refId) : null;
      const type = entry.type || (found ? found.type : 'checkbox');
      return {
        name: locText(entry.name, this.lang) || (found ? locText(found.name, this.lang) : String(refId || '')),
        unitPrice: Number(entry.unitPrice ?? entry.price ?? (found ? found.unitPrice : 0)) || 0,
        quantity: type === 'number' ? (Number(entry.quantity) || 1) : 1,
        type
      };
    }
    return { name: '', unitPrice: 0, quantity: 1, type: 'checkbox' };
  }

  async renderQuotation(bookingId) {
    const view = $('view');
    if (!bookingId) {
      view.innerHTML = this.errorStateHTML(this.t('error_loading_msg'));
      return;
    }
    view.innerHTML = this.loadingStateHTML();
    let booking;
    try {
      const data = await api('/api/bookings/' + encodeURIComponent(bookingId));
      booking = data.booking || data;
    } catch (e) {
      if (e.code === 'unauthorized') { this.requireLogin('#/quotation/' + bookingId); return; }
      view.innerHTML = this.errorStateHTML(e.message || this.t('error_loading_msg'));
      return;
    }

    const biz = this.business || {};
    const guests = Number(booking.guests) || 0;
    const customerName = booking.customerName || booking.userName || (this.user && this.user.name) || '';
    const customerPhone = booking.customerPhone || booking.phone || (this.user && this.user.phone) || '';
    const venueParts = [
      booking.venueAddress, booking.landmark, booking.city,
      booking.district, booking.state
    ].filter(Boolean);
    const venue = venueParts.join(', ') + (booking.pincode ? ' - ' + booking.pincode : '');
    const quoteNo = booking.quoteNumber || ('#' + String(booking.id).slice(-8).toUpperCase());
    const status = String(booking.status || 'pending').toLowerCase();

    // Grouped menu (category headings, in menu order).
    const items = (booking.items || []).map((e) => this.resolveBookingItem(e));
    const catOrder = new Map(this.categories.map((c, i) => [String(c.id), i]));
    const catName = new Map(this.categories.map((c) => [String(c.id), locText(c.name, this.lang)]));
    const grouped = new Map();
    for (const item of items) {
      const key = item.categoryId != null ? String(item.categoryId) : '__other__';
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(item);
    }
    const sortedGroups = [...grouped.entries()].sort((a, b) => {
      const ia = a[0] === '__other__' ? 9999 : (catOrder.get(a[0]) ?? 9998);
      const ib = b[0] === '__other__' ? 9999 : (catOrder.get(b[0]) ?? 9998);
      return ia - ib;
    });
    let menuHTML = '';
    if (!items.length) {
      menuHTML = '<p class="muted" style="font-size:13px;">—</p>';
    } else {
      for (const [key, groupItems] of sortedGroups) {
        if (key !== '__other__') {
          menuHTML += '<h5 class="receipt-cat-heading">' + esc(catName.get(key) || '') + '</h5>';
        }
        for (const item of groupItems) {
          const lineTotal = item.price * guests;
          menuHTML += (
            '<div class="receipt-item-row">' +
              '<span class="receipt-item-name">• ' + esc(item.name) +
                ' (' + fmtINR(item.price) + ' × ' + guests + ')</span>' +
              '<span class="receipt-item-price">' + fmtINR(lineTotal) + '</span>' +
            '</div>'
          );
        }
      }
    }

    // Services lines.
    const services = (booking.services || []).map((e) => this.resolveBookingService(e));
    let servicesHTML = '';
    if (!services.length && !booking.transportTotal) {
      servicesHTML = '<p class="muted" style="font-size:13px;">—</p>';
    } else {
      for (const s of services) {
        const cost = s.type === 'number' ? s.unitPrice * s.quantity : s.unitPrice;
        const desc = s.type === 'number'
          ? esc(s.name) + ' (' + fmtINR(s.unitPrice) + ' × ' + s.quantity + ')'
          : esc(s.name);
        servicesHTML += (
          '<div class="receipt-item-row"><span class="receipt-item-name">' + desc + '</span>' +
          '<span class="receipt-item-price">' + fmtINR(cost) + '</span></div>'
        );
      }
    }

    const taxRate = Number(booking.taxRate ?? this.taxRate());
    const serviceChargeRate = Number(booking.serviceChargeRate ?? this.serviceChargeRate());
    const foodTotal = Number(booking.foodTotal) || 0;
    const servicesTotal = Number(booking.servicesTotal) || 0;
    const serviceCharge = Number(booking.serviceCharge) || 0;
    const transportTotal = Number(booking.transportTotal) || 0;
    const gstAmount = Number(booking.gstAmount) || 0;
    const grandTotal = Number(booking.grandTotal) || 0;

    // WhatsApp message (same shape as the original app's enquiry message).
    const waMessage =
      this.t('whatsapp_msg_pre') + '\n\n' +
      '*Client Details:*\n' +
      '• Name: ' + customerName + '\n' +
      '• Mobile: ' + customerPhone + '\n\n' +
      '*Event Summary:*\n' +
      '• Event: ' + this.eventTypeLabel(booking) + '\n' +
      '• Date: ' + (booking.eventDate || '') + '\n' +
      '• Guest Count: ' + guests + '\n' +
      '• Venue Address: ' + venue + '\n' +
      '• Quotation No.: ' + quoteNo + '\n\n' +
      '*Estimated Grand Total:* ' + fmtINR(Math.round(grandTotal)) + '\n\n' +
      'Please confirm availability. Thank you!';

    view.innerHTML =
      '<div class="container page"><div class="receipt-wrap">' +
        '<div class="page-head no-print">' +
          '<h1>' + esc(this.t('quote_title')) + '</h1>' +
          '<p><span class="status-badge status-' + esc(status) + '">' + esc(this.t('status_' + status) || status) + '</span></p>' +
        '</div>' +

        '<div class="receipt" id="printable-quotation-receipt">' +
          '<div class="receipt-header">' +
            '<div class="receipt-header-left">' +
              '<img src="assets/logo.jpg" alt="Sai Jyothsna logo" class="receipt-logo">' +
              '<div>' +
                '<h3 class="receipt-biz-name">' + esc(biz.name || 'Sai Jyothsna Caterers & Suppliers') + '</h3>' +
                '<p class="receipt-biz-sub">' + esc(this.t('sub_tagline')) + '</p>' +
                '<p class="receipt-biz-sub">PH: ' + esc(biz.phone || OWNER_PHONE) + '</p>' +
              '</div>' +
            '</div>' +
            '<div class="receipt-metadata">' +
              '<p class="receipt-quote-no">' + esc(this.t('quote_number_label')) + ' ' + esc(quoteNo) + '</p>' +
              '<p><strong>' + esc(this.t('cus_name')) + '</strong>: ' + esc(customerName) + '</p>' +
              '<p><strong>' + esc(this.t('cus_phone')) + '</strong>: ' + esc(customerPhone) + '</p>' +
              '<p><strong>' + esc(this.t('evt_type')) + '</strong>: ' + esc(this.eventTypeLabel(booking)) + '</p>' +
              '<p><strong>' + esc(this.t('evt_date')) + '</strong>: ' + esc(fmtDate(booking.eventDate, this.lang)) + '</p>' +
              '<p><strong>' + esc(this.t('evt_guests')) + '</strong>: ' + guests + '</p>' +
            '</div>' +
          '</div>' +
          '<p style="font-size:12px;color:#666;"><strong>' + esc(this.t('evt_addr')) + '</strong>: ' + esc(venue) + '</p>' +

          '<h4 class="receipt-section-title">' + esc(this.t('summary_menu')) + '</h4>' + menuHTML +
          '<h4 class="receipt-section-title">' + esc(this.t('summary_services')) + '</h4>' + servicesHTML +

          '<h4 class="receipt-section-title">' + esc(this.t('summary_billing')) + '</h4>' +
          '<div class="receipt-total-block">' +
            '<div class="receipt-item-row"><span>' + esc(this.t('bill_food')) + '</span><span class="receipt-item-price">' + fmtINR(foodTotal) + '</span></div>' +
            '<div class="receipt-item-row"><span>' + esc(this.t('bill_service')) + '</span><span class="receipt-item-price">' + fmtINR(servicesTotal) + '</span></div>' +
            '<div class="receipt-item-row"><span>' + esc(this.t('service_charge_label')) + ' (' + serviceChargeRate + '%)</span><span class="receipt-item-price">' + fmtINR(serviceCharge) + '</span></div>' +
            '<div class="receipt-item-row"><span>' + esc(this.t('bill_transport')) + '</span><span class="receipt-item-price">' + fmtINR(transportTotal) + '</span></div>' +
            '<div class="receipt-item-row"><span>' + esc(this.t('bill_tax')) + ' (' + taxRate + '%)</span><span class="receipt-item-price">' + fmtINR(gstAmount) + '</span></div>' +
            '<div class="receipt-total-row receipt-grand-total"><span>' + esc(this.t('bill_total')) + '</span><span>' + fmtINR(Math.round(grandTotal)) + '</span></div>' +
          '</div>' +
          '<p class="receipt-validity">' + esc(this.t('validity_note')) + '</p>' +
        '</div>' +

        '<div class="quote-actions no-print">' +
          '<button type="button" class="btn btn-gold" data-action="print-quote"><i class="fa-solid fa-print"></i> ' + esc(this.t('print_pdf_btn')) + '</button>' +
          '<button type="button" class="btn btn-primary" data-action="open-contact" data-booking-id="' + esc(booking.id) + '"><i class="fa-solid fa-paper-plane"></i> ' + esc(this.t('send_inquiry_btn')) + '</button>' +
          '<a class="btn btn-whatsapp" href="' + esc(this.whatsappOwnerUrl(waMessage)) + '" target="_blank" rel="noopener"><i class="fa-brands fa-whatsapp"></i> ' + esc(this.t('whatsapp_owner_btn')) + '</a>' +
          '<a class="btn btn-secondary" href="/api/quotations/' + encodeURIComponent(booking.id) + '" target="_blank" rel="noopener"><i class="fa-solid fa-file-lines"></i> ' + esc(this.t('open_printable_btn')) + '</a>' +
        '</div>' +
      '</div></div>';
  }

  /* ---------------- my bookings view ---------------- */

  async renderBookings() {
    const view = $('view');
    if (!this.user) {
      this.requireLogin('#/bookings');
      return;
    }
    view.innerHTML = this.loadingStateHTML();
    let bookings;
    try {
      const data = await api('/api/bookings');
      bookings = data.bookings || [];
      this.bookingsCache = bookings;
    } catch (e) {
      if (e.code === 'unauthorized') { this.requireLogin('#/bookings'); return; }
      view.innerHTML = this.errorStateHTML(e.message || this.t('error_loading_msg'));
      return;
    }

    if (!bookings.length) {
      view.innerHTML =
        '<div class="container page"><div class="page-head"><h1>' + esc(this.t('bookings_title')) + '</h1></div>' +
        this.emptyStateHTML('fa-calendar-xmark', this.t('no_bookings_title'), this.t('no_bookings_sub'),
          this.t('hero_cta_book'), '#/booking') + '</div>';
      return;
    }

    view.innerHTML =
      '<div class="container page">' +
        '<div class="page-head"><h1>' + esc(this.t('bookings_title')) + '</h1></div>' +
        '<div class="bookings-grid">' +
        bookings.map((b) => {
          const status = String(b.status || 'pending').toLowerCase();
          const quoteNo = b.quoteNumber || ('#' + String(b.id).slice(-8).toUpperCase());
          return (
            '<article class="card booking-card">' +
              '<div class="booking-card-header">' +
                '<div><h3>' + esc(this.eventTypeLabel(b)) + '</h3>' +
                '<p class="muted" style="font-size:13px;">' + esc(this.t('quote_number_label')) + ' ' + esc(quoteNo) + '</p></div>' +
                '<span class="status-badge status-' + esc(status) + '">' + esc(this.t('status_' + status) || status) + '</span>' +
              '</div>' +
              '<div class="booking-meta">' +
                '<span><i class="fa-solid fa-calendar-days"></i> ' + esc(fmtDate(b.eventDate, this.lang)) + '</span>' +
                '<span><i class="fa-solid fa-users"></i> ' + esc(String(b.guests || '')) + ' ' + esc(this.t('guests_label').toLowerCase()) + '</span>' +
                '<span><i class="fa-solid fa-location-dot"></i> ' + esc([b.venueAddress, b.city].filter(Boolean).join(', ')) + '</span>' +
              '</div>' +
              '<div class="booking-card-footer">' +
                '<span class="booking-total">' + fmtINR(Math.round(Number(b.grandTotal) || 0)) + '</span>' +
                '<a href="#/quotation/' + encodeURIComponent(b.id) + '" class="btn btn-sm btn-primary">' +
                  esc(this.t('view_quotation_btn')) + ' <i class="fa-solid fa-arrow-right"></i></a>' +
              '</div>' +
            '</article>'
          );
        }).join('') +
        '</div>' +
      '</div>';
  }

  /* ---------------- reviews view ---------------- */

  starsHTML(rating) {
    let html = '';
    for (let i = 1; i <= 5; i++) {
      html += '<i class="fa-' + (i <= Math.round(rating) ? 'solid' : 'regular') + ' fa-star"></i>';
    }
    return html;
  }

  reviewCardHTML(r) {
    const initial = (r.userName || '?').trim().charAt(0).toUpperCase();
    return (
      '<article class="review-card">' +
        '<div class="review-header">' +
          '<div class="review-user-info">' +
            '<span class="review-avatar">' + esc(initial) + '</span>' +
            '<span><span class="review-user-name">' + esc(r.userName || '') + '</span>' +
            (r.verified ? ' <span class="verified-badge"><i class="fa-solid fa-circle-check"></i> ' + esc(this.t('verified_customer')) + '</span>' : '') +
            '<br><span class="review-meta">' +
              (r.eventType ? esc(this.eventTypeLabel({ eventType: r.eventType, customEventType: r.customEventType })) + ' · ' : '') +
              (r.createdAt ? esc(fmtDate(String(r.createdAt).slice(0, 10), this.lang)) : '') +
            '</span></span>' +
          '</div>' +
          '<span class="review-stars">' + this.starsHTML(r.rating) + '</span>' +
        '</div>' +
        '<p class="review-comment">' + esc(r.comment || '') + '</p>' +
        (r.ownerReply
          ? '<div class="owner-reply-box"><div class="owner-reply-title">' + esc(this.t('owner_reply_label')) + '</div>' + esc(r.ownerReply) + '</div>'
          : '') +
      '</article>'
    );
  }

  async renderReviews() {
    const view = $('view');
    view.innerHTML = this.loadingStateHTML();
    try {
      const data = await api('/api/reviews');
      this.reviewsData = data;
    } catch (e) {
      if (!this.reviewsData) {
        view.innerHTML = this.errorStateHTML(e.message || this.t('error_loading_msg'));
        return;
      }
      /* keep the cached copy on a refresh failure */
    }
    const { reviews = [], stats = {} } = this.reviewsData;
    const average = Number(stats.average) || 0;
    const total = Number(stats.total) || reviews.length;
    const counts = stats.counts || {};
    const bars = [5, 4, 3, 2, 1].map((star) => {
      const count = Number(counts[star] || counts[String(star)] || 0);
      const pct = total > 0 ? Math.round((count / total) * 100) : 0;
      return (
        '<div class="rating-bar-row"><span style="min-width:28px;">' + star + ' ★</span>' +
        '<div class="rating-bar-bg"><div class="rating-bar-fill" style="width:' + pct + '%;"></div></div>' +
        '<span style="min-width:32px;text-align:right;">' + count + '</span></div>'
      );
    }).join('');

    view.innerHTML =
      '<div class="container page">' +
        '<div class="page-head"><h1>' + esc(this.t('reviews_title')) + '</h1>' +
        '<p>' + esc(this.t('reviews_subtitle')) + '</p></div>' +

        '<div class="rating-overview-card">' +
          '<div class="rating-score-box">' +
            '<div class="rating-score-number">' + (average ? average.toFixed(1) : '—') + '</div>' +
            '<div class="rating-score-stars">' + this.starsHTML(average) + '</div>' +
            '<p class="muted" style="font-size:12px;">' + total + ' ' + esc(this.t('reviews_count')) + '</p>' +
          '</div>' +
          '<div class="rating-bars-container">' + bars + '</div>' +
        '</div>' +

        // Write-a-review form (logged in) or login prompt
        (this.user
          ? '<div class="card" style="margin-bottom:24px;max-width:640px;">' +
            '<h3 style="font-family:var(--font-display);font-size:19px;margin-bottom:4px;">' + esc(this.t('write_review_title')) + '</h3>' +
            '<form id="review-form" novalidate>' +
              '<div class="form-error" id="review-form-error"></div>' +
              '<label class="form-label" style="text-align:center;display:block;">' + esc(this.t('your_rating_label')) + '</label>' +
              '<div class="star-rating-selector" id="review-star-picker">' +
                [1, 2, 3, 4, 5].map((n) =>
                  '<i class="fa-solid fa-star' + (n <= this.reviewRating ? ' selected' : '') + '" data-action="set-rating" data-value="' + n + '"></i>').join('') +
              '</div>' +
              '<div class="form-group"><label class="form-label" for="review-event-type">' + esc(this.t('event_type_label')) + '</label>' +
                '<select id="review-event-type" class="form-input">' + this.eventTypeOptionsHTML('') + '</select></div>' +
              '<div class="form-group"><label class="form-label" for="review-comment">' + esc(this.t('review_comment_label')) + '</label>' +
                '<textarea id="review-comment" class="form-input" placeholder="' + esc(this.t('review_comment_placeholder')) + '"></textarea></div>' +
              '<button type="submit" class="btn btn-primary" id="review-submit-btn"><i class="fa-solid fa-paper-plane"></i> ' + esc(this.t('submit_review_btn')) + '</button>' +
            '</form>' +
            '</div>'
          : '<div class="card" style="margin-bottom:24px;max-width:640px;display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;">' +
            '<p class="muted">' + esc(this.t('login_to_review_msg')) + '</p>' +
            '<a href="#/login" class="btn btn-primary btn-sm">' + esc(this.t('login_btn')) + '</a>' +
            '</div>') +

        (reviews.length
          ? '<div class="reviews-grid">' + reviews.map((r) => this.reviewCardHTML(r)).join('') + '</div>'
          : this.emptyStateHTML('fa-star', this.t('reviews_title'), this.t('no_reviews_msg'))) +
      '</div>';

    const form = $('review-form');
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        this.submitReview();
      });
    }
  }

  setReviewRating(value) {
    this.reviewRating = Math.max(1, Math.min(5, value || 5));
    document.querySelectorAll('#review-star-picker i').forEach((star, i) => {
      star.classList.toggle('selected', i < this.reviewRating);
    });
  }

  async submitReview() {
    const comment = ($('review-comment') && $('review-comment').value.trim()) || '';
    const eventType = ($('review-event-type') && $('review-event-type').value) || '';
    const errorEl = $('review-form-error');
    const submitBtn = $('review-submit-btn');
    if (errorEl) { errorEl.classList.remove('show'); errorEl.textContent = ''; }
    if (!comment) {
      if (errorEl) { errorEl.textContent = this.t('review_comment_label'); errorEl.classList.add('show'); }
      return;
    }
    if (submitBtn) submitBtn.disabled = true;
    try {
      await api('/api/reviews', {
        method: 'POST',
        body: { rating: this.reviewRating, eventType: eventType || undefined, comment }
      });
      this.showToast(this.t('review_submitted_msg'), 'success');
      this.reviewRating = 5;
      this.route(true);
    } catch (e) {
      if (e.code === 'unauthorized') {
        this.requireLogin('#/reviews');
      } else if (errorEl) {
        errorEl.textContent = e.message || this.t('error_loading_msg');
        errorEl.classList.add('show');
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  /* ---------------- settings / profile view ---------------- */

  async renderSettings() {
    const view = $('view');
    if (!this.user) {
      this.requireLogin('#/settings');
      return;
    }
    view.innerHTML = this.loadingStateHTML();
    let profile = this.user;
    try {
      const data = await api('/api/profile');
      if (data.user) profile = data.user;
      else if (data.profile) profile = data.profile;
      this.user = profile;
      this.updateAuthUI();
    } catch (e) {
      if (e.code === 'unauthorized') { this.requireLogin('#/settings'); return; }
      /* fall back to the cached session user */
    }

    view.innerHTML =
      '<div class="container page"><div class="settings-wrap">' +
        '<div class="page-head"><h1>' + esc(this.t('profile_title')) + '</h1></div>' +
        '<div class="glass-card profile-card">' +
          '<i class="fa-solid fa-circle-user"></i>' +
          '<div><h3 style="font-size:18px;">' + esc(profile.name || '') + '</h3>' +
          '<p class="muted" style="font-size:14px;">+91 ' + esc(profile.phone || '') + '</p></div>' +
        '</div>' +
        '<form id="settings-form" class="card" novalidate style="margin-bottom:20px;">' +
          '<div class="form-error" id="settings-error"></div>' +
          '<div class="form-success" id="settings-success"></div>' +
          '<div class="form-group"><label class="form-label" for="settings-name">' + esc(this.t('name_label')) + '</label>' +
            '<input type="text" id="settings-name" class="form-input" value="' + esc(profile.name || '') + '" minlength="3" required></div>' +
          '<div class="form-group"><label class="form-label" for="settings-phone">' + esc(this.t('phone_label')) + '</label>' +
            '<input type="tel" id="settings-phone" class="form-input" value="' + esc(profile.phone || '') + '" readonly></div>' +
          '<button type="submit" class="btn btn-primary" id="settings-save-btn"><i class="fa-solid fa-floppy-disk"></i> ' + esc(this.t('save_profile_btn')) + '</button>' +
        '</form>' +
        '<div class="settings-list">' +
          '<div class="settings-row"><div class="settings-left"><i class="fa-solid fa-language"></i><span>' + esc(this.t('language_label')) + '</span></div>' +
            '<div class="lang-switcher">' +
              '<button type="button" class="lang-btn" data-action="set-lang" data-lang="en">EN</button>' +
              '<button type="button" class="lang-btn" data-action="set-lang" data-lang="te">తెలుగు</button>' +
              '<button type="button" class="lang-btn" data-action="set-lang" data-lang="hi">हिन्दी</button>' +
            '</div></div>' +
          '<div class="settings-row"><div class="settings-left"><i class="fa-solid fa-moon"></i><span>' + esc(this.t('dark_mode_label')) + '</span></div>' +
            '<label class="switch"><input type="checkbox" id="settings-dark-toggle"' + (this.darkMode ? ' checked' : '') + '><span class="slider"></span></label></div>' +
          '<div class="settings-row"><div class="settings-left"><i class="fa-solid fa-calendar-check"></i><span>' + esc(this.t('nav_bookings')) + '</span></div>' +
            '<a href="#/bookings" class="btn btn-sm btn-secondary">' + esc(this.t('nav_bookings')) + ' <i class="fa-solid fa-arrow-right"></i></a></div>' +
          '<div class="settings-row"><div class="settings-left"><i class="fa-solid fa-right-from-bracket" style="color:var(--error);"></i><span style="color:var(--error);">' + esc(this.t('logout_btn')) + '</span></div>' +
            '<button type="button" class="btn btn-sm btn-danger" data-action="logout">' + esc(this.t('logout_btn')) + '</button></div>' +
        '</div>' +
      '</div></div>';

    this.updateLangButtons();
    const darkToggle = $('settings-dark-toggle');
    if (darkToggle) darkToggle.addEventListener('change', () => this.setDarkMode(darkToggle.checked));
    const form = $('settings-form');
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        this.saveProfile();
      });
    }
  }

  async saveProfile() {
    const nameInput = $('settings-name');
    const errorEl = $('settings-error');
    const successEl = $('settings-success');
    const saveBtn = $('settings-save-btn');
    const name = nameInput ? nameInput.value.trim() : '';
    if (errorEl) { errorEl.classList.remove('show'); errorEl.textContent = ''; }
    if (successEl) successEl.classList.remove('show');
    if (name.length < 3) {
      if (errorEl) { errorEl.textContent = this.t('err_name'); errorEl.classList.add('show'); }
      return;
    }
    if (saveBtn) saveBtn.disabled = true;
    try {
      const data = await api('/api/profile', { method: 'PUT', body: { name, language: this.lang } });
      if (data.user) this.user = data.user;
      else this.user = { ...this.user, name };
      this.updateAuthUI();
      if (successEl) { successEl.textContent = this.t('profile_saved_msg'); successEl.classList.add('show'); }
    } catch (e) {
      if (e.code === 'unauthorized') {
        this.requireLogin('#/settings');
      } else if (errorEl) {
        errorEl.textContent = e.message || this.t('error_loading_msg');
        errorEl.classList.add('show');
      }
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  /* ---------------- login / OTP view ---------------- */

  renderLogin() {
    const view = $('view');
    if (this.user) {
      location.hash = this.consumeReturnTo();
      return;
    }
    view.innerHTML =
      '<div class="container page"><div class="auth-wrap">' +
        '<div class="text-center" style="margin-bottom:20px;">' +
          '<img src="assets/logo.jpg" alt="Sai Jyothsna logo" class="auth-logo">' +
          '<h1 class="page-title" style="font-size:26px;">' + esc(this.t('login_title')) + '</h1>' +
          '<p class="muted" style="font-size:14px;">' + esc(this.t('login_sub')) + '</p>' +
        '</div>' +
        '<div class="glass-card">' +
          '<div class="form-error" id="login-error"></div>' +
          // Step 1: name + phone
          '<div id="login-step-profile">' +
            '<div class="form-group"><label class="form-label" for="login-name">' + esc(this.t('name_label')) + '</label>' +
              '<input type="text" id="login-name" class="form-input" placeholder="' + esc(this.t('name_placeholder')) + '" minlength="3" required>' +
              '<div class="error-msg" id="login-name-error">' + esc(this.t('err_name')) + '</div></div>' +
            '<div class="form-group"><label class="form-label" for="login-phone">' + esc(this.t('phone_label')) + '</label>' +
              '<input type="tel" id="login-phone" class="form-input" placeholder="' + esc(this.t('phone_placeholder')) + '" inputmode="numeric" maxlength="10" required>' +
              '<div class="error-msg" id="login-phone-error">' + esc(this.t('err_phone')) + '</div></div>' +
            '<button type="button" class="btn btn-primary btn-block" id="btn-send-otp"><i class="fa-solid fa-paper-plane"></i> ' + esc(this.t('send_otp_btn')) + '</button>' +
          '</div>' +
          // Step 2: 6-digit OTP
          '<div id="login-step-otp" style="display:none;">' +
            '<p class="text-center muted" style="font-size:13px;">' + esc(this.t('otp_subtitle')) +
              ' <strong id="otp-target-number">+91 XXXXXXXXXX</strong></p>' +
            '<div class="otp-container" id="otp-container">' +
              [1, 2, 3, 4, 5, 6].map((n) =>
                '<input type="text" inputmode="numeric" maxlength="1" class="otp-box" id="otp-' + n + '" autocomplete="one-time-code">').join('') +
            '</div>' +
            '<div class="otp-timer">' +
              '<span id="otp-timer-text">' + esc(this.t('resend_otp')) + ' <strong id="otp-timer-sec">' + OTP_COOLDOWN_SECONDS + '</strong>s</span>' +
              '<button type="button" class="link-btn" id="btn-resend-otp" style="display:none;">' + esc(this.t('resend_now')) + '</button>' +
            '</div>' +
            '<button type="button" class="btn btn-gold btn-block" id="btn-verify-otp">' + esc(this.t('otp_verify_btn')) + '</button>' +
            '<button type="button" class="text-link" id="btn-change-phone"><i class="fa-solid fa-arrow-left"></i> ' + esc(this.t('change_phone_btn')) + '</button>' +
          '</div>' +
        '</div>' +
        '<a href="#/home" class="text-link">' + esc(this.t('continue_guest_btn')) + ' <i class="fa-solid fa-arrow-right"></i></a>' +
      '</div></div>';

    $('btn-send-otp').addEventListener('click', () => this.requestOtp());
    $('btn-resend-otp').addEventListener('click', () => this.requestOtp(true));
    $('btn-verify-otp').addEventListener('click', () => this.verifyOtp());
    $('btn-change-phone').addEventListener('click', () => this.resetLoginFlow());
    $('login-phone').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.requestOtp(); });
    $('login-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.requestOtp(); });

    // OTP boxes: auto-advance, backspace goes back, paste fills all six.
    for (let n = 1; n <= 6; n++) {
      const box = $('otp-' + n);
      box.addEventListener('input', () => {
        box.value = box.value.replace(/[^0-9]/g, '').slice(0, 1);
        if (box.value && n < 6) $('otp-' + (n + 1)).focus();
        if (n === 6 && box.value) this.verifyOtp();
      });
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !box.value && n > 1) $('otp-' + (n - 1)).focus();
      });
      box.addEventListener('paste', (e) => {
        e.preventDefault();
        const text = ((e.clipboardData || window.clipboardData).getData('text') || '').replace(/[^0-9]/g, '').slice(0, 6);
        for (let i = 0; i < 6; i++) {
          const target = $('otp-' + (i + 1));
          if (target) target.value = text[i] || '';
        }
        if (text.length === 6) this.verifyOtp();
        else if (text.length) $('otp-' + Math.min(text.length + 1, 6)).focus();
      });
    }
  }

  showLoginError(message) {
    const el = $('login-error');
    if (!el) return;
    el.textContent = message;
    el.classList.add('show');
  }

  hideLoginError() {
    const el = $('login-error');
    if (el) el.classList.remove('show');
  }

  async requestOtp(isResend) {
    this.hideLoginError();
    const nameInput = $('login-name');
    const phoneInput = $('login-phone');
    const nameErr = $('login-name-error');
    const phoneErr = $('login-phone-error');
    const name = nameInput ? nameInput.value.trim() : this.otpName || '';
    const phone = phoneInput ? phoneInput.value.trim() : this.otpPhone || '';
    let valid = true;
    if (name.length < 3) { if (nameErr) nameErr.classList.add('show'); valid = false; }
    else if (nameErr) nameErr.classList.remove('show');
    if (!/^[6-9][0-9]{9}$/.test(phone)) { if (phoneErr) phoneErr.classList.add('show'); valid = false; }
    else if (phoneErr) phoneErr.classList.remove('show');
    if (!valid) return;

    this.otpName = name;
    this.otpPhone = phone;
    const sendBtn = isResend ? $('btn-resend-otp') : $('btn-send-otp');
    if (sendBtn) sendBtn.disabled = true;
    try {
      const data = await api('/api/auth/request-otp', { method: 'POST', body: { phone, name } });
      const profileStep = $('login-step-profile');
      const otpStep = $('login-step-otp');
      if (profileStep) profileStep.style.display = 'none';
      if (otpStep) otpStep.style.display = '';
      const target = $('otp-target-number');
      if (target) target.textContent = '+91 ' + phone;
      const firstBox = $('otp-1');
      if (firstBox) firstBox.focus();
      this.startOtpCountdown(Number(data.cooldownSeconds) || OTP_COOLDOWN_SECONDS);
      this.showToast(this.t('otp_sent_msg'), 'success');
    } catch (e) {
      this.showLoginError(e.message || this.t('error_loading_msg'));
    } finally {
      if (sendBtn) sendBtn.disabled = false;
    }
  }

  startOtpCountdown(seconds) {
    this.stopOtpCountdown();
    this.otpSeconds = seconds;
    const timerText = $('otp-timer-text');
    const timerSec = $('otp-timer-sec');
    const resendBtn = $('btn-resend-otp');
    const tick = () => {
      if (this.otpSeconds <= 0) {
        this.stopOtpCountdown();
        if (timerText) timerText.style.display = 'none';
        if (resendBtn) resendBtn.style.display = '';
        return;
      }
      if (timerSec) timerSec.textContent = String(this.otpSeconds);
      if (timerText) timerText.style.display = '';
      if (resendBtn) resendBtn.style.display = 'none';
      this.otpSeconds -= 1;
    };
    tick();
    this.otpTimer = setInterval(tick, 1000);
  }

  stopOtpCountdown() {
    if (this.otpTimer) { clearInterval(this.otpTimer); this.otpTimer = null; }
  }

  resetLoginFlow() {
    this.stopOtpCountdown();
    const profileStep = $('login-step-profile');
    const otpStep = $('login-step-otp');
    if (profileStep) profileStep.style.display = '';
    if (otpStep) otpStep.style.display = 'none';
    for (let n = 1; n <= 6; n++) {
      const box = $('otp-' + n);
      if (box) box.value = '';
    }
    this.hideLoginError();
  }

  async verifyOtp() {
    this.hideLoginError();
    let code = '';
    for (let n = 1; n <= 6; n++) {
      const box = $('otp-' + n);
      code += box ? box.value : '';
    }
    if (code.length !== 6) {
      this.showLoginError(this.t('otp_invalid_msg'));
      return;
    }
    const verifyBtn = $('btn-verify-otp');
    if (verifyBtn) verifyBtn.disabled = true;
    try {
      const data = await api('/api/auth/verify-otp', {
        method: 'POST',
        body: { phone: this.otpPhone, code }
      });
      this.user = data.user || null;
      this.stopOtpCountdown();
      this.updateAuthUI();
      this.showToast(this.t('login_success_msg'), 'success');
      location.hash = this.consumeReturnTo();
    } catch (e) {
      if (e.code === 'invalid_otp' || e.code === 'invalid_code') {
        this.showLoginError(this.t('otp_invalid_msg'));
      } else if (e.code === 'expired_otp' || e.code === 'otp_expired') {
        this.showLoginError(this.t('otp_expired_msg'));
      } else {
        this.showLoginError(e.message || this.t('error_loading_msg'));
      }
    } finally {
      if (verifyBtn) verifyBtn.disabled = false;
    }
  }

  async logout() {
    const confirmed = await this.showDialog({
      title: this.t('logout_btn'),
      body: this.t('logout_confirm_msg'),
      okText: this.t('logout_btn'),
      cancelText: this.t('cancel_btn')
    });
    if (!confirmed) return;
    try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { /* session may already be gone */ }
    this.user = null;
    this.bookingsCache = null;
    this.updateAuthUI();
    this.showToast(this.t('logout_btn'), 'success');
    location.hash = '#/home';
  }
}

/* ============================== Bootstrap ============================== */

const app = new ApplicationController();
window.app = app;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => app.init());
} else {
  app.init();
}
