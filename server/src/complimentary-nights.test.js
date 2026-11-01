import test from "node:test";
import assert from "node:assert/strict";
import { buildBillingSummary, buildPricingRuleLookup, getPricingForSiteAndNights,
  getComplimentaryNightDates, sumReservationTotals } from "./reservation-pricing.js";

const stay = { site_id: 1, arrival_date: "2026-10-30", leave_date: "2026-11-08" };
const row = { id: 1169, billing_mode: "standard", reservation_term: "standard", amount_paid: 113.98,
  deposit_amount: 56.99, payment_method: "card", requested_discounts: [], nightly_price_adjustment: {
    version: 1, scopeStays: [{ site: 1, arrival: "2026-10-30", departure: "2026-11-08" }], complimentaryDates: ["2026-11-07"]
  } };
const lookup = buildPricingRuleLookup([{ number_of_days: 1, site_category: "off_river_small_rig", normal_price: 55, discount_price: 55 }]);
const segment = { ...stay, ...getPricingForSiteAndNights({}, 9, lookup) };
const events = [1, 2].map(id => ({ id, amount: 56.99, note: "Stripe card payment. Price type: card" }));
const summarize = (reservation = row, segments = [segment], payments = events) => {
  const totals = sumReservationTotals(segments, getComplimentaryNightDates(reservation, segments));
  return { totals, ...buildBillingSummary(reservation, totals, payments) };
};

test("Noah #1169 owes five more paid nights while both real Stripe payments remain unchanged", () => {
  const result = summarize();
  assert.equal(result.totalStayNights, 9); assert.equal(result.totalChargeableNights, 7);
  assert.equal(result.paidChargeableNights, 2); assert.equal(result.unpaidChargeableNights, 5);
  assert.equal(result.additionalFreeNights, 1); assert.equal(result.amountPaid, 113.98);
  assert.equal(result.bankDailyPrice, 55); assert.equal(result.cardDailyPrice, 56.99);
  assert.equal(result.bankRemainingBalance, 275); assert.equal(result.cardRemainingBalance, 284.95);
  assert.equal(result.bankTotalPrice, 385); assert.equal(result.cardTotalPrice, 398.93);
  assert.equal(events.length, 2); assert.equal(events[0].amount, 56.99);
});

test("ordinary weekly pricing and other guests are unchanged without a scoped correction", () => {
  const result = summarize({ ...row, nightly_price_adjustment: null });
  assert.equal(result.totalChargeableNights, 8); assert.equal(result.bankRemainingBalance, 330);
  assert.equal(result.cardRemainingBalance, 341.94); assert.equal(result.additionalFreeNights, 0);
});

test("a changed site, date range, billing mode or invalid correction cannot grant a stale free night", () => {
  for (const changed of [{ ...segment, site_id: 2 }, { ...segment, leave_date: "2026-11-09" }]) {
    assert.deepEqual(getComplimentaryNightDates(row, [changed]), []);
  }
  assert.deepEqual(getComplimentaryNightDates({ ...row, billing_mode: "monthly" }, [segment]), []);
  assert.deepEqual(getComplimentaryNightDates({ ...row, nightly_price_adjustment: { ...row.nightly_price_adjustment, scopeStays: [null] } }, [segment]), []);
  for (const dates of [["2026-11-08"], ["2026-10-29"], ["invalid"]]) {
    assert.deepEqual(getComplimentaryNightDates({ ...row, nightly_price_adjustment: {
      ...row.nightly_price_adjustment, complimentaryDates: dates } }, [segment]), []);
  }
});

test("the normal seventh night cannot be counted as a second extra free night", () => {
  const result = summarize({ ...row, nightly_price_adjustment: { ...row.nightly_price_adjustment,
    complimentaryDates: ["2026-11-05", "2026-11-07", "2026-11-07"] } });
  assert.equal(result.totalChargeableNights, 7); assert.equal(result.additionalFreeNights, 1);
});

test("a subsequent real payment clears the corrected balance without inventing receipt income", () => {
  const cash = summarize({ ...row, amount_paid: 388.98, payment_method: "bank" }, [segment],
    [...events, { id: 3, amount: 275, note: "Tender: cash. Price type: bank" }]);
  assert.equal(cash.unpaidStayNights, 0); assert.equal(cash.bankRemainingBalance, 0); assert.equal(cash.cardRemainingBalance, 0);
  const card = summarize({ ...row, amount_paid: 398.93 }, [segment],
    [...events, { id: 3, amount: 284.95, note: "Price type: card" }]);
  assert.equal(card.unpaidStayNights, 0); assert.equal(card.cardRemainingBalance, 0);
});
