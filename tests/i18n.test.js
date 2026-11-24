// Admin portal i18n parity test — no server needed.
// Requires public/js/admin-i18n.js (UMD: works in Node) and asserts every
// dictionary has exactly the same keys as English, every value is a
// non-empty string, and the t() fallback/interpolation behave.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { ADMIN_I18N, t, getAdminLanguage, setAdminLanguage } =
  require('../public/js/admin-i18n.js');

test('admin i18n dictionaries have exact key parity with English', () => {
  const enKeys = Object.keys(ADMIN_I18N.en).sort();
  assert.ok(enKeys.length > 0, 'expected a non-empty English dictionary');
  for (const [lang, dict] of Object.entries(ADMIN_I18N)) {
    if (lang === 'en') continue;
    const keys = Object.keys(dict).sort();
    const missing = enKeys.filter((k) => !Object.prototype.hasOwnProperty.call(dict, k));
    const extra = keys.filter((k) => !Object.prototype.hasOwnProperty.call(ADMIN_I18N.en, k));
    assert.deepEqual(missing, [], `keys missing in ${lang}: ${missing.join(', ')}`);
    assert.deepEqual(extra, [], `keys extra in ${lang}: ${extra.join(', ')}`);
    assert.equal(keys.length, enKeys.length);
  }
});

test('every admin i18n value is a non-empty string', () => {
  for (const [lang, dict] of Object.entries(ADMIN_I18N)) {
    for (const [key, value] of Object.entries(dict)) {
      assert.equal(typeof value, 'string', `${lang}.${key} should be a string`);
      assert.ok(value.trim().length > 0, `${lang}.${key} must not be empty`);
    }
  }
});

test('t() interpolates {params}, falls back to English, then to the key', () => {
  // Default language is English in Node (no localStorage).
  assert.equal(getAdminLanguage(), 'en');
  assert.equal(t('common.guests_count', { count: 5 }), '5 guests');
  assert.equal(t('bookings.quotation_title', { quote: 'SJC-1' }), 'Quotation SJC-1');

  // Telugu: switch, check a value + interpolation, switch back.
  setAdminLanguage('te');
  assert.equal(getAdminLanguage(), 'te');
  assert.equal(t('common.guests_count', { count: 5 }), '5 అతిథులు');
  assert.equal(t('nav.dashboard'), 'డాష్‌బోర్డ్');
  setAdminLanguage('en');

  // Hindi: same check.
  setAdminLanguage('hi');
  assert.equal(getAdminLanguage(), 'hi');
  assert.equal(t('common.guests_count', { count: 5 }), '5 मेहमान');
  assert.equal(t('nav.dashboard'), 'डैशबोर्ड');
  setAdminLanguage('en');

  // Unknown language falls back to English; unknown key returns the key.
  setAdminLanguage('xx');
  assert.equal(getAdminLanguage(), 'en');
  assert.equal(t('does.not.exist'), 'does.not.exist');

  // Missing interpolation params leave the placeholder untouched.
  assert.equal(t('common.guests_count'), '{count} guests');
});
