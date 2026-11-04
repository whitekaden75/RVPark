import test from 'node:test';
import assert from 'node:assert/strict';
import { manualChargePayload, manualChargeStorageKey, saveManualCharge } from './manual-charges.js';
import { getPaymentFollowUps } from './admin-ui.js';

const form = { description: ' December visit ', quantity: '3', unitAmount: '55.00', serviceDate: '2026-12-12', replaceAutomaticBalance: true };
test('manual charge entry preserves the chosen quantity, rate and replacement intent', () => {
  assert.deepEqual(manualChargePayload(form, 'request-1'), { ...form, description: 'December visit', quantity: 3, requestId: 'request-1' });
  assert.equal(manualChargePayload({ ...form, replaceAutomaticBalance: false }, 'request-2').replaceAutomaticBalance, true);
  for (const changes of [{ unitAmount: '' }, { unitAmount: '-5' }, { unitAmount: '1.001' }, { unitAmount: 'NaN' }, { quantity: '1.5' }, { quantity: 0 }, { description: '' }]) {
    assert.throws(() => manualChargePayload({ ...form, ...changes }, 'request-1'));
  }
});

test('lost responses retain the same charge request across retries; successful confirmation clears it', async () => {
  const data = new Map();
  const storage = { setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
  const payload = manualChargePayload(form, 'request-1');
  const calls = [];
  const request = async (path, options) => {
    calls.push({ path, payload: JSON.parse(options.body) });
    if (calls.length === 1) throw new Error('Connection lost');
    return { id: 42, manualChargeTotal: 165 };
  };
  await assert.rejects(saveManualCharge({ reservationId: 42, payload, request, storage }), /Connection lost/);
  assert.deepEqual(JSON.parse(data.get(manualChargeStorageKey(42))), payload);
  await saveManualCharge({ reservationId: 42, payload: JSON.parse(data.get(manualChargeStorageKey(42))), request, storage });
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(data.size, 0);
});

test('rejected input allows corrections while service failures retain a safe retry', async () => {
  for (const status of [400, 409, 500, 503]) {
    const data = new Map();
    const storage = { setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
    await assert.rejects(saveManualCharge({ reservationId: 42, payload: form, storage,
      request: async () => { throw Object.assign(new Error('Failed'), { status }); } }));
    assert.equal(data.size, status < 500 ? 0 : 1);
  }
});

test('an arrived reservation with paid automatic nights still appears for unpaid manual charges', () => {
  const reservation = { id: 42, status: 'active', manualChargeTotal: 165, paidStayNights: 3, unpaidStayNights: 0,
    bankRemainingBalance: 165, cardRemainingBalance: 165,
    siteStays: [{ site_id: 1, site_number: 'A', arrival_date: '2026-11-01', leave_date: '2026-11-04' }] };
  assert.equal(getPaymentFollowUps([reservation], '2026-11-04').length, 1);
  assert.equal(getPaymentFollowUps([{ ...reservation, bankRemainingBalance: 0, cardRemainingBalance: 0 }], '2026-11-04').length, 0);
});
