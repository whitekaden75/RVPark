import test from "node:test";
import assert from "node:assert/strict";
import { checkCheckoutReturn, getCheckoutReturnSessionId } from "./checkout-return.js";

test("payment links, guest bank payments and public bookings all check the returned session", () => {
  for (const query of ["pay=token&pay_status=success", "guest_payment=return&reservationId=42",
    "booking_checkout=return&checkout_token=token"]) {
    assert.equal(getCheckoutReturnSessionId(`?${query}&session_id=cs_test_return`), "cs_test_return");
  }
  for (const query of ["pay=token&pay_status=cancel", "guest_payment=cancel", "booking_checkout=cancel",
    "save_payment=token", "", "pay_status=success"]) {
    assert.equal(getCheckoutReturnSessionId(`?${query}&session_id=cs_test_return`), "");
  }
  assert.equal(getCheckoutReturnSessionId("?pay=token&pay_status=success"), "");
});

async function run(result, cancelled = false) {
  const redirects = [], ready = [], requests = [];
  const response = await checkCheckoutReturn({ sessionId: "cs_test_return",
    request: async path => { requests.push(path); return result; },
    isCancelled: () => cancelled, redirect: url => redirects.push(url), onReady: id => ready.push(id) });
  return { response, redirects, ready, requests };
}

test("bank verification redirects automatically before any success screen is shown", async () => {
  const verificationUrl = "https://payments.stripe.com/microdeposit/verify_test";
  const result = await run({ status: "requires_action", verificationUrl });
  assert.deepEqual(result.requests, ["/guest/checkout-returns/cs_test_return"]);
  assert.deepEqual(result.redirects, [verificationUrl]);
  assert.deepEqual(result.ready, []);
});

test("paid and genuinely processing payments continue to the existing return flow", async () => {
  for (const status of ["succeeded", "processing"]) {
    const result = await run({ status, verificationUrl: null });
    assert.deepEqual(result.ready, ["cs_test_return"]);
    assert.deepEqual(result.redirects, []);
  }
});

test("incomplete or failed payments stay on the payment-help page instead of returning home", async () => {
  for (const status of ["requires_action", "incomplete", "requires_payment_method", "canceled"]) {
    const result = await run({ status, verificationUrl: null });
    assert.deepEqual(result.ready, []); assert.deepEqual(result.redirects, []);
  }
});

test("requests finishing after unmount cannot redirect or mark a payment ready", async () => {
  for (const status of ["requires_action", "succeeded", "processing"]) {
    const result = await run({ status, verificationUrl: "https://payments.stripe.com/test" }, true);
    assert.equal(result.response, null);
    assert.deepEqual(result.ready, []); assert.deepEqual(result.redirects, []);
  }
});

test("a failed status lookup stays an error instead of assuming the checkout succeeded", async () => {
  await assert.rejects(() => checkCheckoutReturn({ sessionId: "cs_test_return",
    request: async () => { throw new Error("Service unavailable"); }, isCancelled: () => false,
    redirect: () => assert.fail("must not redirect"), onReady: () => assert.fail("must not show success")
  }), /Service unavailable/);
});
