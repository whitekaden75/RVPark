import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { monthlyPaymentPayload, monthlyPaymentStorageKey, paymentTenderLabel, prepareMonthlyPaymentText, saveMonthlyOfficePayment } from "./monthly-payments.js";

const reservation = { id: 42, first_name: "Guest", phone_number: "5415550101" };
const payment = { id: 1, amount: 900, tenderType: "cash", paymentMonth: "2026-11", paymentDate: "2026-11-01" };
test("cash and check receipts show the actual tender, including existing office records", () => {
  assert.equal(paymentTenderLabel(payment), "Cash");
  assert.equal(paymentTenderLabel({ ...payment, tenderType: "check", checkNumber: "0012" }), "Check #0012");
  assert.equal(paymentTenderLabel({ note: "Office cash payment. Tender: cash. Price type: bank" }), "Cash");
  assert.equal(paymentTenderLabel({ paymentSource: "stripe" }), "Online payment");
});

test("cash clears stale check numbers and check entries require one", () => {
  const form = { ...payment, amount: "900.00", checkNumber: "stale" };
  assert.equal(monthlyPaymentPayload(form, "2026-11-01").checkNumber, "");
  assert.throws(() => monthlyPaymentPayload({ ...form, tenderType: "check", checkNumber: "" }, "2026-11-01"), /check number/);
});

test("failed saves retain the identical request for retry and only one successful save clears it", async () => {
  const values = new Map(), requests = [];
  const storage = { setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const payload = { ...payment, requestId: "same-request" };
  await assert.rejects(() => saveMonthlyOfficePayment({ reservationId: 42, payload, storage, request: async () => { throw Error("Connection lost"); } }), /Connection lost/);
  assert.deepEqual(JSON.parse(values.get(monthlyPaymentStorageKey(42))), payload);
  const result = await saveMonthlyOfficePayment({ reservationId: 42, payload, storage,
    request: async (path, options) => { requests.push([path, JSON.parse(options.body)]); return { payment, duplicate: true }; } });
  assert.equal(result.duplicate, true); assert.equal(values.size, 0);
  assert.deepEqual(requests, [["/reservations/42/monthly-office-payments", payload]]);
});

test("monthly statement buttons prepare a draft and link without ever calling the SMS endpoint", async () => {
  const calls = [];
  const draft = await prepareMonthlyPaymentText({ reservation, amount: "900", paymentMonth: "2026-11", baseUrl: "https://park.example",
    request: async (path, options) => { calls.push([path, JSON.parse(options.body)]); return { paymentUrl: "https://park.example/?pay=token" }; } });
  assert.equal(calls.length, 1); assert.equal(calls[0][0], "/reservations/42/payment-links");
  assert.equal(calls[0][1].customAmount, "900.00");
  assert.equal(draft.to, "5415550101"); assert.match(draft.body, /November 2026/); assert.match(draft.body, /\$900\.00/);
});

test("cash and check receipt buttons only return reviewable drafts", async () => {
  for (const tenderType of ["cash", "check"]) {
    const draft = await prepareMonthlyPaymentText({ reservation, payment: { ...payment, tenderType, checkNumber: "0012" },
      request: () => assert.fail("receipts must not call a payment or SMS API") });
    assert.match(draft.body, new RegExp(tenderType)); assert.match(draft.body, /\$900\.00/);
    assert.match(draft.body, /2026-11-01/);
  }
});

test("saving meter readings keeps staff on the monthly card and preview opens the editable composer only on demand", async () => {
  const source = readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
  const state = { form: null, compose: false, page: "monthly", amounts: {} };
  const context = vm.createContext({
    monthlyEditValues: { 42: { meter: "300" } }, monthlyMeterHistory: { 42: [{ reading: 100 }] },
    window: { confirm: () => true }, formatCurrency: value => `$${value}`, formatPhoneNumber: value => value,
    apiRequest: async () => ({ id: 1, reading: 300, billingMessage: { total: 920 } }),
    setMonthlyMeterHistory() {}, setMonthlyChargeAmounts: fn => { state.amounts = fn(state.amounts); }, setAdminSaveNotice() {},
    ensureReservationsLoaded: async () => {}, setTextMessageError() {}, setTextMessageSuccess() {}, setMessageMode() {},
    setTextMessageForm: value => { state.form = value; }, setIsNewMessageOpen: value => { state.compose = value; },
    setActivePage: value => { state.page = value; }
  });
  const start = source.indexOf("  function openMonthlyTextPreview(");
  const end = source.indexOf("\n  async function toggleMonthlyMeterHistory", start);
  vm.runInContext(`${source.slice(start, end)}\nthis.saveReading = addMonthlyMeterReading; this.preview = openMonthlyTextPreview;`, context);
  await context.saveReading(reservation);
  assert.equal(state.compose, false); assert.equal(state.page, "monthly"); assert.equal(state.amounts[42], "920.00");
  context.preview({ to: "5415550101", body: "Review me before sending" });
  assert.equal(state.compose, true); assert.equal(state.page, "messages"); assert.equal(state.form.body, "Review me before sending");
});
