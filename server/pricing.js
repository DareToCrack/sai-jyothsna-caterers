// pricing.js — pure quotation computation.
//
// These semantics are copied EXACTLY from the original app.js
// (generateQuotation, ~lines 935-1083). Do not "fix" them by intuition:
//
//   * foodTotal      = SUM(item.price x guests)            — per-guest pricing.
//   * services       = type 'number' -> unitPrice x quantity
//                      type 'checkbox' -> FLAT unitPrice, with NO per-guest
//                      multiplication. That is deliberate: even consumables
//                      like steel plates (Rs 20), banana leaves (Rs 15) and
//                      mineral water (Rs 30) are flat in the original code.
//   * transport      = the service with id 'srv_transport' is split OUT of
//                      servicesTotal into its own transportTotal. If transport
//                      is selected (via the services list OR the standalone
//                      transport flag) but computes to 0 (e.g. its unit price
//                      was set to 0, or it was only flagged, not listed),
//                      fall back to settings.defaultTransportPrice. Selecting
//                      it both ways must never double-charge.
//   * serviceCharge  = servicesTotal x serviceChargeRate%  — on SERVICES ONLY,
//                      never on food and never on transport.
//   * gstAmount      = (foodTotal + servicesTotal + serviceCharge
//                        + transportTotal) x taxRate%.
//   * grandTotal     = Math.round(foodTotal + servicesTotal + transportTotal
//                        + serviceCharge + gstAmount).
//
// The server always computes from CURRENT database prices; client-supplied
// prices are never trusted. Money components are rounded to 2 decimals to
// avoid float noise (e.g. 1659.0000000001); only the grand total is rounded
// to a whole rupee, matching the original.
'use strict';

const TRANSPORT_SERVICE_ID = 'srv_transport';

/** Round to 2 decimal places (paise), guarding against float noise. */
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Compute a full quotation.
 *
 * @param {Object} input
 * @param {Array<{id: string, nameEn: string, price: number}>} input.items
 *        Selected dishes, already resolved from the DB (current prices).
 * @param {Array<{id: string, nameEn: string, type: 'checkbox'|'number',
 *                unitPrice: number, quantity: number}>} input.services
 *        Selected services, already resolved from the DB with quantities
 *        settled (checkbox services carry quantity 1; number services carry
 *        the requested quantity, or their default_quantity when omitted).
 * @param {number} input.guests
 * @param {boolean} input.transportSelected  Standalone transport flag from
 *        the booking request (body.transport === true).
 * @param {Object} input.settings  { taxRate, serviceChargeRate,
 *        defaultTransportPrice }
 * @returns {Object} Totals plus per-line breakdowns and the rates used
 *          (the caller snapshots taxRate/serviceChargeRate onto the booking).
 */
function computeQuotation({ items, services, guests, transportSelected, settings }) {
  const taxRate = Number(settings.taxRate ?? 5);
  const serviceChargeRate = Number(settings.serviceChargeRate ?? 5);
  const defaultTransportPrice = Number(settings.defaultTransportPrice ?? 1500);

  // --- Food: every dish is priced per guest. ---
  const itemLines = items.map((item) => ({
    itemId: item.id,
    itemName: item.nameEn,
    unitPrice: item.price,
    qtyIsGuests: true,
    lineTotal: round2(item.price * guests)
  }));
  const foodTotal = round2(itemLines.reduce((sum, line) => sum + line.lineTotal, 0));

  // --- Services: number = unit x qty, checkbox = flat. Transport is split
  // out of servicesTotal into transportTotal. ---
  let servicesTotal = 0;
  let transportTotal = 0;
  let transportRequested = Boolean(transportSelected);
  const serviceLines = [];

  for (const svc of services) {
    const total = svc.type === 'number'
      ? round2(svc.unitPrice * svc.quantity)
      : round2(svc.unitPrice);
    const isTransport = svc.id === TRANSPORT_SERVICE_ID;
    if (isTransport) {
      transportRequested = true;
      transportTotal = round2(transportTotal + total);
    } else {
      servicesTotal = round2(servicesTotal + total);
    }
    serviceLines.push({
      serviceId: svc.id,
      serviceName: svc.nameEn,
      unitPrice: svc.unitPrice,
      quantity: svc.type === 'number' ? svc.quantity : 1,
      total,
      isTransport
    });
  }

  // Transport selected but priced at 0 (flag-only selection, or a zeroed
  // unit price) -> fall back to the configured default. This runs once, so
  // flag + list selection can never double-charge.
  if (transportRequested && transportTotal === 0) {
    transportTotal = round2(defaultTransportPrice);
  }

  // --- Charges: service charge on services only; GST on everything. ---
  const serviceCharge = round2(servicesTotal * (serviceChargeRate / 100));
  const gstAmount = round2(
    (foodTotal + servicesTotal + serviceCharge + transportTotal) * (taxRate / 100)
  );
  const grandTotal = Math.round(
    foodTotal + servicesTotal + transportTotal + serviceCharge + gstAmount
  );

  return {
    foodTotal,
    servicesTotal,
    transportTotal,
    serviceCharge,
    gstAmount,
    grandTotal,
    taxRate,
    serviceChargeRate,
    itemLines,
    serviceLines
  };
}

module.exports = { computeQuotation, TRANSPORT_SERVICE_ID, round2 };
