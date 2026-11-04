import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { manualChargeInput, registerManualChargeRoutes } from './manual-charges.js';
import { buildBillingSummary, sumReservationTotals } from './reservation-pricing.js';
import { applyBalanceWaiver, getBalanceWaiverScope } from './pricing-waivers.js';
import { combinedBookingPlan } from './combined-bookings.js';

const id = '11111111-1111-4111-8111-111111111111';
const payload = { requestId: id, description: 'November visit', quantity: 3, unitAmount: '55.00', serviceDate: '2026-11-12', replaceAutomaticBalance: true };
const row = { id: 42, status: 'active', billing_mode: 'standard', reservation_term: 'standard', amount_paid: 140, payment_method: 'bank', requested_discounts: [] };
const totals = sumReservationTotals([{ numberOfNights: 4, normalDailyPrice: 40, discountDailyPrice: 35,
  arrival_date: '2026-11-01', leave_date: '2026-11-05' }]);
const entry = manualChargeInput(payload);
const ledger = { version: 1, mode: 'replace', amountPaidBeforeOverride: 140, entries: [entry, { ...entry, id: '22222222-2222-4222-8222-222222222222', description: 'December visit' }] };
const bill = (changes = {}, events = [{ id: 1, amount: 140, note: 'Price type: bank' }]) => buildBillingSummary({ ...row, ...changes }, totals, events);

test('six manually priced nights replace the incorrect $20 balance and preserve past receipts', () => {
  assert.equal(bill().bankRemainingBalance, 20);
  const result = bill({ manual_charges: ledger });
  assert.equal(result.amountPaid, 140);
  assert.equal(result.manualChargeTotal, 330);
  assert.equal(result.bankTotalPrice, 470);
  assert.equal(result.bankRemainingBalance, 330);
  assert.equal(result.cardRemainingBalance, 330);
  assert.equal(result.unpaidStayNights, null);
  assert.deepEqual(result.cardPaymentOptions, []);
  for (const method of ['bank', 'card']) {
    assert.equal(bill({ manual_charges: ledger, amount_paid: 305, payment_method: method }).remainingBalance, 165);
    assert.equal(bill({ manual_charges: ledger, amount_paid: 470, payment_method: method }).remainingBalance, 0);
  }
  assert.equal(bill({ manual_charges: ledger, amount_paid: 140, requested_discounts: ['AAA'] }).bankRemainingBalance, 330);
});

test('existing additive entries replace the old $20 balance while retaining payments already collected', () => {
  const manual_charges = { ...ledger, mode: 'add', amountPaidAtFirstCharge: 140 };
  delete manual_charges.amountPaidBeforeOverride;
  assert.equal(bill({ manual_charges }).bankRemainingBalance, 330);
  assert.equal(bill({ manual_charges, amount_paid: 305 }).bankRemainingBalance, 165);
  assert.equal(bill({ manual_charges, amount_paid: 470 }).cardRemainingBalance, 0);
});

test('unknown, monthly and manual-total base prices can be replaced with exact office charges', () => {
  for (const billing_mode of ['monthly', 'manual_total', 'standard']) {
    const result = buildBillingSummary({ ...row, manual_charges: ledger, billing_mode, total_price: 1000, manual_pricing_override: true },
      { normalPrice: null, discountPrice: null, numberOfNights: null, chargeableNights: null });
    assert.equal(result.bankRemainingBalance, 330);
    assert.equal(result.cardRemainingBalance, 330);
    assert.equal(result.amountPaid, 140);
  }
});

test('voids retain history and payments; adding a charge invalidates an old balance waiver', () => {
  const manual_charges = { ...ledger, entries: ledger.entries.map(entry => ({ ...entry, voidedAt: '2026-11-04T20:00:00Z' })) };
  assert.equal(bill({ manual_charges }).bankRemainingBalance, 0);
  assert.equal(bill({ manual_charges }).manualCharges.length, 2);
  const waivedRow = { ...row, balance_waiver: { scope: getBalanceWaiverScope(row), waivedAt: '2026-11-04T20:00:00Z' } };
  assert.equal(applyBalanceWaiver(waivedRow, [], bill()).bankRemainingBalance, 0);
  assert.equal(applyBalanceWaiver({ ...waivedRow, manual_charges: ledger }, [], bill({ manual_charges: ledger })).bankRemainingBalance, 330);
  const withCharge = { ...row, manual_charges: ledger };
  const waiver = { scope: getBalanceWaiverScope(withCharge), waivedAt: '2026-11-04T20:00:00Z' };
  assert.equal(applyBalanceWaiver({ ...withCharge, balance_waiver: waiver }, [], bill({ manual_charges: ledger })).bankRemainingBalance, 0);
});

test('invalid rates, quantities, dates and request identities are rejected before writes', () => {
  for (const changes of [{ unitAmount: 'NaN' }, { unitAmount: Infinity }, { unitAmount: true }, { unitAmount: '1.001' },
    { unitAmount: 0 }, { quantity: 1.5 }, { quantity: true }, { quantity: 0 }, { quantity: 10001 }, { unitAmount: 99999999.99 },
    { description: '' }, { description: 'a'.repeat(201) }, { serviceDate: '2026-02-30' }, { requestId: 'bad' }, { replaceAutomaticBalance: 'yes' }]) {
    assert.throws(() => manualChargeInput({ ...payload, ...changes }), undefined, JSON.stringify(changes));
  }
  assert.equal(manualChargeInput({ ...payload, unitAmount: '0.29' }).amount, 0.87);
});

test('combining cannot double count or lose active manual charges', () => {
  assert.throws(() => combinedBookingPlan({ ...row, manual_charges: ledger }, row), /Void the manual charges/);
});

const runtime = process.env.RVPARK_TEST_PGLITE_MODULE;
test('PostgreSQL persists, deduplicates, voids and rolls back manual charges without changing receipts', { skip: !runtime }, async () => {
  const { PGlite } = await import(runtime);
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE reservations(id bigint PRIMARY KEY, status text, amount_paid numeric(14,2), merged_into_reservation_id bigint);
      INSERT INTO reservations VALUES(42,'active',140,NULL),(43,'canceled',0,NULL),(44,'active',0,42);`);
    const migration = await readFile(new URL('../../sql/2026-11-04_manual_reservation_charges.sql', import.meta.url), 'utf8');
    await db.exec(migration); await db.exec(migration);
    const query = async (...args) => { const result = await db.query(...args); return { ...result, rowCount: result.rows.length || result.affectedRows || 0 }; };
    const getReservation = async (_client, reservationId) => {
      const record = (await db.query('SELECT * FROM reservations WHERE id=$1', [reservationId])).rows[0];
      if (!record) return null;
      const data = { ...row, ...record };
      return { ...data, ...buildBillingSummary(data, totals) };
    };
    const handlers = {}, notifications = [];
    registerManualChargeRoutes({ post: (path, handler) => { handlers[path] = handler; } }, {
      pool: { connect: async () => ({ query, release() {} }) }, getReservation,
      notify: event => notifications.push(event), now: () => new Date('2026-11-04T20:00:00Z'),
    });
    const call = async (suffix = '', body = payload, reservationId = '42') => {
      const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
      await handlers[`/api/reservations/:id/manual-charges${suffix}`]({ params: { id: reservationId, chargeId: id }, body, adminUser: { id: 7 } }, res);
      return res;
    };
    const first = await call();
    assert.equal(first.code, 200, first.body.message);
    assert.equal(first.body.bankRemainingBalance, 165);
    assert.equal(first.body.amountPaid, 140);
    assert.equal(first.body.manualCharges[0].adminUserId, 7);
    assert.equal((await call()).body.manualCharges.length, 1);
    assert.equal(notifications.length, 1);
    assert.equal((await call('', { ...payload, unitAmount: '56' })).code, 409);
    assert.equal((await call('', payload, '43')).code, 409);
    assert.equal((await call('', payload, '44')).code, 409);
    assert.equal((await call('', payload, '99')).code, 404);
    assert.equal((await call('/restore-automatic', {})).code, 409);
    const second = await call('', { ...payload, requestId: '22222222-2222-4222-8222-222222222222', description: 'December visit', serviceDate: '2026-12-12' });
    assert.equal(second.body.bankRemainingBalance, 165);
    assert.equal(second.body.manualCharges[0].replacedByChargeId, '22222222-2222-4222-8222-222222222222');
    assert.equal(second.body.manualCharges[1].voidedAt, undefined);
    const third = await call('', { ...payload, requestId: '33333333-3333-4333-8333-333333333333', unitAmount: '60', replaceAutomaticBalance: false });
    assert.equal(third.body.bankRemainingBalance, 180);
    assert.equal(third.body.manualCharges.filter(entry => !entry.voidedAt).length, 1);
    await db.exec('UPDATE reservations SET amount_paid=305 WHERE id=42');
    assert.equal((await getReservation(db, 42)).cardRemainingBalance, 15);
    assert.equal((await call('/:chargeId/void', {})).body.bankRemainingBalance, 15);
    await db.exec('UPDATE reservations SET amount_paid=320 WHERE id=42');
    const voided = await call('/:chargeId/void', {});
    assert.equal(voided.body.bankRemainingBalance, 0);
    assert.equal(voided.body.amountPaid, 320);
    assert.equal(voided.body.manualCharges[0].voidedByAdminUserId, 7);
    const beforeRepeat = notifications.length;
    await call('/:chargeId/void', {});
    assert.equal(notifications.length, beforeRepeat);
    await db.exec(`CREATE FUNCTION reject_charge_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$;
      CREATE TRIGGER reject_charge_write BEFORE UPDATE ON reservations FOR EACH ROW EXECUTE FUNCTION reject_charge_write();`);
    assert.equal((await call('', { ...payload, requestId: '44444444-4444-4444-8444-444444444444' })).code, 500);
    assert.equal((await getReservation(db, 42)).manualCharges.length, 3);
    assert.equal(notifications.length, beforeRepeat);
  } finally { await db.close(); }
});
