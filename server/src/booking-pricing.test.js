import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { applyBookedPricing, createBookingPricingQuote, loadBookedPricing } from "./booking-pricing.js";
import {
  buildBillingSummary, buildPricingRuleLookup, calculateChargeableNights,
  getCardPrice, getPricingForSiteAndNights, sumReservationTotals
} from "./reservation-pricing.js";

const reservation = {
  id: 42, billing_mode: "standard", reservation_term: "standard",
  payment_method: "card", requested_discounts: [], deposit_amount: 77.99,
  amount_paid: 77.99, total_price: null, pricing_category_override: null
};
const stay = {
  site_id: 4, river_category: null, is_big_rig: false,
  arrival_date: "2026-10-09", leave_date: "2026-10-11"
};
const prices = (normalPrice = 65, discountPrice = 55) => buildPricingRuleLookup([
  { site_category: "off_river_small_rig", number_of_days: 1, normal_price: normalPrice, discount_price: discountPrice }
]);
const priceStay = (segment = stay, lookup = prices()) => ({
  ...segment,
  ...getPricingForSiteAndNights(segment,
    (Date.parse(`${segment.leave_date}T00:00:00Z`) - Date.parse(`${segment.arrival_date}T00:00:00Z`)) / 86400000,
    lookup)
});
const booking = (overrides = {}) => ({
  reservation_id: 42, site_id: 4, arrival_date: stay.arrival_date, leave_date: stay.leave_date,
  pricing_payload: { baseTotalPrice: 150, totalPrice: 155.98, paymentMethod: "card", discounts: [], ...overrides }
});
const summarize = (row = reservation, source = booking(), segments = [priceStay()], events) => {
  const siteStays = applyBookedPricing(row, segments, source);
  const totals = sumReservationTotals(siteStays);
  return { siteStays, totals, ...buildBillingSummary(row, totals,
    events ?? [{ amount: row.amount_paid, note: `Stripe deposit. Price type: ${row.payment_method}` }]) };
};

test("regular-price online booking retains $75 plus the card price at check-in", () => {
  const bill = summarize();
  assert.equal(bill.bankDailyPrice, 75);
  assert.equal(bill.cardDailyPrice, 77.99);
  assert.equal(bill.bankRemainingBalance, 75);
  assert.equal(bill.cardRemainingBalance, 77.99);
  assert.equal(bill.remainingBalance, 77.99);
  assert.equal(bill.paidChargeableNights, 1);
  assert.equal(bill.unpaidStayNights, 1);
  assert.equal(bill.bankTotalPrice, 150);
  assert.equal(bill.cardTotalPrice, 155.98);
  assert.equal(bill.requiredDepositAmount, 75);
  assert.equal(bill.requiredCardDepositAmount, 77.99);
  assert.deepEqual(bill.requestedDiscounts, []);
  assert.deepEqual(bill.cardPaymentOptions, [{ nights: 1, amount: 77.99 }]);
});

test("an unselected $65 discount is not silently applied", () => {
  const bill = summarize(reservation, booking(), [priceStay(stay, prices(75, 65))]);
  assert.equal(bill.bankDailyPrice, 75);
  assert.equal(bill.cardRemainingBalance, 77.99);
  assert.equal(bill.totals.discountPrice, 130); // Still available for an intentional admin choice.
});

test("selected discounted online price also survives later rate changes", () => {
  const bill = summarize({ ...reservation, requested_discounts: ["AAA"], amount_paid: 66.99, deposit_amount: 66.99 },
    booking({ baseTotalPrice: 130, totalPrice: 133.98, discounts: ["AAA"] }),
    [priceStay(stay, prices(90, 70))]);
  assert.equal(bill.bankDailyPrice, 65);
  assert.equal(bill.cardRemainingBalance, 66.99);
  assert.deepEqual(bill.requestedDiscounts, ["AAA"]);
});

test("bank payment uses the same booked base rate and later card payment uses its card rate", () => {
  const source = booking({ paymentMethod: "bank", totalPrice: 150 });
  const bankRow = { ...reservation, payment_method: "bank", amount_paid: 75, deposit_amount: 75 };
  const events = [{ amount: 75, note: "ACH deposit. Price type: bank" }];
  const bankBill = summarize(bankRow, source, undefined, events);
  const cardBill = summarize({ ...bankRow, payment_method: "card" }, source, undefined, events);
  assert.equal(bankBill.remainingBalance, 75);
  assert.equal(cardBill.remainingBalance, 77.99);
  assert.equal(bankBill.cardRemainingBalance, cardBill.cardRemainingBalance);
});

test("card-paid deposit can be followed by a bank-priced night without charging the fee twice", () => {
  const row = { ...reservation, payment_method: "bank", amount_paid: 152.99 };
  const bill = summarize(row, booking(), undefined, [
    { amount: 75, note: "Cash payment. Price type: bank" },
    { amount: 77.99, note: "Card deposit. Price type: card" }
  ]);
  assert.equal(bill.bankRemainingBalance, 0);
  assert.equal(bill.cardRemainingBalance, 0);
  assert.equal(bill.unpaidStayNights, 0);
});

test("partial card payments retain the booked nightly rate and payment credit", () => {
  const bill = summarize({ ...reservation, amount_paid: 20 });
  assert.equal(bill.paidChargeableNights, 0);
  assert.equal(bill.partialPaymentCredit, 20);
  assert.equal(bill.bankRemainingBalance, 130);
  assert.equal(bill.cardRemainingBalance, 135.98);
  assert.deepEqual(bill.cardPaymentOptions, [{ nights: 1, amount: 57.99 }, { nights: 2, amount: 135.98 }]);
});

test("fully paid QR/card checkout has no new balance at check-in", () => {
  const bill = summarize({ ...reservation, amount_paid: 155.98 });
  assert.equal(bill.remainingBalance, 0);
  assert.equal(bill.cardRemainingBalance, 0);
  assert.equal(bill.unpaidStayNights, 0);
});

test("booked pricing keeps seventh-night-free and two-night deposit rules", () => {
  for (const [nights, leaveDate] of [[7, "2026-10-16"], [8, "2026-10-17"], [14, "2026-10-23"], [28, "2026-11-06"]]) {
    const charged = calculateChargeableNights(nights);
    const source = { ...booking({ baseTotalPrice: charged * 75, totalPrice: Number((charged * 77.99).toFixed(2)) }), leave_date: leaveDate };
    const deposit = nights > 7 ? 155.98 : 77.99;
    const bill = summarize({ ...reservation, deposit_amount: deposit, amount_paid: deposit }, source,
      [priceStay({ ...stay, leave_date: leaveDate })]);
    assert.equal(bill.totalStayNights, nights);
    assert.equal(bill.totalChargeableNights, charged);
    assert.equal(bill.bankTotalPrice, charged * 75);
    assert.equal(bill.cardTotalPrice, Number((charged * 77.99).toFixed(2)));
    assert.equal(bill.requiredCardDepositAmount, deposit);
  }
  const source = { ...booking({ baseTotalPrice: 450, totalPrice: 467.94 }), leave_date: "2026-10-16" };
  const bill = summarize({ ...reservation, amount_paid: 467.94 }, source,
    [priceStay({ ...stay, leave_date: "2026-10-16" })]);
  assert.equal(bill.paidStayNights, 7);
  assert.equal(bill.cardRemainingBalance, 0);
});

test("new checkout saves a durable regular/discounted nightly card quote", () => {
  const regular = createBookingPricingQuote(priceStay(stay, prices(75, 65)), []);
  const discount = createBookingPricingQuote(priceStay(stay, prices(75, 65)), ["AAA"]);
  assert.deepEqual(regular, { version: 1, pricingCategory: "off_river_small_rig", discountQualified: false, bankDailyPrice: 75, cardDailyPrice: 77.99 });
  assert.equal(discount.bankDailyPrice, 65);
  assert.equal(discount.cardDailyPrice, 66.99);
  const bill = summarize(reservation, booking({ pricingQuote: regular }));
  assert.equal(bill.cardRemainingBalance, 77.99);
});

test("saved card quote is used even when it differs from current card rounding", () => {
  const source = booking({ pricingQuote: { version: 1, pricingCategory: "off_river_small_rig", discountQualified: false, bankDailyPrice: 75, cardDailyPrice: 78.49 } });
  const bill = summarize({ ...reservation, amount_paid: 78.49 }, source);
  assert.equal(bill.cardDailyPrice, 78.49);
  assert.equal(bill.cardRemainingBalance, 78.49);
});

test("ordinary contact, check-in, and payment info edits preserve the quote", () => {
  const bill = summarize({ ...reservation, first_name: "Updated", notes: "Checked in", amount_paid: 0, deposit_amount: 0 });
  assert.equal(bill.bankDailyPrice, 75);
  assert.equal(bill.requiredDepositAmount, 0);
  assert.equal(bill.cardRemainingBalance, 155.98);
});

test("intentional pricing and dates/site changes use the current admin configuration", () => {
  const live = [priceStay()];
  for (const row of [
    { ...reservation, requested_discounts: ["Admin confirmed discount"] },
    { ...reservation, pricing_category_override: "prime_river" },
    { ...reservation, billing_mode: "monthly" },
    { ...reservation, billing_mode: "manual_total" },
    { ...reservation, reservation_term: "yearly" }
  ]) assert.equal(applyBookedPricing(row, live, booking()), live);
  for (const segment of [
    { ...stay, site_id: 5 }, { ...stay, arrival_date: "2026-10-10" }, { ...stay, leave_date: "2026-10-12" }
  ]) {
    const changed = [priceStay(segment)];
    assert.equal(applyBookedPricing(reservation, changed, booking()), changed);
  }
  assert.equal(applyBookedPricing(reservation, [...live, ...live], booking()).length, 2);
});

test("same explicit pricing category and renamed discount qualification keep new quotes", () => {
  const source = booking({ discounts: ["AAA"], baseTotalPrice: 130, totalPrice: 133.98,
    pricingQuote: createBookingPricingQuote(priceStay(stay, prices(75, 65)), ["AAA"]) });
  const bill = summarize({ ...reservation, pricing_category_override: "off_river_small_rig", requested_discounts: ["Admin confirmed discount"], amount_paid: 66.99 }, source);
  assert.equal(bill.bankDailyPrice, 65);
  assert.equal(bill.cardRemainingBalance, 66.99);
});

test("missing current rate table does not erase a valid booked quote", () => {
  const bill = summarize(reservation, booking(), [priceStay(stay, new Map())]);
  assert.equal(bill.bankDailyPrice, 75);
  assert.equal(bill.cardRemainingBalance, 77.99);
  assert.equal(bill.siteStays[0].pricingConfigured, true);
});

test("missing or invalid quotes do not guess historical prices or mutate live pricing", () => {
  const live = [priceStay()];
  const before = structuredClone(live);
  for (const source of [null, booking({ baseTotalPrice: null }), booking({ baseTotalPrice: "oops" }), booking({ baseTotalPrice: -150 })]) {
    assert.equal(applyBookedPricing(reservation, live, source), live);
  }
  applyBookedPricing(reservation, live, booking());
  assert.deepEqual(live, before);
  const bill = summarize(reservation, null, live);
  assert.equal(bill.bankDailyPrice, 65);
});

test("schedule quotes are loaded in one parameterized batch without contact data", async () => {
  let calls = 0;
  const db = { query: async (sql, params) => {
    calls += 1;
    assert.match(sql, /reservation_id = ANY\(\$1::bigint\[\]\)/);
    assert.doesNotMatch(sql, /email|phone|firstName|lastName/);
    assert.deepEqual(params, [[42, 43]]);
    return { rows: [{ ...booking(), reservation_id: "42" }] };
  } };
  assert.equal((await loadBookedPricing(db, [])).size, 0);
  const result = await loadBookedPricing(db, [42, 43]);
  assert.equal(calls, 1);
  assert.equal(result.get(42).pricing_payload.baseTotalPrice, 150);
  assert.equal(result.has(43), false);
});

test("schedule and check-in reservation loaders both return the original quote", async () => {
  // Exercise the production loaders without starting Express, connecting to a
  // real database, or contacting Stripe/email services from the server bootstrap.
  const source = readFileSync(new URL("./index.js", import.meta.url), "utf8");
  const declarations = ["nightsBetween", "isOpenEndedSegment", "fetchReservationDetails", "buildReservationDetailsFromParts", "fetchReservationList"].map((name) => {
    const start = source.indexOf(`async function ${name}(`) >= 0
      ? source.indexOf(`async function ${name}(`) : source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `Missing production loader ${name}`);
    return source.slice(start, source.indexOf("\n}\n", start) + 3);
  });
  const liveRules = [{ site_category: "off_river_small_rig", number_of_days: 1, normal_price: 65, discount_price: 55 }];
  const row = { ...reservation, id: "42", status: "active" };
  const events = [{ reservation_id: "42", id: 1, amount: 77.99, note: "Stripe deposit. Price type: card" }];
  const checkIns = [{ reservation_id: "42", id: 2, discount_memberships: [], signed_name: "Guest" }];
  let quoteQueries = 0;
  const db = { query: async (sql) => {
    let rows;
    if (sql.includes("FROM reservations r")) rows = [row];
    else if (sql.includes("FROM reservation_payment_events")) rows = events;
    else if (sql.includes("FROM reservation_check_ins")) rows = checkIns;
    else if (sql.includes("FROM reservation_site_stays rss")) rows = [{ ...stay, reservation_id: "42", id: 10 }];
    else if (sql.includes("FROM public_booking_checkouts")) { quoteQueries += 1; rows = [booking()]; }
    else assert.fail(`Unexpected loader query: ${sql}`);
    return { rowCount: rows.length, rows };
  } };
  const loaders = vm.runInNewContext(`${declarations.join("\n")}\n({ fetchReservationDetails, fetchReservationList })`, {
    applyBookedPricing, loadBookedPricing, buildPricingRuleLookup, getPricingForSiteAndNights,
    sumReservationTotals, buildBillingSummary,
    toPriceNumber: (value) => value == null ? null : Number(value),
    serializeReservationCheckIn: (value) => value || null,
    loadPricingRules: async () => liveRules,
    openEndedStayDate: "9999-12-31"
  });
  const detail = await loaders.fetchReservationDetails(db, "42");
  const [schedule] = await loaders.fetchReservationList(db);
  for (const result of [detail, schedule]) {
    assert.equal(result.bankDailyPrice, 75);
    assert.equal(result.cardDailyPrice, getCardPrice(75));
    assert.equal(result.bankRemainingBalance, 75);
    assert.equal(result.cardRemainingBalance, 77.99);
    assert.equal(result.siteStays[0].bookingPriceLocked, true);
    assert.equal(result.checkIn.signed_name, "Guest");
    assert.equal(result.booking_payload, undefined);
    assert.equal(result.pricing_payload, undefined);
  }
  assert.equal(quoteQueries, 2); // One lookup per load, not per reservation.
});
