// Admin portal i18n parity test — no server needed.
// Requires public/js/admin-i18n.js (UMD: works in Node) and asserts the
// English and Telugu dictionaries have exactly the same keys, every value
// is a non-empty string, and the t() fallback/interpolation behave.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { ADMIN_I18N, t, getAdminLanguage, setAdminLanguage } =
  require('../public/js/admin-i18n.js');

test('admin i18n dictionaries have exact key parity (en vs te)', () => {
  const enKeys = Object.keys(ADMIN_I18N.en).sort();
  const teKeys = Object.keys(ADMIN_I18N.te).sort();
  assert.ok(enKeys.length > 0, 'expected a non-empty English dictionary');
  const missingInTe = enKeys.filter((k) => !Object.prototype.hasOwnProperty.call(ADMIN_I18N.te, k));
  const extraInTe = teKeys.filter((k) => !Object.prototype.hasOwnProperty.call(ADMIN_I18N.en, k));
  assert.deepEqual(missingInTe, [], `keys missing in te: ${missingInTe.join(', ')}`);
  assert.deepEqual(extraInTe, [], `keys extra in te: ${extraInTe.join(', ')}`);
  assert.equal(teKeys.length, enKeys.length);
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

  // Unknown language falls back to English; unknown key returns the key.
  setAdminLanguage('xx');
  assert.equal(getAdminLanguage(), 'en');
  assert.equal(t('does.not.exist'), 'does.not.exist');

  // Missing interpolation params leave the placeholder untouched.
  assert.equal(t('common.guests_count'), '{count} guests');
});
