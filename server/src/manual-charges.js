const round = value => Math.round(Number(value) * 100) / 100;
const fault = (message, status = 400) => Object.assign(new Error(message), { status });
const uuid = value => typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);

export function manualChargeInput(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fault('Enter valid charge details.');
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (!description || description.length > 200) throw fault('Enter a charge description of 200 characters or fewer.');
  const quantity = Number(body.quantity);
  if (!['string', 'number'].includes(typeof body.quantity) || !Number.isInteger(quantity) || quantity < 1 || quantity > 10000) {
    throw fault('Enter a whole number of nights or items between 1 and 10,000.');
  }
  if (!['string', 'number'].includes(typeof body.unitAmount) || !/^\d+(?:\.\d{1,2})?$/.test(String(body.unitAmount)) ||
      !Number.isFinite(Number(body.unitAmount)) || Number(body.unitAmount) <= 0 || quantity * Number(body.unitAmount) > 99999999.99) {
    throw fault('Enter a positive rate with up to two decimal places and a charge total below $100,000,000.');
  }
  const serviceDate = body.serviceDate ?? '';
  if (typeof serviceDate !== 'string' || serviceDate && (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate) ||
      !Number.isFinite(Date.parse(serviceDate)) || new Date(serviceDate).toISOString().slice(0, 10) !== serviceDate)) {
    throw fault('Choose a valid visit date or leave it blank.');
  }
  if (!uuid(body.requestId)) throw fault('A charge request ID is required. Refresh and try again.');
  if (body.replaceAutomaticBalance !== undefined && typeof body.replaceAutomaticBalance !== 'boolean') throw fault('Enter valid charge details.');
  // Keep the legacy flag in the request fingerprint for safe retries. New
  // entries always replace the balance, including requests from older clients.
  return { id: body.requestId, description, quantity, unitAmount: round(body.unitAmount),
    amount: round(quantity * Number(body.unitAmount)), serviceDate, replaceAutomaticBalance: body.replaceAutomaticBalance ?? true };
}

// Charges are exact office-entered amounts for every tender. They do not inherit
// nightly discounts, free nights, card rounding, or the calculated night limit.
export function applyManualCharges(row, billing) {
  const ledger = row.manual_charges;
  const entries = ledger?.version === 1 && Array.isArray(ledger.entries) ? ledger.entries : [];
  const total = round(entries.filter(entry => !entry.voidedAt).reduce((sum, entry) => sum + Number(entry.amount), 0));
  // Older additive entries also replace automatic pricing. Preserve payments
  // collected since the original entry instead of resetting their paid baseline.
  const replace = ledger?.version === 1 && (ledger.mode === 'replace' || entries.some(entry => !entry.voidedAt));
  const details = { manualCharges: entries, manualChargeTotal: total, manualChargePricingMode: replace ? 'replace' : 'add' };
  if (!replace) return { ...billing, ...details };
  const paidBaseline = ledger.amountPaidBeforeOverride ?? ledger.amountPaidAtFirstCharge ?? billing.amountPaid;
  const totalPrice = round(Number(paidBaseline) + total);
  const remaining = round(Math.max(totalPrice - billing.amountPaid, 0));
  return { ...billing, ...details,
    bankTotalPrice: totalPrice, cardTotalPrice: totalPrice, effectiveTotalPrice: totalPrice,
    remainingBalance: remaining, bankRemainingBalance: remaining, cardRemainingBalance: remaining,
    bankDailyPrice: null, cardDailyPrice: null, totalChargeableNights: null, paidChargeableNights: null,
    unpaidChargeableNights: null, totalStayNights: null, paidStayNights: null, unpaidStayNights: null,
    cardPaymentOptions: [], partialPaymentCredit: 0 };

}

export function registerManualChargeRoutes(app, { pool, getReservation, notify, now = () => new Date() }) {
  async function change(req, res, action) {
    let input;
    try {
      if (!/^[1-9]\d*$/.test(String(req.params.id))) throw fault('Choose a reservation.');
      if (action === 'add') input = manualChargeInput(req.body);
      if (action === 'void' && !uuid(req.params.chargeId)) throw fault('Choose a valid charge.');
    } catch (error) { return res.status(error.status || 400).json({ message: error.message }); }
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const locked = await client.query('SELECT id FROM reservations WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!locked.rowCount) throw fault('Reservation not found.', 404);
      const reservation = await getReservation(client, req.params.id);
      if (String(reservation.id) !== String(req.params.id) || reservation.merged_into_reservation_id) {
        throw fault('Open the combined reservation to change its charges.', 409);
      }
      if (!['active', 'pending'].includes(reservation.status)) throw fault('Only active or pending reservations can have their charges changed.', 409);
      const ledger = structuredClone(reservation.manual_charges || { version: 1, mode: 'add', entries: [] });
      let changed = true;
      if (action === 'add') {
        const prior = ledger.entries.find(entry => entry.id === input.id);
        if (prior) {
          if (Object.keys(input).some(key => prior[key] !== input[key])) throw fault('This charge request already has different details. Refresh and try again.', 409);
          changed = false;
        } else {
          const replacedAt = now().toISOString();
          for (const entry of ledger.entries) if (!entry.voidedAt) {
            entry.voidedAt = replacedAt;
            entry.voidedByAdminUserId = req.adminUser.id;
            entry.replacedByChargeId = input.id;
          }
          ledger.mode = 'replace';
          ledger.amountPaidBeforeOverride = reservation.amountPaid;
          ledger.replacedAt = replacedAt;
          ledger.replacedByAdminUserId = req.adminUser.id;
          ledger.entries.push({ ...input, createdAt: now().toISOString(), adminUserId: req.adminUser.id });
        }
      } else if (action === 'void') {
        const entry = ledger.entries.find(entry => entry.id === req.params.chargeId);
        if (!entry) throw fault('Charge not found.', 404);
        changed = !entry.voidedAt;
        if (changed) { entry.voidedAt = now().toISOString(); entry.voidedByAdminUserId = req.adminUser.id; }
      } else {
        if (ledger.entries.some(entry => !entry.voidedAt)) throw fault('Void the manual charges before restoring automatic pricing.', 409);
        changed = ledger.mode === 'replace';
        ledger.mode = 'add';
        ledger.restoredAt = now().toISOString();
        ledger.restoredByAdminUserId = req.adminUser.id;
      }
      if (changed) await client.query('UPDATE reservations SET manual_charges=$2::jsonb WHERE id=$1', [req.params.id, JSON.stringify(ledger)]);
      const updated = await getReservation(client, req.params.id);
      await client.query('COMMIT');
      if (changed) notify({ reason: 'reservation_manual_charges_updated', reservationId: Number(req.params.id) });
      return res.json(updated);
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      const missing = ['42703', '42P01'].includes(error.code);
      return res.status(missing ? 503 : error.status || 500).json({ message: missing
        ? 'Run sql/2026-11-04_manual_reservation_charges.sql to enable manual charges.'
        : error.status ? error.message : 'Unable to confirm the charge. Retry the same charge to check whether it was saved.' });
    } finally { client?.release(); }
  }
  app.post('/api/reservations/:id/manual-charges', (req, res) => change(req, res, 'add'));
  app.post('/api/reservations/:id/manual-charges/:chargeId/void', (req, res) => change(req, res, 'void'));
  app.post('/api/reservations/:id/manual-charges/restore-automatic', (req, res) => change(req, res, 'restore'));
}
