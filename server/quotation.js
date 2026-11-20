// quotation.js — printable quotation HTML template.
//
// Renders a full standalone HTML page (receipt layout): business header,
// customer/event meta, menu grouped by category with per-item price x guests,
// services, and the billing breakdown (service charge + GST + grand total).
// Includes print CSS so the browser's Print dialog produces a clean receipt.
'use strict';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inr(n) {
  return `&#8377;${Number(n).toLocaleString('en-IN')}`;
}

function formatDate(isoDate) {
  const d = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

/**
 * @param {Object} input
 * @param {Object} input.booking  CamelCase booking object (see lib.mapBookingDetail).
 * @param {Array<{categoryName: string, items: Array<{itemName, unitPrice, lineTotal}>}>}
 *        input.groupedItems  Menu items grouped by category, in menu order.
 * @param {Array} input.serviceLines  Quotation service lines.
 * @param {Object} input.business  Business settings.
 * @returns {string} Standalone HTML page.
 */
function renderQuotationHTML({ booking, groupedItems, serviceLines, business }) {
  const eventName = booking.customEventType || booking.eventType;
  const venue = [booking.venueAddress, booking.landmark, booking.city, booking.district, booking.state, booking.pincode]
    .filter(Boolean)
    .join(', ');
  const created = new Date(booking.createdAt).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric'
  });

  const menuHtml = groupedItems.map((group) => `
      <h3 class="group-title">${escapeHtml(group.categoryName)}</h3>
      ${group.items.map((item) => `
      <div class="row">
        <span class="row-name">&bull; ${escapeHtml(item.itemName)} (${inr(item.unitPrice)} &times; ${booking.guests})</span>
        <span class="row-price">${inr(item.lineTotal)}</span>
      </div>`).join('')}`).join('');

  const servicesHtml = serviceLines.length > 0
    ? serviceLines.map((svc) => {
      const qty = svc.quantity > 1 ? ` (${inr(svc.unitPrice)} &times; ${svc.quantity})` : '';
      return `
      <div class="row">
        <span class="row-name">${escapeHtml(svc.serviceName)}${qty}</span>
        <span class="row-price">${inr(svc.total)}</span>
      </div>`;
    }).join('')
    : '<div class="row"><span class="row-name muted">No additional services selected.</span><span class="row-price">-</span></div>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Quotation ${escapeHtml(booking.quoteNumber)} — ${escapeHtml(business.businessName)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1a1a1a; margin: 0; padding: 24px; background: #f4f4f4; }
  .sheet { max-width: 720px; margin: 0 auto; background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 32px 36px; }
  .header { text-align: center; border-bottom: 2px solid #0c3e26; padding-bottom: 16px; margin-bottom: 20px; }
  .header h1 { margin: 0 0 4px; font-size: 22px; color: #0c3e26; }
  .header p { margin: 2px 0; font-size: 13px; color: #555; }
  .title-row { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 16px; }
  .title-row h2 { margin: 0; font-size: 18px; }
  .title-row .quote-no { font-size: 14px; font-weight: 700; }
  .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 24px; font-size: 14px; margin-bottom: 20px; }
  .meta div span { color: #666; }
  h3.section { font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; color: #0c3e26; border-bottom: 1px solid #e0e0e0; padding-bottom: 6px; margin: 20px 0 10px; }
  h3.group-title { font-size: 13px; color: #0c3e26; margin: 12px 0 4px; }
  .row { display: flex; justify-content: space-between; gap: 16px; font-size: 14px; padding: 3px 0; }
  .row-name { flex: 1; }
  .row-price { white-space: nowrap; font-variant-numeric: tabular-nums; }
  .muted { color: #777; }
  .totals { margin-top: 20px; border-top: 2px solid #0c3e26; padding-top: 12px; }
  .totals .row { padding: 4px 0; }
  .totals .grand { font-size: 18px; font-weight: 800; border-top: 1px solid #ddd; margin-top: 8px; padding-top: 10px; }
  .note { margin-top: 24px; font-size: 12px; color: #666; text-align: center; }
  .print-btn { display: block; margin: 20px auto 0; padding: 10px 28px; font-size: 15px; background: #0c3e26; color: #fff; border: 0; border-radius: 6px; cursor: pointer; }
  @media print {
    body { background: #fff; padding: 0; }
    .sheet { border: 0; border-radius: 0; padding: 0; max-width: none; }
    .print-btn { display: none; }
  }
</style>
</head>
<body>
<div class="sheet">
  <div class="header">
    <h1>${escapeHtml(business.businessName)}</h1>
    <p>${escapeHtml(business.address)}</p>
    <p>Phone: ${escapeHtml(business.phone)} &nbsp;|&nbsp; Email: ${escapeHtml(business.email)} &nbsp;|&nbsp; GSTIN: ${escapeHtml(business.gstNumber)}</p>
  </div>
  <div class="title-row">
    <h2>Catering Quotation</h2>
    <span class="quote-no">Quote No: ${escapeHtml(booking.quoteNumber)}</span>
  </div>
  <div class="meta">
    <div><span>Customer:</span> ${escapeHtml(booking.customerName)}</div>
    <div><span>Phone:</span> ${escapeHtml(booking.customerPhone)}</div>
    <div><span>Event:</span> ${escapeHtml(eventName)}</div>
    <div><span>Event date:</span> ${formatDate(booking.eventDate)}</div>
    <div><span>Guests:</span> ${booking.guests}</div>
    <div><span>Issued:</span> ${created}</div>
    <div style="grid-column: 1 / -1;"><span>Venue:</span> ${escapeHtml(venue)}</div>
    <div style="grid-column: 1 / -1;"><span>Status:</span> ${escapeHtml(booking.status)}</div>
  </div>

  <h3 class="section">Menu</h3>
  ${menuHtml}

  <h3 class="section">Services</h3>
  ${servicesHtml}

  <div class="totals">
    <div class="row"><span class="row-name">Food total</span><span class="row-price">${inr(booking.foodTotal)}</span></div>
    <div class="row"><span class="row-name">Services total</span><span class="row-price">${inr(booking.servicesTotal)}</span></div>
    <div class="row"><span class="row-name">Transport</span><span class="row-price">${inr(booking.transportTotal)}</span></div>
    <div class="row"><span class="row-name">Service charge (${booking.serviceChargeRate}%)</span><span class="row-price">${inr(booking.serviceCharge)}</span></div>
    <div class="row"><span class="row-name">GST (${booking.taxRate}%)</span><span class="row-price">${inr(booking.gstAmount)}</span></div>
    <div class="row grand"><span class="row-name">Grand Total</span><span class="row-price">${inr(booking.grandTotal)}</span></div>
  </div>

  ${booking.notes ? `<p class="note" style="text-align:left;"><strong>Notes:</strong> ${escapeHtml(booking.notes)}</p>` : ''}
  <p class="note">This quotation is valid for 7 days from the date of issue. Prices are inclusive of GST as shown above.<br>Thank you for choosing ${escapeHtml(business.businessName)}!</p>
  <button class="print-btn" onclick="window.print()">Print Quotation</button>
</div>
</body>
</html>`;
}

module.exports = { renderQuotationHTML, escapeHtml };
