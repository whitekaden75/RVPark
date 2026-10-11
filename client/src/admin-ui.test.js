import test from "node:test";
import assert from "node:assert/strict";
import { adminPages, getSiteOptions, updateStayField, getAdminOverview, getPaymentFollowUps } from "./admin-ui.js";

const sites = [
  { id: 1, site_number: "10" },
  { id: 2, site_number: "2" },
  { id: 3, site_number: "A1" },
];

test("site search keeps the selected option visible while searching a different site", () => {
  assert.deepEqual(getSiteOptions(sites, " a ", "2").map((site) => site.id), [2, 3]);
  assert.deepEqual(getSiteOptions(sites, "missing", 2).map((site) => site.id), [2]);
  assert.deepEqual(getSiteOptions(sites, "missing").map((site) => site.id), []);
});

test("selecting a site restores every choice and preserves the dates", () => {
  const stay = { siteId: "2", siteSearch: "A", arrivalDate: "2026-10-10", leaveDate: "2026-10-12" };
  const next = updateStayField(stay, "siteId", "3");
  assert.equal(next.siteSearch, "");
  assert.equal(next.arrivalDate, stay.arrivalDate);
  assert.equal(next.leaveDate, stay.leaveDate);
  assert.deepEqual(getSiteOptions(sites, next.siteSearch, next.siteId).map((site) => site.site_number), ["2", "10", "A1"]);
  assert.equal(stay.siteSearch, "A");
});

test("typing a filter never silently changes the chosen site", () => {
  assert.deepEqual(updateStayField({ siteId: "2", siteSearch: "" }, "siteSearch", "A"), { siteId: "2", siteSearch: "A" });
});

test("moving arrival past departure clears the invalid range; valid departures stay intact", () => {
  const stay = { siteId: "2", arrivalDate: "2026-10-10", leaveDate: "2026-10-12" };
  assert.equal(updateStayField(stay, "arrivalDate", "2026-10-12").leaveDate, "");
  assert.equal(updateStayField(stay, "arrivalDate", "2026-10-13").leaveDate, "");
  assert.equal(updateStayField(stay, "arrivalDate", "").leaveDate, "");
  assert.equal(updateStayField(stay, "arrivalDate", "2026-10-11").leaveDate, "2026-10-12");
});

test("all admin destinations can be opened by URL", () => {
  for (const key of ["overview", "reservation", "availability", "schedule", "history", "monthly", "yearly", "bookkeeping", "sites", "checkin", "messages"]) {
    assert.ok(adminPages.some((page) => page.key === key), key);
  }
  assert.equal(new Set(adminPages.map((page) => page.key)).size, adminPages.length);
});

const stay = (siteId, arrival, leave) => ({ site_id: siteId, site_number: sites.find((site) => site.id === siteId)?.site_number, arrival_date: arrival, leave_date: leave });
const reservation = (id, stays, status = "active") => ({ id, status, siteStays: stays });

test("daily overview separates site moves from arrivals and departures, including return visits", () => {
  const data = [
    reservation(1, [stay(1, "2026-10-01", "2026-10-10"), stay(2, "2026-10-10", "2026-10-12")]),
    reservation(2, [stay(3, "2026-09-01", "2026-09-05"), stay(3, "2026-10-10", "2026-10-15")]),
    reservation(3, [stay(1, "2026-10-05", "2026-10-10")]),
  ];
  const result = getAdminOverview(data, sites, "2026-10-10");
  assert.deepEqual(result.moves.map((entry) => entry.reservation.id), [1]);
  assert.deepEqual(result.arrivals.map((entry) => entry.reservation.id), [2]);
  assert.deepEqual(result.departures.map((entry) => entry.reservation.id), [3]);
  assert.equal(result.reservedSites, 2);
});

test("occupancy uses exclusive departure dates, unique known sites and active bookings", () => {
  const result = getAdminOverview([
    reservation(1, [stay(1, "2026-10-05", "2026-10-10")]),
    reservation(2, [stay(2, "2026-10-10", "9999-12-31"), stay(2, "2026-10-10", "2026-10-11")]),
    reservation(3, [stay(3, "2026-10-10", "2026-10-15")], "pending"),
    reservation(4, [stay(1, "2026-10-10", "2026-10-15")], "canceled"),
    reservation(5, [stay(99, "2026-10-10", "2026-10-15")]),
  ], sites, "2026-10-10");
  assert.equal(result.reservedSites, 1);
  assert.equal(result.totalSites, 3);
  assert.deepEqual(result.pending.map((row) => row.id), [3]);
  assert.ok(!result.arrivals.some((entry) => [3, 4].includes(entry.reservation.id)));
});

test("payment follow-up includes yesterday's deposit-only arrival and departed unpaid guests", () => {
  const partial = { ...reservation(1, [stay(1, "2026-10-09", "2026-10-12")]), paidStayNights: 1, unpaidStayNights: 2 };
  const departed = { ...reservation(2, [stay(2, "2026-10-07", "2026-10-10")]), paidStayNights: 1, unpaidStayNights: 2 };
  const result = getPaymentFollowUps([partial, departed], "2026-10-10");
  assert.deepEqual(result.map((entry) => entry.reservation.id), [2, 1]);
  assert.equal(result[0].departed, true);
  assert.equal(result[1].arrivalDate, "2026-10-09");
  assert.equal(result[1].unpaidNights, 2);
  assert.equal(getPaymentFollowUps([{ ...partial, paidStayNights: 3, unpaidStayNights: 0 }], "2026-10-10").length, 0);
});

test("payment follow-up excludes future, canceled, fully-paid and recurring stays", () => {
  const owing = { ...reservation(1, [stay(1, "2026-10-09", "2026-10-12")]), bankRemainingBalance: 120 };
  const excluded = [
    { ...owing, id: 2, siteStays: [stay(1, "2026-10-11", "2026-10-14")] },
    { ...owing, id: 3, status: "canceled" },
    { ...owing, id: 4, status: "pending" },
    { ...owing, id: 5, bankRemainingBalance: 0, cardRemainingBalance: 0 },
    { ...owing, id: 6, effectiveBillingMode: "monthly" },
    { ...owing, id: 7, reservation_term: "yearly" },
    { ...owing, id: 8, bankRemainingBalance: null, remainingBalance: null },
  ];
  assert.deepEqual(getPaymentFollowUps([owing, ...excluded], "2026-10-10").map((entry) => entry.reservation.id), [1]);
});

test("unverified after-hours cash envelopes stay visible; ordinary pending bookings do not", () => {
  const cash = { ...reservation(1, [stay(1, "2026-10-09", "2026-10-12")], "pending"),
    notes: "AFTER-HOURS DRIVE-UP — cash envelope payment awaiting office verification.", paidStayNights: 0, unpaidStayNights: 3 };
  assert.equal(getPaymentFollowUps([cash], "2026-10-10")[0].cashEnvelope, true);
});

test("site moves preserve visit arrival; paid past visits don't flag an unpaid future return visit", () => {
  const moved = { ...reservation(1, [stay(1, "2026-10-09", "2026-10-10"), stay(2, "2026-10-10", "2026-10-12")]), paidStayNights: 1, unpaidStayNights: 2 };
  const returnVisit = { ...reservation(2, [stay(3, "2026-10-01", "2026-10-03"), stay(3, "2026-11-01", "2026-11-03")]), paidStayNights: 2, unpaidStayNights: 2 };
  const result = getPaymentFollowUps([moved, returnVisit], "2026-10-10");
  assert.equal(result.length, 1);
  assert.equal(result[0].arrivalDate, "2026-10-09");
  assert.deepEqual(result[0].siteNumbers, ["10", "2"]);
});

test("an ongoing trip includes unpaid nights after a future site move", () => {
  const trip = { ...reservation(1, [stay(1, "2026-10-09", "2026-10-11"), stay(2, "2026-10-11", "2026-10-14")]),
    paidStayNights: 2, unpaidStayNights: 3 };
  const [result] = getPaymentFollowUps([trip], "2026-10-10");
  assert.equal(result.arrivalDate, "2026-10-09");
  assert.equal(result.leaveDate, "2026-10-14");
  assert.equal(result.departed, false);
  assert.equal(result.unpaidNights, 3);
  assert.deepEqual(result.siteNumbers, ["10", "2"]);
});
