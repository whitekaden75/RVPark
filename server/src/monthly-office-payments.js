import { isMonthlyAccount } from "./bookkeeping-lodging.js";

const validDate = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const pacificDate = date => new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit"
}).format(date);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export function monthlyOfficePayment(body = {}, today = pacificDate(new Date())) {
  const { amount, tenderType, paymentDate, paymentMonth, requestId } = body;
  if (!["string", "number"].includes(typeof amount) || !/^\d+(?:\.\d{1,2})?$/.test(String(amount)) ||
      !Number.isFinite(Number(amount)) || Number(amount) <= 0 || Number(amount) > 99999999.99) {
    throw fail("Enter the amount received, greater than zero, with up to two decimal places.");
  }
  if (!["cash", "check"].includes(tenderType)) throw fail("Choose cash or check.");
  const checkNumber = typeof body.checkNumber === "string" ? body.checkNumber.trim() : "";
  if (tenderType === "check" && (!checkNumber || checkNumber.length > 50)) {
    throw fail("Enter a check number of 50 characters or fewer.");
  }
  if (!validDate(paymentDate) || paymentDate > today) throw fail("Choose a valid payment date that is today or earlier.");
  if (typeof paymentMonth !== "string" || !/^\d{4}-\d{2}$/.test(paymentMonth) || !validDate(`${paymentMonth}-01`)) {
    throw fail("Choose the month this payment covers.");
  }
  if (typeof requestId !== "string" || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(requestId)) {
    throw fail("A payment request ID is required. Refresh and try again.");
  }
  if (body.note !== undefined && typeof body.note !== "string") throw fail("Enter a valid payment note.");
  const note = (body.note || "").trim();
  if (note.length > 500) throw fail("Payment notes must be 500 characters or fewer.");
  return { amount: Math.round(Number(amount) * 100) / 100, tenderType,
    checkNumber: tenderType === "check" ? checkNumber : "", paymentDate,
    paymentMonth, requestId, note };
}

export function serializeMonthlyPayment(row) {
  return { id: row.id, amount: Number(row.amount), paymentSource: row.payment_source,
    tenderType: row.tender_type || null, checkNumber: row.check_number || "",
    paymentMonth: row.billing_month?.slice(0, 7) || "", paymentDate: row.payment_date,
    note: row.note || "", recordedAt: row.recorded_at, createdAt: row.created_at };
}

const paymentFields = `id, reservation_id, amount, payment_source, note, recorded_at, created_at,
  to_jsonb(reservation_payment_events)->>'office_tender_type' AS tender_type,
  to_jsonb(reservation_payment_events)->>'office_check_number' AS check_number,
  to_jsonb(reservation_payment_events)->>'billing_month' AS billing_month,
  (recorded_at AT TIME ZONE 'America/Los_Angeles')::date::text AS payment_date`;

export function registerMonthlyOfficePaymentRoutes(app, { pool, getReservation, notify, now = () => new Date() }) {
  app.get("/api/reservations/:id/monthly-payments", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    if (!/^[1-9]\d*$/.test(String(req.params.id))) return res.status(400).json({ message: "A reservation is required." });
    try {
      const reservation = await getReservation(pool, req.params.id);
      if (!reservation) return res.status(404).json({ message: "Reservation not found." });
      if (String(reservation.id) !== String(req.params.id)) return res.status(409).json({ message: "Open the combined booking to view its payments." });
      const result = await pool.query(`SELECT ${paymentFields} FROM reservation_payment_events
        WHERE reservation_id = $1 ORDER BY recorded_at DESC, id DESC`, [req.params.id]);
      return res.json({ payments: result.rows.map(serializeMonthlyPayment) });
    } catch {
      return res.status(500).json({ message: "Unable to load payment history. Please try again." });
    }
  });

  app.post("/api/reservations/:id/monthly-office-payments", async (req, res) => {
    let payment;
    try {
      if (!/^[1-9]\d*$/.test(String(req.params.id))) throw fail("A reservation is required.");
      payment = monthlyOfficePayment(req.body, pacificDate(now()));
    } catch (error) {
      return res.status(error.status || 400).json({ message: error.message });
    }
    let client;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      const locked = await client.query("SELECT id FROM reservations WHERE id = $1 FOR UPDATE", [req.params.id]);
      if (!locked.rowCount) throw fail("Reservation not found.", 404);
      const reservation = await getReservation(client, req.params.id);
      if (String(reservation.id) !== String(req.params.id) || reservation.merged_into_reservation_id) {
        throw fail("Open the combined booking before recording a payment.", 409);
      }
      const note = `Monthly payment for ${payment.paymentMonth}${payment.note ? `: ${payment.note}` : ""}.${
        payment.tenderType === "check" ? ` Check number: ${payment.checkNumber}.` : ""
      } Tender: ${payment.tenderType}. Price type: bank`;
      const existing = await client.query(`SELECT ${paymentFields} FROM reservation_payment_events
        WHERE office_recording_request_id = $1`, [payment.requestId]);
      if (existing.rows.length) {
        const prior = existing.rows[0];
        if (String(prior.reservation_id) !== String(req.params.id) || Number(prior.amount) !== payment.amount ||
            prior.tender_type !== payment.tenderType || (prior.check_number || "") !== payment.checkNumber ||
            prior.billing_month !== `${payment.paymentMonth}-01` || prior.payment_date !== payment.paymentDate || prior.note !== note) {
          throw fail("This payment request was already used with different details. Refresh the payment history.", 409);
        }
        await client.query("COMMIT");
        return res.json({ reservation, payment: serializeMonthlyPayment(prior), duplicate: true });
      }
      if (!["active", "pending"].includes(reservation.status) || !isMonthlyAccount(reservation, reservation.siteStays)) {
        throw fail("Only an active or pending monthly booking can accept this payment.", 409);
      }
      // Monthly receipts are recurring collections, independent of a whole-stay/nightly balance.
      // Noon Pacific preserves the entered receipt date across daylight-saving changes.
      const inserted = await client.query(`INSERT INTO reservation_payment_events
        (reservation_id, stripe_payment_record_id, amount, payment_source, note, recorded_at,
         office_tender_type, office_check_number, billing_month, office_recording_request_id, recorded_by_admin_user_id)
        VALUES ($1, NULL, $2, 'office_card_reader', $3,
          ($4::date + TIME '12:00') AT TIME ZONE 'America/Los_Angeles', $5, $6, $7::date, $8, $9)
        RETURNING ${paymentFields}`, [req.params.id, payment.amount, note, payment.paymentDate,
        payment.tenderType, payment.checkNumber || null, `${payment.paymentMonth}-01`, payment.requestId, req.adminUser.id]);
      await client.query(`UPDATE reservations SET amount_paid = COALESCE(amount_paid, 0) + $2,
        status = CASE WHEN status = 'pending' THEN 'active' ELSE status END WHERE id = $1`, [req.params.id, payment.amount]);
      const updated = await getReservation(client, req.params.id);
      await client.query("COMMIT");
      notify({ reason: "monthly_office_payment_recorded", reservationId: Number(req.params.id) });
      return res.status(201).json({ reservation: updated, payment: serializeMonthlyPayment(inserted.rows[0]), duplicate: false });
    } catch (error) {
      if (client) await client.query("ROLLBACK");
      const missingMigration = ["42703", "42P01"].includes(error.code);
      return res.status(missingMigration ? 503 : error.status || 500).json({ message: missingMigration
        ? "Run sql/2026-11-01_monthly_office_payments.sql before recording monthly cash or check payments."
        : error.status ? error.message : "Unable to confirm the payment record. Retry the same payment to check whether it was saved." });
    } finally {
      client?.release();
    }
  });
}
