import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function paymentLinkGenerator(request) {
  const source = readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
  const start = source.indexOf("  async function generatePaymentLink(");
  const end = source.indexOf("\n  function getPaymentLinkAmountsForNights", start);
  const state = { rows: {}, link: null, error: "" };
  const context = vm.createContext({
    pendingPaymentLinks: { current: new Set() },
    setPaymentLinkStates: update => { state.rows = update(state.rows); },
    setPaymentLinkErrorMessage: value => { state.error = value; },
    setPaymentLinkSuccessMessage() {},
    setGeneratedPaymentLink: value => { state.link = value; },
    apiRequest: request,
    window: { location: { origin: "https://park.example" } }
  });
  vm.runInContext(`${source.slice(start, end)}\nthis.generate = generatePaymentLink;`, context);
  return { generate: context.generate, state };
}

const quote = (id) => ({ bankAmount: "900.00", cardAmount: "927.00", paymentUrl: `https://park.example/?pay=${id}` });

test("monthly custom amounts generate links with no nightly balance and show loading until ready", async () => {
  let complete;
  let submitted;
  const { generate, state } = paymentLinkGenerator((_path, options) => {
    submitted = JSON.parse(options.body);
    return new Promise(resolve => { complete = resolve; });
  });
  const pending = generate({ id: 10, remainingBalance: 0 }, "Monthly payment link", { customAmount: "900.00", description: "Monthly rent" });
  assert.equal(state.rows[10].isLoading, true);
  assert.equal(state.rows[10].link, null);
  assert.equal(submitted.customAmount, "900.00");
  assert.equal(submitted.description, "Monthly rent");
  complete(quote(10)); await pending;
  assert.equal(state.rows[10].isLoading, false);
  assert.equal(state.rows[10].link.checkoutUrl, quote(10).paymentUrl);
  assert.equal(state.rows[10].error, "");
});

test("each monthly guest retains their own link when another guest generates one", async () => {
  const { generate, state } = paymentLinkGenerator(async path => quote(path.includes("/10/") ? 10 : 11));
  await generate({ id: 10 }, "Monthly payment link", { customAmount: 900 });
  await generate({ id: 11 }, "Monthly payment link", { customAmount: 900 });
  assert.equal(state.rows[10].link.checkoutUrl, quote(10).paymentUrl);
  assert.equal(state.rows[11].link.checkoutUrl, quote(11).paymentUrl);
});

test("errors appear on the correct guest card, end loading, and allow another attempt", async () => {
  let calls = 0;
  const { generate, state } = paymentLinkGenerator(async () => {
    if (++calls === 1) throw new Error("Payment service unavailable. Please try again.");
    return quote(10);
  });
  assert.equal(await generate({ id: 10 }, "Monthly", { customAmount: 900 }), null);
  assert.equal(state.rows[10].isLoading, false);
  assert.match(state.rows[10].error, /Payment service unavailable/);
  await generate({ id: 10 }, "Monthly", { customAmount: 900 });
  assert.equal(state.rows[10].error, "");
  assert.equal(state.rows[10].link.checkoutUrl, quote(10).paymentUrl);
});

test("double clicks do not create duplicate requests and invalid amounts do not fall back to a balance", async () => {
  let complete;
  let calls = 0;
  const { generate, state } = paymentLinkGenerator(() => {
    calls++; return new Promise(resolve => { complete = resolve; });
  });
  const pending = generate({ id: 10 }, "Monthly", { customAmount: 900 });
  assert.equal(await generate({ id: 10 }, "Monthly", { customAmount: 900 }), null);
  assert.equal(calls, 1); assert.equal(state.rows[10].isLoading, true);
  complete(quote(10)); await pending;
  for (const customAmount of [0, "", -5, "invalid", Infinity]) {
    await generate({ id: 10, remainingBalance: 500 }, "Monthly", { customAmount });
    assert.match(state.rows[10].error, /greater than zero/);
  }
  assert.equal(calls, 1);
  await generate({ id: 11, remainingBalance: 0 });
  assert.match(state.rows[11].error, /unpaid nights/);
});
