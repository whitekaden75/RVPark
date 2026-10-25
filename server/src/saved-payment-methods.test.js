import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { randomBytes } from "node:crypto";
import { createSavedPaymentMethods, storageConsentText, validateSavedCharge } from "./saved-payment-methods.js";

const requestId = "63213552-67d8-4900-8f71-b84bd073c570";
const draft = (overrides = {}) => ({ requestId, amount: "925.50", description: "October rent and utilities",
  guestApproved: true, approvalNote: "Guest approved $925.50 by signed authorization on October 24", ...overrides });

function fixture() {
  const routes = new Map();
  const state = { requests: new Map(), payments: new Map(), sessions: new Map(), saved: [],
    reservation: { id: 10, customer_id: 30, status: "active", email: "guest@example.com" },
    method: { id: 7, customer_id: 30, stripe_customer_id: "cus_guest", stripe_payment_method_id: "pm_guest", payment_method_type: "card", revoked_at: null },
    current: { id: "pm_guest", customer: "cus_guest", type: "card", card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 } },
    intents: new Map(), creates: 0, confirms: 0, settlements: 0, notifications: 0, checkoutCreates: 0,
    nextStatus: "succeeded", disconnect: false, committed: false };
  const rows = (values) => ({ rows: values, rowCount: values.length });
  const pool = { connect: async () => ({ query: pool.query, release() {} }), query: async (sql, values = []) => {
    if (sql === "COMMIT") { state.committed = true; return rows([]); }
    if (["BEGIN", "ROLLBACK"].includes(sql) || sql.includes("pg_advisory_xact_lock")) return rows([]);
    if (sql.startsWith("SELECT stripe_customer_id FROM customers")) return rows([{ stripe_customer_id: "cus_guest" }]);
    if (sql.includes("INSERT INTO saved_payment_charge_requests")) {
      const [id, reservation_id, saved_payment_method_id, amount_cents, description, approval_note, approved_by] = values;
      if (!state.requests.has(id)) state.requests.set(id, { reservation_id, saved_payment_method_id, amount_cents, description, approval_note, approved_by });
      return rows([]);
    }
    if (sql.includes("SELECT * FROM saved_payment_charge_requests")) return rows([state.requests.get(values[0])]);
    if (sql.includes("UPDATE saved_payment_charge_requests")) { state.requests.get(values[0]).stripe_payment_intent_id = values[1]; return rows([]); }
    if (sql.includes("INSERT INTO stripe_payment_records")) {
      assert.equal(state.payments.has(values[1]), false, "a retry must not insert another payment record");
      state.payments.set(values[1], { amount: values[2], paid: false }); return rows([]);
    }
    if (sql.includes("INSERT INTO payment_method_save_sessions")) {
      state.sessions.set(values[0], { stripe_checkout_session_id: values[0], reservation_id: values[1], customer_id: values[2],
        stripe_customer_id: values[3], consent_version: values[4], consent_text: values[5], consent_at: "2026-10-24T12:00:00Z" }); return rows([]);
    }
    if (sql.includes("SELECT * FROM payment_method_save_sessions")) {
      const session = state.sessions.get(values[0]); return rows(session && !session.completed_at ? [session] : []);
    }
    if (sql.includes("UPDATE payment_method_save_sessions")) { state.sessions.get(values[0]).completed_at = true; return rows([]); }
    if (sql.includes("SELECT stripe_checkout_session_id FROM payment_method_save_sessions")) return rows([]);
    if (sql.includes("INSERT INTO reservation_saved_payment_methods")) { state.saved.push(values); return rows([]); }
    if (sql.includes("UPDATE reservation_saved_payment_methods")) { state.method.revoked_at = true; return rows([]); }
    if (sql.includes("FROM reservation_saved_payment_methods")) {
      return rows(String(values[0]) === String(state.method.id) && String(values[1]) === String(state.method.customer_id) &&
        (!sql.includes("revoked_at IS NULL") || !state.method.revoked_at) ? [state.method] : []);
    }
    throw new Error(`Unexpected SQL in test: ${sql}`);
  } };
  const stripe = { paymentMethods: {
    retrieve: async () => state.current,
    detach: async () => { if (state.detachFails) throw new Error("Stripe unavailable"); state.current.customer = null; }
  }, paymentIntents: {
    create: async (params, options) => {
      state.creates++; assert.equal(options.idempotencyKey, `saved-payment-create-${requestId}`);
      assert.equal(params.amount, 92550); assert.equal(params.customer, "cus_guest");
      const intent = { id: "pi_charge", status: "requires_confirmation", metadata: params.metadata };
      state.intents.set(intent.id, intent); return intent;
    },
    retrieve: async (id) => state.intents.get(id),
    confirm: async (id, params, options) => {
      assert.equal(state.committed, true); assert.equal(state.payments.has(id), true, "persist before Stripe can confirm");
      assert.equal(params.off_session, true); assert.equal(options.idempotencyKey, `saved-payment-confirm-${requestId}`);
      state.confirms++; const intent = state.intents.get(id); intent.status = state.nextStatus;
      if (state.disconnect) { state.disconnect = false; throw new Error("Response lost after bank accepted payment"); }
      if (state.throwAuthentication) throw Object.assign(new Error("Authentication required"), { payment_intent: intent });
      return intent;
    },
    cancel: async (id) => { const intent = state.intents.get(id); intent.status = "canceled"; return intent; }
  }, setupIntents: { retrieve: async () => ({ status: state.setupStatus || "succeeded", payment_method: state.current }) },
  checkout: { sessions: { create: async (options) => {
    state.checkoutCreates++; assert.equal(options.mode, "setup"); assert.equal(options.setup_intent_data.usage, "off_session");
    assert.deepEqual(options.payment_method_types, ["card"]);
    return { id: "cs_setup", url: "https://checkout.stripe.com/test" };
  } } } };
  const service = createSavedPaymentMethods({ pool, stripe, getReservation: async () => state.reservation,
    secret: "test-secret", allowedOrigins: ["https://park.example"], signToken: () => "signed-token",
    readToken: (token) => token === "valid" ? { reservationId: 10, customerId: 30 } : null,
    syncPayments: async () => {
      for (const [id, payment] of state.payments) if (!payment.paid && state.intents.get(id).status === "succeeded") {
        payment.paid = true; state.settlements++;
      }
    }, notify: () => state.notifications++ });
  const app = Object.fromEntries(["get", "post", "delete"].map((method) => [method, (path, handler) => routes.set(`${method} ${path}`, handler)]));
  service.registerRoutes(app);
  async function call(method, suffix, body = {}, params = {}) {
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; } };
    await routes.get(`${method} /api/${suffix}`)({ params: { id: "10", methodId: "7", token: "valid", ...params }, body, query: {}, adminUser: { id: 2 } }, response);
    return response;
  }
  return { service, state, pool, call };
}

const chargePath = "reservations/:id/saved-payment-methods/:methodId/charges";

test("saved charges require an exact positive amount, request ID, description and affirmative approval", () => {
  assert.equal(validateSavedCharge(draft()).amountCents, 92550);
  assert.equal(validateSavedCharge(draft({ requestId: requestId.toUpperCase() })).requestId, requestId);
  for (const amount of ["", 0, -1, true, "1e3", "0.001", "Infinity", "1000000", "9.123"]) assert.throws(() => validateSavedCharge(draft({ amount })));
  for (const body of [{ guestApproved: false }, { guestApproved: "true" }, { approvalNote: " " }, { description: " " }, { requestId: "" }]) assert.throws(() => validateSavedCharge(draft(body)));
});

test("saving without a payment requires guest opt-in and a valid, customer-bound link", async () => {
  const { call, state } = fixture();
  const path = "guest/payment-method-setups/:token/checkouts";
  assert.equal((await call("post", path, { storageAccepted: false, baseUrl: "https://park.example" })).statusCode, 400);
  assert.equal((await call("post", path, { storageAccepted: "true", baseUrl: "https://park.example" })).statusCode, 400);
  assert.equal((await call("post", path, { storageAccepted: true, baseUrl: "https://evil.example" })).statusCode, 400);
  assert.equal((await call("post", path, {}, { token: "expired" })).statusCode, 401);
  assert.equal(state.checkoutCreates, 0);
  const response = await call("post", path, { storageAccepted: true, baseUrl: "https://park.example" });
  assert.equal(response.statusCode, 200); assert.equal(state.checkoutCreates, 1);
  assert.equal(state.sessions.get("cs_setup").consent_text, storageConsentText);
  assert.equal(state.payments.size, 0);
  state.reservation.customer_id = 99;
  assert.equal((await call("post", path, { storageAccepted: true, baseUrl: "https://park.example" })).statusCode, 401);
});

test("browser returns and webhook retries save only a completed Stripe setup with the correct attached customer", async () => {
  const { service, state, pool } = fixture();
  const session = { id: "cs_setup", mode: "setup", customer: "cus_guest", setup_intent: "seti_test", status: "open" };
  await service.rememberSession(session, state.reservation, "cus_guest");
  assert.equal(await service.completeSession(pool, session), null); assert.equal(state.saved.length, 0);
  session.status = "complete"; state.setupStatus = "requires_action";
  assert.equal(await service.completeSession(pool, session), null); assert.equal(state.saved.length, 0);
  state.setupStatus = "succeeded"; state.current.customer = "cus_other";
  await assert.rejects(service.completeSession(pool, session), /reusable payment method/);
  assert.equal(state.saved.length, 0); assert.equal(state.sessions.get(session.id).completed_at, undefined);
  state.current.customer = "cus_guest";
  assert.equal(await service.completeSession(pool, session), 10);
  assert.equal(await service.completeSession(pool, session), null);
  assert.equal(state.saved.length, 1); assert.equal(state.saved[0][6], "4242");
  assert.equal(state.saved[0].includes(storageConsentText), true);
});

test("storage is refused without consent or for another Stripe customer", async () => {
  const { service, state, pool } = fixture();
  const details = { reservation: state.reservation, method: state.current, stripeCustomerId: "cus_guest", source: "public_booking" };
  assert.equal(await service.saveMethod(pool, details), false);
  assert.equal(await service.saveMethod(pool, { ...details, consentAt: new Date(), stripeCustomerId: "cus_other" }), false);
  assert.equal(state.saved.length, 0);
});

test("saved monthly charges persist before confirmation and retries never collect or credit twice", async () => {
  const { call, state } = fixture();
  const first = await call("post", chargePath, draft());
  assert.equal(first.statusCode, 200); assert.equal(first.body.status, "succeeded");
  const retry = await call("post", chargePath, draft());
  assert.equal(retry.body.status, "succeeded"); assert.equal(state.creates, 1); assert.equal(state.confirms, 1);
  assert.equal(state.settlements, 1); assert.equal(state.payments.size, 1);
  assert.equal(state.requests.get(requestId).approved_by, "2");
  assert.equal((await call("post", chargePath, draft({ amount: "800" }))).statusCode, 409);
});

test("a lost payment response reuses the recorded intent instead of charging again", async () => {
  const { call, state } = fixture(); state.disconnect = true;
  assert.equal((await call("post", chargePath, draft())).statusCode, 500);
  assert.equal(state.payments.size, 1); assert.equal(state.settlements, 0);
  assert.equal((await call("post", chargePath, draft())).body.status, "succeeded");
  assert.equal(state.creates, 1); assert.equal(state.confirms, 1); assert.equal(state.settlements, 1);
});

test("an existing charge can still be reconciled after the guest removes the payment method", async () => {
  const { call, state } = fixture(); state.disconnect = true;
  assert.equal((await call("post", chargePath, draft())).statusCode, 500);
  state.method.revoked_at = true; state.current.customer = null;
  const response = await call("post", chargePath, draft());
  assert.equal(response.body.status, "succeeded"); assert.equal(state.creates, 1); assert.equal(state.settlements, 1);
});

test("processing bank payments receive no credit until Stripe confirms success", async () => {
  const { call, state } = fixture(); state.method.payment_method_type = "us_bank_account"; state.nextStatus = "processing";
  assert.equal((await call("post", chargePath, draft())).body.status, "processing");
  assert.equal(state.settlements, 0);
  state.intents.get("pi_charge").status = "succeeded";
  assert.equal((await call("post", chargePath, draft())).body.status, "succeeded");
  assert.equal(state.settlements, 1); assert.equal(state.confirms, 1);
});

test("declines and authentication cancel the attempt without recording a payment", async () => {
  for (const status of ["requires_action", "requires_payment_method"]) {
    const { call, state } = fixture(); state.nextStatus = status; state.throwAuthentication = true;
    const response = await call("post", chargePath, draft());
    assert.equal(response.statusCode, 200); assert.equal(response.body.status, "canceled"); assert.equal(state.settlements, 0);
    assert.match(response.body.message, /payment link/);
  }
});

test("revoked methods, unrelated guests, missing approval, and canceled reservations cannot be charged", async () => {
  for (const change of [s => s.method.revoked_at = true, s => s.method.customer_id = 99,
    s => s.current.customer = "cus_other", s => s.reservation.status = "canceled"]) {
    const { call, state } = fixture(); change(state);
    assert.ok((await call("post", chargePath, draft())).statusCode >= 400); assert.equal(state.creates, 0);
  }
  const { call, state } = fixture();
  assert.equal((await call("post", chargePath, draft({ guestApproved: false }))).statusCode, 400);
  assert.equal(state.creates, 0);
});

test("removal revokes locally even when Stripe is temporarily unavailable", async () => {
  const { call, state } = fixture(); state.detachFails = true;
  assert.equal((await call("delete", "reservations/:id/saved-payment-methods/:methodId")).statusCode, 500);
  assert.equal(state.method.revoked_at, true);
  assert.equal((await call("post", chargePath, draft())).statusCode, 404);
  state.detachFails = false;
  assert.equal((await call("delete", "reservations/:id/saved-payment-methods/:methodId")).statusCode, 200);
  assert.equal(state.current.customer, null);
});

test("guest-facing consent text matches the recorded authorization", () => {
  const client = readFileSync(new URL("../../client/src/SavedPaymentMethods.jsx", import.meta.url), "utf8");
  const text = client.match(/export const storageConsentText = (".*");/)[1];
  assert.equal(JSON.parse(text), storageConsentText);
});

test("public card and bank bookings can opt out; only literal opt-in enables future usage and consent storage", async () => {
  const source = readFileSync(new URL("./index.js", import.meta.url), "utf8");
  const start = source.indexOf('app.post("/api/guest/booking-checkouts",');
  const end = source.indexOf('\napp.get("/api/guest/booking-checkouts/', start);
  let handler;
  const sessions = [], inserts = [];
  const client = { release() {}, query: async (sql, values) => {
    if (sql.includes("FROM rv_sites")) return { rowCount: 1, rows: [{ id: 1, site_number: "1", size_feet: 45 }] };
    if (sql.includes("INSERT INTO public_booking_checkouts")) inserts.push(values);
    return { rows: [], rowCount: 0 };
  } };
  vm.runInContext(source.slice(start, end), vm.createContext({
    app: { post: (_path, callback) => { handler = callback; } }, pool: { connect: async () => client },
    ensureStripeConfigured: () => true, normalizeGuestPhone: () => "5415550101", nightsBetween: () => 2,
    getParkTodayDate: () => "2026-10-24", allowedClientOrigins: ["https://park.example"],
    findReservationOverlap: async () => null, findPublicCheckoutOverlap: async () => null,
    buildPricingRuleLookup: () => ({}), loadPricingRules: async () => [],
    getPricingForSiteAndNights: (_site, nights) => ({ normalPrice: 75 * nights, discountPrice: 65 * nights }),
    roundCurrency: (n) => Math.round(n * 100) / 100, getCardStayTotal: (n) => n + 3,
    calculateChargeableNights: (n) => n, toAmountCents: (n) => Math.round(n * 100),
    randomBytes, createBookingPricingQuote: () => ({}), formatDisplayDate: (d) => d,
    publicBookingTermsVersion: "2026-10-24", storageConsentText, storageConsentVersion: "2026-10-24",
    stripe: { customers: { create: async () => ({ id: "cus_public" }) }, checkout: { sessions: { create: async (options) => {
      sessions.push(options); return { id: `cs_${sessions.length}`, url: "https://checkout.stripe.com/test" };
    } } } }
  }));
  for (const paymentMethod of ["card", "bank"]) {
    for (const consent of [undefined, false, "true", true]) {
      const response = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
      await handler({ body: { firstName: "Test", lastName: "Guest", email: "test@example.com", siteId: 1,
        arrivalDate: "2026-10-24", leaveDate: "2026-10-26", rvKind: "van", rigLengthFeet: 20,
        termsAccepted: true, paymentMethod, paymentMethodStorageAccepted: consent, baseUrl: "https://park.example" } }, response);
      assert.equal(response.code, 201, response.body?.message);
      assert.equal(sessions.at(-1).payment_intent_data.setup_future_usage, consent === true ? "off_session" : undefined);
      const payload = JSON.parse(inserts.at(-1)[8]);
      assert.equal(payload.paymentMethodStorageAccepted, consent === true);
      assert.equal(inserts.at(-1)[12], consent === true);
      assert.equal(payload.storageConsentText, consent === true ? storageConsentText : null);
    }
  }
});
