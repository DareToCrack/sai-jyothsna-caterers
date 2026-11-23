// sms.js — OTP delivery channels.
//
// Priority: MSG91 (when MSG91_AUTH_KEY is set) -> Twilio (when TWILIO_SID,
// TWILIO_TOKEN and TWILIO_FROM are all set) -> WhatsApp Cloud API (when
// WHATSAPP_CLOUD_TOKEN + WHATSAPP_PHONE_NUMBER_ID are set; sends the OTP
// via an approved AUTHENTICATION template, default name `sjc_otp_code`,
// overridable with WHATSAPP_OTP_TEMPLATE) -> dev-log (no provider
// configured: the code is printed to the server console and the API reports
// devMode: true, so local development still works).
//
// sendOtp() NEVER throws: every failure is returned as { ok: false, error }
// so a provider outage can never break the OTP request endpoint.
'use strict';

const notify = require('./notify');

const DEFAULT_WHATSAPP_OTP_TEMPLATE = 'sjc_otp_code';

function otpMessage(code) {
  return `Your Sai Jyothsna Caterers OTP is ${code}. Valid for 5 minutes.`;
}

function isSmsConfigured() {
  if (process.env.MSG91_AUTH_KEY) return true;
  if (process.env.TWILIO_SID && process.env.TWILIO_TOKEN && process.env.TWILIO_FROM) return true;
  return notify.isWhatsappCloudConfigured();
}

async function sendViaMsg91(phone10, code) {
  const params = new URLSearchParams({
    authkey: process.env.MSG91_AUTH_KEY,
    mobiles: `91${phone10}`,
    message: otpMessage(code),
    sender: process.env.MSG91_SENDER_ID || 'SAIJYO',
    route: '4',
    country: '91'
  });
  if (process.env.MSG91_TEMPLATE_ID) {
    params.set('template_id', process.env.MSG91_TEMPLATE_ID);
  }
  const res = await fetch(`https://api.msg91.com/api/sendhttp.php?${params.toString()}`);
  const text = await res.text();
  if (!res.ok) {
    return { provider: 'msg91', ok: false, error: `MSG91 HTTP ${res.status}: ${text}` };
  }
  return { provider: 'msg91', ok: true };
}

async function sendViaTwilio(phone10, code) {
  const sid = process.env.TWILIO_SID;
  const auth = Buffer.from(`${sid}:${process.env.TWILIO_TOKEN}`).toString('base64');
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        To: `+91${phone10}`,
        From: process.env.TWILIO_FROM,
        Body: otpMessage(code)
      })
    }
  );
  const text = await res.text();
  if (!res.ok) {
    return { provider: 'twilio', ok: false, error: `Twilio HTTP ${res.status}: ${text}` };
  }
  return { provider: 'twilio', ok: true };
}

async function sendViaWhatsapp(phone10, code) {
  const templateName = process.env.WHATSAPP_OTP_TEMPLATE || DEFAULT_WHATSAPP_OTP_TEMPLATE;
  try {
    await notify.sendWhatsappTemplate({
      to: `91${phone10}`,
      templateName,
      languageCode: 'en',
      bodyParams: [code]
    });
    return { provider: 'whatsapp', ok: true };
  } catch (err) {
    return { provider: 'whatsapp', ok: false, error: err.message };
  }
}

/**
 * Send a 6-digit OTP to an Indian 10-digit mobile number.
 * @returns {Promise<{provider: string, ok: boolean, error?: string}>}
 */
async function sendOtp(phone10, code) {
  try {
    if (process.env.MSG91_AUTH_KEY) return await sendViaMsg91(phone10, code);
    if (process.env.TWILIO_SID && process.env.TWILIO_TOKEN && process.env.TWILIO_FROM) {
      return await sendViaTwilio(phone10, code);
    }
    if (notify.isWhatsappCloudConfigured()) {
      return await sendViaWhatsapp(phone10, code);
    }
    // No provider configured: dev mode. The code is only ever written to the
    // server console, never returned to the client.
    console.log(
      `DEV ONLY — NO SMS PROVIDER CONFIGURED — OTP for ${phone10}: ${code}`
    );
    return { provider: 'dev-log', ok: true };
  } catch (err) {
    return { provider: 'unknown', ok: false, error: err.message };
  }
}

module.exports = { sendOtp, isSmsConfigured, otpMessage, DEFAULT_WHATSAPP_OTP_TEMPLATE };
