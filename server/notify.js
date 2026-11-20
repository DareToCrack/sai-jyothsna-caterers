// notify.js — notification orchestration + outbox recording.
//
// Channels:
//   1. EMAIL (SMTP via nodemailer) to settings.adminEmail. If SMTP is not
//      configured, the message is recorded in notifications_outbox with
//      status 'pending' (honest outbox pattern: nothing is silently dropped,
//      and an admin can resend later once SMTP is set up).
//   2. WHATSAPP: a wa.me/<adminWhatsapp>?text=... link is ALWAYS computed
//      and returned to the caller so the owner can tap-to-send. If the
//      WhatsApp Cloud API is configured (WHATSAPP_CLOUD_TOKEN +
//      WHATSAPP_PHONE_NUMBER_ID), the message is ALSO posted to the Graph API
//      and recorded in the outbox.
//
// Notification failures NEVER fail the booking/inquiry request: every send
// is wrapped, failures are recorded in the outbox with the error, and the
// caller continues.
'use strict';

const nodemailer = require('nodemailer');
const { getAllSettings, nowIso } = require('./db');

function inr(n) {
  return `Rs ${Number(n).toLocaleString('en-IN')}`;
}

function whatsappUrl(number, text) {
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}

function isSmtpConfigured() {
  return Boolean(
    process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS
  );
}

function isWhatsappCloudConfigured() {
  return Boolean(
    process.env.WHATSAPP_CLOUD_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID
  );
}

function recordOutbox(db, row) {
  const result = db
    .prepare(
      `INSERT INTO notifications_outbox
         (channel, recipient, subject, body, related_type, related_id, status, error, created_at, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.channel,
      row.recipient,
      row.subject || null,
      row.body,
      row.relatedType || null,
      row.relatedId || null,
      row.status,
      row.error || null,
      nowIso(),
      row.status === 'sent' ? nowIso() : null
    );
  return Number(result.lastInsertRowid);
}

async function sendEmail({ to, subject, text }) {
  const port = Number(process.env.SMTP_PORT || 587);
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    text
  });
}

async function sendWhatsappCloud({ to, text }) {
  const res = await fetch(
    `https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_CLOUD_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text }
      })
    }
  );
  const payload = await res.text();
  if (!res.ok) {
    throw new Error(`WhatsApp Cloud HTTP ${res.status}: ${payload}`);
  }
}

function buildBookingMessage(booking, details, business) {
  const lines = [];
  lines.push(`New catering booking ${booking.quoteNumber || booking.quote_number}`);
  lines.push('');
  lines.push(`Customer: ${booking.customerName} (${booking.customerPhone})`);
  lines.push(
    `Event: ${booking.customEventType || booking.eventType} — ${booking.eventDate}, ${booking.guests} guests`
  );
  lines.push(
    `Venue: ${[booking.venueAddress, booking.landmark, booking.city, booking.district, booking.state, booking.pincode].filter(Boolean).join(', ')}`
  );
  lines.push('');
  lines.push('Menu (per guest x guests):');
  for (const item of details.items || []) {
    lines.push(`- ${item.itemName}: ${inr(item.unitPrice)} x ${booking.guests} = ${inr(item.lineTotal)}`);
  }
  if (details.services && details.services.length > 0) {
    lines.push('');
    lines.push('Services:');
    for (const svc of details.services) {
      const qty = svc.quantity > 1 ? ` x ${svc.quantity}` : '';
      lines.push(`- ${svc.serviceName}: ${inr(svc.unitPrice)}${qty} = ${inr(svc.total)}`);
    }
  }
  lines.push('');
  lines.push(`Food total: ${inr(booking.foodTotal)}`);
  lines.push(`Services total: ${inr(booking.servicesTotal)}`);
  lines.push(`Transport: ${inr(booking.transportTotal)}`);
  lines.push(`Service charge (${booking.serviceChargeRate}%): ${inr(booking.serviceCharge)}`);
  lines.push(`GST (${booking.taxRate}%): ${inr(booking.gstAmount)}`);
  lines.push(`GRAND TOTAL: ${inr(booking.grandTotal)}`);
  if (booking.notes) lines.push('', `Notes: ${booking.notes}`);
  lines.push('', `— ${business.businessName}`);
  return lines.join('\n');
}

function buildInquiryMessage(inquiry, booking, business) {
  const lines = [];
  lines.push('New inquiry — Sai Jyothsna Caterers');
  lines.push('');
  lines.push(`Name: ${inquiry.name}`);
  lines.push(`Phone: ${inquiry.phone}`);
  if (inquiry.email) lines.push(`Email: ${inquiry.email}`);
  if (inquiry.eventType) lines.push(`Event: ${inquiry.eventType}`);
  if (inquiry.eventDate) lines.push(`Event date: ${inquiry.eventDate}`);
  if (inquiry.guests) lines.push(`Guests: ${inquiry.guests}`);
  if (booking) lines.push(`Related booking: ${booking.quoteNumber} (${inr(booking.grandTotal)})`);
  if (inquiry.message) lines.push('', `Message: ${inquiry.message}`);
  lines.push('', `— ${business.businessName}`);
  return lines.join('\n');
}

/**
 * Attempt the email + WhatsApp sends for one notification, recording every
 * outcome in the outbox. Never throws.
 * @returns {Promise<{whatsappUrl: string|null, emailStatus: string,
 *                    whatsappStatus: string|null}>}
 */
async function dispatch(db, { channel, recipient, subject, body, relatedType, relatedId }) {
  const settings = getAllSettings(db);
  const result = { whatsappUrl: null, emailStatus: 'pending', whatsappStatus: null };

  // --- Email ---
  if (isSmtpConfigured()) {
    try {
      await sendEmail({ to: recipient, subject, text: body });
      recordOutbox(db, { channel: 'email', recipient, subject, body, relatedType, relatedId, status: 'sent' });
      result.emailStatus = 'sent';
    } catch (err) {
      recordOutbox(db, { channel: 'email', recipient, subject, body, relatedType, relatedId, status: 'failed', error: err.message });
      result.emailStatus = 'failed';
    }
  } else {
    // Honest outbox: no SMTP configured, so the message waits as pending.
    recordOutbox(db, { channel: 'email', recipient, subject, body, relatedType, relatedId, status: 'pending' });
    result.emailStatus = 'pending';
  }

  // --- WhatsApp: always compute the wa.me link; send via Cloud API only
  // when it is configured. ---
  const adminWhatsapp = settings.adminWhatsapp;
  if (adminWhatsapp) {
    result.whatsappUrl = whatsappUrl(adminWhatsapp, body);
    if (isWhatsappCloudConfigured()) {
      try {
        await sendWhatsappCloud({ to: adminWhatsapp, text: body });
        recordOutbox(db, { channel: 'whatsapp', recipient: adminWhatsapp, subject: null, body, relatedType, relatedId, status: 'sent' });
        result.whatsappStatus = 'sent';
      } catch (err) {
        recordOutbox(db, { channel: 'whatsapp', recipient: adminWhatsapp, subject: null, body, relatedType, relatedId, status: 'failed', error: err.message });
        result.whatsappStatus = 'failed';
      }
    }
  }

  return result;
}

async function notifyBookingCreated(db, booking, details) {
  try {
    const settings = getAllSettings(db);
    const body = buildBookingMessage(booking, details, settings);
    return await dispatch(db, {
      recipient: settings.adminEmail,
      subject: `New booking ${booking.quoteNumber} — ${booking.customerName} (${booking.eventDate})`,
      body,
      relatedType: 'booking',
      relatedId: booking.id
    });
  } catch (err) {
    console.error('notifyBookingCreated failed:', err);
    return { whatsappUrl: null, emailStatus: 'failed', whatsappStatus: null };
  }
}

async function notifyInquiryCreated(db, inquiry, booking) {
  try {
    const settings = getAllSettings(db);
    const body = buildInquiryMessage(inquiry, booking, settings);
    return await dispatch(db, {
      recipient: settings.adminEmail,
      subject: `New inquiry from ${inquiry.name} (${inquiry.phone})`,
      body,
      relatedType: 'inquiry',
      relatedId: inquiry.id
    });
  } catch (err) {
    console.error('notifyInquiryCreated failed:', err);
    return { whatsappUrl: null, emailStatus: 'failed', whatsappStatus: null };
  }
}

/**
 * Re-attempt the send for one stored outbox row (admin resend), using the
 * stored recipient/subject/body. Updates the row status in place.
 * @returns {Promise<{status: string, error?: string}>}
 */
async function resendOutbox(db, row) {
  try {
    if (row.channel === 'email') {
      if (!isSmtpConfigured()) {
        throw new Error('SMTP is not configured');
      }
      await sendEmail({ to: row.recipient, subject: row.subject, text: row.body });
    } else if (row.channel === 'whatsapp') {
      if (!isWhatsappCloudConfigured()) {
        throw new Error('WhatsApp Cloud API is not configured');
      }
      await sendWhatsappCloud({ to: row.recipient, text: row.body });
    } else {
      throw new Error(`Unknown channel: ${row.channel}`);
    }
    db.prepare(
      'UPDATE notifications_outbox SET status = ?, error = NULL, sent_at = ? WHERE id = ?'
    ).run('sent', nowIso(), row.id);
    return { status: 'sent' };
  } catch (err) {
    db.prepare(
      'UPDATE notifications_outbox SET status = ?, error = ? WHERE id = ?'
    ).run('failed', err.message, row.id);
    return { status: 'failed', error: err.message };
  }
}

module.exports = {
  notifyBookingCreated,
  notifyInquiryCreated,
  resendOutbox,
  buildBookingMessage,
  buildInquiryMessage,
  whatsappUrl,
  isSmtpConfigured,
  isWhatsappCloudConfigured,
  recordOutbox
};
