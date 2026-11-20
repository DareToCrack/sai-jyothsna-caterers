/* Admin Portal — Sai Jyothsna Caterers & Suppliers
   Vanilla JS. All data comes from the same-origin admin API (see contract in
   the task brief). No mock data, no Firebase, no hardcoded credentials. */

'use strict';

/* ============================== Helpers ============================== */

const $ = (id) => document.getElementById(id);

/** Escape text before inserting into HTML. Never interpolate raw API/user text. */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function money(n) {
  const num = Number(n);
  return '₹' + (Number.isFinite(num) ? num : 0).toLocaleString('en-IN');
}

function num(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

/** 'YYYY-MM-DD' -> '20 Nov 2026' (parsed as a local date to avoid TZ shifts). */
function fmtDate(value) {
  if (!value) return '—';
  const s = String(value);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** ISO timestamp -> '20 Nov 2026, 5:30 pm'. */
function fmtDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** 'YYYY-MM' -> 'Nov 2026'. */
function fmtMonth(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return String(value || '—');
  const d = new Date(Number(m[1]), Number(m[2]) - 1, 1);
  return d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
}

/** Prettify an event-type key: 'fn_wedding' -> 'Wedding'; plain text passes through. */
function eventLabel(booking) {
  if (!booking) return '—';
  if (booking.eventType === 'other' || booking.eventType === 'fn_other') {
    return booking.customEventType || 'Other';
  }
  const t = String(booking.eventType || '');
  return t.replace(/^fn_/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) || '—';
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function waLink(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  const withCountry = digits.startsWith('91') && digits.length > 10 ? digits : '91' + digits;
  return 'https://wa.me/' + withCountry;
}

/* ============================== API client ============================== */

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function getCsrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)sjc_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : '';
}

/**
 * Single API helper: same-origin cookies, CSRF header on writes, JSON parsing,
 * throws ApiError carrying the server message. On 401 it shows the login screen.
 */
async function api(path, { method = 'GET', body = null, formData = null, noAuthRedirect = false } = {}) {
  const headers = {};
  const opts = { method, credentials: 'same-origin', headers };
  if (formData) {
    opts.body = formData; // browser sets the multipart boundary
  } else if (body !== null) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  if (method !== 'GET' && method !== 'HEAD') {
    const token = getCsrfToken();
    if (token) headers['X-CSRF-Token'] = token;
  }

  let res;
  try {
    res = await fetch(path, opts);
  } catch (err) {
    throw new ApiError(0, 'Could not reach the server. Please check your connection and try again.');
  }

  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch (e) { /* non-JSON body */ }
  }

  if (res.status === 401) {
    // Auth calls (login / forgot / change-password / initial /me check) handle
    // 401 themselves so the server message can be shown instead of a redirect.
    if (!noAuthRedirect) showLogin('Your session expired. Please sign in again.');
    throw new ApiError(401, (data && (data.message || data.error)) || 'Session expired');
  }
  if (!res.ok || (data && data.ok === false)) {
    const message = (data && (data.message || data.error)) || `Request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }
  return data || {};
}

/* ============================== State ============================== */

const state = {
  admin: null,
  section: 'dashboard',
  categories: [],        // GET /api/admin/categories
  categoryMap: {},       // id -> category
  items: [],
  bookings: [],
  customers: [],
  inquiries: [],
  reviews: [],
  currentBooking: null,
  currentInquiry: null,
  itemImageFile: null,
  loaded: {},            // section -> true once loaded (for lazy loading)
};

const SECTION_TITLES = {
  dashboard: 'Dashboard',
  bookings: 'Bookings',
  items: 'Menu Items',
  categories: 'Categories',
  services: 'Services',
  customers: 'Customers',
  inquiries: 'Inquiries',
  reviews: 'Reviews',
  settings: 'Business Settings',
  admins: 'Admins',
  outbox: 'Outbox',
  audit: 'Audit Log',
};

/* ============================== UI primitives ============================== */

function showToast(message, type = 'success') {
  const container = $('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast' + (type === 'error' ? ' toast-error' : '');
  const icon = document.createElement('i');
  icon.className = type === 'error' ? 'fa-solid fa-circle-exclamation' : 'fa-solid fa-circle-check';
  const span = document.createElement('span');
  span.textContent = message;
  toast.appendChild(icon);
  toast.appendChild(span);
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4500);
}

function setLoading(id, show) {
  const el = $(id);
  if (el) el.hidden = !show;
}

function hideAlert(id) {
  const el = $(id);
  if (el) { el.hidden = true; el.textContent = ''; }
}

function showInlineError(id, message) {
  const el = $(id);
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}

/** Section error banner with a Retry button wired to the given callback. */
function showSectionError(id, message, retryFn) {
  const el = $(id);
  if (!el) return;
  el.innerHTML = '';
  el.appendChild(document.createTextNode(message + ' '));
  if (typeof retryFn === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'retry-link';
    btn.textContent = 'Retry';
    btn.addEventListener('click', retryFn);
    el.appendChild(btn);
  }
  el.hidden = false;
}

function openModal(id) {
  const el = $(id);
  if (el) el.classList.add('active');
}

function closeModal(id) {
  const el = $(id);
  if (el) el.classList.remove('active');
}

function closeAllModals() {
  document.querySelectorAll('.modal-overlay.active').forEach((m) => m.classList.remove('active'));
}

/** Styled confirm dialog. Resolves true when the user confirms. */
let confirmResolver = null;
function confirmDialog(title, message, okLabel = 'Confirm') {
  return new Promise((resolve) => {
    confirmResolver = resolve;
    $('confirm-modal-title').textContent = title;
    $('confirm-modal-message').textContent = message;
    $('confirm-ok-btn').textContent = okLabel;
    openModal('confirm-modal');
  });
}
function resolveConfirm(value) {
  closeModal('confirm-modal');
  if (confirmResolver) {
    const r = confirmResolver;
    confirmResolver = null;
    r(value);
  }
}

function setBusy(button, busy, busyLabel) {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.innerHTML;
    button.innerHTML = '<span class="spinner" style="width:14px;height:14px;border-width:2px;"></span> ' + esc(busyLabel || 'Please wait…');
    button.disabled = true;
  } else {
    if (button.dataset.label) button.innerHTML = button.dataset.label;
    button.disabled = false;
  }
}

/* ============================== Auth / views ============================== */

function showAuthForm(formId) {
  ['login-form', 'forgot-form', 'change-password-form'].forEach((id) => {
    $(id).hidden = id !== formId;
  });
}

function showLogin(message) {
  state.admin = null;
  $('portal-view').hidden = true;
  $('auth-view').hidden = false;
  closeAllModals();
  showAuthForm('login-form');
  hideAlert('login-error');
  hideAlert('login-info');
  if (message) showInlineError('login-error', message);
  const email = $('login-email');
  if (email) email.focus();
}

function showChangePassword() {
  $('portal-view').hidden = true;
  $('auth-view').hidden = false;
  showAuthForm('change-password-form');
  hideAlert('change-password-error');
  $('change-old-password').value = '';
  $('change-new-password').value = '';
  $('change-confirm-password').value = '';
  $('change-old-password').focus();
}

function showPortal() {
  $('auth-view').hidden = true;
  $('portal-view').hidden = false;
  const label = state.admin
    ? (state.admin.name ? `${state.admin.name} (${state.admin.email})` : state.admin.email)
    : 'Admin';
  $('admin-user-label').textContent = label;
  const hashSection = (location.hash || '').replace(/^#\/?/, '');
  showSection(SECTION_TITLES[hashSection] ? hashSection : 'dashboard', { updateHash: false });
}

/** First load: check the session; portal if logged in, login screen otherwise. */
async function checkSession() {
  try {
    const data = await api('/api/admin/auth/me', { noAuthRedirect: true });
    state.admin = data.admin;
    if (state.admin && state.admin.mustChangePassword) {
      showChangePassword();
    } else {
      showPortal();
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      showLogin();
    } else {
      // Server unreachable: still show login with a hint.
      showLogin('Could not reach the server. Please try again.');
    }
  }
}

async function handleLogin(event) {
  event.preventDefault();
  hideAlert('login-error');
  hideAlert('login-info');
  const email = $('login-email').value.trim();
  const password = $('login-password').value;
  if (!email || !password) {
    showInlineError('login-error', 'Please enter your email and password.');
    return;
  }
  const btn = $('login-submit');
  setBusy(btn, true, 'Signing in…');
  try {
    const data = await api('/api/admin/auth/login', {
      method: 'POST',
      body: { email, password },
      noAuthRedirect: true,
    });
    state.admin = data.admin;
    $('login-password').value = '';
    if (state.admin && state.admin.mustChangePassword) {
      showChangePassword();
    } else {
      showToast('Signed in successfully.');
      showPortal();
    }
  } catch (err) {
    if (err instanceof ApiError) {
      showInlineError('login-error', err.message);
    }
    // Note: a failed login is a 401 with the generic server message, shown above.
  } finally {
    setBusy(btn, false);
  }
}

async function handleForgotPassword(event) {
  event.preventDefault();
  hideAlert('forgot-error');
  hideAlert('forgot-info');
  const email = $('forgot-email').value.trim();
  if (!email) {
    showInlineError('forgot-error', 'Please enter your email address.');
    return;
  }
  const btn = $('forgot-submit');
  setBusy(btn, true, 'Sending…');
  try {
    const data = await api('/api/admin/auth/forgot-password', {
      method: 'POST',
      body: { email },
      noAuthRedirect: true,
    });
    // Server message may include the CLI-reset hint when resetViaCli is true.
    const info = $('forgot-info');
    info.textContent = data.message || 'If that email belongs to an admin account, reset instructions have been sent.';
    info.hidden = false;
  } catch (err) {
    if (err instanceof ApiError) {
      showInlineError('forgot-error', err.message);
    }
  } finally {
    setBusy(btn, false);
  }
}

async function handleChangePassword(event) {
  event.preventDefault();
  hideAlert('change-password-error');
  const oldPassword = $('change-old-password').value;
  const newPassword = $('change-new-password').value;
  const confirm = $('change-confirm-password').value;
  if (newPassword.length < 8) {
    showInlineError('change-password-error', 'The new password must be at least 8 characters long.');
    return;
  }
  if (newPassword !== confirm) {
    showInlineError('change-password-error', 'The new passwords do not match.');
    return;
  }
  const btn = $('change-password-submit');
  setBusy(btn, true, 'Changing password…');
  try {
    await api('/api/admin/auth/change-password', {
      method: 'POST',
      body: { oldPassword, newPassword },
      noAuthRedirect: true,
    });
    showToast('Password changed successfully.');
    // Re-check the session so mustChangePassword is refreshed.
    const data = await api('/api/admin/auth/me', { noAuthRedirect: true });
    state.admin = data.admin;
    if (state.admin && state.admin.mustChangePassword) {
      showInlineError('change-password-error', 'The password change did not take effect. Please try again.');
      return;
    }
    showPortal();
  } catch (err) {
    if (err instanceof ApiError) {
      showInlineError('change-password-error', err.message);
    }
  } finally {
    setBusy(btn, false);
  }
}

async function handleLogout() {
  try {
    await api('/api/admin/auth/logout', { method: 'POST' });
  } catch (err) {
    // Logout is best-effort; always return to the login screen.
  }
  showLogin();
  showToast('Signed out.');
}

/* ============================== Section switching ============================== */

function showSection(name, { updateHash = true } = {}) {
  if (!SECTION_TITLES[name]) name = 'dashboard';
  state.section = name;
  document.querySelectorAll('.view-section').forEach((s) => s.classList.toggle('active', s.id === 'section-' + name));
  document.querySelectorAll('.sidebar-nav .nav-item').forEach((b) => b.classList.toggle('active', b.dataset.section === name));
  $('section-title').textContent = SECTION_TITLES[name];
  closeSidebar();
  if (updateHash) {
    const target = '#/' + name;
    if (location.hash !== target) history.replaceState(null, '', target);
  }
  loadSection(name);
}

const SECTION_LOADERS = {
  dashboard: loadDashboard,
  bookings: loadBookings,
  items: loadItems,
  categories: loadCategories,
  services: loadServices,
  customers: loadCustomers,
  inquiries: loadInquiries,
  reviews: loadReviews,
  settings: loadSettings,
  admins: loadAdmins,
  outbox: loadOutbox,
  audit: loadAudit,
};

function loadSection(name) {
  const loader = SECTION_LOADERS[name];
  if (loader) loader();
}

function closeSidebar() {
  $('sidebar').classList.remove('open');
  $('sidebar-overlay').classList.remove('visible');
}

/* ============================== Dashboard ============================== */

function statusBadge(status) {
  const s = String(status || '').toLowerCase();
  return `<span class="badge badge-${esc(s)}">${esc(s || '—')}</span>`;
}

function listEmpty(ul, text) {
  ul.innerHTML = `<li class="list-empty">${esc(text)}</li>`;
}

async function loadDashboard() {
  setLoading('dashboard-loading', true);
  $('dashboard-content').hidden = true;
  hideAlert('dashboard-error');
  try {
    const data = await api('/api/admin/dashboard');
    // Ephemeral-storage notice (Vercel demo only): shown at the top of the
    // dashboard unless dismissed earlier in this browser session.
    let noticeDismissed = false;
    try { noticeDismissed = sessionStorage.getItem('sjc-hide-ephemeral-notice') === '1'; } catch { /* ignore */ }
    $('dashboard-ephemeral-notice').hidden = !(data.ephemeral === true && !noticeDismissed);
    const stats = data.stats || {};
    const byStatus = stats.bookingsByStatus || {};
    $('stat-bookings-total').textContent = num(stats.bookingsTotal);
    $('stat-bookings-pending').textContent = num(byStatus.pending);
    $('stat-bookings-confirmed').textContent = num(byStatus.confirmed);
    $('stat-bookings-completed').textContent = num(byStatus.completed);
    $('stat-bookings-cancelled').textContent = num(byStatus.cancelled);
    $('stat-revenue').textContent = money(stats.revenueEstimate);
    $('stat-customers').textContent = num(stats.customersTotal);
    $('stat-inquiries').textContent = num(stats.inquiriesPending);
    $('stat-items').textContent = num(stats.itemsTotal);
    $('stat-services').textContent = num(stats.servicesTotal);

    // Recent bookings (5)
    const recentBody = $('dashboard-recent-bookings');
    const recent = Array.isArray(data.recentBookings) ? data.recentBookings.slice(0, 5) : [];
    if (recent.length === 0) {
      recentBody.innerHTML = '<tr><td colspan="6" class="cell-muted">No bookings yet.</td></tr>';
    } else {
      recentBody.innerHTML = recent.map((b) => `
        <tr class="row-link" data-booking-id="${esc(b.id)}">
          <td class="cell-nowrap"><strong>${esc(b.quoteNumber || b.id)}</strong></td>
          <td>${esc(b.customerName)}<br><span class="cell-muted">${esc(b.customerPhone || '')}</span></td>
          <td>${esc(eventLabel(b))}</td>
          <td class="cell-nowrap">${esc(fmtDate(b.eventDate))}</td>
          <td class="cell-nowrap">${esc(money(b.grandTotal))}</td>
          <td>${statusBadge(b.status)}</td>
        </tr>`).join('');
      recentBody.querySelectorAll('tr[data-booking-id]').forEach((tr) => {
        tr.addEventListener('click', () => openBookingDetail(tr.dataset.bookingId));
      });
    }

    // Pending inquiries
    const inqList = $('dashboard-pending-inquiries');
    const inqs = Array.isArray(data.recentInquiries) ? data.recentInquiries : [];
    if (inqs.length === 0) {
      listEmpty(inqList, 'No pending inquiries.');
    } else {
      inqList.innerHTML = inqs.map((q) => `
        <li>
          <span><strong>${esc(q.name || '—')}</strong><br><span class="list-sub">${esc(eventLabel(q))} · ${esc(fmtDate(q.eventDate))}</span></span>
          <button type="button" class="btn btn-xs btn-secondary" data-inquiry-id="${esc(q.id)}">View</button>
        </li>`).join('');
      inqList.querySelectorAll('button[data-inquiry-id]').forEach((btn) => {
        btn.addEventListener('click', () => openInquiryDetail(btn.dataset.inquiryId));
      });
    }

    // Monthly revenue
    const revList = $('dashboard-monthly-revenue');
    const monthly = Array.isArray(data.monthlyRevenue) ? data.monthlyRevenue : [];
    if (monthly.length === 0) {
      listEmpty(revList, 'No revenue recorded yet.');
    } else {
      revList.innerHTML = monthly.map((r) => `
        <li><span>${esc(fmtMonth(r.month))}</span><strong>${esc(money(r.total))}</strong></li>`).join('');
    }

    // Popular items (top 5)
    const popList = $('dashboard-popular-items');
    const popular = Array.isArray(data.popularItems) ? data.popularItems.slice(0, 5) : [];
    if (popular.length === 0) {
      listEmpty(popList, 'No items ordered yet.');
    } else {
      popList.innerHTML = popular.map((p) => `
        <li><span>${esc(p.name)}</span><strong>${esc(num(p.count))} times</strong></li>`).join('');
    }

    // Upcoming events (next 5)
    const upList = $('dashboard-upcoming-events');
    const upcoming = Array.isArray(data.upcomingEvents) ? data.upcomingEvents.slice(0, 5) : [];
    if (upcoming.length === 0) {
      listEmpty(upList, 'No upcoming events scheduled.');
    } else {
      upList.innerHTML = upcoming.map((b) => `
        <li>
          <span><strong>${esc(fmtDate(b.eventDate))}</strong> — ${esc(eventLabel(b))} (${esc(b.customerName || '—')})</span>
          <strong>${esc(num(b.guests))} guests</strong>
        </li>`).join('');
    }

    $('dashboard-content').hidden = false;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    showSectionError('dashboard-error', err.message || 'Failed to load the dashboard.', loadDashboard);
  } finally {
    setLoading('dashboard-loading', false);
  }
}

/* ============================== Bookings ============================== */

function bookingQueryParams() {
  const params = new URLSearchParams();
  const q = $('bookings-search').value.trim();
  const status = $('bookings-status-filter').value;
  const from = $('bookings-from').value;
  const to = $('bookings-to').value;
  if (q) params.set('q', q);
  if (status) params.set('status', status);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  return params.toString();
}

async function loadBookings() {
  setLoading('bookings-loading', true);
  hideAlert('bookings-error');
  $('bookings-empty').hidden = true;
  try {
    const qs = bookingQueryParams();
    const data = await api('/api/admin/bookings' + (qs ? '?' + qs : ''));
    const list = Array.isArray(data.bookings) ? data.bookings : [];
    state.bookings = list;
    const body = $('bookings-table-body');
    if (list.length === 0) {
      body.innerHTML = '';
      $('bookings-empty').hidden = false;
    } else {
      body.innerHTML = list.map((b) => `
        <tr>
          <td class="cell-nowrap"><strong>${esc(b.quoteNumber || b.id)}</strong></td>
          <td>${esc(b.customerName)}<br><span class="cell-muted">${esc(b.customerPhone || '')}</span></td>
          <td>${esc(eventLabel(b))}</td>
          <td class="cell-nowrap">${esc(fmtDate(b.eventDate))}</td>
          <td>${esc(num(b.guests))}</td>
          <td class="cell-nowrap">${esc(money(b.grandTotal))}</td>
          <td>${statusBadge(b.status)}</td>
          <td class="cell-actions"><button type="button" class="btn btn-xs btn-secondary" data-booking-id="${esc(b.id)}">View</button></td>
        </tr>`).join('');
      body.querySelectorAll('button[data-booking-id]').forEach((btn) => {
        btn.addEventListener('click', () => openBookingDetail(btn.dataset.bookingId));
      });
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    showSectionError('bookings-error', err.message || 'Failed to load bookings.', loadBookings);
  } finally {
    setLoading('bookings-loading', false);
  }
}

function bookingAddress(b) {
  const parts = [b.venueAddress, b.landmark, b.city, b.district, b.state, b.pincode]
    .map((p) => String(p || '').trim())
    .filter(Boolean);
  return parts.join(', ') || '—';
}

async function openBookingDetail(id) {
  const modalBody = $('booking-modal-body');
  $('booking-modal-title').textContent = 'Booking';
  modalBody.innerHTML = '<div class="loading-row"><span class="spinner"></span> Loading booking…</div>';
  $('booking-print-link').href = '#';
  openModal('booking-modal');
  try {
    const data = await api('/api/admin/bookings/' + encodeURIComponent(id));
    const b = data.booking || data;
    state.currentBooking = b;
    $('booking-modal-title').textContent = 'Quotation ' + (b.quoteNumber || b.id);
    $('booking-print-link').href = '/api/quotations/' + encodeURIComponent(b.id);

    const items = Array.isArray(b.items) ? b.items : [];
    const services = Array.isArray(b.services) ? b.services : [];
    const itemRows = items.length === 0
      ? '<tr><td colspan="4" class="cell-muted">No menu items selected.</td></tr>'
      : items.map((it) => {
          const qty = it.qtyIsGuests ? num(b.guests) : num(it.quantity, 1);
          return `<tr>
            <td>${esc(it.itemName)}</td>
            <td class="num">${esc(money(it.unitPrice))}</td>
            <td class="num">${it.qtyIsGuests ? esc(num(b.guests)) + ' guests' : esc(qty)}</td>
            <td class="num">${esc(money(it.lineTotal ?? num(it.unitPrice) * qty))}</td>
          </tr>`;
        }).join('');
    const serviceRows = services.length === 0
      ? '<tr><td colspan="4" class="cell-muted">No services selected.</td></tr>'
      : services.map((s) => `<tr>
          <td>${esc(s.serviceName)}</td>
          <td class="num">${esc(money(s.unitPrice))}</td>
          <td class="num">${esc(num(s.quantity, 1))}</td>
          <td class="num">${esc(money(s.total ?? num(s.unitPrice) * num(s.quantity, 1)))}</td>
        </tr>`).join('');

    const statuses = ['pending', 'confirmed', 'completed', 'cancelled'];
    modalBody.innerHTML = `
      <div class="detail-grid">
        <p><span class="detail-label">Customer</span>${esc(b.customerName)}<br><span class="cell-muted">${esc(b.customerPhone || '')}</span></p>
        <p><span class="detail-label">Status</span>${statusBadge(b.status)}</p>
        <p><span class="detail-label">Event</span>${esc(eventLabel(b))}</p>
        <p><span class="detail-label">Event date</span>${esc(fmtDate(b.eventDate))}</p>
        <p><span class="detail-label">Guests</span>${esc(num(b.guests))}</p>
        <p><span class="detail-label">Booked on</span>${esc(fmtDateTime(b.createdAt))}</p>
        <p style="grid-column: 1 / -1;"><span class="detail-label">Venue</span>${esc(bookingAddress(b))}</p>
        ${b.notes ? `<p style="grid-column: 1 / -1;"><span class="detail-label">Notes</span>${esc(b.notes)}</p>` : ''}
      </div>

      <h4 class="detail-section-title">Menu Items</h4>
      <table class="bill-table">
        <thead><tr><th>Item</th><th class="num">Price</th><th class="num">Qty</th><th class="num">Total</th></tr></thead>
        <tbody>${itemRows}</tbody>
      </table>

      <h4 class="detail-section-title">Services</h4>
      <table class="bill-table">
        <thead><tr><th>Service</th><th class="num">Unit Price</th><th class="num">Qty</th><th class="num">Total</th></tr></thead>
        <tbody>${serviceRows}</tbody>
      </table>

      <h4 class="detail-section-title">Billing Breakdown</h4>
      <table class="bill-table">
        <tbody>
          <tr><td>Food total</td><td class="num">${esc(money(b.foodTotal))}</td></tr>
          <tr><td>Services total</td><td class="num">${esc(money(b.servicesTotal))}</td></tr>
          <tr><td>Transport</td><td class="num">${esc(money(b.transportTotal))}</td></tr>
          <tr><td>Service charge${b.serviceChargeRate != null ? ` (${esc(num(b.serviceChargeRate))}%)` : ''}</td><td class="num">${esc(money(b.serviceCharge))}</td></tr>
          <tr><td>GST${b.taxRate != null ? ` (${esc(num(b.taxRate))}%)` : ''}</td><td class="num">${esc(money(b.gstAmount))}</td></tr>
          <tr class="total-row"><td>Grand total</td><td class="num">${esc(money(b.grandTotal))}</td></tr>
        </tbody>
      </table>

      <div class="booking-status-form">
        <div id="booking-update-error" class="alert alert-error" hidden></div>
        <label class="form-label" for="booking-status-select">Change status</label>
        <select id="booking-status-select" class="form-input">
          ${statuses.map((s) => `<option value="${s}"${s === b.status ? ' selected' : ''}>${s.charAt(0).toUpperCase() + s.slice(1)}</option>`).join('')}
        </select>
        <label class="form-label" for="booking-notes-input">Notes</label>
        <textarea id="booking-notes-input" class="form-input" rows="2">${esc(b.notes || '')}</textarea>
        <button type="button" id="booking-save-btn" class="btn btn-primary" style="margin-top:12px;">Save Changes</button>
      </div>`;

    $('booking-save-btn').addEventListener('click', saveBookingChanges);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    modalBody.innerHTML = `<div class="alert alert-error">${esc(err.message || 'Failed to load this booking.')}</div>`;
  }
}

async function saveBookingChanges() {
  const b = state.currentBooking;
  if (!b) return;
  const status = $('booking-status-select').value;
  const notes = $('booking-notes-input').value.trim();
  hideAlert('booking-update-error');
  const statusChanged = status !== b.status;
  if (statusChanged) {
    const ok = await confirmDialog(
      'Change Status',
      `Change booking ${b.quoteNumber || b.id} from "${b.status}" to "${status}"?`,
      'Change Status'
    );
    if (!ok) return;
  }
  const btn = $('booking-save-btn');
  setBusy(btn, true, 'Saving…');
  try {
    await api('/api/admin/bookings/' + encodeURIComponent(b.id), {
      method: 'PATCH',
      body: { status, notes },
    });
    showToast('Booking updated.');
    closeModal('booking-modal');
    loadBookings();
    if (state.section === 'dashboard') loadDashboard();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    showInlineError('booking-update-error', err.message || 'Failed to update the booking.');
  } finally {
    setBusy(btn, false);
  }
}

/* ============================== Categories ============================== */

/** Load categories into state + the item-form/filter dropdowns. Shared helper. */
async function fetchCategories() {
  const data = await api('/api/admin/categories');
  const list = Array.isArray(data.categories) ? data.categories : [];
  state.categories = list;
  state.categoryMap = {};
  list.forEach((c) => { state.categoryMap[c.id] = c; });
  return list;
}

function categoryName(cat, lang = 'en') {
  if (!cat) return '—';
  if (cat.name && typeof cat.name === 'object') return cat.name[lang] || cat.name.en || '—';
  return cat.nameEn || cat.name || '—';
}

function populateCategorySelects(selectedId = '') {
  const filter = $('items-category-filter');
  const currentFilter = filter.value;
  filter.innerHTML = '<option value="">All categories</option>' + state.categories.map((c) =>
    `<option value="${esc(c.id)}">${esc(categoryName(c))}</option>`).join('');
  filter.value = currentFilter;

  const formSelect = $('item-category');
  formSelect.innerHTML = state.categories.map((c) =>
    `<option value="${esc(c.id)}"${c.id === selectedId ? ' selected' : ''}>${esc(categoryName(c))}</option>`).join('');
}

async function loadCategories() {
  setLoading('categories-loading', true);
  hideAlert('categories-error');
  $('categories-empty').hidden = true;
  try {
    const list = await fetchCategories();
    populateCategorySelects();
    const body = $('categories-table-body');
    if (list.length === 0) {
      body.innerHTML = '';
      $('categories-empty').hidden = false;
    } else {
      body.innerHTML = list.map((c) => {
        const name = (c.name && typeof c.name === 'object') ? c.name : { en: c.nameEn || '', te: c.nameTe || '', hi: c.nameHi || '' };
        const active = c.isActive !== false;
        return `<tr>
          <td>${esc(num(c.orderIndex))}</td>
          <td><strong>${esc(name.en || '—')}</strong></td>
          <td>${esc(name.te || '—')}</td>
          <td>${esc(name.hi || '—')}</td>
          <td><span class="badge ${active ? 'badge-yes' : 'badge-no'}">${active ? 'Active' : 'Inactive'}</span></td>
          <td class="cell-actions">
            <button type="button" class="btn btn-xs btn-secondary" data-edit-category="${esc(c.id)}">Edit</button>
            <button type="button" class="btn btn-xs btn-danger" data-delete-category="${esc(c.id)}" data-category-name="${esc(name.en || '')}">Delete</button>
          </td>
        </tr>`;
      }).join('');
      body.querySelectorAll('button[data-edit-category]').forEach((btn) => {
        btn.addEventListener('click', () => openCategoryForm(btn.dataset.editCategory));
      });
      body.querySelectorAll('button[data-delete-category]').forEach((btn) => {
        btn.addEventListener('click', () => deleteCategory(btn.dataset.deleteCategory, btn.dataset.categoryName));
      });
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    showSectionError('categories-error', err.message || 'Failed to load categories.', loadCategories);
  } finally {
    setLoading('categories-loading', false);
  }
}

function openCategoryForm(id) {
  hideAlert('category-form-error');
  const form = $('category-form');
  form.reset();
  $('category-id').value = '';
  $('category-modal-title').textContent = 'Add Category';
  $('category-is-active').checked = true;
  if (id) {
    const c = state.categoryMap[id];
    if (!c) return;
    $('category-modal-title').textContent = 'Edit Category';
    $('category-id').value = c.id;
    const name = (c.name && typeof c.name === 'object') ? c.name : { en: c.nameEn || '', te: c.nameTe || '', hi: c.nameHi || '' };
    $('category-name-en').value = name.en || '';
    $('category-name-te').value = name.te || '';
    $('category-name-hi').value = name.hi || '';
    $('category-order').value = num(c.orderIndex);
    $('category-is-active').checked = c.isActive !== false;
  }
  openModal('category-modal');
}

async function saveCategory(event) {
  event.preventDefault();
  hideAlert('category-form-error');
  const id = $('category-id').value;
  const nameEn = $('category-name-en').value.trim();
  if (!nameEn) {
    showInlineError('category-form-error', 'Please enter an English category name.');
    return;
  }
  const payload = {
    nameEn,
    nameTe: $('category-name-te').value.trim(),
    nameHi: $('category-name-hi').value.trim(),
    orderIndex: parseInt($('category-order').value, 10) || 0,
    isActive: $('category-is-active').checked,
  };
  const btn = $('category-save-btn');
  setBusy(btn, true, 'Saving…');
  try {
    if (id) {
      await api('/api/admin/categories/' + encodeURIComponent(id), { method: 'PUT', body: payload });
      showToast('Category updated.');
    } else {
      await api('/api/admin/categories', { method: 'POST', body: payload });
      showToast('Category added.');
    }
    closeModal('category-modal');
    loadCategories();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    showInlineError('category-form-error', err.message || 'Failed to save the category.');
  } finally {
    setBusy(btn, false);
  }
}

async function deleteCategory(id, name) {
  const ok = await confirmDialog('Delete Category', `Delete the category "${name || id}"? This cannot be undone.`, 'Delete');
  if (!ok) return;
  try {
    await api('/api/admin/categories/' + encodeURIComponent(id), { method: 'DELETE' });
    showToast('Category deleted.');
    loadCategories();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    // 409 when items still exist in the category — show the server message.
    showToast(err.message || 'Failed to delete the category.', 'error');
  }
}

/* ============================== Menu Items ============================== */

function itemName(item, lang = 'en') {
  if (!item) return '—';
  if (item.name && typeof item.name === 'object') return item.name[lang] || item.name.en || '—';
  return item.nameEn || item.name || '—';
}

function itemDesc(item, lang = 'en') {
  if (!item) return '';
  if (item.desc && typeof item.desc === 'object') return item.desc[lang] || item.desc.en || '';
  return item['desc' + lang.charAt(0).toUpperCase() + lang.slice(1)] || item.descEn || '';
}

function itemImage(item) {
  return item.imageUrl || item.image || '';
}

async function loadItems() {
  setLoading('items-loading', true);
  hideAlert('items-error');
  $('items-empty').hidden = true;
  try {
    if (state.categories.length === 0) {
      try { await fetchCategories(); } catch (e) { /* categories are optional for the list */ }
    }
    populateCategorySelects();
    const params = new URLSearchParams();
    const q = $('items-search').value.trim();
    const cat = $('items-category-filter').value;
    if (q) params.set('search', q);
    if (cat) params.set('categoryId', cat);
    const qs = params.toString();
    const data = await api('/api/admin/items' + (qs ? '?' + qs : ''));
    const list = Array.isArray(data.items) ? data.items : [];
    state.items = list;
    const body = $('items-table-body');
    if (list.length === 0) {
      body.innerHTML = '';
      $('items-empty').hidden = false;
    } else {
      body.innerHTML = list.map((it) => {
        const img = itemImage(it);
        const thumb = img
          ? `<img class="thumb" src="${esc(img)}" alt="">`
          : '<span class="thumb-placeholder"><i class="fa-solid fa-utensils"></i></span>';
        return `<tr>
          <td>${thumb}</td>
          <td><strong>${esc(itemName(it))}</strong></td>
          <td>${esc(categoryName(state.categoryMap[it.categoryId]))}</td>
          <td class="cell-nowrap">${esc(money(it.price))}</td>
          <td><span class="badge ${it.isVeg ? 'badge-veg' : 'badge-nonveg'}">${it.isVeg ? 'Veg' : 'Non-Veg'}</span></td>
          <td><span class="badge ${it.isAvailable !== false ? 'badge-yes' : 'badge-no'}">${it.isAvailable !== false ? 'Yes' : 'No'}</span></td>
          <td class="cell-actions">
            <button type="button" class="btn btn-xs btn-secondary" data-edit-item="${esc(it.id)}">Edit</button>
            <button type="button" class="btn btn-xs btn-danger" data-delete-item="${esc(it.id)}" data-item-name="${esc(itemName(it))}">Delete</button>
          </td>
        </tr>`;
      }).join('');
      body.querySelectorAll('button[data-edit-item]').forEach((btn) => {
        btn.addEventListener('click', () => openItemForm(btn.dataset.editItem));
      });
      body.querySelectorAll('button[data-delete-item]').forEach((btn) => {
        btn.addEventListener('click', () => deleteItem(btn.dataset.deleteItem, btn.dataset.itemName));
      });
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    showSectionError('items-error', err.message || 'Failed to load menu items.', loadItems);
  } finally {
    setLoading('items-loading', false);
  }
}

function resetItemImagePreview() {
  state.itemImageFile = null;
  $('item-image-file').value = '';
  $('item-image-preview').hidden = true;
  $('item-image-preview').src = '';
  $('item-image-status').textContent = 'No image selected';
}

function openItemForm(id) {
  hideAlert('item-form-error');
  const form = $('item-form');
  form.reset();
  resetItemImagePreview();
  $('item-id').value = '';
  $('item-modal-title').textContent = 'Add Menu Item';
  $('item-is-veg').checked = true;
  $('item-is-available').checked = true;
  populateCategorySelects();
  if (id) {
    const it = state.items.find((x) => String(x.id) === String(id));
    if (!it) return;
    $('item-modal-title').textContent = 'Edit Menu Item';
    $('item-id').value = it.id;
    const name = (it.name && typeof it.name === 'object') ? it.name : { en: it.nameEn || '', te: it.nameTe || '', hi: it.nameHi || '' };
    const desc = (it.desc && typeof it.desc === 'object') ? it.desc : { en: it.descEn || '', te: it.descTe || '', hi: it.descHi || '' };
    $('item-name-en').value = name.en || '';
    $('item-name-te').value = name.te || '';
    $('item-name-hi').value = name.hi || '';
    $('item-desc-en').value = desc.en || '';
    $('item-desc-te').value = desc.te || '';
    $('item-desc-hi').value = desc.hi || '';
    $('item-price').value = it.price ?? '';
    $('item-image-url').value = itemImage(it);
    $('item-is-veg').checked = !!it.isVeg;
    $('item-is-available').checked = it.isAvailable !== false;
    populateCategorySelects(it.categoryId);
    const img = itemImage(it);
    if (img) {
      $('item-image-preview').src = img;
      $('item-image-preview').hidden = false;
      $('item-image-status').textContent = 'Current image';
    }
  }
  openModal('item-modal');
}

function handleItemImageFile(input) {
  const file = input.files && input.files[0];
  if (!file) {
    state.itemImageFile = null;
    $('item-image-status').textContent = 'No image selected';
    return;
  }
  state.itemImageFile = file;
  const reader = new FileReader();
  reader.onload = (e) => {
    $('item-image-preview').src = e.target.result;
    $('item-image-preview').hidden = false;
    $('item-image-status').textContent = 'New image selected — will upload on save';
  };
  reader.readAsDataURL(file);
}

async function saveItem(event) {
  event.preventDefault();
  hideAlert('item-form-error');
  const id = $('item-id').value;
  const nameEn = $('item-name-en').value.trim();
  const price = parseFloat($('item-price').value);
  const categoryId = $('item-category').value;
  if (!nameEn) {
    showInlineError('item-form-error', 'Please enter an English item name.');
    return;
  }
  if (!categoryId) {
    showInlineError('item-form-error', 'Please choose a category.');
    return;
  }
  if (!Number.isFinite(price) || price < 0) {
    showInlineError('item-form-error', 'Please enter a valid price.');
    return;
  }
  const payload = {
    categoryId,
    nameEn,
    nameTe: $('item-name-te').value.trim(),
    nameHi: $('item-name-hi').value.trim(),
    descEn: $('item-desc-en').value.trim(),
    descTe: $('item-desc-te').value.trim(),
    descHi: $('item-desc-hi').value.trim(),
    price,
    isVeg: $('item-is-veg').checked,
    isAvailable: $('item-is-available').checked,
    imageUrl: $('item-image-url').value.trim(),
  };
  const btn = $('item-save-btn');
  setBusy(btn, true, 'Saving…');
  try {
    let savedId = id;
    if (id) {
      await api('/api/admin/items/' + encodeURIComponent(id), { method: 'PUT', body: payload });
    } else {
      const data = await api('/api/admin/items', { method: 'POST', body: payload });
      savedId = (data.item && data.item.id) || data.id;
    }
    // Upload a chosen image file after the item is saved.
    if (state.itemImageFile && savedId) {
      const formData = new FormData();
      formData.append('image', state.itemImageFile);
      try {
        await api('/api/admin/items/' + encodeURIComponent(savedId) + '/image', { method: 'POST', formData });
      } catch (uploadErr) {
        if (uploadErr instanceof ApiError && uploadErr.status === 401) throw uploadErr;
        showToast('Item saved, but the image upload failed: ' + uploadErr.message, 'error');
      }
    }
    showToast(id ? 'Menu item updated.' : 'Menu item added.');
    closeModal('item-modal');
    loadItems();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    showInlineError('item-form-error', err.message || 'Failed to save the menu item.');
  } finally {
    setBusy(btn, false);
  }
}

async function deleteItem(id, name) {
  const ok = await confirmDialog('Delete Menu Item', `Delete "${name || id}"? This cannot be undone.`, 'Delete');
  if (!ok) return;
  try {
    await api('/api/admin/items/' + encodeURIComponent(id), { method: 'DELETE' });
    showToast('Menu item deleted.');
    loadItems();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    showToast(err.message || 'Failed to delete the menu item.', 'error');
  }
}

/* ============================== Services ============================== */

function serviceName(srv, lang = 'en') {
  if (!srv) return '—';
  if (srv.name && typeof srv.name === 'object') return srv.name[lang] || srv.name.en || '—';
  return srv.nameEn || srv.name || '—';
}

async function loadServices() {
  setLoading('services-loading', true);
  hideAlert('services-error');
  $('services-empty').hidden = true;
  try {
    const data = await api('/api/admin/services');
    const list = Array.isArray(data.services) ? data.services : [];
    const body = $('services-table-body');
    if (list.length === 0) {
      body.innerHTML = '';
      $('services-empty').hidden = false;
    } else {
      body.innerHTML = list.map((s) => `<tr>
        <td><strong>${esc(serviceName(s))}</strong></td>
        <td>${esc(s.type === 'number' ? 'Number (count adjustable)' : 'Checkbox (flat fee)')}</td>
        <td class="cell-nowrap">${esc(money(s.unitPrice))}</td>
        <td>${s.type === 'number' ? esc(num(s.defaultQuantity, 1)) : '—'}</td>
        <td><span class="badge ${s.isAvailable !== false ? 'badge-yes' : 'badge-no'}">${s.isAvailable !== false ? 'Yes' : 'No'}</span></td>
        <td class="cell-actions">
          <button type="button" class="btn btn-xs btn-secondary" data-edit-service="${esc(s.id)}">Edit</button>
          <button type="button" class="btn btn-xs btn-danger" data-delete-service="${esc(s.id)}" data-service-name="${esc(serviceName(s))}">Delete</button>
        </td>
      </tr>`).join('');
      body.querySelectorAll('button[data-edit-service]').forEach((btn) => {
        btn.addEventListener('click', () => openServiceForm(btn.dataset.editService));
      });
      body.querySelectorAll('button[data-delete-service]').forEach((btn) => {
        btn.addEventListener('click', () => deleteService(btn.dataset.deleteService, btn.dataset.serviceName));
      });
    }
    state.services = list;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    showSectionError('services-error', err.message || 'Failed to load services.', loadServices);
  } finally {
    setLoading('services-loading', false);
  }
}

function openServiceForm(id) {
  hideAlert('service-form-error');
  const form = $('service-form');
  form.reset();
  $('service-id').value = '';
  $('service-modal-title').textContent = 'Add Service';
  $('service-type').value = 'checkbox';
  $('service-default-qty').value = '1';
  $('service-is-available').checked = true;
  if (id) {
    const srv = (state.services || []).find((x) => String(x.id) === String(id));
    if (!srv) return;
    $('service-modal-title').textContent = 'Edit Service';
    $('service-id').value = srv.id;
    const name = (srv.name && typeof srv.name === 'object') ? srv.name : { en: srv.nameEn || '', te: srv.nameTe || '', hi: srv.nameHi || '' };
    $('service-name-en').value = name.en || '';
    $('service-name-te').value = name.te || '';
    $('service-name-hi').value = name.hi || '';
    $('service-type').value = srv.type || 'checkbox';
    $('service-price').value = srv.unitPrice ?? '';
    $('service-default-qty').value = srv.defaultQuantity ?? 1;
    $('service-is-available').checked = srv.isAvailable !== false;
  }
  openModal('service-modal');
}

async function saveService(event) {
  event.preventDefault();
  hideAlert('service-form-error');
  const id = $('service-id').value;
  const nameEn = $('service-name-en').value.trim();
  const unitPrice = parseFloat($('service-price').value);
  if (!nameEn) {
    showInlineError('service-form-error', 'Please enter an English service name.');
    return;
  }
  if (!Number.isFinite(unitPrice) || unitPrice < 0) {
    showInlineError('service-form-error', 'Please enter a valid unit price.');
    return;
  }
  const type = $('service-type').value;
  const payload = {
    nameEn,
    nameTe: $('service-name-te').value.trim(),
    nameHi: $('service-name-hi').value.trim(),
    type,
    unitPrice,
    defaultQuantity: type === 'number' ? (parseInt($('service-default-qty').value, 10) || 1) : 1,
    isAvailable: $('service-is-available').checked,
  };
  const btn = $('service-save-btn');
  setBusy(btn, true, 'Saving…');
  try {
    if (id) {
      await api('/api/admin/services/' + encodeURIComponent(id), { method: 'PUT', body: payload });
      showToast('Service updated.');
    } else {
      await api('/api/admin/services', { method: 'POST', body: payload });
      showToast('Service added.');
    }
    closeModal('service-modal');
    loadServices();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    showInlineError('service-form-error', err.message || 'Failed to save the service.');
  } finally {
    setBusy(btn, false);
  }
}

async function deleteService(id, name) {
  const ok = await confirmDialog('Delete Service', `Delete the service "${name || id}"? This cannot be undone.`, 'Delete');
  if (!ok) return;
  try {
    await api('/api/admin/services/' + encodeURIComponent(id), { method: 'DELETE' });
    showToast('Service deleted.');
    loadServices();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    showToast(err.message || 'Failed to delete the service.', 'error');
  }
}

/* ============================== Customers ============================== */

async function loadCustomers() {
  setLoading('customers-loading', true);
  hideAlert('customers-error');
  $('customers-empty').hidden = true;
  try {
    const params = new URLSearchParams();
    const q = $('customers-search').value.trim();
    if (q) params.set('q', q);
    const qs = params.toString();
    const data = await api('/api/admin/customers' + (qs ? '?' + qs : ''));
    const list = Array.isArray(data.customers) ? data.customers : [];
    state.customers = list;
    const body = $('customers-table-body');
    if (list.length === 0) {
      body.innerHTML = '';
      $('customers-empty').hidden = false;
    } else {
      body.innerHTML = list.map((c) => `<tr>
        <td><strong>${esc(c.name || '—')}</strong></td>
        <td class="cell-nowrap">${esc(c.phone || '—')}</td>
        <td>${esc(num(c.bookingsCount ?? (c.bookings ? c.bookings.length : 0)))}</td>
        <td class="cell-nowrap">${esc(fmtDate(c.lastBookingDate))}</td>
        <td class="cell-actions">
          <button type="button" class="btn btn-xs btn-secondary" data-customer-id="${esc(c.id)}">View</button>
          ${c.phone ? `<a class="btn btn-xs btn-secondary" href="${esc(waLink(c.phone))}" target="_blank" rel="noopener"><i class="fa-brands fa-whatsapp"></i> WhatsApp</a>` : ''}
        </td>
      </tr>`).join('');
      body.querySelectorAll('button[data-customer-id]').forEach((btn) => {
        btn.addEventListener('click', () => openCustomerDetail(btn.dataset.customerId));
      });
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    showSectionError('customers-error', err.message || 'Failed to load customers.', loadCustomers);
  } finally {
    setLoading('customers-loading', false);
  }
}

async function openCustomerDetail(id) {
  const modalBody = $('customer-modal-body');
  $('customer-modal-title').textContent = 'Customer';
  modalBody.innerHTML = '<div class="loading-row"><span class="spinner"></span> Loading customer…</div>';
  openModal('customer-modal');
  try {
    const data = await api('/api/admin/customers/' + encodeURIComponent(id));
    const c = data.customer || data;
    const bookings = Array.isArray(data.bookings) ? data.bookings : (Array.isArray(c.bookings) ? c.bookings : []);
    $('customer-modal-title').textContent = c.name || 'Customer';
    const historyRows = bookings.length === 0
      ? '<tr><td colspan="5" class="cell-muted">No bookings yet.</td></tr>'
      : bookings.map((b) => `<tr>
          <td class="cell-nowrap"><strong>${esc(b.quoteNumber || b.id)}</strong></td>
          <td>${esc(eventLabel(b))}</td>
          <td class="cell-nowrap">${esc(fmtDate(b.eventDate))}</td>
          <td class="cell-nowrap">${esc(money(b.grandTotal))}</td>
          <td>${statusBadge(b.status)}</td>
        </tr>`).join('');
    modalBody.innerHTML = `
      <div class="detail-grid">
        <p><span class="detail-label">Name</span>${esc(c.name || '—')}</p>
        <p><span class="detail-label">Phone</span>${esc(c.phone || '—')}</p>
        ${c.email ? `<p><span class="detail-label">Email</span>${esc(c.email)}</p>` : ''}
        <p><span class="detail-label">Total bookings</span>${esc(bookings.length)}</p>
      </div>
      ${c.phone ? `<p><a class="btn btn-secondary btn-sm" href="${esc(waLink(c.phone))}" target="_blank" rel="noopener"><i class="fa-brands fa-whatsapp"></i> WhatsApp</a>
      <a class="btn btn-secondary btn-sm" href="tel:${esc(String(c.phone).replace(/\D/g, ''))}"><i class="fa-solid fa-phone"></i> Call</a></p>` : ''}
      <h4 class="detail-section-title">Booking History</h4>
      <div class="table-wrap">
        <table class="data-table" style="min-width:0">
          <thead><tr><th>Quote No.</th><th>Event</th><th>Date</th><th>Total</th><th>Status</th></tr></thead>
          <tbody>${historyRows}</tbody>
        </table>
      </div>`;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    modalBody.innerHTML = `<div class="alert alert-error">${esc(err.message || 'Failed to load this customer.')}</div>`;
  }
}

/* ============================== Inquiries ============================== */

async function loadInquiries() {
  setLoading('inquiries-loading', true);
  hideAlert('inquiries-error');
  $('inquiries-empty').hidden = true;
  try {
    const params = new URLSearchParams();
    const status = $('inquiries-status-filter').value;
    if (status) params.set('status', status);
    const qs = params.toString();
    const data = await api('/api/admin/inquiries' + (qs ? '?' + qs : ''));
    const list = Array.isArray(data.inquiries) ? data.inquiries : [];
    state.inquiries = list;
    const container = $('inquiries-list');
    if (list.length === 0) {
      container.innerHTML = '';
      $('inquiries-empty').hidden = false;
    } else {
      container.innerHTML = list.map((q) => `<article class="list-card">
        <div class="list-card-header">
          <div>
            <h4 class="list-card-title">${esc(q.name || '—')}</h4>
            <p class="list-card-meta">${esc(q.phone || '')}${q.email ? ' · ' + esc(q.email) : ''} · ${esc(eventLabel(q))} · ${esc(fmtDate(q.eventDate))} · ${esc(num(q.guests))} guests</p>
          </div>
          ${statusBadge(q.status)}
        </div>
        <p class="list-card-body">${esc(q.message || '')}</p>
        <div class="list-card-actions">
          <button type="button" class="btn btn-sm btn-secondary" data-inquiry-id="${esc(q.id)}">View Details</button>
          ${q.phone ? `<a class="btn btn-sm btn-secondary" href="${esc(waLink(q.phone))}" target="_blank" rel="noopener"><i class="fa-brands fa-whatsapp"></i> WhatsApp</a>
          <a class="btn btn-sm btn-secondary" href="tel:${esc(String(q.phone).replace(/\D/g, ''))}"><i class="fa-solid fa-phone"></i> Call</a>` : ''}
          ${q.email ? `<a class="btn btn-sm btn-secondary" href="mailto:${esc(q.email)}"><i class="fa-solid fa-envelope"></i> Email</a>` : ''}
        </div>
      </article>`).join('');
      container.querySelectorAll('button[data-inquiry-id]').forEach((btn) => {
        btn.addEventListener('click', () => openInquiryDetail(btn.dataset.inquiryId));
      });
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    showSectionError('inquiries-error', err.message || 'Failed to load inquiries.', loadInquiries);
  } finally {
    setLoading('inquiries-loading', false);
  }
}

async function openInquiryDetail(id) {
  const modalBody = $('inquiry-modal-body');
  const footer = $('inquiry-modal-footer');
  $('inquiry-modal-title').textContent = 'Inquiry';
  modalBody.innerHTML = '<div class="loading-row"><span class="spinner"></span> Loading inquiry…</div>';
  footer.innerHTML = '';
  openModal('inquiry-modal');
  // The list response already carries the full inquiry; reuse it when present.
  const cached = (state.inquiries || []).find((q) => String(q.id) === String(id));
  if (cached) {
    renderInquiryDetail(cached);
    return;
  }
  // Otherwise fetch the list (there is no single-inquiry GET in the contract)
  // and pick the requested one.
  try {
    const data = await api('/api/admin/inquiries');
    const list = Array.isArray(data.inquiries) ? data.inquiries : [];
    state.inquiries = list;
    const found = list.find((q) => String(q.id) === String(id));
    if (found) {
      renderInquiryDetail(found);
    } else {
      modalBody.innerHTML = '<div class="alert alert-error">Inquiry not found.</div>';
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    modalBody.innerHTML = `<div class="alert alert-error">${esc(err.message || 'Failed to load this inquiry.')}</div>`;
  }
}

function renderInquiryDetail(q) {
  state.currentInquiry = q;
  $('inquiry-modal-title').textContent = 'Inquiry — ' + (q.name || '—');
  const linkedQuote = q.quoteNumber || q.linkedQuoteNumber || q.bookingQuoteNumber || '';
  $('inquiry-modal-body').innerHTML = `
    <div id="inquiry-update-error" class="alert alert-error" hidden></div>
    <div class="detail-grid">
      <p><span class="detail-label">Name</span>${esc(q.name || '—')}</p>
      <p><span class="detail-label">Status</span>${statusBadge(q.status)}</p>
      <p><span class="detail-label">Phone</span>${esc(q.phone || '—')}</p>
      <p><span class="detail-label">Email</span>${esc(q.email || '—')}</p>
      <p><span class="detail-label">Event</span>${esc(eventLabel(q))}</p>
      <p><span class="detail-label">Event date</span>${esc(fmtDate(q.eventDate))}</p>
      <p><span class="detail-label">Guests</span>${esc(num(q.guests))}</p>
      <p><span class="detail-label">Received</span>${esc(fmtDateTime(q.createdAt))}</p>
      ${linkedQuote ? `<p><span class="detail-label">Linked booking</span><strong>${esc(linkedQuote)}</strong></p>` : ''}
      <p style="grid-column: 1 / -1;"><span class="detail-label">Message</span>${esc(q.message || '—')}</p>
    </div>`;
  const footer = $('inquiry-modal-footer');
  footer.innerHTML = '';
  if (q.phone) {
    footer.insertAdjacentHTML('beforeend',
      `<a class="btn btn-secondary" href="${esc(waLink(q.phone))}" target="_blank" rel="noopener"><i class="fa-brands fa-whatsapp"></i> WhatsApp</a>
       <a class="btn btn-secondary" href="tel:${esc(String(q.phone).replace(/\D/g, ''))}"><i class="fa-solid fa-phone"></i> Call</a>`);
  }
  if (q.email) {
    footer.insertAdjacentHTML('beforeend',
      `<a class="btn btn-secondary" href="mailto:${esc(q.email)}"><i class="fa-solid fa-envelope"></i> Email</a>`);
  }
  footer.insertAdjacentHTML('beforeend', '<span class="modal-footer-spacer"></span>');
  const statuses = ['new', 'contacted', 'closed'];
  statuses.forEach((s) => {
    if (s === q.status) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-primary';
    btn.textContent = 'Mark ' + s;
    btn.addEventListener('click', () => updateInquiryStatus(q.id, s));
    footer.appendChild(btn);
  });
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn btn-secondary';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', () => closeModal('inquiry-modal'));
  footer.appendChild(closeBtn);
}

async function updateInquiryStatus(id, status) {
  hideAlert('inquiry-update-error');
  try {
    await api('/api/admin/inquiries/' + encodeURIComponent(id), {
      method: 'PATCH',
      body: { status },
    });
    showToast(`Inquiry marked ${status}.`);
    closeModal('inquiry-modal');
    loadInquiries();
    if (state.section === 'dashboard') loadDashboard();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    showInlineError('inquiry-update-error', err.message || 'Failed to update the inquiry.');
  }
}

/* ============================== Reviews ============================== */

function starsHtml(rating) {
  const r = Math.max(0, Math.min(5, Math.round(num(rating))));
  let out = '';
  for (let i = 1; i <= 5; i++) {
    out += `<i class="fa-${i <= r ? 'solid' : 'regular'} fa-star"></i>`;
  }
  return `<span class="stars" aria-label="${r} out of 5 stars">${out}</span>`;
}

async function loadReviews() {
  setLoading('reviews-loading', true);
  hideAlert('reviews-error');
  $('reviews-empty').hidden = true;
  try {
    const data = await api('/api/admin/reviews');
    const list = Array.isArray(data.reviews) ? data.reviews : [];
    state.reviews = list;
    const container = $('reviews-list');
    if (list.length === 0) {
      container.innerHTML = '';
      $('reviews-empty').hidden = false;
    } else {
      container.innerHTML = list.map((r) => `<article class="list-card">
        <div class="list-card-header">
          <div>
            <h4 class="list-card-title">${esc(r.customerName || r.name || '—')}</h4>
            <p class="list-card-meta">${esc(eventLabel(r))} · ${esc(fmtDate(r.createdAt))}</p>
          </div>
          <div style="text-align:right;">
            ${starsHtml(r.rating)}
            <div style="margin-top:4px;">${r.isVerified ? '<span class="badge badge-verified">Verified</span> ' : ''}<span class="badge ${r.isVisible !== false ? 'badge-yes' : 'badge-no'}">${r.isVisible !== false ? 'Visible' : 'Hidden'}</span></div>
          </div>
        </div>
        <p class="list-card-body">${esc(r.comment || r.text || '')}</p>
        ${r.ownerReply ? `<div class="owner-reply"><strong>Your reply:</strong> ${esc(r.ownerReply)}</div>` : ''}
        <div class="list-card-actions">
          <button type="button" class="btn btn-sm btn-secondary" data-toggle-review="${esc(r.id)}" data-visible="${r.isVisible !== false}">${r.isVisible !== false ? 'Hide' : 'Show'}</button>
          <button type="button" class="btn btn-sm btn-secondary" data-reply-review="${esc(r.id)}">${r.ownerReply ? 'Edit Reply' : 'Reply'}</button>
          <button type="button" class="btn btn-sm btn-danger" data-delete-review="${esc(r.id)}">Delete</button>
        </div>
      </article>`).join('');
      container.querySelectorAll('button[data-toggle-review]').forEach((btn) => {
        btn.addEventListener('click', () => toggleReviewVisibility(btn.dataset.toggleReview, btn.dataset.visible !== 'true'));
      });
      container.querySelectorAll('button[data-reply-review]').forEach((btn) => {
        btn.addEventListener('click', () => openReviewReply(btn.dataset.replyReview));
      });
      container.querySelectorAll('button[data-delete-review]').forEach((btn) => {
        btn.addEventListener('click', () => deleteReview(btn.dataset.deleteReview));
      });
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    showSectionError('reviews-error', err.message || 'Failed to load reviews.', loadReviews);
  } finally {
    setLoading('reviews-loading', false);
  }
}

async function toggleReviewVisibility(id, makeVisible) {
  try {
    await api('/api/admin/reviews/' + encodeURIComponent(id), {
      method: 'PATCH',
      body: { isVisible: makeVisible },
    });
    showToast(makeVisible ? 'Review is now visible.' : 'Review hidden.');
    loadReviews();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    showToast(err.message || 'Failed to update the review.', 'error');
  }
}

function openReviewReply(id) {
  const r = (state.reviews || []).find((x) => String(x.id) === String(id));
  if (!r) return;
  hideAlert('review-form-error');
  $('review-id').value = r.id;
  $('review-quote').textContent = `“${r.comment || r.text || ''}” — ${r.customerName || r.name || ''}`;
  $('review-reply-text').value = r.ownerReply || '';
  openModal('review-modal');
}

async function saveReviewReply(event) {
  event.preventDefault();
  hideAlert('review-form-error');
  const id = $('review-id').value;
  const ownerReply = $('review-reply-text').value.trim();
  const btn = $('review-save-btn');
  setBusy(btn, true, 'Saving…');
  try {
    await api('/api/admin/reviews/' + encodeURIComponent(id), {
      method: 'PATCH',
      body: { ownerReply },
    });
    showToast('Reply saved.');
    closeModal('review-modal');
    loadReviews();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    showInlineError('review-form-error', err.message || 'Failed to save the reply.');
  } finally {
    setBusy(btn, false);
  }
}

async function deleteReview(id) {
  const ok = await confirmDialog('Delete Review', 'Delete this review? This cannot be undone.', 'Delete');
  if (!ok) return;
  try {
    await api('/api/admin/reviews/' + encodeURIComponent(id), { method: 'DELETE' });
    showToast('Review deleted.');
    loadReviews();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    showToast(err.message || 'Failed to delete the review.', 'error');
  }
}

/* ============================== Settings ============================== */

/* Settings keys (PUT /api/admin/settings takes an object of keys). taxRate /
   serviceChargeRate / defaultTransportPrice match the original app's business
   info and the booking object's rate fields. */
const SETTING_FIELDS = [
  ['settings-name', 'businessName'],
  ['settings-owner', 'ownerName'],
  ['settings-phone', 'phone'],
  ['settings-email', 'email'],
  ['settings-whatsapp', 'whatsapp'],
  ['settings-address', 'address'],
  ['settings-gst-number', 'gstNumber'],
  ['settings-gst-rate', 'taxRate'],
  ['settings-service-charge', 'serviceChargeRate'],
  ['settings-transport', 'defaultTransportPrice'],
  ['settings-min-guests', 'minGuestsForBooking'],
  ['settings-notify-email', 'adminEmail'],
  ['settings-notify-whatsapp', 'adminWhatsapp'],
];

async function loadSettings() {
  setLoading('settings-loading', true);
  $('settings-form').hidden = true;
  hideAlert('settings-error');
  hideAlert('settings-success');
  try {
    const data = await api('/api/admin/settings');
    const s = data.settings || data;
    SETTING_FIELDS.forEach(([inputId, key]) => {
      const el = $(inputId);
      const value = s[key];
      el.value = value === undefined || value === null ? '' : value;
    });
    $('settings-form').hidden = false;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    showSectionError('settings-error', err.message || 'Failed to load settings.', loadSettings);
  } finally {
    setLoading('settings-loading', false);
  }
}

async function saveSettings(event) {
  event.preventDefault();
  hideAlert('settings-error');
  hideAlert('settings-success');
  const payload = {};
  SETTING_FIELDS.forEach(([inputId, key]) => {
    const raw = $(inputId).value.trim();
    if (['taxRate', 'serviceChargeRate'].includes(key)) {
      payload[key] = raw === '' ? 0 : parseFloat(raw);
    } else if (['defaultTransportPrice', 'minGuestsForBooking'].includes(key)) {
      payload[key] = raw === '' ? 0 : parseInt(raw, 10);
    } else {
      payload[key] = raw;
    }
  });
  if (Number.isNaN(payload.taxRate) || Number.isNaN(payload.serviceChargeRate) ||
      Number.isNaN(payload.defaultTransportPrice) || Number.isNaN(payload.minGuestsForBooking)) {
    showInlineError('settings-error', 'Please enter valid numbers for the rates, transport price and minimum guests.');
    return;
  }
  const btn = $('settings-save-btn');
  setBusy(btn, true, 'Saving…');
  try {
    await api('/api/admin/settings', { method: 'PUT', body: payload });
    showInlineError('settings-success', 'Settings saved successfully.');
    showToast('Settings saved.');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    showInlineError('settings-error', err.message || 'Failed to save settings.');
  } finally {
    setBusy(btn, false);
  }
}

/* ============================== Admins ============================== */

async function loadAdmins() {
  setLoading('admins-loading', true);
  hideAlert('admins-error');
  $('admins-empty').hidden = true;
  try {
    const data = await api('/api/admin/admins');
    const list = Array.isArray(data.admins) ? data.admins : [];
    const body = $('admins-table-body');
    if (list.length === 0) {
      body.innerHTML = '';
      $('admins-empty').hidden = false;
    } else {
      body.innerHTML = list.map((a) => `<tr>
        <td><strong>${esc(a.email)}</strong>${state.admin && String(a.id) === String(state.admin.id) ? ' <span class="badge badge-verified">You</span>' : ''}</td>
        <td>${esc(a.name || '—')}</td>
        <td>${esc(a.role || 'admin')}</td>
        <td class="cell-nowrap">${esc(fmtDate(a.createdAt))}</td>
        <td class="cell-actions"><button type="button" class="btn btn-xs btn-danger" data-delete-admin="${esc(a.id)}" data-admin-email="${esc(a.email)}">Delete</button></td>
      </tr>`).join('');
      body.querySelectorAll('button[data-delete-admin]').forEach((btn) => {
        btn.addEventListener('click', () => deleteAdmin(btn.dataset.deleteAdmin, btn.dataset.adminEmail));
      });
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    showSectionError('admins-error', err.message || 'Failed to load admins.', loadAdmins);
  } finally {
    setLoading('admins-loading', false);
  }
}

async function addAdmin(event) {
  event.preventDefault();
  hideAlert('admins-error');
  const email = $('admin-add-email').value.trim();
  const name = $('admin-add-name').value.trim();
  const password = $('admin-add-password').value;
  if (!email) {
    showInlineError('admins-error', 'Please enter an email address.');
    return;
  }
  if (password.length < 8) {
    showInlineError('admins-error', 'The password must be at least 8 characters long.');
    return;
  }
  const btn = $('admin-add-submit');
  setBusy(btn, true, 'Adding…');
  try {
    await api('/api/admin/admins', { method: 'POST', body: { email, password, name } });
    showToast('Admin added.');
    $('admin-add-form').reset();
    loadAdmins();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    showInlineError('admins-error', err.message || 'Failed to add the admin.');
  } finally {
    setBusy(btn, false);
  }
}

async function deleteAdmin(id, email) {
  const ok = await confirmDialog('Delete Admin', `Delete the admin account "${email || id}"? This cannot be undone.`, 'Delete');
  if (!ok) return;
  try {
    await api('/api/admin/admins/' + encodeURIComponent(id), { method: 'DELETE' });
    showToast('Admin deleted.');
    loadAdmins();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    // Server forbids deleting the last admin or yourself — show its message.
    showToast(err.message || 'Failed to delete the admin.', 'error');
  }
}

/* ============================== Outbox ============================== */

async function loadOutbox() {
  setLoading('outbox-loading', true);
  hideAlert('outbox-error');
  $('outbox-empty').hidden = true;
  try {
    const params = new URLSearchParams({ limit: '100' });
    const status = $('outbox-status-filter').value;
    if (status) params.set('status', status);
    const data = await api('/api/admin/outbox?' + params.toString());
    const list = Array.isArray(data.outbox) ? data.outbox : (Array.isArray(data.items) ? data.items : []);
    const body = $('outbox-table-body');
    if (list.length === 0) {
      body.innerHTML = '';
      $('outbox-empty').hidden = false;
    } else {
      body.innerHTML = list.map((o) => {
        const related = o.quoteNumber || o.inquiryId || o.bookingId || '—';
        const canResend = o.status === 'pending' || o.status === 'failed';
        return `<tr>
          <td>${esc(o.channel || '—')}</td>
          <td>${esc(o.recipient || '—')}</td>
          <td>${esc(o.subject || '—')}</td>
          <td class="cell-nowrap">${esc(related)}</td>
          <td>${statusBadge(o.status)}</td>
          <td class="cell-muted">${esc(o.error || '—')}</td>
          <td class="cell-nowrap">${esc(fmtDateTime(o.createdAt))}</td>
          <td class="cell-nowrap">${esc(fmtDateTime(o.sentAt))}</td>
          <td class="cell-actions">${canResend ? `<button type="button" class="btn btn-xs btn-secondary" data-resend-outbox="${esc(o.id)}">Resend</button>` : ''}</td>
        </tr>`;
      }).join('');
      body.querySelectorAll('button[data-resend-outbox]').forEach((btn) => {
        btn.addEventListener('click', () => resendOutbox(btn.dataset.resendOutbox, btn));
      });
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    showSectionError('outbox-error', err.message || 'Failed to load the outbox.', loadOutbox);
  } finally {
    setLoading('outbox-loading', false);
  }
}

async function resendOutbox(id, btn) {
  if (btn) btn.disabled = true;
  try {
    await api('/api/admin/outbox/' + encodeURIComponent(id) + '/resend', { method: 'POST' });
    showToast('Notification queued for resend.');
    loadOutbox();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    showToast(err.message || 'Failed to resend the notification.', 'error');
    if (btn) btn.disabled = false;
  }
}

/* ============================== Audit Log ============================== */

async function loadAudit() {
  setLoading('audit-loading', true);
  hideAlert('audit-error');
  $('audit-empty').hidden = true;
  try {
    const data = await api('/api/admin/audit-logs?limit=100');
    const list = Array.isArray(data.logs) ? data.logs : (Array.isArray(data.auditLogs) ? data.auditLogs : []);
    const body = $('audit-table-body');
    if (list.length === 0) {
      body.innerHTML = '';
      $('audit-empty').hidden = false;
    } else {
      body.innerHTML = list.map((l) => `<tr>
        <td class="cell-nowrap">${esc(fmtDateTime(l.createdAt || l.timestamp))}</td>
        <td>${esc(l.adminEmail || l.admin || l.userEmail || '—')}</td>
        <td><strong>${esc(l.action || '—')}</strong></td>
        <td>${esc(l.detail || l.details || '')}</td>
      </tr>`).join('');
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    showSectionError('audit-error', err.message || 'Failed to load the audit log.', loadAudit);
  } finally {
    setLoading('audit-loading', false);
  }
}

/* ============================== Init / wiring ============================== */

function init() {
  // Item thumbnails are remote URLs: if one fails to load, hide it instead
  // of showing a broken-image icon.
  document.addEventListener('error', (e) => {
    const el = e.target;
    if (el && el.tagName === 'IMG' && el.classList.contains('thumb')) {
      el.style.display = 'none';
    }
  }, true);

  // Auth forms
  $('login-form').addEventListener('submit', handleLogin);
  $('forgot-form').addEventListener('submit', handleForgotPassword);
  $('change-password-form').addEventListener('submit', handleChangePassword);
  $('forgot-password-link').addEventListener('click', () => {
    hideAlert('forgot-error');
    hideAlert('forgot-info');
    $('forgot-email').value = $('login-email').value;
    showAuthForm('forgot-form');
  });
  $('forgot-back-link').addEventListener('click', () => showAuthForm('login-form'));
  $('logout-btn').addEventListener('click', handleLogout);

  // Vercel demo-deployment notice (admin dashboard only): dismissible for
  // the rest of the browser session.
  $('dashboard-ephemeral-dismiss').addEventListener('click', () => {
    try { sessionStorage.setItem('sjc-hide-ephemeral-notice', '1'); } catch { /* ignore */ }
    $('dashboard-ephemeral-notice').hidden = true;
  });

  // Sidebar
  document.querySelectorAll('.sidebar-nav .nav-item').forEach((btn) => {
    btn.addEventListener('click', () => showSection(btn.dataset.section));
  });
  $('sidebar-toggle').addEventListener('click', () => {
    $('sidebar').classList.toggle('open');
    $('sidebar-overlay').classList.toggle('visible');
  });
  $('sidebar-overlay').addEventListener('click', closeSidebar);

  // Hash-based section switching (back/forward support)
  window.addEventListener('hashchange', () => {
    if ($('portal-view').hidden) return;
    const name = (location.hash || '').replace(/^#\/?/, '');
    if (SECTION_TITLES[name] && name !== state.section) showSection(name, { updateHash: false });
  });

  // Modals: close buttons + overlay click + Escape
  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.closest('#confirm-modal')) { resolveConfirm(false); return; }
      closeModal(btn.dataset.close);
    });
  });
  document.querySelectorAll('.modal-overlay').forEach((overlay) => {
    overlay.addEventListener('click', (e) => {
      if (e.target !== overlay) return;
      if (overlay.id === 'confirm-modal') { resolveConfirm(false); return; }
      closeModal(overlay.id);
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = document.querySelector('.modal-overlay.active');
    if (!open) return;
    if (open.id === 'confirm-modal') resolveConfirm(false);
    else closeModal(open.id);
  });
  $('confirm-ok-btn').addEventListener('click', () => resolveConfirm(true));
  $('confirm-cancel-btn').addEventListener('click', () => resolveConfirm(false));

  // Bookings filters
  $('bookings-search').addEventListener('input', debounce(loadBookings, 300));
  $('bookings-status-filter').addEventListener('change', loadBookings);
  $('bookings-from').addEventListener('change', loadBookings);
  $('bookings-to').addEventListener('change', loadBookings);
  $('bookings-refresh').addEventListener('click', loadBookings);

  // Items
  $('items-search').addEventListener('input', debounce(loadItems, 300));
  $('items-category-filter').addEventListener('change', loadItems);
  $('items-add-btn').addEventListener('click', () => openItemForm(null));
  $('item-form').addEventListener('submit', saveItem);
  $('item-image-file').addEventListener('change', (e) => handleItemImageFile(e.target));
  $('item-image-url').addEventListener('input', () => {
    const url = $('item-image-url').value.trim();
    if (url && !state.itemImageFile) {
      $('item-image-preview').src = url;
      $('item-image-preview').hidden = false;
      $('item-image-status').textContent = 'Image URL set';
    }
  });

  // Categories
  $('categories-add-btn').addEventListener('click', () => openCategoryForm(null));
  $('category-form').addEventListener('submit', saveCategory);

  // Services
  $('services-add-btn').addEventListener('click', () => openServiceForm(null));
  $('service-form').addEventListener('submit', saveService);

  // Customers
  $('customers-search').addEventListener('input', debounce(loadCustomers, 300));

  // Inquiries
  $('inquiries-status-filter').addEventListener('change', loadInquiries);
  $('inquiries-refresh').addEventListener('click', loadInquiries);

  // Reviews
  $('review-form').addEventListener('submit', saveReviewReply);

  // Settings
  $('settings-form').addEventListener('submit', saveSettings);

  // Admins
  $('admin-add-form').addEventListener('submit', addAdmin);

  // Outbox
  $('outbox-status-filter').addEventListener('change', loadOutbox);
  $('outbox-refresh').addEventListener('click', loadOutbox);

  // Session check on first load
  checkSession();
}

document.addEventListener('DOMContentLoaded', init);
