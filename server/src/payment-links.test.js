import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import vm from "node:vm";
import { getCardPrice, roundCurrency } from "./reservation-pricing.js";

const source = readFileSync(new URL("./index.js", import.meta.url), "utf8");

function routesFor(link, balances = { bankAmount: 0, cardAmount: 0 }) {
  const handlers = {}, sessions = [], records = [];
  const reservation = { id: 42, status: "active", first_name: "Test", last_name: "Guest",
    email: "guest@example.com", siteStays: [] };
  const start = source.indexOf('app.get("/api/guest/payment-links/:token",');
  const end = source.indexOf('\napp.post("/api/guest/reservations/:id/bank-checkouts",', start);
  vm.runInContext(source.slice(start, end), vm.createContext({
    app: { get: (_path, handler) => { handlers.get = handler; }, post: (_path, handler) => { handlers.post = handler; } },
    readGuestPaymentLinkToken: () => link,
    ensureStripeConfigured: () => true,
    syncOpenStripePayments: async () => {},
    fetchReservationDetails: async () => reservation,
    getRemainingBalancePaymentAmounts: () => balances,
    hasPaymentDueForReservation: () => balances.bankAmount > 0,
    getCardPrice, toAmountCents: amount => Math.round(Number(amount) * 100),
    allowedClientOrigins: ["https://park.example"],
    pool: { query: async (_sql, values) => { records.push(values); } },
    stripe: { checkout: { sessions: { create: async options => {
      sessions.push(options);
      return { id: `cs_${sessions.length}`, url: "https://checkout.stripe.com/test", currency: "usd", payment_status: "unpaid" };
    } } } }
  }));
  async function call(method, paymentMethod = "card") {
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
    await handlers[method]({ params: { token: "signed-test-link" }, body: { paymentMethod, baseUrl: "https://park.example" } }, response);
    assert.equal(response.statusCode, 200, response.body?.message);
    return response.body;
  }
  return { call, sessions, records };
}

test("existing custom-amount links show the 3% card price rounded up to .99 and charge that same amount", async () => {
  for (const [bankAmount, cardAmount] of [[75, 77.99], [900, 927.99], [1000, 1030.99], [123.45, 127.99]]) {
    const { call, sessions, records } = routesFor({ reservationId: 42, customAmount: bankAmount });
    const page = await call("get");
    assert.equal(page.bankAmount, bankAmount); assert.equal(page.cardAmount, cardAmount);
    const card = await call("post", "card");
    assert.equal(Number(card.amount), cardAmount);
    assert.equal(sessions.at(-1).line_items[0].price_data.unit_amount, Math.round(cardAmount * 100));
    assert.equal(records.at(-1)[2], Math.round(cardAmount * 100));
    await call("post", "bank");
    assert.equal(sessions.at(-1).line_items[0].price_data.unit_amount, Math.round(bankAmount * 100));
  }
});

test("explicit nightly card quotes and balance-based links retain their existing prices without another markup", async () => {
  for (const link of [
    { reservationId: 42, customAmount: 150, customCardAmount: 155.98 },
    { reservationId: 42 }
  ]) {
    const { call, sessions } = routesFor(link, { bankAmount: 150, cardAmount: 155.98 });
    assert.equal((await call("get")).cardAmount, 155.98);
    await call("post", "card");
    assert.equal(sessions[0].line_items[0].price_data.unit_amount, 15598);
  }
});

test("new monthly and meter-payment tokens retain both prices, while supplied nightly quotes stay intact", () => {
  const start = source.indexOf("function createGuestPaymentLinkToken(");
  const end = source.indexOf("\nfunction readGuestPaymentLinkToken", start);
  const context = vm.createContext({
    randomBytes, roundCurrency, getCardPrice, guestAuthSecret: "test-secret",
    encodeTokenPayload: payload => Buffer.from(JSON.stringify(payload)).toString("base64url"),
    signTokenPayload: () => "test-signature"
  });
  vm.runInContext(`${source.slice(start, end)}\nthis.create = createGuestPaymentLinkToken;`, context);
  const payload = (...args) => JSON.parse(Buffer.from(context.create(...args).split(".")[0], "base64url").toString());
  const monthly = payload(42, 900, "Monthly rent");
  assert.equal(monthly.customAmount, 900); assert.equal(monthly.customCardAmount, 927.99);
  assert.equal(payload(42, 150, "Two nights", 155.98).customCardAmount, 155.98);
  const balance = payload(42);
  assert.equal(balance.customAmount, undefined); assert.equal(balance.customCardAmount, undefined);
});
