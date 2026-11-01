import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerMonthlyOfficePaymentRoutes } from "./monthly-office-payments.js";
import { buildBillingSummary, buildPricingRuleLookup, getPricingForSiteAndNights,
  getComplimentaryNightDates, sumReservationTotals } from "./reservation-pricing.js";

// Optional disposable PostgreSQL/WASM runtime; no production connection is used.
const testRuntime = process.env.RVPARK_TEST_PGLITE_MODULE;
test("PostgreSQL validates monthly receipts, dates, retry safety and the guarded Noah migration", { skip: !testRuntime }, async () => {
  const { PGlite } = await import(testRuntime);
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE admin_users(id bigint PRIMARY KEY);
      CREATE TABLE customers(id bigint PRIMARY KEY, first_name text, last_name text, email text);
      CREATE TABLE reservations(id bigint PRIMARY KEY, customer_id bigint REFERENCES customers(id), status text,
        billing_mode text, reservation_term text, amount_paid numeric(14,2), notes text);
      CREATE TABLE rv_sites(id bigint PRIMARY KEY, site_number text);
      CREATE TABLE reservation_site_stays(id bigint PRIMARY KEY, reservation_id bigint REFERENCES reservations(id), site_id bigint REFERENCES rv_sites(id), arrival_date date, leave_date date);
      CREATE TABLE reservation_payment_events(id bigserial PRIMARY KEY, reservation_id bigint REFERENCES reservations(id), stripe_payment_record_id bigint,
        amount numeric(14,2), payment_source text CHECK(payment_source IN ('office_card_reader','stripe')),
        note text, recorded_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now());
      INSERT INTO admin_users VALUES(7);
      INSERT INTO customers VALUES(1,'Test','Guest','guest@example.com'),(2,'Noah','Atkins','noaheatkins@gmail.com');
      INSERT INTO reservations VALUES(42,1,'active','monthly','standard',900,''),(1169,2,'active','standard','standard',113.98,'');
      INSERT INTO rv_sites VALUES(1,'A');
      INSERT INTO reservation_site_stays VALUES(1,42,1,'2026-10-01','2027-01-01'),(2,1169,1,'2026-10-30','2026-11-08');
      INSERT INTO reservation_payment_events(reservation_id,amount,payment_source,note,recorded_at) VALUES
        (1169,56.99,'stripe','Stripe deposit. Price type: card','2026-10-30T02:57:55Z'),
        (1169,56.99,'stripe','Stripe payment. Price type: card','2026-11-01T00:06:27Z');`);
    const setup = await readFile(new URL("../../sql/2026-11-01_monthly_office_payments.sql", import.meta.url), "utf8");
    await db.exec(setup); await db.exec(setup);
    const getReservation = async (_queryable, id) => {
      const row = (await db.query("SELECT * FROM reservations WHERE id=$1", [id])).rows[0];
      if (!row) return null;
      const stays = (await db.query("SELECT site_id,arrival_date::text,leave_date::text FROM reservation_site_stays WHERE reservation_id=$1", [id])).rows;
      return { ...row, amountPaid: Number(row.amount_paid), siteStays: stays };
    };
    const handlers = {};
    let queryFailure;
    const query = async (...args) => {
      try { const result = await db.query(...args); return { ...result, rowCount: result.rows.length || result.affectedRows || 0 }; }
      catch (error) { queryFailure = error; throw error; }
    };
    registerMonthlyOfficePaymentRoutes({ get: (_, fn) => handlers.get = fn, post: (_, fn) => handlers.post = fn }, {
      pool: { query, connect: async () => ({ query, release() {} }) }, getReservation, notify() {}, now: () => new Date("2026-11-01T19:00:00Z")
    });
    const payload = { requestId: "8d517000-1111-4444-8888-000000000001", amount: "900.00", tenderType: "check",
      checkNumber: "001234", paymentDate: "2026-10-31", paymentMonth: "2026-11", note: "Rent" };
    async function call(method, body = payload) {
      const res = { code: 200, setHeader() {}, status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
      await handlers[method]({ params: { id: "42" }, body, adminUser: { id: 7 } }, res); return res;
    }
    const first = await call("post");
    assert.equal(first.code, 201, queryFailure?.message || first.body.message);
    assert.equal(first.body.reservation.amountPaid, 1800);
    assert.equal(first.body.payment.paymentDate, "2026-10-31"); assert.equal(first.body.payment.paymentMonth, "2026-11");
    assert.equal(first.body.payment.checkNumber, "001234");
    assert.equal((await call("post")).body.duplicate, true);
    const history = await call("get"); assert.equal(history.body.payments.length, 1);
    const ledger = (await db.query("SELECT amount,recorded_by_admin_user_id FROM reservation_payment_events WHERE reservation_id=42")).rows;
    assert.equal(ledger.length, 1); assert.equal(Number(ledger[0].amount), 900); assert.equal(Number(ledger[0].recorded_by_admin_user_id), 7);

    const correction = await readFile(new URL("../../sql/2026-11-01_noah_1169_free_night_correction.sql", import.meta.url), "utf8");
    await db.exec(correction); await db.exec(correction);
    const noah = await getReservation(db, 1169);
    const prices = buildPricingRuleLookup([{ site_category: "off_river_small_rig", number_of_days: 1, normal_price: 55, discount_price: 55 }]);
    const stays = noah.siteStays.map(stay => ({ ...stay, ...getPricingForSiteAndNights({}, 9, prices) }));
    const events = (await db.query("SELECT * FROM reservation_payment_events WHERE reservation_id=1169")).rows;
    const totals = sumReservationTotals(stays, getComplimentaryNightDates(noah, stays));
    const bill = buildBillingSummary({ ...noah, payment_method: "card", requested_discounts: [] }, totals, events);
    assert.equal(bill.amountPaid, 113.98); assert.equal(bill.unpaidChargeableNights, 5);
    assert.equal(bill.bankRemainingBalance, 275); assert.equal(bill.cardRemainingBalance, 284.95);
    assert.equal(events.length, 2);
    assert.equal((await db.query("SELECT * FROM reservation_nightly_price_adjustment_events")).rows.length, 1);
    assert.equal((await getReservation(db, 42)).amountPaid, 1800);

    await db.exec("UPDATE reservations SET nightly_price_adjustment=NULL,amount_paid=114.98 WHERE id=1169;");
    await assert.rejects(() => db.exec(correction), /no longer shows \$113.98/);
    await db.exec("ROLLBACK;");
    assert.equal((await getReservation(db, 1169)).nightly_price_adjustment, null);
    assert.equal((await getReservation(db, 1169)).amountPaid, 114.98);
  } finally { await db.close(); }
});
