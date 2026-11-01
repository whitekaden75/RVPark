import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { monthlyOfficePayment, registerMonthlyOfficePaymentRoutes } from "./monthly-office-payments.js";

const requestId = "8d517000-1111-4444-8888-000000000001";
const body = { requestId, amount: "900.00", tenderType: "cash", paymentDate: "2026-11-01", paymentMonth: "2026-11", note: "Rent" };
const booking = { id: 42, status: "active", billing_mode: "monthly", amountPaid: 900, bankRemainingBalance: 0,
  first_name: "Test", siteStays: [{ arrival_date: "2026-10-01", leave_date: "2027-01-01" }] };

function fixture({ row = booking, failAt, missingMigration = false } = {}) {
  const handlers = {}, statements = [], notifications = [];
  let stored = structuredClone(row), payments = [], snapshot;
  const query = async (sql, values) => {
    statements.push(sql);
    if (sql === "BEGIN") snapshot = structuredClone({ stored, payments });
    if (sql === "ROLLBACK" && snapshot) ({ stored, payments } = snapshot);
    if (sql.startsWith("SELECT id FROM reservations")) return { rowCount: stored ? 1 : 0 };
    if (sql.includes("WHERE office_recording_request_id")) {
      if (missingMigration) throw Object.assign(new Error("missing"), { code: "42703" });
      return { rows: payments.filter(payment => payment.requestId === values[0]) };
    }
    if (sql.startsWith("INSERT INTO reservation_payment_events")) {
      if (failAt === "insert") throw new Error("write failed");
      const [reservation_id, amount, note, payment_date, tender_type, check_number, billing_month, id, adminId] = values;
      const payment = { id: payments.length + 1, reservation_id, amount, note, payment_date, tender_type, check_number, billing_month,
        requestId: id, adminId, payment_source: "office_card_reader", recorded_at: `${payment_date}T20:00:00Z`, created_at: "2026-11-01T21:00:00Z" };
      payments.push(payment); return { rows: [payment] };
    }
    if (sql.startsWith("UPDATE reservations SET amount_paid")) {
      if (failAt === "update") throw new Error("write failed");
      stored.amountPaid += values[1]; stored.status = "active";
    }
    if (sql.includes("FROM reservation_payment_events")) return { rows: payments };
    return { rows: [], rowCount: 1 };
  };
  const client = { query, release: () => statements.push("RELEASE") };
  const getReservation = async () => stored && { ...stored, paymentEvents: payments };
  registerMonthlyOfficePaymentRoutes({ get: (path, handler) => handlers.get = handler, post: (path, handler) => handlers.post = handler },
    { pool: { connect: async () => client, query }, getReservation,
      notify: event => notifications.push(event), now: () => new Date("2026-11-01T19:00:00Z") });
  const call = async (payload = body, method = "post") => {
    const res = { code: 200, status(code) { this.code = code; return this; }, setHeader() {}, json(value) { this.body = value; return this; } };
    await handlers[method]({ params: { id: "42" }, body: payload, adminUser: { id: 7 } }, res);
    return res;
  };
  return { call, statements, notifications, payments: () => payments, stored: () => stored };
}

test("monthly cash receipts update the booking and existing ledger despite a zero nightly balance", async () => {
  const f = fixture(), result = await f.call();
  assert.equal(result.code, 201); assert.equal(result.body.reservation.amountPaid, 1800);
  assert.equal(result.body.payment.tenderType, "cash"); assert.equal(result.body.payment.paymentMonth, "2026-11");
  assert.equal(result.body.payment.paymentDate, "2026-11-01"); assert.equal(f.payments()[0].adminId, 7);
  assert.equal(f.notifications.length, 1);
  assert.ok(f.statements.includes("COMMIT")); assert.ok(f.statements.some(sql => sql.includes("FOR UPDATE")));
});

test("checks retain their number, support partial receipts and record a chosen earlier receipt date", async () => {
  const f = fixture(), result = await f.call({ ...body, tenderType: "check", checkNumber: " 001234 ", amount: "350.25", paymentDate: "2026-10-31" });
  assert.equal(result.code, 201); assert.equal(result.body.payment.checkNumber, "001234");
  assert.equal(result.body.payment.paymentDate, "2026-10-31"); assert.equal(result.body.reservation.amountPaid, 1250.25);
  assert.match(f.payments()[0].note, /Tender: check\. Price type: bank/);
  const history = await f.call({}, "get"); assert.equal(history.body.payments.length, 1);
  assert.equal(history.body.payments[0].tenderType, "check");
});

test("lost responses and repeated saves reuse one receipt without doubling booking or bookkeeping totals", async () => {
  const f = fixture(); await f.call();
  const retry = await f.call();
  assert.equal(retry.code, 200); assert.equal(retry.body.duplicate, true);
  assert.equal(f.payments().length, 1); assert.equal(f.stored().amountPaid, 1800);
  assert.equal(f.notifications.length, 1);
  for (const change of [{ amount: "100" }, { tenderType: "check", checkNumber: "123" }, { paymentMonth: "2026-10" }, { note: "different" }]) {
    assert.equal((await f.call({ ...body, ...change })).code, 409);
  }
  assert.equal(f.payments().length, 1);
});

test("later months are new payments and pending, marked-monthly and legacy open-ended bookings are supported", async () => {
  const f = fixture(); await f.call();
  assert.equal((await f.call({ ...body, requestId: "8d517000-1111-4444-8888-000000000002", paymentMonth: "2026-12" })).code, 201);
  assert.equal(f.stored().amountPaid, 2700);
  for (const row of [{ ...booking, status: "pending" }, { ...booking, billing_mode: "standard", monthly_classification: true },
    { ...booking, billing_mode: "standard", reservation_term: "yearly" },
    { ...booking, billing_mode: "standard", siteStays: [{ arrival_date: "2026-10-01", leave_date: "9999-12-31" }] }]) {
    assert.equal((await fixture({ row }).call()).code, 201);
  }
});

test("invalid amounts, dates, months, tenders and missing check numbers cannot create receipts", () => {
  for (const amount of [0, -1, "", true, null, "NaN", "1.234", "Infinity", "100000000.00"]) {
    assert.throws(() => monthlyOfficePayment({ ...body, amount }, "2026-11-01"));
  }
  for (const change of [{ tenderType: "card" }, { tenderType: "check" }, { paymentDate: "2026-02-30" },
    { paymentDate: "2026-11-02" }, { paymentMonth: "2026-13" }, { requestId: "invalid" }, { note: "a".repeat(501) }]) {
    assert.throws(() => monthlyOfficePayment({ ...body, ...change }, "2026-11-01"));
  }
});

test("daily, canceled, merged and missing bookings cannot be credited; write failures roll everything back", async () => {
  for (const row of [{ ...booking, status: "canceled" }, { ...booking, merged_into_reservation_id: 1 }, { ...booking, id: 99 },
    { ...booking, billing_mode: "standard", siteStays: [{ arrival_date: "2026-11-01", leave_date: "2026-11-03" }] }]) {
    const f = fixture({ row }); assert.equal((await f.call()).code, 409); assert.equal(f.payments().length, 0);
  }
  assert.equal((await fixture({ row: null }).call()).code, 404);
  for (const failAt of ["insert", "update"]) {
    const f = fixture({ failAt }); assert.equal((await f.call()).code, 500);
    assert.equal(f.payments().length, 0); assert.equal(f.stored().amountPaid, 900);
    assert.ok(f.statements.includes("ROLLBACK")); assert.equal(f.notifications.length, 0);
  }
  const missing = fixture({ missingMigration: true });
  assert.equal((await missing.call()).code, 503); assert.equal(missing.payments().length, 0);
});

test("saving a meter reading never sends a monthly text, including the legacy sendBillingMessage flag", async () => {
  const source = readFileSync(new URL("./index.js", import.meta.url), "utf8");
  const start = source.indexOf('app.post("/api/reservations/:id/monthly-meter-readings",');
  const end = source.indexOf('\napp.put("/api/reservations/:id/monthly-settings",', start);
  let handler, sent = 0;
  vm.runInContext(source.slice(start, end), vm.createContext({
    app: { post: (_, fn) => handler = fn },
    pool: { query: async sql => sql.includes("SELECT reading") ? { rows: [{ reading: 100 }] }
      : sql.includes("INSERT INTO") ? { rows: [{ id: 1, reading: 300 }] }
      : sql.includes("monthly_recurring_charges") ? { rows: [{ description: "Storage", amount: 20 }] } : { rows: [] } },
    fetchReservationDetails: async () => ({ id: 42, monthlyRentPrice: 900, first_name: "Guest" }),
    createGuestPaymentLinkToken: () => "token", normalizeSmsPhoneNumber: () => "",
    roundCurrency: value => Math.round(value * 100) / 100,
    addSmsComplianceFooter: text => text, process: { env: { CLIENT_ORIGIN: "https://park.example" } },
    makeTwilioRequest: async () => { sent++; throw Error("must never send"); }
  }));
  for (const flags of [{ sendBillingMessage: true }, { prepareBillingMessage: true, sendBillingMessage: true }]) {
    const res = { code: 200, status(code) { this.code = code; return this; }, json(value) { this.body = value; } };
    await handler({ params: { id: 42 }, body: { reading: 300, ...flags } }, res);
    assert.equal(res.code, 201); assert.equal(sent, 0);
    if (flags.prepareBillingMessage) assert.equal(res.body.billingMessage.total, 920);
  }
});
