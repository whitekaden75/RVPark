import test from 'node:test';
import assert from 'node:assert/strict';
import { buildParkAudience } from './park-broadcasts.js';

const normalize = value => {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits.startsWith('1') ? `+${digits}` : '';
};
const guest = (id, fields = {}) => ({ id, first_name: 'Guest', last_name: String(id), phone_number: '5415550101', sites: ['2'], ...fields });

test('park audience includes daily, monthly, yearly and deduplicates formatted shared numbers', () => {
  const result = buildParkAudience([
    guest(1), guest(2, { phone_number: '(541) 555-0102', is_monthly: true }),
    guest(3, { phone_number: '+1 541 555 0103', reservation_term: 'yearly', is_monthly: true }),
    guest(4, { phone_number: '+1 (541) 555-0101' }),
    guest(5, { phone_number: '' }), guest(6, { phone_number: '123' }),
  ], '2026-11-12', normalize);
  assert.equal(result.recipientCount, 3);
  assert.equal(result.skippedCount, 3);
  assert.deepEqual(result.recipients.filter(row => row.eligible).map(row => row.stayType), ['Daily', 'Monthly', 'Yearly']);
  assert.match(result.recipients[3].skipReason, /Shared number/);
  assert.equal(result.recipients[4].skipReason, 'No valid mobile number');
});

test('opt-outs apply to all current bookings sharing a mobile number', () => {
  const result = buildParkAudience([guest(1), guest(2, { notes: 'Guest did not opt in to text messages.' })], '2026-11-12', normalize);
  assert.equal(result.recipientCount, 0);
  assert.ok(result.recipients.every(row => row.skipReason === 'Guest opted out of texts'));
});

test('review fingerprint changes when the date, phone, guests, sites or consent changes', () => {
  const fingerprint = (rows, date = '2026-11-12') => buildParkAudience(rows, date, normalize).fingerprint;
  const original = fingerprint([guest(1)]);
  assert.equal(fingerprint([guest(1)]), original);
  for (const rows of [[guest(1), guest(2)], [guest(1, { phone_number: '5415550199' })],
    [guest(1, { sites: ['3'] })], [guest(1, { notes: 'Guest did not opt in to text messages.' })]]) {
    assert.notEqual(fingerprint(rows), original);
  }
  assert.notEqual(fingerprint([guest(1)], '2026-11-13'), original);
});
