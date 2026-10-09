import {
  calculateChargeableNights,
  getCardPrice,
  normalizeRequestedDiscounts,
  roundCurrency
} from "./reservation-pricing.js";

const hasDiscount = (discounts) => normalizeRequestedDiscounts(discounts).length > 0;
const positivePrice = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? roundCurrency(amount) : null;
};

// Save the selected nightly prices as well as the stay total. Card rounding is per
// chargeable night, not a new surcharge on the outstanding dollar balance.
export function createBookingPricingQuote(pricing, discounts) {
  const discountQualified = hasDiscount(discounts);
  const bankDailyPrice = discountQualified
    ? pricing.discountDailyPrice ?? pricing.normalDailyPrice
    : pricing.normalDailyPrice ?? pricing.discountDailyPrice;
  return {
    version: 1,
    pricingCategory: pricing.pricingCategory,
    discountQualified,
    bankDailyPrice: roundCurrency(bankDailyPrice),
    cardDailyPrice: getCardPrice(bankDailyPrice)
  };
}

// Use a single batch lookup for the schedule, rather than one query per booking.
// Only load pricing fields; the checkout's contact/consent data stays private.
export async function loadBookedPricing(queryable, reservationIds) {
  if (!reservationIds.length) return new Map();
  const result = await queryable.query(
    `SELECT DISTINCT ON (reservation_id)
       reservation_id, site_id, arrival_date::text, leave_date::text,
       jsonb_build_object(
         'baseTotalPrice', booking_payload->'baseTotalPrice',
         'totalPrice', booking_payload->'totalPrice',
         'paymentMethod', booking_payload->'paymentMethod',
         'discounts', booking_payload->'discounts',
         'pricingQuote', booking_payload->'pricingQuote'
       ) AS pricing_payload
     FROM public_booking_checkouts
     WHERE reservation_id = ANY($1::bigint[])
     ORDER BY reservation_id, id`,
    [reservationIds]
  );
  return new Map(result.rows.map((row) => [Number(row.reservation_id), row]));
}

export function applyBookedPricing(reservation, siteStays, booking) {
  if (!booking || reservation.billing_mode !== "standard" ||
      reservation.reservation_term === "yearly" || siteStays.length !== 1) {
    return siteStays;
  }

  const stay = siteStays[0];
  const payload = booking.pricing_payload || {};
  const quote = payload.pricingQuote;
  const discountQualified = hasDiscount(payload.discounts);
  // Ordinary check-in/contact/payment-method edits must not reprice the stay.
  // An explicit discount, pricing-category, or dates/site edit can reprice it.
  if (Number(stay.site_id) !== Number(booking.site_id) ||
      stay.arrival_date !== booking.arrival_date ||
      stay.leave_date !== booking.leave_date ||
      hasDiscount(reservation.requested_discounts) !== discountQualified ||
      (reservation.pricing_category_override &&
        reservation.pricing_category_override !== quote?.pricingCategory)) {
    return siteStays;
  }

  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!datePattern.test(booking.arrival_date) || !datePattern.test(booking.leave_date)) return siteStays;
  const numberOfNights = (Date.parse(`${booking.leave_date}T00:00:00Z`) -
    Date.parse(`${booking.arrival_date}T00:00:00Z`)) / 86400000;
  const chargeableNights = calculateChargeableNights(numberOfNights);
  if (!Number.isInteger(numberOfNights) || chargeableNights === null) return siteStays;

  let bankDailyPrice;
  let cardDailyPrice;
  if (quote?.version === 1 && quote.discountQualified === discountQualified) {
    bankDailyPrice = positivePrice(quote.bankDailyPrice);
    cardDailyPrice = positivePrice(quote.cardDailyPrice);
  } else {
    // Older checkouts already contain the agreed bank/card totals. Recover their
    // nightly quote without guessing from a deposit or using today's rate table.
    const bankTotal = positivePrice(payload.baseTotalPrice);
    bankDailyPrice = bankTotal === null ? null : roundCurrency(bankTotal / chargeableNights);
    const cardTotal = positivePrice(payload.totalPrice);
    cardDailyPrice = payload.paymentMethod === "card" && cardTotal !== null
      ? roundCurrency(cardTotal / chargeableNights)
      : getCardPrice(bankDailyPrice);
    if (bankTotal !== null && Math.abs(bankDailyPrice * chargeableNights - bankTotal) > 0.011) return siteStays;
    if (payload.paymentMethod === "card" && cardTotal !== null &&
        Math.abs(cardDailyPrice * chargeableNights - cardTotal) > 0.011) return siteStays;
  }
  if (bankDailyPrice === null || cardDailyPrice === null) return siteStays;

  const pricePrefix = discountQualified ? "discount" : "normal";
  return [{
    ...stay,
    numberOfNights,
    pricingConfigured: true,
    bookingPriceLocked: true,
    [`${pricePrefix}DailyPrice`]: bankDailyPrice,
    [`${pricePrefix}CardDailyPrice`]: cardDailyPrice,
    [`${pricePrefix}Price`]: roundCurrency(bankDailyPrice * chargeableNights)
  }];
}
