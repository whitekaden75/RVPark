import test from "node:test";
import assert from "node:assert/strict";
import { registerCheckoutReturnRoutes } from "./checkout-return.js";

const verificationUrl = "https://payments.stripe.com/microdeposit/verify_test";
const needsVerification = {
  id: "cs_test_return", mode: "payment", status: "complete", payment_status: "unpaid",
  payment_intent: {
    id: "pi_test", status: "requires_action",
    next_action: { type: "verify_with_microdeposits", verify_with_microdeposits: { hosted_verification_url: verificationUrl } }
  }
};

async function check({ session = needsVerification, known = true, sessionId = "cs_test_return", stripeError, configured = true } = {}) {
  let handler;
  const calls = [];
  const pool = { query: async (sql, values) => {
    assert.match(sql, /stripe_payment_records/);
    assert.match(sql, /public_booking_checkouts/);
    assert.doesNotMatch(sql, /INSERT|UPDATE|DELETE/);
    assert.deepEqual(values, [sessionId]);
    return { rows: known ? [{ "?column?": 1 }] : [] };
  } };
  const stripe = {
    checkout: { sessions: { retrieve: async (...args) => {
      calls.push(args);
      if (stripeError) throw stripeError;
      return session;
    } } },
    paymentIntents: { retrieve: async id => {
      assert.equal(id, "pi_test");
      return needsVerification.payment_intent;
    } }
  };
  registerCheckoutReturnRoutes({ get: (path, fn) => {
    assert.equal(path, "/api/guest/checkout-returns/:sessionId");
    handler = fn;
  } }, { pool, stripe: configured ? stripe : null });
  const res = { code: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ params: { sessionId } }, res);
  return { ...res, calls };
}

test("completed ACH checkout requiring verification returns its existing Stripe verification URL", async () => {
  const res = await check();
  assert.equal(res.code, 200);
  assert.deepEqual(res.body, { status: "requires_action", verificationUrl });
  assert.deepEqual(res.calls, [["cs_test_return", { expand: ["payment_intent"] }]]);
  assert.equal(res.headers["Cache-Control"], "private, no-store");
});

test("card success and bank processing do not send customers back to verification", async () => {
  for (const status of ["succeeded", "processing", "requires_payment_method", "canceled"]) {
    const res = await check({ session: { ...needsVerification,
      payment_intent: { ...needsVerification.payment_intent, status } } });
    assert.deepEqual(res.body, { status, verificationUrl: null });
  }
});

test("unexpanded PaymentIntents are retrieved and only payment checkouts are supported", async () => {
  assert.equal((await check({ session: { ...needsVerification, payment_intent: "pi_test" } })).body.verificationUrl, verificationUrl);
  assert.equal((await check({ session: { ...needsVerification, mode: "setup" } })).code, 400);
});

test("missing next steps, expired sessions and other authentication actions never imply success", async () => {
  assert.deepEqual((await check({ session: { ...needsVerification, payment_intent: null } })).body,
    { status: "incomplete", verificationUrl: null });
  assert.equal((await check({ session: { ...needsVerification, status: "expired", payment_intent: null } })).body.status, "canceled");
  assert.equal((await check({ session: { ...needsVerification, payment_intent: null, payment_status: "paid" } })).body.status, "succeeded");
  assert.equal((await check({ session: { ...needsVerification, payment_intent: {
    ...needsVerification.payment_intent, next_action: { type: "use_stripe_sdk" }
  } } })).body.verificationUrl, null);
});

test("verification redirects only accept HTTPS Stripe URLs", async () => {
  for (const url of [undefined, "javascript:alert(1)", "http://payments.stripe.com/test",
    "https://payments.stripe.com.evil.example/test", "https://evil.example/test", "https://user:pass@payments.stripe.com/test"]) {
    const res = await check({ session: { ...needsVerification, payment_intent: {
      ...needsVerification.payment_intent, next_action: { type: "verify_with_microdeposits",
        verify_with_microdeposits: { hosted_verification_url: url } }
    } } });
    assert.equal(res.body.verificationUrl, null);
  }
});

test("unknown or malformed sessions and Stripe outages fail safely without leaking payment data", async () => {
  for (const sessionId of ["pi_test", "cs_bad?query", `cs_${"x".repeat(256)}`]) {
    const res = await check({ sessionId });
    assert.equal(res.code, 400); assert.equal(res.calls.length, 0);
  }
  const unknown = await check({ known: false });
  assert.equal(unknown.code, 404); assert.equal(unknown.calls.length, 0);
  assert.equal((await check({ configured: false })).code, 503);
  const failure = await check({ stripeError: new Error("secret diagnostic") });
  assert.equal(failure.code, 502);
  assert.doesNotMatch(JSON.stringify(failure.body), /secret diagnostic/);
});
