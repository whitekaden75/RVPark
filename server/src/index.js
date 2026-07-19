import cors from "cors";
import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import dotenv from "dotenv";
import express from "express";
import Stripe from "stripe";
import { pool } from "./db.js";
import {
  buildAvailabilityMap,
  buildAvailabilityBookingContext,
  buildAvailabilityLeadTimes,
  buildSiteSwitchPlan,
  getDirectMatches,
  normalizeSegments,
  openEndedStayDate,
  validateReservationSegments
} from "./planner.js";

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 4000);
const appPasscode = process.env.APP_PASSCODE || "rvpark2026";
const appPasscodeHeader = "x-app-passcode";
const stripeApiVersion = "2026-02-25.clover";
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || "";
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";
const sendGridApiKey = process.env.SENDGRID_API_KEY || "";
const sendGridFromEmail = process.env.SENDGRID_FROM_EMAIL || "";
const sendGridFromName = process.env.SENDGRID_FROM_NAME || "Riverpark RV Resort";
const sendGridReplyTo = process.env.SENDGRID_REPLY_TO || sendGridFromEmail;
const guestAuthSecret = process.env.GUEST_AUTH_SECRET || "";
const guestVerificationRequests = new Map();
const guestVerificationAttempts = new Map();
const cardPriceMultiplier = 1.03;
const pricingPreviewDays = Array.from({ length: 28 }, (_, index) => index + 1);
const stripe = stripeSecretKey
  ? new Stripe(stripeSecretKey, { apiVersion: stripeApiVersion })
  : null;

app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN?.split(",").map((value) => value.trim()) || "*",
    allowedHeaders: ["Content-Type", appPasscodeHeader]
  })
);

app.post("/api/stripe/webhooks", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe) {
    return res.status(503).json({
      message: "Stripe is not configured. Add STRIPE_SECRET_KEY on the server first."
    });
  }

  if (!stripeWebhookSecret) {
    return res.status(503).json({
      message: "Stripe webhook secret is not configured. Add STRIPE_WEBHOOK_SECRET on the server first."
    });
  }

  const signature = req.header("stripe-signature");

  if (!signature) {
    return res.status(400).json({ message: "Missing Stripe signature header." });
  }

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, signature, stripeWebhookSecret);
  } catch (error) {
    return res.status(400).json({ message: `Invalid Stripe webhook signature: ${error.message}` });
  }

  let eventRecord;

  try {
    eventRecord = await upsertStripeWebhookEventRecord(event);
  } catch (error) {
    console.error("Unable to store Stripe webhook event", event.id, error);
    return res.status(500).json({ message: "Unable to store Stripe webhook event." });
  }

  if (eventRecord.processingStatus === "processed") {
    return res.json({ received: true, duplicate: true });
  }

  try {
    await handleStripeWebhookEvent(event);
    await updateStripeWebhookEventRecord(eventRecord.id, "processed");
    return res.json({ received: true });
  } catch (error) {
    console.error("Unable to process Stripe webhook event", event.id, error);
    await updateStripeWebhookEventRecord(eventRecord.id, "failed", error.message);
    return res.status(500).json({ message: "Unable to process Stripe webhook event." });
  }
});

app.use(express.json());

app.use("/api", (req, res, next) => {
  if (
    req.path === "/health" ||
    req.path === "/availability/search" ||
    req.path === "/availability/plan" ||
    req.path === "/availability/flexible-search" ||
    req.path.startsWith("/guest/")
  ) {
    return next();
  }

  const requestPasscode = req.header(appPasscodeHeader);

  if (requestPasscode !== appPasscode) {
    return res.status(401).json({ message: "Invalid passcode." });
  }

  return next();
});

function nightsBetween(arrivalDate, leaveDate) {
  const start = new Date(`${arrivalDate}T00:00:00Z`);
  const end = new Date(`${leaveDate}T00:00:00Z`);
  return Math.round((end - start) / 86400000);
}

function addDays(dateString, numberOfDays) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + numberOfDays);
  return date.toISOString().slice(0, 10);
}

function formatDisplayDate(dateString) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  }).format(new Date(`${dateString}T00:00:00Z`));
}

function formatEmailCurrency(value) {
  const amount = Number(value);

  if (!Number.isFinite(amount)) {
    return "Not set";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
  }).format(amount);
}

function buildEmailConfirmationCode(reservation) {
  const bookedDate = String(reservation.booked_date || "")
    .replaceAll("-", "")
    .slice(2);

  return `#${reservation.id}${bookedDate ? `-${bookedDate}` : ""}`;
}

function escapeEmailHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildReservationConfirmationEmail(reservation) {
  const primaryStay = reservation.siteStays?.[0] || null;
  const customerName = `${reservation.first_name || ""} ${reservation.last_name || ""}`.trim();
  const confirmationCode = buildEmailConfirmationCode(reservation);
  const departureDate = primaryStay?.isOpenEnded
    ? "Open-ended yearly stay"
    : primaryStay?.leave_date
      ? formatDisplayDate(primaryStay.leave_date)
      : "Not set";
  const text = [
    "Riverpark RV Resort",
    "RESERVATION CONFIRMATION",
    `Confirmation: ${confirmationCode}`,
    "",
    `Hi ${customerName || "Guest"},`,
    "",
    `Email: ${reservation.email || "Not set"}`,
    `Phone: ${reservation.phone_number || "Not set"}`,
    "",
    "Deposit",
    "Non Refundable",
    "1 night per reservation, per week. We have a 3% surcharge for credit card. (No Debit cards) you may write a check, or cash with no surcharge on arrival balance.",
    `Deposit amount: ${formatEmailCurrency(reservation.depositAmount)}`,
    `Arrival: ${primaryStay?.arrival_date ? formatDisplayDate(primaryStay.arrival_date) : "Not set"}`,
    "(Check-in 1:00 P.M.)",
    `Depart: ${departureDate}`,
    "(Check-out 11:00 A.M.)",
    "",
    "Important information",
    "***Upon arrival, please stop at office to register",
    "**We welcome your fur babies, but out of respect for other campers, & office please: keep pets on a leash at all times; immediately pick-up your pets doo, droppings**",
    "or we will ask you to leave!! No Exceptions!",
    "***There are no WOOD fires allowed in the park. No exceptions!",
    "** Charcoal barbecue's, & propane are okay",
    "(1 car or truck) per site reserved",
    "$5.00 charge extra car",
    "***PLEASE BE RESPECTFUL AND NEVER WALK THROUGH ANOTHER GUESTS SITE!!! This includes walking behind other RV's that are parked along the river!! The rose bush area is fine to cut through!!!",
    "***SITE AND RATES ARE SUBJECT TO CHANGE***",
    "***Contact us as soon as possible if any corrections are necessary.",
    "Please note!! No AT&T cell towers close by & signal is weak or may not work",
    "",
    "Thank you for booking with us!",
    "Makayla",
    "",
    "Riverpark RV Resort",
    "2956 Rogue River Hwy",
    "Grants Pass, OR 97527",
    "",
    "541-295-1269 (cell)",
    "Text message okay"
  ].join("\n");
  const escapedText = text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\n", "<br>");

  return {
    subject: `Riverpark RV Resort reservation confirmation ${confirmationCode}`,
    text,
    html: `<div style="max-width:680px;margin:0 auto;padding:24px;color:#17372f;font-family:Arial,sans-serif;font-size:16px;line-height:1.6">${escapedText}</div>`
  };
}

async function sendEmailWithSendGrid({ to, toName = "", subject, text, html }) {
  if (!sendGridApiKey || !sendGridFromEmail) {
    throw new Error(
      "Email is not configured. Add SENDGRID_API_KEY and SENDGRID_FROM_EMAIL to the server."
    );
  }

  const payload = {
    personalizations: [
      {
        to: [
          {
            email: to,
            ...(toName ? { name: toName } : {})
          }
        ]
      }
    ],
    from: {
      email: sendGridFromEmail,
      name: sendGridFromName
    },
    ...(sendGridReplyTo ? { reply_to: { email: sendGridReplyTo } } : {}),
    subject,
    content: [
      { type: "text/plain", value: text },
      { type: "text/html", value: html }
    ]
  };
  const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sendGridApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    const sendGridMessage = errorBody?.errors?.[0]?.message;
    throw new Error(sendGridMessage || `SendGrid rejected the email (${response.status}).`);
  }
}

async function sendReservationConfirmationEmail(reservation) {
  const message = buildReservationConfirmationEmail(reservation);
  const recipientName = `${reservation.first_name || ""} ${reservation.last_name || ""}`.trim();

  await sendEmailWithSendGrid({
    to: reservation.email,
    toName: recipientName,
    ...message
  });
}

function signGuestToken(payload) {
  if (!guestAuthSecret) {
    throw new Error("Guest email sign-in is not configured. Add GUEST_AUTH_SECRET to the server.");
  }

  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", guestAuthSecret)
    .update(encodedPayload)
    .digest("base64url");

  return `${encodedPayload}.${signature}`;
}

function readGuestToken(token, expectedType) {
  if (!guestAuthSecret) {
    return null;
  }

  const [encodedPayload, providedSignature, ...extraParts] = String(token || "").split(".");

  if (!encodedPayload || !providedSignature || extraParts.length) {
    return null;
  }

  const expectedSignature = createHmac("sha256", guestAuthSecret)
    .update(encodedPayload)
    .digest("base64url");
  const providedBuffer = Buffer.from(providedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));

    if (
      payload.type !== expectedType ||
      !Number.isFinite(payload.expiresAt) ||
      payload.expiresAt <= Date.now()
    ) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

function buildGuestCodeDigest(nonce, verificationCode) {
  return createHmac("sha256", guestAuthSecret)
    .update(`${nonce}:${verificationCode}`)
    .digest("base64url");
}

function guestCodeMatches(challenge, verificationCode) {
  const providedDigest = buildGuestCodeDigest(challenge.nonce, verificationCode);
  const providedBuffer = Buffer.from(providedDigest);
  const expectedBuffer = Buffer.from(challenge.codeDigest || "");

  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

async function sendGuestVerificationEmail(customer, verificationCode) {
  const guestName = `${customer.first_name || ""} ${customer.last_name || ""}`.trim();
  const safeGuestName = escapeEmailHtml(guestName || "Guest");
  const subject = "Your Riverpark booking verification code";
  const text = [
    `Hi ${guestName || "Guest"},`,
    "",
    "Use this verification code to manage your Riverpark RV Resort booking:",
    "",
    verificationCode,
    "",
    "This code expires in 10 minutes. If you did not request it, you can ignore this email.",
    "",
    "Riverpark RV Resort",
    "541-295-1269"
  ].join("\n");
  const html = `
    <div style="max-width:600px;margin:0 auto;padding:28px;color:#17372f;font-family:Arial,sans-serif;font-size:16px;line-height:1.6">
      <p>Hi ${safeGuestName},</p>
      <p>Use this verification code to manage your Riverpark RV Resort booking:</p>
      <div style="margin:24px 0;padding:18px;border-radius:12px;background:#f3ede0;font-size:32px;font-weight:700;letter-spacing:8px;text-align:center">${verificationCode}</div>
      <p>This code expires in 10 minutes. If you did not request it, you can ignore this email.</p>
      <p>Riverpark RV Resort<br>541-295-1269</p>
    </div>
  `;

  await sendEmailWithSendGrid({
    to: customer.email,
    toName: guestName,
    subject,
    text,
    html
  });
}

function toPriceNumber(value) {
  return value === null || value === undefined ? null : Number(value);
}

function toAmountCents(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return Math.round(parsed * 100);
}

function roundCurrency(value) {
  return value === null || value === undefined
    ? null
    : Math.round(Number(value) * 100) / 100;
}

function getCardPrice(value) {
  const amount = toPriceNumber(value);

  if (amount === null) {
    return null;
  }

  const cardAmount = amount * cardPriceMultiplier;
  return roundCurrency(Math.ceil(cardAmount - 0.99) + 0.99);
}

function getBaseAmountFromCardPayment(value) {
  const amount = toPriceNumber(value);

  if (amount === null) {
    return null;
  }

  return roundCurrency(amount / cardPriceMultiplier);
}

function isCardPaymentMethodType(value) {
  return String(value || "").toLowerCase() === "card";
}

function normalizeReservationStatus(value) {
  if (value === "canceled") {
    return "canceled";
  }

  if (value === "pending") {
    return "pending";
  }

  return "active";
}

function normalizeReservationTerm(value) {
  return value === "yearly" ? "yearly" : "standard";
}

function normalizeBillingMode(value) {
  if (value === "manual_total") {
    return "manual_total";
  }

  if (value === "monthly") {
    return "monthly";
  }

  return "standard";
}

function normalizeSitePayload(body) {
  const siteNumber = String(body?.siteNumber || "").trim();
  const sizeFeet = Number(body?.sizeFeet);
  const isOnRiver = Boolean(body?.isOnRiver);
  const isBigRig = Boolean(body?.isBigRig);
  const riverCategory = String(body?.riverCategory || "").trim();

  if (!siteNumber) {
    return { error: "Site number is required." };
  }

  if (!Number.isFinite(sizeFeet) || sizeFeet <= 0) {
    return { error: "Site size must be greater than zero." };
  }

  if (isOnRiver && !["prime_river", "normal_river"].includes(riverCategory)) {
    return { error: "River category must be prime river or non-prime river." };
  }

  return {
    siteNumber,
    sizeFeet,
    isOnRiver,
    riverCategory,
    isBigRig
  };
}

function toMeterNumber(value) {
  return value === null || value === undefined || value === "" ? null : Number(value);
}

function calculateUtilityPrice(electricMeterReading) {
  const meter = toMeterNumber(electricMeterReading);

  if (meter === null) {
    return null;
  }

  return meter * 0.17 - 75;
}

function getEffectiveReservationTotal(billingMode, totals, totalPrice, monthlyRentPrice, utilityPrice) {
  if (billingMode === "manual_total") {
    return toPriceNumber(totalPrice);
  }

  if (billingMode === "monthly") {
    const rent = toPriceNumber(monthlyRentPrice);

    if (rent === null || utilityPrice === null) {
      return null;
    }

    return rent + utilityPrice;
  }

  if (totals.normalPrice !== null && totals.normalPrice !== undefined) {
    return totals.normalPrice;
  }

  if (totals.discountPrice !== null && totals.discountPrice !== undefined) {
    return totals.discountPrice;
  }

  return toPriceNumber(totalPrice);
}

function isOpenEndedSegment(segment, reservationTerm) {
  return reservationTerm === "yearly" && segment.leave_date === openEndedStayDate;
}

function getPricingCategory(site) {
  if (site.river_category === "prime_river") {
    return "prime_river";
  }

  if (site.river_category === "normal_river") {
    return "normal_river";
  }

  return site.is_big_rig ? "off_river_big_rig" : "off_river_small_rig";
}

function calculateChargeableNights(numberOfNights) {
  if (!Number.isFinite(numberOfNights) || numberOfNights <= 0 || numberOfNights > 28) {
    return null;
  }

  return numberOfNights - Math.floor(numberOfNights / 7);
}

function buildPricingRuleLookup(pricingRules) {
  const lookup = new Map();

  for (const rule of pricingRules) {
    if (Number(rule.number_of_days) !== 1) {
      continue;
    }

    lookup.set(rule.site_category, {
      numberOfDays: rule.number_of_days,
      normalPrice: toPriceNumber(rule.normal_price),
      discountPrice: toPriceNumber(rule.discount_price)
    });
  }

  return lookup;
}

function buildPricingRulesByCategory(pricingRules) {
  const byCategory = new Map();

  for (const rule of pricingRules) {
    if (Number(rule.number_of_days) !== 1) {
      continue;
    }

    const baseRule = {
      numberOfDays: 1,
      normalPrice: toPriceNumber(rule.normal_price),
      discountPrice: toPriceNumber(rule.discount_price)
    };
    byCategory.set(
      rule.site_category,
      pricingPreviewDays.map((numberOfDays) => {
        const chargeableNights = calculateChargeableNights(numberOfDays);

        return {
          numberOfDays,
          normalPrice:
            baseRule.normalPrice !== null
              ? roundCurrency(baseRule.normalPrice * chargeableNights)
              : null,
          discountPrice:
            baseRule.discountPrice !== null
              ? roundCurrency(baseRule.discountPrice * chargeableNights)
              : null
        };
      })
    );
  }

  return byCategory;
}

function applyBalanceSummary(amountPaid, totals) {
  const paid = toPriceNumber(amountPaid) ?? 0;

  return {
    amountPaid: paid,
    remainingNormalPrice:
      totals?.normalPrice !== null && totals?.normalPrice !== undefined
        ? Math.max(totals.normalPrice - paid, 0)
        : null,
    remainingDiscountPrice:
      totals?.discountPrice !== null && totals?.discountPrice !== undefined
        ? Math.max(totals.discountPrice - paid, 0)
        : null
  };
}

function buildBillingSummary(reservationRow, totals) {
  const utilityPrice = calculateUtilityPrice(reservationRow.electric_meter_reading);
  const effectiveTotalPrice = getEffectiveReservationTotal(
    reservationRow.billing_mode,
    totals,
    reservationRow.total_price,
    reservationRow.monthly_rent_price,
    utilityPrice
  );

  return {
    depositAmount: toPriceNumber(reservationRow.deposit_amount) ?? 0,
    cardDepositAmount: getCardPrice(reservationRow.deposit_amount) ?? 0,
    totalPrice: toPriceNumber(reservationRow.total_price),
    monthlyRentPrice: toPriceNumber(reservationRow.monthly_rent_price),
    electricMeterReading: toMeterNumber(reservationRow.electric_meter_reading),
    utilityPrice,
    effectiveTotalPrice,
    cardTotalPrice: getCardPrice(effectiveTotalPrice),
    remainingBalance:
      effectiveTotalPrice !== null && effectiveTotalPrice !== undefined
        ? roundCurrency(
            effectiveTotalPrice - (toPriceNumber(reservationRow.amount_paid) ?? 0)
          )
        : null,
    cardRemainingBalance:
      effectiveTotalPrice !== null && effectiveTotalPrice !== undefined
        ? getCardPrice(
            Math.max(
              effectiveTotalPrice - (toPriceNumber(reservationRow.amount_paid) ?? 0),
              0
            )
          )
        : null
  };
}

async function insertReservationPaymentEvent(
  client,
  {
    reservationId,
    stripePaymentRecordId = null,
    amount,
    paymentSource,
    note = null,
    recordedAt = new Date().toISOString()
  }
) {
  const normalizedAmount = toPriceNumber(amount);

  if (normalizedAmount === null || normalizedAmount <= 0) {
    return;
  }

  if (stripePaymentRecordId) {
    await client.query(
      `
        INSERT INTO reservation_payment_events (
          reservation_id,
          stripe_payment_record_id,
          amount,
          payment_source,
          note,
          recorded_at
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (stripe_payment_record_id) DO NOTHING
      `,
      [reservationId, stripePaymentRecordId, normalizedAmount, paymentSource, note, recordedAt]
    );
    return;
  }

  await client.query(
    `
      INSERT INTO reservation_payment_events (
        reservation_id,
        stripe_payment_record_id,
        amount,
        payment_source,
        note,
        recorded_at
      )
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [reservationId, null, normalizedAmount, paymentSource, note, recordedAt]
  );
}

function ensureStripeConfigured(res) {
  if (!stripe) {
    res.status(503).json({
      message: "Stripe is not configured. Add STRIPE_SECRET_KEY on the server first."
    });
    return false;
  }

  return true;
}

function getStripeEventTimestamp(event) {
  return Number.isFinite(event?.created) ? new Date(event.created * 1000).toISOString() : null;
}

function getStripeObjectId(event) {
  return typeof event?.data?.object?.id === "string" ? event.data.object.id : null;
}

async function upsertStripeWebhookEventRecord(event) {
  const existingResult = await pool.query(
    `
      SELECT id, processing_status
      FROM stripe_webhook_events
      WHERE stripe_event_id = $1
      LIMIT 1
    `,
    [event.id]
  );

  if (existingResult.rowCount > 0) {
    return {
      id: existingResult.rows[0].id,
      processingStatus: existingResult.rows[0].processing_status,
      isNew: false
    };
  }

  const insertResult = await pool.query(
    `
      INSERT INTO stripe_webhook_events (
        stripe_event_id,
        event_type,
        api_version,
        livemode,
        stripe_created_at,
        stripe_object_id,
        payload,
        processing_status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'received')
      RETURNING id, processing_status
    `,
    [
      event.id,
      event.type,
      event.api_version || null,
      Boolean(event.livemode),
      getStripeEventTimestamp(event),
      getStripeObjectId(event),
      JSON.stringify(event)
    ]
  );

  return {
    id: insertResult.rows[0].id,
    processingStatus: insertResult.rows[0].processing_status,
    isNew: true
  };
}

async function updateStripeWebhookEventRecord(eventRowId, status, errorMessage = null) {
  await pool.query(
    `
      UPDATE stripe_webhook_events
      SET
        processing_status = $2,
        processing_error = $3,
        processed_at = NOW()
      WHERE id = $1
    `,
    [eventRowId, status, errorMessage]
  );
}

async function findStripePaymentRecordForUpdate(client, { checkoutSessionId = null, paymentIntentId = null }) {
  if (checkoutSessionId) {
    const bySessionResult = await client.query(
      `
        SELECT
          id,
          reservation_id,
          amount_cents,
          activate_reservation_on_payment,
          payment_status
        FROM stripe_payment_records
        WHERE stripe_checkout_session_id = $1
        FOR UPDATE
      `,
      [checkoutSessionId]
    );

    if (bySessionResult.rowCount > 0) {
      return bySessionResult.rows[0];
    }
  }

  if (paymentIntentId) {
    const byIntentResult = await client.query(
      `
        SELECT
          id,
          reservation_id,
          amount_cents,
          activate_reservation_on_payment,
          payment_status
        FROM stripe_payment_records
        WHERE stripe_payment_intent_id = $1
        FOR UPDATE
      `,
      [paymentIntentId]
    );

    if (byIntentResult.rowCount > 0) {
      return byIntentResult.rows[0];
    }
  }

  return null;
}

async function applyStripePaymentSettlement(client, paymentRecord, details) {
  const wasAlreadyPaid = paymentRecord.payment_status === "paid";
  const collectedAmount = Number(paymentRecord.amount_cents) / 100;
  const amountPaidToApply = isCardPaymentMethodType(details.paymentMethodType)
    ? getBaseAmountFromCardPayment(collectedAmount)
    : collectedAmount;

  if (!wasAlreadyPaid) {
    await client.query(
      `
        UPDATE reservations
        SET
          amount_paid = COALESCE(amount_paid, 0) + $2,
          status = CASE
            WHEN status = 'pending' AND $3::boolean THEN 'active'
            ELSE status
          END
        WHERE id = $1
      `,
      [
        paymentRecord.reservation_id,
        amountPaidToApply,
        paymentRecord.activate_reservation_on_payment
      ]
    );

    await insertReservationPaymentEvent(client, {
      reservationId: paymentRecord.reservation_id,
      stripePaymentRecordId: paymentRecord.id,
      amount: collectedAmount,
      paymentSource: "stripe",
      note: details.paymentIntentId ? `Stripe PaymentIntent ${details.paymentIntentId}` : "Stripe payment",
      recordedAt: details.paidAt || new Date().toISOString()
    });
  }

  await client.query(
    `
      UPDATE stripe_payment_records
      SET
        stripe_payment_intent_id = COALESCE($2, stripe_payment_intent_id),
        stripe_charge_id = COALESCE($3, stripe_charge_id),
        payment_status = $4,
        checkout_status = COALESCE($5, checkout_status),
        stripe_customer_email = COALESCE($6, stripe_customer_email),
        stripe_payment_method_type = COALESCE($7, stripe_payment_method_type),
        amount_received_cents = COALESCE($8, amount_received_cents, amount_cents),
        paid_at = COALESCE(paid_at, $9),
        failed_at = NULL,
        expired_at = NULL,
        last_error_message = NULL,
        last_event_id = $10,
        last_event_type = $11,
        last_event_created_at = $12
      WHERE id = $1
    `,
    [
      paymentRecord.id,
      details.paymentIntentId,
      details.chargeId,
      details.paymentStatus,
      details.checkoutStatus,
      details.customerEmail,
      details.paymentMethodType,
      details.amountReceivedCents,
      details.paidAt,
      details.eventId,
      details.eventType,
      details.eventCreatedAt
    ]
  );
}

async function applyStripePaymentStateUpdate(client, paymentRecord, details) {
  await client.query(
    `
      UPDATE stripe_payment_records
      SET
        stripe_payment_intent_id = COALESCE($2, stripe_payment_intent_id),
        stripe_charge_id = COALESCE($3, stripe_charge_id),
        payment_status = $4,
        checkout_status = COALESCE($5, checkout_status),
        stripe_customer_email = COALESCE($6, stripe_customer_email),
        stripe_payment_method_type = COALESCE($7, stripe_payment_method_type),
        amount_received_cents = COALESCE($8, amount_received_cents),
        failed_at = COALESCE($9, failed_at),
        expired_at = COALESCE($10, expired_at),
        last_error_message = COALESCE($11, last_error_message),
        last_event_id = $12,
        last_event_type = $13,
        last_event_created_at = $14
      WHERE id = $1
    `,
    [
      paymentRecord.id,
      details.paymentIntentId,
      details.chargeId,
      details.paymentStatus,
      details.checkoutStatus,
      details.customerEmail,
      details.paymentMethodType,
      details.amountReceivedCents,
      details.failedAt,
      details.expiredAt,
      details.errorMessage,
      details.eventId,
      details.eventType,
      details.eventCreatedAt
    ]
  );
}

async function applyStripeRefundUpdate(client, paymentRecord, details) {
  await client.query(
    `
      UPDATE stripe_payment_records
      SET
        stripe_payment_intent_id = COALESCE($2, stripe_payment_intent_id),
        stripe_charge_id = COALESCE($3, stripe_charge_id),
        refunded_cents = GREATEST(COALESCE(refunded_cents, 0), COALESCE($4, 0)),
        refunded_at = COALESCE($5, refunded_at),
        last_event_id = $6,
        last_event_type = $7,
        last_event_created_at = $8
      WHERE id = $1
    `,
    [
      paymentRecord.id,
      details.paymentIntentId,
      details.chargeId,
      details.refundedCents,
      details.refundedAt,
      details.eventId,
      details.eventType,
      details.eventCreatedAt
    ]
  );
}

async function handleStripeWebhookEvent(event) {
  const eventCreatedAt = getStripeEventTimestamp(event);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const session = event.data.object;
        const paymentRecord = await findStripePaymentRecordForUpdate(client, {
          checkoutSessionId: session.id,
          paymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : null
        });

        if (paymentRecord) {
          if (session.payment_status === "paid") {
            await applyStripePaymentSettlement(client, paymentRecord, {
              paymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : null,
              chargeId: null,
              paymentStatus: session.payment_status || "paid",
              checkoutStatus: session.status || null,
              customerEmail: session.customer_details?.email || null,
              paymentMethodType: Array.isArray(session.payment_method_types)
                ? session.payment_method_types[0] || null
                : null,
              amountReceivedCents:
                Number.isFinite(session.amount_total) ? Number(session.amount_total) : null,
              paidAt: session.status === "complete" ? new Date().toISOString() : null,
              eventId: event.id,
              eventType: event.type,
              eventCreatedAt
            });
          } else {
            await applyStripePaymentStateUpdate(client, paymentRecord, {
              paymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : null,
              chargeId: null,
              paymentStatus: session.payment_status || "unpaid",
              checkoutStatus: session.status || null,
              customerEmail: session.customer_details?.email || null,
              paymentMethodType: Array.isArray(session.payment_method_types)
                ? session.payment_method_types[0] || null
                : null,
              amountReceivedCents:
                Number.isFinite(session.amount_total) ? Number(session.amount_total) : null,
              failedAt: null,
              expiredAt: null,
              errorMessage: null,
              eventId: event.id,
              eventType: event.type,
              eventCreatedAt
            });
          }
        }

        break;
      }
      case "checkout.session.async_payment_failed":
      case "checkout.session.expired": {
        const session = event.data.object;
        const paymentRecord = await findStripePaymentRecordForUpdate(client, {
          checkoutSessionId: session.id,
          paymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : null
        });

        if (paymentRecord) {
          await applyStripePaymentStateUpdate(client, paymentRecord, {
            paymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : null,
            chargeId: null,
            paymentStatus: event.type === "checkout.session.expired" ? "expired" : "failed",
            checkoutStatus: session.status || null,
            customerEmail: session.customer_details?.email || null,
            paymentMethodType: Array.isArray(session.payment_method_types)
              ? session.payment_method_types[0] || null
              : null,
            amountReceivedCents:
              Number.isFinite(session.amount_total) ? Number(session.amount_total) : null,
            failedAt: event.type === "checkout.session.async_payment_failed" ? new Date().toISOString() : null,
            expiredAt: event.type === "checkout.session.expired" ? new Date().toISOString() : null,
            errorMessage: null,
            eventId: event.id,
            eventType: event.type,
            eventCreatedAt
          });
        }

        break;
      }
      case "payment_intent.succeeded":
      case "payment_intent.payment_failed": {
        const paymentIntent = event.data.object;
        const paymentRecord = await findStripePaymentRecordForUpdate(client, {
          paymentIntentId: paymentIntent.id
        });

        if (paymentRecord) {
          if (event.type === "payment_intent.succeeded") {
            await applyStripePaymentSettlement(client, paymentRecord, {
              paymentIntentId: paymentIntent.id,
              chargeId:
                typeof paymentIntent.latest_charge === "string" ? paymentIntent.latest_charge : null,
              paymentStatus: "paid",
              checkoutStatus: null,
              customerEmail: paymentIntent.receipt_email || null,
              paymentMethodType:
                Array.isArray(paymentIntent.payment_method_types)
                  ? paymentIntent.payment_method_types[0] || null
                  : null,
              amountReceivedCents:
                Number.isFinite(paymentIntent.amount_received)
                  ? Number(paymentIntent.amount_received)
                  : null,
              paidAt: new Date().toISOString(),
              eventId: event.id,
              eventType: event.type,
              eventCreatedAt
            });
          } else {
            await applyStripePaymentStateUpdate(client, paymentRecord, {
              paymentIntentId: paymentIntent.id,
              chargeId:
                typeof paymentIntent.latest_charge === "string" ? paymentIntent.latest_charge : null,
              paymentStatus: "failed",
              checkoutStatus: null,
              customerEmail: paymentIntent.receipt_email || null,
              paymentMethodType:
                Array.isArray(paymentIntent.payment_method_types)
                  ? paymentIntent.payment_method_types[0] || null
                  : null,
              amountReceivedCents:
                Number.isFinite(paymentIntent.amount_received)
                  ? Number(paymentIntent.amount_received)
                  : null,
              failedAt: new Date().toISOString(),
              expiredAt: null,
              errorMessage: paymentIntent.last_payment_error?.message || null,
              eventId: event.id,
              eventType: event.type,
              eventCreatedAt
            });
          }
        }

        break;
      }
      case "charge.refunded": {
        const charge = event.data.object;
        const paymentRecord = await findStripePaymentRecordForUpdate(client, {
          paymentIntentId: typeof charge.payment_intent === "string" ? charge.payment_intent : null
        });

        if (paymentRecord) {
          await applyStripeRefundUpdate(client, paymentRecord, {
            paymentIntentId: typeof charge.payment_intent === "string" ? charge.payment_intent : null,
            chargeId: charge.id,
            refundedCents:
              Number.isFinite(charge.amount_refunded) ? Number(charge.amount_refunded) : null,
            refundedAt: new Date().toISOString(),
            eventId: event.id,
            eventType: event.type,
            eventCreatedAt
          });
        }

        break;
      }
      default:
        break;
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function syncOpenStripePayments() {
  if (!stripe) {
    return {
      checkedCount: 0,
      updatedCount: 0,
      errorCount: 0
    };
  }

  const paymentsResult = await pool.query(
    `
      SELECT
        id,
        reservation_id,
        stripe_checkout_session_id,
        stripe_payment_intent_id,
        amount_cents,
        activate_reservation_on_payment,
        payment_status
      FROM stripe_payment_records
      WHERE payment_status <> 'paid'
      ORDER BY created_at ASC
      LIMIT 100
    `
  );

  const summary = {
    checkedCount: paymentsResult.rows.length,
    updatedCount: 0,
    errorCount: 0
  };

  for (const paymentRecord of paymentsResult.rows) {
    let session;
    let paymentIntent;

    try {
      if (paymentRecord.stripe_checkout_session_id) {
        session = await stripe.checkout.sessions.retrieve(paymentRecord.stripe_checkout_session_id);
      } else if (paymentRecord.stripe_payment_intent_id) {
        paymentIntent = await stripe.paymentIntents.retrieve(paymentRecord.stripe_payment_intent_id);
      } else {
        continue;
      }
    } catch (error) {
      console.error(
        "Unable to refresh Stripe payment state",
        paymentRecord.stripe_checkout_session_id || paymentRecord.stripe_payment_intent_id,
        error
      );
      summary.errorCount += 1;
      continue;
    }

    if (session && session.payment_status !== "paid") {
      continue;
    }

    if (paymentIntent && paymentIntent.status !== "succeeded") {
      continue;
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const lockedPaymentResult = await client.query(
        `
          SELECT
            id,
            reservation_id,
            amount_cents,
            activate_reservation_on_payment,
            payment_status
          FROM stripe_payment_records
          WHERE id = $1
          FOR UPDATE
        `,
        [paymentRecord.id]
      );

      if (lockedPaymentResult.rowCount === 0) {
        await client.query("ROLLBACK");
        continue;
      }

      const lockedPayment = lockedPaymentResult.rows[0];

      if (lockedPayment.payment_status === "paid") {
        await client.query("COMMIT");
        continue;
      }

      await client.query(
        `
          UPDATE reservations
          SET
            amount_paid = COALESCE(amount_paid, 0) + $2,
            status = CASE
              WHEN status = 'pending' AND $3::boolean THEN 'active'
              ELSE status
            END
          WHERE id = $1
        `,
        [
          lockedPayment.reservation_id,
          Number(lockedPayment.amount_cents) / 100,
          lockedPayment.activate_reservation_on_payment
        ]
      );

      await insertReservationPaymentEvent(client, {
        reservationId: lockedPayment.reservation_id,
        stripePaymentRecordId: lockedPayment.id,
        amount: Number(lockedPayment.amount_cents) / 100,
        paymentSource: "stripe",
        note: session
          ? typeof session.payment_intent === "string"
            ? `Stripe PaymentIntent ${session.payment_intent}`
            : "Stripe payment"
          : paymentIntent?.id
            ? `Stripe PaymentIntent ${paymentIntent.id}`
            : "Stripe payment",
        recordedAt: new Date().toISOString()
      });

      await client.query(
        `
          UPDATE stripe_payment_records
          SET
            stripe_payment_intent_id = $2,
            payment_status = $3,
            paid_at = COALESCE(paid_at, $4)
          WHERE id = $1
        `,
        [
          lockedPayment.id,
          session
            ? typeof session.payment_intent === "string"
              ? session.payment_intent
              : null
            : paymentIntent?.id || null,
          session ? session.payment_status : "paid",
          session
            ? session.status === "complete"
              ? new Date().toISOString()
              : null
            : new Date().toISOString()
        ]
      );

      summary.updatedCount += 1;
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      summary.errorCount += 1;
      console.error(
        "Unable to record Stripe payment",
        paymentRecord.stripe_checkout_session_id || paymentRecord.stripe_payment_intent_id,
        error
      );
    } finally {
      client.release();
    }
  }

  return summary;
}

function getPricingForSiteAndNights(site, numberOfNights, pricingLookup) {
  const pricingCategory = getPricingCategory(site);
  const baseRule = pricingLookup.get(pricingCategory) || null;
  const chargeableNights = calculateChargeableNights(numberOfNights);

  return {
    pricingCategory,
    numberOfNights,
    pricingConfigured: Boolean(baseRule && chargeableNights !== null),
    normalPrice:
      baseRule?.normalPrice !== null &&
      baseRule?.normalPrice !== undefined &&
      chargeableNights !== null
        ? roundCurrency(baseRule.normalPrice * chargeableNights)
        : null,
    discountPrice:
      baseRule?.discountPrice !== null &&
      baseRule?.discountPrice !== undefined &&
      chargeableNights !== null
        ? roundCurrency(baseRule.discountPrice * chargeableNights)
        : null
  };
}

function decorateSiteWithPricingTable(site, pricingRulesByCategory) {
  const pricingCategory = getPricingCategory(site);

  return {
    ...site,
    pricing_category: pricingCategory,
    pricing_rules: pricingRulesByCategory.get(pricingCategory) || []
  };
}

function sumReservationTotals(siteStays) {
  return siteStays.reduce(
    (summary, segment) => ({
      normalPrice:
        summary.normalPrice !== null && segment.normalPrice !== null
          ? summary.normalPrice + segment.normalPrice
          : null,
      discountPrice:
        summary.discountPrice !== null && segment.discountPrice !== null
          ? summary.discountPrice + segment.discountPrice
          : null
    }),
    { normalPrice: 0, discountPrice: 0 }
  );
}

function parseAvailabilityFilters(body) {
  const arrivalDate = body.arrivalDate;
  const leaveDate = body.leaveDate;
  const minSizeFeet = body.minSizeFeet ? Number(body.minSizeFeet) : null;
  const riverfrontOnly = Boolean(body.riverfrontOnly);
  const rigLengthFeet = body.rigLengthFeet ? Number(body.rigLengthFeet) : null;
  const isOversizedFifthWheel = body.rvKind === "5th wheel" && rigLengthFeet > 43;

  if (!arrivalDate || !leaveDate || arrivalDate >= leaveDate) {
    return { error: "Arrival date must be before leave date." };
  }

  return {
    arrivalDate,
    leaveDate,
    minSizeFeet,
    riverfrontOnly,
    isOversizedFifthWheel
  };
}

function parseFlexibleAvailabilityFilters(body) {
  const flexibleStartDate = body.flexibleStartDate;
  const flexibleEndDate = body.flexibleEndDate;
  const minSizeFeet = body.minSizeFeet ? Number(body.minSizeFeet) : null;
  const riverfrontOnly = Boolean(body.riverfrontOnly);
  const rigLengthFeet = body.rigLengthFeet ? Number(body.rigLengthFeet) : null;
  const isOversizedFifthWheel = body.rvKind === "5th wheel" && rigLengthFeet > 43;
  const stayLengthValue = String(body.stayLengthRange || "");
  const stayLengthMatch = /^(\d+)-(\d+)$/.exec(stayLengthValue);

  if (!flexibleStartDate || !flexibleEndDate || flexibleStartDate >= flexibleEndDate) {
    return { error: "Flexible search start date must be before the end date." };
  }

  if (!stayLengthMatch) {
    return { error: "Choose how many days the guest wants to stay." };
  }

  const minNights = Number(stayLengthMatch[1]);
  const maxNights = Number(stayLengthMatch[2]);

  if (!Number.isFinite(minNights) || !Number.isFinite(maxNights) || minNights <= 0 || maxNights < minNights) {
    return { error: "Stay length range is invalid." };
  }

  return {
    flexibleStartDate,
    flexibleEndDate,
    minSizeFeet,
    riverfrontOnly,
    minNights,
    maxNights,
    isOversizedFifthWheel
  };
}

function buildFlexibleOpenWindows(site, siteStays, flexibleStartDate, flexibleEndDate, minNights, maxNights) {
  const windows = [];
  const sortedStays = [...siteStays].sort((left, right) =>
    left.arrival_date.localeCompare(right.arrival_date)
  );
  let cursor = flexibleStartDate;

  for (const stay of sortedStays) {
    if (stay.leave_date <= flexibleStartDate) {
      continue;
    }

    if (stay.arrival_date >= flexibleEndDate) {
      break;
    }

    const gapEnd = stay.arrival_date < flexibleEndDate ? stay.arrival_date : flexibleEndDate;
    const availableNights = nightsBetween(cursor, gapEnd);

    if (availableNights >= minNights) {
      windows.push({
        arrivalDate: cursor,
        leaveDate: gapEnd,
        availableNights,
        minStayNights: minNights,
        maxStayNights: Math.min(maxNights, availableNights),
        latestArrivalDate: addDays(gapEnd, -minNights)
      });
    }

    if (stay.leave_date > cursor) {
      cursor = stay.leave_date;
    }

    if (cursor >= flexibleEndDate) {
      break;
    }
  }

  if (cursor < flexibleEndDate) {
    const availableNights = nightsBetween(cursor, flexibleEndDate);

    if (availableNights >= minNights) {
      windows.push({
        arrivalDate: cursor,
        leaveDate: flexibleEndDate,
        availableNights,
        minStayNights: minNights,
        maxStayNights: Math.min(maxNights, availableNights),
        latestArrivalDate: addDays(flexibleEndDate, -minNights)
      });
    }
  }

  return windows;
}

async function buildFlexibleAvailabilitySearchResult({
  flexibleStartDate,
  flexibleEndDate,
  minSizeFeet,
  riverfrontOnly = false,
  minNights,
  maxNights
}) {
  const sites = await loadCandidateSites(minSizeFeet, riverfrontOnly);
  const siteIds = sites.map((site) => site.id);
  const contextStays = await loadAvailabilityContextStays(siteIds);
  const staysBySite = new Map();

  for (const site of sites) {
    staysBySite.set(site.id, []);
  }

  for (const stay of contextStays) {
    if (!staysBySite.has(stay.site_id)) {
      continue;
    }

    staysBySite.get(stay.site_id).push(stay);
  }

  const matches = sites
    .map((site) => {
      const openWindows = buildFlexibleOpenWindows(
        site,
        staysBySite.get(site.id) || [],
        flexibleStartDate,
        flexibleEndDate,
        minNights,
        maxNights
      );

      if (!openWindows.length) {
        return null;
      }

      return {
        siteId: site.id,
        siteNumber: site.site_number,
        sizeFeet: site.size_feet,
        isOnRiver: site.is_on_river,
        riverCategory: site.river_category,
        isBigRig: site.is_big_rig,
        maxAvailableNights: Math.max(...openWindows.map((window) => window.availableNights)),
        openWindows
      };
    })
    .filter(Boolean);

  return { matches };
}

async function loadCandidateSites(minSizeFeet, riverfrontOnly) {
  const values = [];
  const where = [];

  if (minSizeFeet) {
    values.push(minSizeFeet);
    where.push(`size_feet >= $${values.length}`);
  }

  if (riverfrontOnly) {
    values.push(true);
    where.push(`is_on_river = $${values.length}`);
  }

  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const result = await pool.query(
    `
      SELECT
        id,
        site_number,
        size_feet,
        is_on_river,
        river_category,
        is_big_rig
      FROM rv_sites
      ${whereClause}
      ORDER BY site_number
    `,
    values
  );

  return result.rows;
}

async function loadPricingRules(numberOfDays = null) {
  const values = [];
  let whereClause = "";

  if (Array.isArray(numberOfDays) && numberOfDays.length > 0) {
    values.push(numberOfDays);
    whereClause = `WHERE number_of_days = ANY($1::integer[])`;
  } else if (typeof numberOfDays === "number") {
    values.push(numberOfDays);
    whereClause = `WHERE number_of_days = $1`;
  }

  const result = await pool.query(
    `
      SELECT
        id,
        site_category,
        number_of_days,
        normal_price,
        discount_price
      FROM pricing_rules
      ${whereClause}
      ORDER BY site_category, number_of_days
    `,
    values
  );

  return result.rows;
}

async function loadConflictingStays(siteIds, arrivalDate, leaveDate, excludedReservationId = null) {
  if (siteIds.length === 0) {
    return [];
  }

  const values = [siteIds, arrivalDate, leaveDate];
  let excludeClause = "";

  if (excludedReservationId) {
    values.push(excludedReservationId);
    excludeClause = `AND reservation_id <> $4`;
  }

  const result = await pool.query(
    `
      SELECT site_id, arrival_date::text, leave_date::text
      FROM reservation_site_stays
      WHERE site_id = ANY($1::bigint[])
        AND arrival_date < $3
        AND leave_date > $2
        ${excludeClause}
      ORDER BY arrival_date
    `,
    values
  );

  return result.rows;
}

async function findReservationOverlap(queryable, normalizedSegments, excludedReservationId = null) {
  for (const segment of normalizedSegments) {
    const values = [segment.siteId, segment.arrivalDate, segment.leaveDate];
    let excludeClause = "";

    if (excludedReservationId) {
      values.push(excludedReservationId);
      excludeClause = `AND rss.reservation_id <> $4`;
    }

    const result = await queryable.query(
      `
        SELECT
          rss.reservation_id,
          rss.arrival_date::text,
          rss.leave_date::text,
          s.site_number
        FROM reservation_site_stays rss
        JOIN rv_sites s ON s.id = rss.site_id
        WHERE rss.site_id = $1
          AND rss.arrival_date < $3
          AND rss.leave_date > $2
          ${excludeClause}
        ORDER BY rss.arrival_date
        LIMIT 1
      `,
      values
    );

    if (result.rowCount > 0) {
      const overlap = result.rows[0];

      return {
        message: `Site ${overlap.site_number} is already booked from ${formatDisplayDate(
          overlap.arrival_date
        )} to ${formatDisplayDate(overlap.leave_date)}.`
      };
    }
  }

  return null;
}

async function loadFutureStays(siteIds, arrivalDate, excludedReservationId = null) {
  if (siteIds.length === 0) {
    return [];
  }

  const values = [siteIds, arrivalDate];
  let excludeClause = "";

  if (excludedReservationId) {
    values.push(excludedReservationId);
    excludeClause = `AND reservation_id <> $3`;
  }

  const result = await pool.query(
    `
      SELECT site_id, arrival_date::text, leave_date::text
      FROM reservation_site_stays
      WHERE site_id = ANY($1::bigint[])
        AND leave_date > $2
        ${excludeClause}
      ORDER BY site_id, arrival_date
    `,
    values
  );

  return result.rows;
}

async function loadAvailabilityContextStays(siteIds, excludedReservationId = null) {
  if (siteIds.length === 0) {
    return [];
  }

  const values = [siteIds];
  let excludeClause = "";

  if (excludedReservationId) {
    values.push(excludedReservationId);
    excludeClause = `WHERE site_id = ANY($1::bigint[]) AND reservation_id <> $2`;
  }

  const result = await pool.query(
    `
      SELECT site_id, arrival_date::text, leave_date::text
      FROM reservation_site_stays
      ${excludeClause || "WHERE site_id = ANY($1::bigint[])"}
      ORDER BY site_id, arrival_date
    `,
    values
  );

  return result.rows;
}

async function fetchReservationDetails(queryable, reservationId) {
  const reservationResult = await queryable.query(
    `
      SELECT
        r.id,
        r.customer_id,
        r.booked_date::text,
        r.status,
        r.reservation_term,
        r.billing_mode,
        r.deposit_amount,
        r.total_price,
        r.monthly_rent_price,
        r.electric_meter_reading,
        r.canceled_at,
        r.canceled_site_stays,
        r.rv_kind,
        r.motorhome_class_a,
        r.motorhome_class_c,
        r.motorhome_with_tow,
        r.rig_length_feet,
        r.amount_paid,
        r.notes,
        r.created_at,
        c.first_name,
        c.last_name,
        c.email,
        c.phone_number
      FROM reservations r
      JOIN customers c ON c.id = r.customer_id
      WHERE r.id = $1
    `,
    [reservationId]
  );

  if (reservationResult.rowCount === 0) {
    return null;
  }

  const reservationRow = reservationResult.rows[0];
  const paymentEventsResult = await queryable.query(
    `
      SELECT
        id,
        stripe_payment_record_id,
        amount,
        payment_source,
        note,
        recorded_at,
        created_at
      FROM reservation_payment_events
      WHERE reservation_id = $1
      ORDER BY recorded_at DESC, id DESC
    `,
    [reservationId]
  );
  let stayRows = [];

  if (reservationRow.status === "canceled") {
    const archivedStays = Array.isArray(reservationRow.canceled_site_stays)
      ? reservationRow.canceled_site_stays
      : [];
    const siteIds = [...new Set(archivedStays.map((segment) => Number(segment.siteId)).filter(Boolean))];
    const sitesById = new Map();

    if (siteIds.length) {
      const sitesResult = await queryable.query(
        `
          SELECT id, site_number, river_category, is_big_rig
          FROM rv_sites
          WHERE id = ANY($1::bigint[])
        `,
        [siteIds]
      );

      for (const site of sitesResult.rows) {
        sitesById.set(Number(site.id), site);
      }
    }

    stayRows = archivedStays
      .map((segment, index) => {
        const site = sitesById.get(Number(segment.siteId));

        if (!site || !segment.arrivalDate || !segment.leaveDate) {
          return null;
        }

        return {
          id: `canceled-${reservationId}-${index}`,
          site_id: Number(segment.siteId),
          site_number: site.site_number,
          river_category: site.river_category,
          is_big_rig: site.is_big_rig,
          arrival_date: segment.arrivalDate,
          leave_date: segment.leaveDate
        };
      })
      .filter(Boolean);
  } else {
    const staysResult = await queryable.query(
      `
        SELECT
          rss.id,
          rss.site_id,
          s.site_number,
          s.river_category,
          s.is_big_rig,
          rss.arrival_date::text,
          rss.leave_date::text
        FROM reservation_site_stays rss
        JOIN rv_sites s ON s.id = rss.site_id
        WHERE rss.reservation_id = $1
        ORDER BY rss.arrival_date
      `,
      [reservationId]
    );

    stayRows = staysResult.rows;
  }

  const pricingLookup = buildPricingRuleLookup(await loadPricingRules());
  const pricedSiteStays = stayRows.map((segment) => ({
    ...(function buildSegment() {
      if (isOpenEndedSegment(segment, reservationRow.reservation_term)) {
        return {
          ...segment,
          pricingCategory: null,
          numberOfNights: null,
          pricingConfigured: false,
          normalPrice: null,
          discountPrice: null,
          isOpenEnded: true
        };
      }

      return {
        ...segment,
        ...getPricingForSiteAndNights(
          segment,
          nightsBetween(segment.arrival_date, segment.leave_date),
          pricingLookup
        ),
        isOpenEnded: false
      };
    })()
  }));
  const totals = sumReservationTotals(pricedSiteStays);
  const balances = applyBalanceSummary(reservationRow.amount_paid, totals);
  const billing = buildBillingSummary(reservationRow, totals);

  return {
    ...reservationRow,
    totals,
    ...balances,
    ...billing,
    paymentEvents: paymentEventsResult.rows.map((row) => ({
      id: row.id,
      stripePaymentRecordId: row.stripe_payment_record_id,
      amount: toPriceNumber(row.amount),
      paymentSource: row.payment_source,
      note: row.note || "",
      recordedAt: row.recorded_at,
      createdAt: row.created_at
    })),
    siteStays: pricedSiteStays
  };
}

function buildReservationDetailsFromParts(
  reservationRow,
  paymentEventRows,
  stayRows,
  pricingLookup
) {
  const pricedSiteStays = stayRows.map((segment) => ({
    ...(function buildSegment() {
      if (isOpenEndedSegment(segment, reservationRow.reservation_term)) {
        return {
          ...segment,
          pricingCategory: null,
          numberOfNights: null,
          pricingConfigured: false,
          normalPrice: null,
          discountPrice: null,
          isOpenEnded: true
        };
      }

      return {
        ...segment,
        ...getPricingForSiteAndNights(
          segment,
          nightsBetween(segment.arrival_date, segment.leave_date),
          pricingLookup
        ),
        isOpenEnded: false
      };
    })()
  }));
  const totals = sumReservationTotals(pricedSiteStays);
  const balances = applyBalanceSummary(reservationRow.amount_paid, totals);
  const billing = buildBillingSummary(reservationRow, totals);

  return {
    ...reservationRow,
    totals,
    ...balances,
    ...billing,
    paymentEvents: paymentEventRows.map((row) => ({
      id: row.id,
      stripePaymentRecordId: row.stripe_payment_record_id,
      amount: toPriceNumber(row.amount),
      paymentSource: row.payment_source,
      note: row.note || "",
      recordedAt: row.recorded_at,
      createdAt: row.created_at
    })),
    siteStays: pricedSiteStays
  };
}

async function fetchReservationList(queryable) {
  const reservationsResult = await queryable.query(
    `
      SELECT
        r.id,
        r.customer_id,
        r.booked_date::text,
        r.status,
        r.reservation_term,
        r.billing_mode,
        r.deposit_amount,
        r.total_price,
        r.monthly_rent_price,
        r.electric_meter_reading,
        r.canceled_at,
        r.canceled_site_stays,
        r.rv_kind,
        r.motorhome_class_a,
        r.motorhome_class_c,
        r.motorhome_with_tow,
        r.rig_length_feet,
        r.amount_paid,
        r.notes,
        r.created_at,
        c.first_name,
        c.last_name,
        c.email,
        c.phone_number
      FROM reservations r
      JOIN customers c ON c.id = r.customer_id
      ORDER BY r.booked_date DESC, r.id DESC
    `
  );

  if (reservationsResult.rowCount === 0) {
    return [];
  }

  const reservationRows = reservationsResult.rows;
  const reservationIds = reservationRows.map((row) => row.id);
  const [paymentEventsResult, activeStaysResult, pricingRules] = await Promise.all([
    queryable.query(
      `
        SELECT
          id,
          reservation_id,
          stripe_payment_record_id,
          amount,
          payment_source,
          note,
          recorded_at,
          created_at
        FROM reservation_payment_events
        WHERE reservation_id = ANY($1::bigint[])
        ORDER BY reservation_id, recorded_at DESC, id DESC
      `,
      [reservationIds]
    ),
    queryable.query(
      `
        SELECT
          rss.id,
          rss.reservation_id,
          rss.site_id,
          s.site_number,
          s.river_category,
          s.is_big_rig,
          rss.arrival_date::text,
          rss.leave_date::text
        FROM reservation_site_stays rss
        JOIN rv_sites s ON s.id = rss.site_id
        WHERE rss.reservation_id = ANY($1::bigint[])
        ORDER BY rss.reservation_id, rss.arrival_date
      `,
      [reservationIds]
    ),
    loadPricingRules()
  ]);

  const paymentEventsByReservationId = new Map();
  for (const row of paymentEventsResult.rows) {
    const reservationPaymentEvents =
      paymentEventsByReservationId.get(row.reservation_id) || [];
    reservationPaymentEvents.push(row);
    paymentEventsByReservationId.set(row.reservation_id, reservationPaymentEvents);
  }

  const activeStaysByReservationId = new Map();
  for (const row of activeStaysResult.rows) {
    const reservationStays = activeStaysByReservationId.get(row.reservation_id) || [];
    reservationStays.push(row);
    activeStaysByReservationId.set(row.reservation_id, reservationStays);
  }

  const canceledSiteIds = [
    ...new Set(
      reservationRows.flatMap((row) =>
        (Array.isArray(row.canceled_site_stays) ? row.canceled_site_stays : [])
          .map((segment) => Number(segment.siteId))
          .filter(Boolean)
      )
    )
  ];
  const canceledSitesById = new Map();

  if (canceledSiteIds.length) {
    const canceledSitesResult = await queryable.query(
      `
        SELECT id, site_number, river_category, is_big_rig
        FROM rv_sites
        WHERE id = ANY($1::bigint[])
      `,
      [canceledSiteIds]
    );

    for (const site of canceledSitesResult.rows) {
      canceledSitesById.set(Number(site.id), site);
    }
  }

  const pricingLookup = buildPricingRuleLookup(pricingRules);

  return reservationRows.map((reservationRow) => {
    const paymentEventRows =
      paymentEventsByReservationId.get(reservationRow.id) || [];
    let stayRows = [];

    if (reservationRow.status === "canceled") {
      const archivedStays = Array.isArray(reservationRow.canceled_site_stays)
        ? reservationRow.canceled_site_stays
        : [];

      stayRows = archivedStays
        .map((segment, index) => {
          const site = canceledSitesById.get(Number(segment.siteId));

          if (!site || !segment.arrivalDate || !segment.leaveDate) {
            return null;
          }

          return {
            id: `canceled-${reservationRow.id}-${index}`,
            site_id: Number(segment.siteId),
            site_number: site.site_number,
            river_category: site.river_category,
            is_big_rig: site.is_big_rig,
            arrival_date: segment.arrivalDate,
            leave_date: segment.leaveDate
          };
        })
        .filter(Boolean);
    } else {
      stayRows = activeStaysByReservationId.get(reservationRow.id) || [];
    }

    return buildReservationDetailsFromParts(
      reservationRow,
      paymentEventRows,
      stayRows,
      pricingLookup
    );
  });
}

function normalizeGuestPhone(value) {
  return String(value || "").replaceAll(/\D/g, "").slice(-10);
}

async function findGuestCustomerByIdentity({
  firstName,
  lastName,
  phoneNumber
} = {}) {
  const normalizedFirstName = String(firstName || "").trim();
  const normalizedLastName = String(lastName || "").trim();
  const normalizedPhoneNumber = normalizeGuestPhone(phoneNumber);

  if (
    !normalizedFirstName ||
    !normalizedLastName ||
    normalizedPhoneNumber.length !== 10
  ) {
    return null;
  }

  const result = await pool.query(
    `
      SELECT id, first_name, last_name, email, phone_number
      FROM customers
      WHERE LOWER(TRIM(first_name)) = LOWER($1)
        AND LOWER(TRIM(last_name)) = LOWER($2)
        AND RIGHT(REGEXP_REPLACE(COALESCE(phone_number, ''), '[^0-9]', '', 'g'), 10) = $3
      LIMIT 1
    `,
    [normalizedFirstName, normalizedLastName, normalizedPhoneNumber]
  );

  return result.rows[0] || null;
}

async function findGuestCustomerByEmail(emailValue) {
  const email = String(emailValue || "").trim().toLowerCase();

  if (!email || !email.includes("@")) {
    return null;
  }

  const result = await pool.query(
    `
      SELECT id, first_name, last_name, email, phone_number
      FROM customers
      WHERE LOWER(TRIM(email)) = $1
      LIMIT 1
    `,
    [email]
  );

  return result.rows[0] || null;
}

async function authenticateGuestReservation(reservationId, credentials) {
  const session = readGuestToken(credentials?.accessToken, "guest_access");

  if (!session?.customerId) {
    return null;
  }

  const customerResult = await pool.query(
    `
      SELECT id, first_name, last_name, email, phone_number
      FROM customers
      WHERE id = $1
      LIMIT 1
    `,
    [session.customerId]
  );
  const customer = customerResult.rows[0] || null;

  if (!customer) {
    return null;
  }

  const ownershipResult = await pool.query(
    `
      SELECT id
      FROM reservations
      WHERE id = $1 AND customer_id = $2
    `,
    [reservationId, customer.id]
  );

  if (ownershipResult.rowCount === 0) {
    return null;
  }

  return customer;
}

function sanitizeGuestReservation(reservation) {
  return {
    id: reservation.id,
    booked_date: reservation.booked_date,
    status: reservation.status,
    reservation_term: reservation.reservation_term,
    first_name: reservation.first_name,
    last_name: reservation.last_name,
    email: reservation.email || "",
    phone_number: reservation.phone_number || "",
    rv_kind: reservation.rv_kind,
    motorhome_class_a: Boolean(reservation.motorhome_class_a),
    motorhome_class_c: Boolean(reservation.motorhome_class_c),
    motorhome_with_tow: Boolean(reservation.motorhome_with_tow),
    rig_length_feet: reservation.rig_length_feet,
    depositAmount: reservation.depositAmount,
    cardDepositAmount: reservation.cardDepositAmount,
    totalPrice: reservation.totalPrice,
    effectiveTotalPrice: reservation.effectiveTotalPrice,
    cardTotalPrice: reservation.cardTotalPrice,
    amountPaid: reservation.amountPaid,
    remainingBalance: reservation.remainingBalance,
    cardRemainingBalance: reservation.cardRemainingBalance,
    siteStays: reservation.siteStays.map((segment) => ({
      id: segment.id,
      site_id: segment.site_id,
      site_number: segment.site_number,
      arrival_date: segment.arrival_date,
      leave_date: segment.leave_date,
      numberOfNights: segment.numberOfNights,
      isOpenEnded: segment.isOpenEnded
    })),
    paymentEvents: reservation.paymentEvents.map((event) => ({
      id: event.id,
      amount: event.amount,
      paymentSource: event.paymentSource,
      recordedAt: event.recordedAt
    }))
  };
}

async function buildAvailabilitySearchResult({
  arrivalDate,
  leaveDate,
  minSizeFeet,
  riverfrontOnly = false,
  excludedReservationId = null
}) {
  const sites = await loadCandidateSites(minSizeFeet, riverfrontOnly);
  const numberOfNights = nightsBetween(arrivalDate, leaveDate);
  const pricingLookup = buildPricingRuleLookup(await loadPricingRules());
  const siteIds = sites.map((site) => site.id);
  const conflictingStays = await loadConflictingStays(
    siteIds,
    arrivalDate,
    leaveDate,
    excludedReservationId
  );
  const futureStays = await loadFutureStays(siteIds, arrivalDate, excludedReservationId);
  const contextStays = await loadAvailabilityContextStays(siteIds, excludedReservationId);
  const availability = buildAvailabilityMap(sites, conflictingStays, arrivalDate, leaveDate);
  const availabilityLeadTimes = buildAvailabilityLeadTimes(sites, futureStays, arrivalDate);
  const bookingContext = buildAvailabilityBookingContext(
    sites,
    contextStays,
    arrivalDate,
    leaveDate
  );
  const directMatches = getDirectMatches(availability, arrivalDate, leaveDate).map((site) => ({
    id: site.id,
    siteNumber: site.site_number,
    sizeFeet: site.size_feet,
    isOnRiver: site.is_on_river,
    riverCategory: site.river_category,
    isBigRig: site.is_big_rig,
    ...(availabilityLeadTimes.get(site.id) || {
      availableDays: null,
      availableUntil: null,
      openEnded: false
    }),
    ...(bookingContext.get(site.id) || {
      previousBookedUntil: null,
      nextBookedFrom: null
    }),
    ...getPricingForSiteAndNights(site, numberOfNights, pricingLookup)
  }));

  return {
    numberOfNights,
    directMatches,
    contextStays,
    bookingContext
  };
}

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

app.get("/api/sites", async (_req, res) => {
  try {
    const [sitesResult, pricingRules] = await Promise.all([
      pool.query(
        `
          SELECT
            id,
            site_number,
            size_feet,
            is_on_river,
            river_category,
            is_big_rig
          FROM rv_sites
          ORDER BY site_number
        `
      ),
      loadPricingRules()
    ]);

    const pricingRulesByCategory = buildPricingRulesByCategory(pricingRules);
    res.json(
      sitesResult.rows.map((site) => decorateSiteWithPricingTable(site, pricingRulesByCategory))
    );
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.put("/api/sites/:id", async (req, res) => {
  const siteId = Number(req.params.id);

  if (!siteId) {
    return res.status(400).json({ message: "Site ID is required." });
  }

  const parsed = normalizeSitePayload(req.body);

  if (parsed.error) {
    return res.status(400).json({ message: parsed.error });
  }

  try {
    const existingSiteResult = await pool.query(
      `
        SELECT id, river_category
        FROM rv_sites
        WHERE id = $1
      `,
      [siteId]
    );

    if (existingSiteResult.rowCount === 0) {
      return res.status(404).json({ message: "Site not found." });
    }

    const existingSite = existingSiteResult.rows[0];
    const nextRiverCategory = parsed.isOnRiver
      ? parsed.riverCategory
      : existingSite.river_category || "off_river";

    const result = await pool.query(
      `
        UPDATE rv_sites
        SET
          site_number = $2,
          size_feet = $3,
          is_on_river = $4,
          river_category = $5,
          is_big_rig = $6
        WHERE id = $1
        RETURNING
          id,
          site_number,
          size_feet,
          is_on_river,
          river_category,
          is_big_rig
      `,
      [
        siteId,
        parsed.siteNumber,
        parsed.sizeFeet,
        parsed.isOnRiver,
        nextRiverCategory,
        parsed.isBigRig
      ]
    );

    const pricingRulesByCategory = buildPricingRulesByCategory(await loadPricingRules());
    res.json(decorateSiteWithPricingTable(result.rows[0], pricingRulesByCategory));
  } catch (error) {
    res.status(500).json({ message: error.detail || error.message });
  }
});

app.delete("/api/sites/:id", async (req, res) => {
  const siteId = Number(req.params.id);

  if (!siteId) {
    return res.status(400).json({ message: "Site ID is required." });
  }

  try {
    const usageResult = await pool.query(
      `
        SELECT COUNT(*)::int AS reservation_count
        FROM reservation_site_stays
        WHERE site_id = $1
      `,
      [siteId]
    );

    if ((usageResult.rows[0]?.reservation_count || 0) > 0) {
      return res.status(400).json({
        message: "This site cannot be deleted because it is already tied to reservation history."
      });
    }

    const deleteResult = await pool.query(
      `
        DELETE FROM rv_sites
        WHERE id = $1
        RETURNING id, site_number
      `,
      [siteId]
    );

    if (deleteResult.rowCount === 0) {
      return res.status(404).json({ message: "Site not found." });
    }

    res.json({
      id: deleteResult.rows[0].id,
      siteNumber: deleteResult.rows[0].site_number
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get("/api/customers", async (_req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT id, first_name, last_name, email, phone_number
        FROM customers
        ORDER BY last_name, first_name, id
      `
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.put("/api/customers/:id", async (req, res) => {
  const { firstName, lastName, email, phoneNumber } = req.body;

  if (!firstName || !lastName) {
    return res.status(400).json({ message: "First name and last name are required." });
  }

  if (!email && !phoneNumber) {
    return res.status(400).json({ message: "Provide at least an email or phone number." });
  }

  try {
    const result = await pool.query(
      `
        UPDATE customers
        SET
          first_name = $2,
          last_name = $3,
          email = $4,
          phone_number = $5
        WHERE id = $1
        RETURNING id, first_name, last_name, email, phone_number
      `,
      [req.params.id, firstName, lastName, email || null, phoneNumber || null]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Customer not found." });
    }

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post("/api/customers", async (req, res) => {
  const { firstName, lastName, email, phoneNumber } = req.body;

  if (!firstName || !lastName) {
    return res.status(400).json({ message: "First name and last name are required." });
  }

  if (!email && !phoneNumber) {
    return res.status(400).json({ message: "Provide at least an email or phone number." });
  }

  try {
    const result = await pool.query(
      `
        INSERT INTO customers (first_name, last_name, email, phone_number)
        VALUES ($1, $2, $3, $4)
        RETURNING id, first_name, last_name, email, phone_number
      `,
      [firstName, lastName, email || null, phoneNumber || null]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post("/api/availability/search", async (req, res) => {
  const filters = parseAvailabilityFilters(req.body);

  if (filters.error) {
    return res.status(400).json({ message: filters.error });
  }

  if (filters.isOversizedFifthWheel) {
    return res.json({
      numberOfNights: nightsBetween(filters.arrivalDate, filters.leaveDate),
      directMatches: [],
      restriction: "oversized_fifth_wheel"
    });
  }

  try {
    const result = await buildAvailabilitySearchResult({
      arrivalDate: filters.arrivalDate,
      leaveDate: filters.leaveDate,
      minSizeFeet: filters.minSizeFeet,
      riverfrontOnly: filters.riverfrontOnly
    });

    res.json({
      numberOfNights: result.numberOfNights,
      directMatches: result.directMatches
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post("/api/availability/flexible-search", async (req, res) => {
  const filters = parseFlexibleAvailabilityFilters(req.body);

  if (filters.error) {
    return res.status(400).json({ message: filters.error });
  }

  if (filters.isOversizedFifthWheel) {
    return res.json({
      matches: [],
      restriction: "oversized_fifth_wheel"
    });
  }

  try {
    const result = await buildFlexibleAvailabilitySearchResult({
      flexibleStartDate: filters.flexibleStartDate,
      flexibleEndDate: filters.flexibleEndDate,
      minSizeFeet: filters.minSizeFeet,
      riverfrontOnly: filters.riverfrontOnly,
      minNights: filters.minNights,
      maxNights: filters.maxNights
    });

    res.json({
      matches: result.matches
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post("/api/availability/plan", async (req, res) => {
  const filters = parseAvailabilityFilters(req.body);

  if (filters.error) {
    return res.status(400).json({ message: filters.error });
  }

  if (filters.isOversizedFifthWheel) {
    return res.json({
      plan: null,
      totals: null,
      restriction: "oversized_fifth_wheel"
    });
  }

  try {
    const sites = await loadCandidateSites(filters.minSizeFeet, filters.riverfrontOnly);
    const conflictingStays = await loadConflictingStays(
      sites.map((site) => site.id),
      filters.arrivalDate,
      filters.leaveDate
    );
    const availability = buildAvailabilityMap(
      sites,
      conflictingStays,
      filters.arrivalDate,
      filters.leaveDate
    );
    const plan = buildSiteSwitchPlan(availability, filters.arrivalDate, filters.leaveDate);

    if (!plan) {
      return res.json({ plan: null, totals: null });
    }

    const pricingLookup = buildPricingRuleLookup(await loadPricingRules());
    const siteLookup = new Map(sites.map((site) => [site.id, site]));
    const pricedPlan = plan.map((segment) => {
      const site = siteLookup.get(segment.siteId);
      return {
        ...segment,
        ...getPricingForSiteAndNights(
          site,
          nightsBetween(segment.arrivalDate, segment.leaveDate),
          pricingLookup
        )
      };
    });

    const totals = pricedPlan.reduce(
      (summary, segment) => ({
        normalPrice:
          summary.normalPrice !== null && segment.normalPrice !== null
            ? summary.normalPrice + segment.normalPrice
            : null,
        discountPrice:
          summary.discountPrice !== null && segment.discountPrice !== null
            ? summary.discountPrice + segment.discountPrice
            : null
      }),
      { normalPrice: 0, discountPrice: 0 }
    );

    res.json({ plan: pricedPlan, totals });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post("/api/guest/reservations/request-code", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const email = String(req.body.email || "").trim().toLowerCase();

  if (!email || !email.includes("@")) {
    return res.status(400).json({ message: "Enter a valid email address." });
  }

  if (!guestAuthSecret) {
    return res.status(503).json({
      message: "Guest email sign-in is not configured yet. Please call the office."
    });
  }

  try {
    const lastRequestAt = guestVerificationRequests.get(email) || 0;

    if (Date.now() - lastRequestAt < 60000) {
      return res.status(429).json({
        message: "A code was recently requested. Wait one minute before trying again."
      });
    }

    guestVerificationRequests.set(email, Date.now());
    const customer = await findGuestCustomerByEmail(email);
    const verificationCode = String(randomInt(100000, 1000000));
    const nonce = randomBytes(18).toString("base64url");
    const challengeToken = signGuestToken({
      type: "guest_email_code",
      email,
      nonce,
      codeDigest: buildGuestCodeDigest(nonce, verificationCode),
      expiresAt: Date.now() + 10 * 60 * 1000
    });
    guestVerificationAttempts.set(nonce, 0);

    if (customer) {
      await sendGuestVerificationEmail(customer, verificationCode);
    }

    res.json({
      challengeToken,
      message: "If that email matches a booking, a verification code is on its way."
    });
  } catch (error) {
    console.error("Unable to send guest verification code", error);
    res.status(500).json({ message: error.message });
  }
});

app.post("/api/guest/reservations/sign-in", async (req, res) => {
  res.set("Cache-Control", "no-store");

  try {
    let accessSession = readGuestToken(req.body.accessToken, "guest_access");

    if (!accessSession) {
      const challenge = readGuestToken(
        req.body.challengeToken,
        "guest_email_code"
      );
      const verificationCode = String(req.body.verificationCode || "").trim();
      const failedAttempts = challenge?.nonce
        ? guestVerificationAttempts.get(challenge.nonce) || 0
        : 0;

      if (
        !challenge?.email ||
        failedAttempts >= 5 ||
        !/^\d{6}$/.test(verificationCode) ||
        !guestCodeMatches(challenge, verificationCode)
      ) {
        if (challenge?.nonce) {
          guestVerificationAttempts.set(challenge.nonce, failedAttempts + 1);
        }

        return res.status(401).json({
          message: "That verification code is invalid or has expired."
        });
      }

      guestVerificationAttempts.delete(challenge.nonce);
      const verifiedCustomer = await findGuestCustomerByEmail(challenge.email);

      if (!verifiedCustomer) {
        return res.status(401).json({
          message: "That verification code is invalid or has expired."
        });
      }

      accessSession = {
        type: "guest_access",
        customerId: verifiedCustomer.id,
        email: challenge.email,
        expiresAt: Date.now() + 12 * 60 * 60 * 1000
      };
    }

    const customerResult = await pool.query(
      `
        SELECT id, first_name, last_name, email, phone_number
        FROM customers
        WHERE id = $1
        LIMIT 1
      `,
      [accessSession.customerId]
    );
    const customer = customerResult.rows[0] || null;

    if (!customer) {
      return res.status(401).json({
        message: "That booking sign-in is invalid or has expired."
      });
    }

    await syncOpenStripePayments();
    const reservationsResult = await pool.query(
      `
        SELECT id
        FROM reservations
        WHERE customer_id = $1
        ORDER BY booked_date DESC, id DESC
      `,
      [customer.id]
    );
    const reservations = await Promise.all(
      reservationsResult.rows.map((row) => fetchReservationDetails(pool, row.id))
    );

    res.json({
      customer: {
        firstName: customer.first_name,
        lastName: customer.last_name,
        email: customer.email
      },
      accessToken: signGuestToken(accessSession),
      reservations: reservations.filter(Boolean).map(sanitizeGuestReservation)
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post("/api/guest/reservations", async (req, res) => {
  const firstName = String(req.body.firstName || "").trim();
  const lastName = String(req.body.lastName || "").trim();
  const email = String(req.body.email || "").trim();
  const phoneNumber = normalizeGuestPhone(req.body.phoneNumber);
  const arrivalDate = req.body.arrivalDate;
  const leaveDate = req.body.leaveDate;
  const siteId = Number(req.body.siteId);
  const rigLengthFeet = Number(req.body.rigLengthFeet);
  const discounts = Array.isArray(req.body.discounts) ? req.body.discounts : [];
  const allowedRvKinds = ["camper", "van", "5th wheel", "motor home", "trailer"];
  const rvKind = allowedRvKinds.includes(req.body.rvKind) ? req.body.rvKind : "";
  const numberOfNights = nightsBetween(arrivalDate, leaveDate);
  const applyDiscountPricing = discounts.length > 0;

  if (!firstName || !lastName || phoneNumber.length !== 10) {
    return res.status(400).json({ message: "Name and a valid phone number are required." });
  }

  if (!email || !email.includes("@")) {
    return res.status(400).json({ message: "A valid email is required." });
  }

  if (!arrivalDate || !leaveDate || arrivalDate >= leaveDate || numberOfNights <= 0) {
    return res.status(400).json({ message: "Choose valid arrival and departure dates." });
  }

  if (numberOfNights > 14) {
    return res.status(400).json({
      message: "Stays longer than two weeks must be reserved by calling 541-295-1269."
    });
  }

  if (!siteId || !rvKind || !Number.isFinite(rigLengthFeet) || rigLengthFeet <= 0) {
    return res.status(400).json({ message: "Site and rig details are required." });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const siteResult = await client.query(
      `
        SELECT id, site_number, size_feet, is_on_river, river_category, is_big_rig
        FROM rv_sites
        WHERE id = $1
      `,
      [siteId]
    );

    if (siteResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "That site is no longer available." });
    }

    const site = siteResult.rows[0];

    if (site.size_feet < Math.max(1, rigLengthFeet - 5)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "That site does not fit the entered rig length." });
    }

    const segment = { siteId, arrivalDate, leaveDate };
    const overlap = await findReservationOverlap(client, [segment]);

    if (overlap) {
      await client.query("ROLLBACK");
      return res.status(409).json(overlap);
    }

    const pricingLookup = buildPricingRuleLookup(await loadPricingRules());
    const stayPricing = getPricingForSiteAndNights(site, numberOfNights, pricingLookup);
    const depositPricing = getPricingForSiteAndNights(site, 1, pricingLookup);
    const totalPrice = applyDiscountPricing
      ? stayPricing.discountPrice ?? stayPricing.normalPrice
      : stayPricing.normalPrice ?? stayPricing.discountPrice;
    const oneNightDeposit = applyDiscountPricing
      ? depositPricing.discountPrice ?? depositPricing.normalPrice
      : depositPricing.normalPrice ?? depositPricing.discountPrice;

    if (totalPrice === null || oneNightDeposit === null) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        message: "Online pricing is not configured for this stay. Please call 541-295-1269."
      });
    }

    let customer = await findGuestCustomerByIdentity({
      firstName,
      lastName,
      phoneNumber
    });

    if (customer) {
      await client.query(
        `UPDATE customers SET email = $2 WHERE id = $1`,
        [customer.id, email]
      );
    } else {
      const customerResult = await client.query(
        `
          INSERT INTO customers (first_name, last_name, email, phone_number)
          VALUES ($1, $2, $3, $4)
          RETURNING id, first_name, last_name, email, phone_number
        `,
        [firstName, lastName, email, phoneNumber]
      );
      customer = customerResult.rows[0];
    }

    const reservationResult = await client.query(
      `
        INSERT INTO reservations (
          customer_id,
          booked_date,
          status,
          reservation_term,
          billing_mode,
          deposit_amount,
          total_price,
          rv_kind,
          motorhome_class_a,
          motorhome_class_c,
          motorhome_with_tow,
          rig_length_feet,
          amount_paid,
          notes
        )
        VALUES ($1, CURRENT_DATE, 'pending', 'standard', 'standard', $2, $3, $4, $5, $6, $7, $8, 0, $9)
        RETURNING id
      `,
      [
        customer.id,
        Math.min(oneNightDeposit, totalPrice),
        totalPrice,
        rvKind,
        rvKind === "motor home" ? Boolean(req.body.motorhomeClassA) : false,
        rvKind === "motor home" ? Boolean(req.body.motorhomeClassC) : false,
        rvKind === "motor home" ? Boolean(req.body.motorhomeWithTow) : false,
        rigLengthFeet,
        applyDiscountPricing
          ? `Created through the public website. Requested discounts: ${discounts.join(", ")}.`
          : "Created through the public website."
      ]
    );
    const reservationId = reservationResult.rows[0].id;

    await client.query(
      `
        INSERT INTO reservation_site_stays (reservation_id, site_id, arrival_date, leave_date)
        VALUES ($1, $2, $3, $4)
      `,
      [reservationId, siteId, arrivalDate, leaveDate]
    );
    await client.query("COMMIT");

    const reservation = await fetchReservationDetails(pool, reservationId);
    res.status(201).json(sanitizeGuestReservation(reservation));
  } catch (error) {
    await client.query("ROLLBACK");

    if (error.code === "23P01") {
      return res.status(409).json({
        message: "That site was just reserved for these dates. Please choose another site."
      });
    }

    res.status(500).json({ message: error.message });
  } finally {
    client.release();
  }
});

app.post("/api/guest/reservations/:id/availability-preview", async (req, res) => {
  const reservationId = Number(req.params.id);

  if (!reservationId) {
    return res.status(400).json({ message: "Reservation is required." });
  }

  try {
    const customer = await authenticateGuestReservation(reservationId, req.body.credentials);

    if (!customer) {
      return res.status(401).json({ message: "Your booking sign-in has expired or is invalid." });
    }

    const reservation = await fetchReservationDetails(pool, reservationId);

    if (!reservation || reservation.status === "canceled") {
      return res.status(400).json({ message: "This reservation cannot be changed online." });
    }

    const rigLengthFeet = Number(req.body.rigLengthFeet);
    const requestedStays = Array.isArray(req.body.siteStays) ? req.body.siteStays : [];
    const currentSiteIds = reservation.siteStays.map((segment) => Number(segment.site_id)).sort();
    const requestedSiteIds = requestedStays.map((segment) => Number(segment.siteId)).sort();

    if (!Number.isFinite(rigLengthFeet) || rigLengthFeet <= 0) {
      return res.status(400).json({ message: "Enter a valid rig length." });
    }

    if (
      requestedSiteIds.length !== currentSiteIds.length ||
      requestedSiteIds.some((siteId, index) => siteId !== currentSiteIds[index])
    ) {
      return res.status(400).json({
        message: "Guests can change dates online, but site changes must be handled by the office."
      });
    }

    const minSizeFeet = Math.max(1, rigLengthFeet - 5);
    const stays = [];

    for (const [index, stay] of requestedStays.entries()) {
      const siteId = Number(stay.siteId);
      const arrivalDate = String(stay.arrivalDate || "");
      const leaveDate =
        reservation.reservation_term === "yearly"
          ? addDays(arrivalDate, 1)
          : String(stay.leaveDate || "");

      if (!siteId || !arrivalDate || !leaveDate || arrivalDate >= leaveDate) {
        stays.push({
          index,
          siteId,
          currentSiteAvailable: null,
          bookedRanges: [],
          directMatches: [],
          previousBookedUntil: null,
          nextBookedFrom: null
        });
        continue;
      }

      const searchResult = await buildAvailabilitySearchResult({
        arrivalDate,
        leaveDate,
        minSizeFeet,
        excludedReservationId: reservationId
      });
      const currentSiteContext = searchResult.bookingContext.get(siteId) || {
        previousBookedUntil: null,
        nextBookedFrom: null
      };

      stays.push({
        index,
        siteId,
        currentSiteAvailable: searchResult.directMatches.some(
          (site) => Number(site.id) === siteId
        ),
        bookedRanges: searchResult.contextStays.filter(
          (segment) => Number(segment.site_id) === siteId
        ),
        directMatches: searchResult.directMatches,
        previousBookedUntil: currentSiteContext.previousBookedUntil || null,
        nextBookedFrom: currentSiteContext.nextBookedFrom || null
      });
    }

    res.json({ stays });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.put("/api/guest/reservations/:id", async (req, res) => {
  const reservationId = Number(req.params.id);

  if (!reservationId) {
    return res.status(400).json({ message: "Reservation is required." });
  }

  try {
    const customer = await authenticateGuestReservation(reservationId, req.body.credentials);

    if (!customer) {
      return res.status(401).json({ message: "Your booking sign-in has expired or is invalid." });
    }

    const reservation = await fetchReservationDetails(pool, reservationId);

    if (!reservation || reservation.status === "canceled") {
      return res.status(400).json({ message: "This reservation cannot be changed online." });
    }

    const allowedRvKinds = ["camper", "van", "5th wheel", "motor home", "trailer"];
    const rvKind = allowedRvKinds.includes(req.body.rvKind)
      ? req.body.rvKind
      : reservation.rv_kind;
    const rigLengthFeet = Number(req.body.rigLengthFeet);
    const email = String(req.body.email || "").trim();
    const requestedStays = Array.isArray(req.body.siteStays) ? req.body.siteStays : [];
    const currentSiteIds = reservation.siteStays.map((segment) => Number(segment.site_id)).sort();
    const requestedSiteIds = requestedStays.map((segment) => Number(segment.siteId)).sort();

    if (!Number.isFinite(rigLengthFeet) || rigLengthFeet <= 0) {
      return res.status(400).json({ message: "Enter a valid rig length." });
    }

    if (
      requestedSiteIds.length !== currentSiteIds.length ||
      requestedSiteIds.some((siteId, index) => siteId !== currentSiteIds[index])
    ) {
      return res.status(400).json({
        message: "Guests can change dates online, but site changes must be handled by the office."
      });
    }

    const validationMessage = validateReservationSegments(
      requestedStays,
      reservation.reservation_term
    );

    if (validationMessage) {
      return res.status(400).json({ message: validationMessage });
    }

    const normalizedSegments = normalizeSegments(requestedStays, reservation.reservation_term);
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      const overlap = await findReservationOverlap(client, normalizedSegments, reservationId);

      if (overlap) {
        await client.query("ROLLBACK");
        return res.status(409).json(overlap);
      }

      await client.query(
        `
          UPDATE customers
          SET email = $2
          WHERE id = $1
        `,
        [customer.id, email || null]
      );
      await client.query(
        `
          UPDATE reservations
          SET
            rv_kind = $2,
            motorhome_class_a = $3,
            motorhome_class_c = $4,
            motorhome_with_tow = $5,
            rig_length_feet = $6
          WHERE id = $1
        `,
        [
          reservationId,
          rvKind,
          rvKind === "motor home" ? Boolean(req.body.motorhomeClassA) : false,
          rvKind === "motor home" ? Boolean(req.body.motorhomeClassC) : false,
          rvKind === "motor home" ? Boolean(req.body.motorhomeWithTow) : false,
          rigLengthFeet
        ]
      );
      await client.query("DELETE FROM reservation_site_stays WHERE reservation_id = $1", [
        reservationId
      ]);

      for (const segment of normalizedSegments) {
        await client.query(
          `
            INSERT INTO reservation_site_stays (
              reservation_id,
              site_id,
              arrival_date,
              leave_date
            )
            VALUES ($1, $2, $3, $4)
          `,
          [reservationId, segment.siteId, segment.arrivalDate, segment.leaveDate]
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const updatedReservation = await fetchReservationDetails(pool, reservationId);
    res.json(sanitizeGuestReservation(updatedReservation));
  } catch (error) {
    if (error.code === "23P01") {
      return res.status(409).json({
        message: "Those dates overlap another reservation. Please choose different dates."
      });
    }

    res.status(500).json({ message: error.message });
  }
});

app.post("/api/guest/reservations/:id/payment-intents", async (req, res) => {
  if (!ensureStripeConfigured(res)) {
    return;
  }

  const reservationId = Number(req.params.id);
  const amountCents = toAmountCents(req.body.amount);

  if (!reservationId || !amountCents) {
    return res.status(400).json({ message: "Reservation and payment amount are required." });
  }

  try {
    const customer = await authenticateGuestReservation(reservationId, req.body.credentials);

    if (!customer) {
      return res.status(401).json({ message: "Your booking sign-in has expired or is invalid." });
    }

    const reservation = await fetchReservationDetails(pool, reservationId);

    if (!reservation || reservation.status === "canceled") {
      return res.status(400).json({ message: "This reservation cannot accept payments." });
    }

    const remainingBalanceCents = toAmountCents(reservation.cardRemainingBalance);

    if (!remainingBalanceCents) {
      return res.status(400).json({ message: "This reservation does not have a remaining balance." });
    }

    if (amountCents > remainingBalanceCents) {
      return res.status(400).json({
        message: "Payment amount cannot be greater than the current remaining balance."
      });
    }

    const activateReservationOnPayment =
      reservation.status === "pending" && Boolean(req.body.activateReservationOnPayment);
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: "usd",
      payment_method_types: ["card"],
      receipt_email: reservation.email || undefined,
      metadata: {
        reservation_id: String(reservation.id),
        payment_amount_cents: String(amountCents),
        activate_reservation_on_payment: activateReservationOnPayment ? "true" : "false"
      }
    });

    await pool.query(
      `
        INSERT INTO stripe_payment_records (
          reservation_id,
          stripe_checkout_session_id,
          stripe_payment_intent_id,
          amount_cents,
          currency,
          payment_status,
          activate_reservation_on_payment,
          stripe_customer_email
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        reservation.id,
        null,
        paymentIntent.id,
        amountCents,
        paymentIntent.currency || "usd",
        paymentIntent.status === "succeeded" ? "paid" : "unpaid",
        activateReservationOnPayment,
        reservation.email || null
      ]
    );

    res.json({
      reservationId: reservation.id,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      amount: (amountCents / 100).toFixed(2)
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get("/api/reservations", async (_req, res) => {
  try {
    await syncOpenStripePayments();
    const reservations = await fetchReservationList(pool);
    res.json(reservations);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get("/api/reservations/:id", async (req, res) => {
  try {
    await syncOpenStripePayments();

    const reservation = await fetchReservationDetails(pool, req.params.id);

    if (!reservation) {
      return res.status(404).json({ message: "Reservation not found." });
    }

    res.json(reservation);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post("/api/reservations/:id/email-confirmation", async (req, res) => {
  const reservationId = Number(req.params.id);

  if (!reservationId) {
    return res.status(400).json({ message: "A valid reservation is required." });
  }

  try {
    const reservation = await fetchReservationDetails(pool, reservationId);

    if (!reservation) {
      return res.status(404).json({ message: "Reservation not found." });
    }

    if (!reservation.email || !reservation.email.includes("@")) {
      return res.status(400).json({
        message: "Add a valid customer email address before sending the confirmation."
      });
    }

    await sendReservationConfirmationEmail(reservation);

    res.json({
      message: `Confirmation sent to ${reservation.email}.`,
      reservationId: reservation.id,
      recipient: reservation.email
    });
  } catch (error) {
    console.error("Unable to send reservation confirmation", reservationId, error);
    res.status(500).json({ message: error.message });
  }
});

app.post("/api/reservations", async (req, res) => {
  const {
    customerId,
    bookedDate,
    rvKind,
    motorhomeClassA,
    motorhomeClassC,
    motorhomeWithTow,
    rigLengthFeet,
    amountPaid,
    depositAmount,
    reservationTerm,
    billingMode,
    totalPrice,
    monthlyRentPrice,
    electricMeterReading,
    notes,
    siteStays,
    status
  } = req.body;

  if (!customerId || !bookedDate || !rvKind) {
    return res.status(400).json({ message: "Customer, booked date, and RV kind are required." });
  }

  const normalizedReservationTerm = normalizeReservationTerm(reservationTerm);
  const validationMessage = validateReservationSegments(siteStays, normalizedReservationTerm);

  if (validationMessage) {
    return res.status(400).json({ message: validationMessage });
  }

  const normalizedSegments = normalizeSegments(siteStays, normalizedReservationTerm);
  const reservationStatus = normalizeReservationStatus(status);
  const reservationBillingMode = normalizeBillingMode(billingMode);
  const isMotorhome = rvKind === "motor home";
  const parsedTotalPrice = toPriceNumber(totalPrice);
  const parsedDepositAmount = toPriceNumber(depositAmount) ?? 0;
  const parsedMonthlyRentPrice = toPriceNumber(monthlyRentPrice);
  const parsedElectricMeterReading = toMeterNumber(electricMeterReading);
  const archivedSegments = normalizedSegments.map((segment) => ({
    siteId: Number(segment.siteId),
    arrivalDate: segment.arrivalDate,
    leaveDate: segment.leaveDate
  }));

  if (reservationBillingMode === "manual_total" && parsedTotalPrice === null) {
    return res.status(400).json({ message: "Total price is required for manual total billing." });
  }

  if (reservationBillingMode === "monthly" && parsedMonthlyRentPrice === null) {
    return res.status(400).json({ message: "Monthly rent price is required for monthly billing." });
  }
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    if (reservationStatus !== "canceled") {
      const overlap = await findReservationOverlap(client, normalizedSegments);

      if (overlap) {
        await client.query("ROLLBACK");
        return res.status(409).json(overlap);
      }
    }

    const reservationResult = await client.query(
      `
        INSERT INTO reservations (
          customer_id,
          booked_date,
          status,
          reservation_term,
          billing_mode,
          deposit_amount,
          total_price,
          monthly_rent_price,
          electric_meter_reading,
          canceled_at,
          canceled_site_stays,
          rv_kind,
          motorhome_class_a,
          motorhome_class_c,
          motorhome_with_tow,
          rig_length_feet,
          amount_paid,
          notes
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $16, $17, $18)
        RETURNING id
      `,
      [
        customerId,
        bookedDate,
        reservationStatus,
        normalizedReservationTerm,
        reservationBillingMode,
        parsedDepositAmount,
        parsedTotalPrice,
        parsedMonthlyRentPrice,
        parsedElectricMeterReading,
        reservationStatus === "canceled" ? new Date().toISOString() : null,
        JSON.stringify(reservationStatus === "canceled" ? archivedSegments : []),
        rvKind,
        isMotorhome ? Boolean(motorhomeClassA) : false,
        isMotorhome ? Boolean(motorhomeClassC) : false,
        isMotorhome ? Boolean(motorhomeWithTow) : false,
        rigLengthFeet ? Number(rigLengthFeet) : null,
        toPriceNumber(amountPaid) ?? 0,
        notes || ""
      ]
    );

    const reservationId = reservationResult.rows[0].id;

    if (reservationStatus !== "canceled") {
      for (const segment of normalizedSegments) {
        await client.query(
          `
            INSERT INTO reservation_site_stays (
              reservation_id,
              site_id,
              arrival_date,
              leave_date
            )
            VALUES ($1, $2, $3, $4)
          `,
          [reservationId, segment.siteId, segment.arrivalDate, segment.leaveDate]
        );
      }
    }

    await client.query("COMMIT");
    const reservation = await fetchReservationDetails(pool, reservationId);
    res.status(201).json(reservation);
  } catch (error) {
    await client.query("ROLLBACK");

    if (error.code === "23P01") {
      return res.status(409).json({
        message: "One or more site stays overlap an existing reservation."
      });
    }

    res.status(500).json({ message: error.message });
  } finally {
    client.release();
  }
});

app.put("/api/reservations/:id", async (req, res) => {
  const {
    customerId,
    bookedDate,
    rvKind,
    motorhomeClassA,
    motorhomeClassC,
    motorhomeWithTow,
    rigLengthFeet,
    amountPaid,
    depositAmount,
    reservationTerm,
    billingMode,
    totalPrice,
    monthlyRentPrice,
    electricMeterReading,
    notes,
    siteStays,
    status
  } = req.body;

  if (!customerId || !bookedDate || !rvKind) {
    return res.status(400).json({ message: "Customer, booked date, and RV kind are required." });
  }

  const normalizedReservationTerm = normalizeReservationTerm(reservationTerm);
  const validationMessage = validateReservationSegments(siteStays, normalizedReservationTerm);

  if (validationMessage) {
    return res.status(400).json({ message: validationMessage });
  }

  const normalizedSegments = normalizeSegments(siteStays, normalizedReservationTerm);
  const reservationStatus = normalizeReservationStatus(status);
  const reservationBillingMode = normalizeBillingMode(billingMode);
  const isMotorhome = rvKind === "motor home";
  const parsedTotalPrice = toPriceNumber(totalPrice);
  const parsedDepositAmount = toPriceNumber(depositAmount) ?? 0;
  const parsedMonthlyRentPrice = toPriceNumber(monthlyRentPrice);
  const parsedElectricMeterReading = toMeterNumber(electricMeterReading);
  const archivedSegments = normalizedSegments.map((segment) => ({
    siteId: Number(segment.siteId),
    arrivalDate: segment.arrivalDate,
    leaveDate: segment.leaveDate
  }));

  if (reservationBillingMode === "manual_total" && parsedTotalPrice === null) {
    return res.status(400).json({ message: "Total price is required for manual total billing." });
  }

  if (reservationBillingMode === "monthly" && parsedMonthlyRentPrice === null) {
    return res.status(400).json({ message: "Monthly rent price is required for monthly billing." });
  }
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    if (reservationStatus !== "canceled") {
      const overlap = await findReservationOverlap(client, normalizedSegments, req.params.id);

      if (overlap) {
        await client.query("ROLLBACK");
        return res.status(409).json(overlap);
      }
    }

    const updateResult = await client.query(
      `
        UPDATE reservations
        SET
          customer_id = $2,
          booked_date = $3,
          status = $4,
          reservation_term = $5,
          billing_mode = $6,
          deposit_amount = $7,
          total_price = $8,
          monthly_rent_price = $9,
          electric_meter_reading = $10,
          canceled_at = $11,
          canceled_site_stays = $12::jsonb,
          rv_kind = $13,
          motorhome_class_a = $14,
          motorhome_class_c = $15,
          motorhome_with_tow = $16,
          rig_length_feet = $17,
          amount_paid = $18,
          notes = $19
        WHERE id = $1
        RETURNING id
      `,
      [
        req.params.id,
        customerId,
        bookedDate,
        reservationStatus,
        normalizedReservationTerm,
        reservationBillingMode,
        parsedDepositAmount,
        parsedTotalPrice,
        parsedMonthlyRentPrice,
        parsedElectricMeterReading,
        reservationStatus === "canceled" ? new Date().toISOString() : null,
        JSON.stringify(reservationStatus === "canceled" ? archivedSegments : []),
        rvKind,
        isMotorhome ? Boolean(motorhomeClassA) : false,
        isMotorhome ? Boolean(motorhomeClassC) : false,
        isMotorhome ? Boolean(motorhomeWithTow) : false,
        rigLengthFeet ? Number(rigLengthFeet) : null,
        toPriceNumber(amountPaid) ?? 0,
        notes || ""
      ]
    );

    if (updateResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Reservation not found." });
    }

    await client.query(`DELETE FROM reservation_site_stays WHERE reservation_id = $1`, [
      req.params.id
    ]);

    if (reservationStatus !== "canceled") {
      for (const segment of normalizedSegments) {
        await client.query(
          `
            INSERT INTO reservation_site_stays (
              reservation_id,
              site_id,
              arrival_date,
              leave_date
            )
            VALUES ($1, $2, $3, $4)
          `,
          [req.params.id, segment.siteId, segment.arrivalDate, segment.leaveDate]
        );
      }
    }

    await client.query("COMMIT");

    const reservation = await fetchReservationDetails(pool, req.params.id);
    res.json(reservation);
  } catch (error) {
    await client.query("ROLLBACK");

    if (error.code === "23P01") {
      return res.status(409).json({
        message: "One or more site stays overlap an existing reservation."
      });
    }

    res.status(500).json({ message: error.message });
  } finally {
    client.release();
  }
});

app.post("/api/reservations/:id/payment-links", async (req, res) => {
  if (!ensureStripeConfigured(res)) {
    return;
  }

  const reservationId = Number(req.params.id);
  const amountCents = toAmountCents(req.body.amount);
  const baseUrl = String(
    req.body.baseUrl || process.env.CLIENT_ORIGIN?.split(",").map((value) => value.trim())[0] || ""
  )
    .trim()
    .replace(/\/+$/, "");
  const activateReservationOnPayment = Boolean(req.body.activateReservationOnPayment);

  if (!reservationId || !amountCents) {
    return res.status(400).json({ message: "Reservation and payment amount are required." });
  }

  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
    return res.status(400).json({ message: "A valid site URL is required to generate a Stripe link." });
  }

  try {
    const reservation = await fetchReservationDetails(pool, reservationId);

    if (!reservation) {
      return res.status(404).json({ message: "Reservation not found." });
    }

    if (reservation.status === "canceled") {
      return res.status(400).json({ message: "Canceled reservations cannot accept payments." });
    }

    const remainingBalanceCents = toAmountCents(reservation.cardRemainingBalance);

    if (!remainingBalanceCents) {
      return res.status(400).json({ message: "This reservation does not have a remaining balance." });
    }

    if (amountCents > remainingBalanceCents) {
      return res.status(400).json({
        message: "Payment amount cannot be greater than the current remaining balance."
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      client_reference_id: String(reservation.id),
      success_url: `${baseUrl}/?payment=success&reservationId=${reservation.id}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/?payment=cancel&reservationId=${reservation.id}`,
      metadata: {
        reservation_id: String(reservation.id),
        payment_amount_cents: String(amountCents),
        activate_reservation_on_payment: activateReservationOnPayment ? "true" : "false"
      },
      payment_intent_data: {
        metadata: {
          reservation_id: String(reservation.id),
          payment_amount_cents: String(amountCents)
        }
      },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: amountCents,
            product_data: {
              name: `Reservation #${reservation.id} payment`,
              description: `${reservation.first_name} ${reservation.last_name}`
            }
          }
        }
      ]
    });

    await pool.query(
      `
        INSERT INTO stripe_payment_records (
          reservation_id,
          stripe_checkout_session_id,
          amount_cents,
          currency,
          payment_status,
          activate_reservation_on_payment,
          checkout_url
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        reservation.id,
        session.id,
        amountCents,
        session.currency || "usd",
        session.payment_status || "unpaid",
        activateReservationOnPayment,
        session.url
      ]
    );

    res.json({
      reservationId: reservation.id,
      checkoutUrl: session.url
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post("/api/reservations/:id/payment-intents", async (req, res) => {
  if (!ensureStripeConfigured(res)) {
    return;
  }

  const reservationId = Number(req.params.id);
  const amountCents = toAmountCents(req.body.amount);
  const activateReservationOnPayment = Boolean(req.body.activateReservationOnPayment);

  if (!reservationId || !amountCents) {
    return res.status(400).json({ message: "Reservation and payment amount are required." });
  }

  try {
    const reservation = await fetchReservationDetails(pool, reservationId);

    if (!reservation) {
      return res.status(404).json({ message: "Reservation not found." });
    }

    if (reservation.status === "canceled") {
      return res.status(400).json({ message: "Canceled reservations cannot accept payments." });
    }

    const remainingBalanceCents = toAmountCents(reservation.cardRemainingBalance);

    if (!remainingBalanceCents) {
      return res.status(400).json({ message: "This reservation does not have a remaining balance." });
    }

    if (amountCents > remainingBalanceCents) {
      return res.status(400).json({
        message: "Payment amount cannot be greater than the current remaining balance."
      });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: "usd",
      payment_method_types: ["card"],
      receipt_email: reservation.email || undefined,
      metadata: {
        reservation_id: String(reservation.id),
        payment_amount_cents: String(amountCents),
        activate_reservation_on_payment: activateReservationOnPayment ? "true" : "false"
      }
    });

    await pool.query(
      `
        INSERT INTO stripe_payment_records (
          reservation_id,
          stripe_checkout_session_id,
          stripe_payment_intent_id,
          amount_cents,
          currency,
          payment_status,
          activate_reservation_on_payment,
          stripe_customer_email
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        reservation.id,
        null,
        paymentIntent.id,
        amountCents,
        paymentIntent.currency || "usd",
        paymentIntent.status === "succeeded" ? "paid" : "unpaid",
        activateReservationOnPayment,
        reservation.email || null
      ]
    );

    res.json({
      reservationId: reservation.id,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      amount: (amountCents / 100).toFixed(2)
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post("/api/stripe/sync", async (_req, res) => {
  if (!ensureStripeConfigured(res)) {
    return;
  }

  try {
    const summary = await syncOpenStripePayments();
    res.json(summary);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post("/api/reservations/:id/mark-paid", async (req, res) => {
  const reservationId = Number(req.params.id);
  const paymentSource = req.body?.paymentSource === "office_card_reader"
    ? "office_card_reader"
    : "office_card_reader";
  const paymentNote = typeof req.body?.note === "string" ? req.body.note.trim() : "";

  if (!reservationId) {
    return res.status(400).json({ message: "Reservation ID is required." });
  }

  try {
    const reservation = await fetchReservationDetails(pool, reservationId);

    if (!reservation) {
      return res.status(404).json({ message: "Reservation not found." });
    }

    if (reservation.status === "canceled") {
      return res.status(400).json({ message: "Canceled reservations cannot be updated." });
    }

    if (reservation.effectiveTotalPrice === null || reservation.effectiveTotalPrice === undefined) {
      return res.status(400).json({ message: "Set the reservation total before marking it paid." });
    }

    const amountToRecord = Math.max(
      Number(reservation.effectiveTotalPrice) - (Number(reservation.amountPaid || 0) || 0),
      0
    );
    const cardAmountToRecord = Math.max(
      Number(reservation.cardRemainingBalance || 0) || 0,
      0
    );

    if (amountToRecord <= 0) {
      return res.status(400).json({ message: "This reservation is already fully paid." });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      await client.query(
        `
          UPDATE reservations
          SET
            amount_paid = $2,
            status = CASE
              WHEN status = 'pending' THEN 'active'
              ELSE status
            END
          WHERE id = $1
        `,
        [reservationId, reservation.effectiveTotalPrice]
      );

      await insertReservationPaymentEvent(client, {
        reservationId,
        amount: cardAmountToRecord || amountToRecord,
        paymentSource,
        note: paymentNote || "Office card reader payment"
      });

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const updatedReservation = await fetchReservationDetails(pool, reservationId);
    res.json(updatedReservation);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post("/api/reservations/:id/record-payment", async (req, res) => {
  const reservationId = Number(req.params.id);
  const paymentSource = "office_card_reader";
  const paymentNote = typeof req.body?.note === "string" ? req.body.note.trim() : "";
  const paymentAmount = toPriceNumber(req.body?.amount);

  if (!reservationId) {
    return res.status(400).json({ message: "Reservation ID is required." });
  }

  if (paymentAmount === null || paymentAmount <= 0) {
    return res.status(400).json({ message: "Enter an office payment amount greater than zero." });
  }

  try {
    const reservation = await fetchReservationDetails(pool, reservationId);

    if (!reservation) {
      return res.status(404).json({ message: "Reservation not found." });
    }

    if (reservation.status === "canceled") {
      return res.status(400).json({ message: "Canceled reservations cannot be updated." });
    }

    if (reservation.remainingBalance !== null && paymentAmount > Number(reservation.remainingBalance)) {
      return res.status(400).json({ message: "Office payment cannot exceed the remaining balance." });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      await client.query(
        `
          UPDATE reservations
          SET
            amount_paid = COALESCE(amount_paid, 0) + $2,
            status = CASE
              WHEN status = 'pending' THEN 'active'
              ELSE status
            END
          WHERE id = $1
        `,
        [reservationId, paymentAmount]
      );

      await insertReservationPaymentEvent(client, {
        reservationId,
        amount: paymentAmount,
        paymentSource,
        note: paymentNote || "Office card reader payment"
      });

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const updatedReservation = await fetchReservationDetails(pool, reservationId);
    res.json(updatedReservation);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.delete("/api/reservation-payment-events/:id", async (req, res) => {
  const paymentEventId = Number(req.params.id);

  if (!paymentEventId) {
    return res.status(400).json({ message: "Payment event ID is required." });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const paymentEventResult = await client.query(
      `
        SELECT
          id,
          reservation_id,
          amount,
          payment_source
        FROM reservation_payment_events
        WHERE id = $1
        FOR UPDATE
      `,
      [paymentEventId]
    );

    if (paymentEventResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Payment record not found." });
    }

    const paymentEvent = paymentEventResult.rows[0];

    if (paymentEvent.payment_source !== "office_card_reader") {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Only office payment records can be deleted here." });
    }

    const reservationResult = await client.query(
      `
        SELECT
          id,
          amount_paid
        FROM reservations
        WHERE id = $1
        FOR UPDATE
      `,
      [paymentEvent.reservation_id]
    );

    if (reservationResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Reservation not found." });
    }

    const reservation = reservationResult.rows[0];
    const nextAmountPaid = Math.max(
      (toPriceNumber(reservation.amount_paid) ?? 0) - (toPriceNumber(paymentEvent.amount) ?? 0),
      0
    );

    await client.query(`DELETE FROM reservation_payment_events WHERE id = $1`, [paymentEventId]);

    await client.query(
      `
        UPDATE reservations
        SET amount_paid = $2
        WHERE id = $1
      `,
      [paymentEvent.reservation_id, nextAmountPaid]
    );

    await client.query("COMMIT");

    const updatedReservation = await fetchReservationDetails(pool, paymentEvent.reservation_id);
    res.json(updatedReservation);
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(500).json({ message: error.message });
  } finally {
    client.release();
  }
});

app.delete("/api/reservations/:id", async (req, res) => {
  const reservationId = Number(req.params.id);

  if (!reservationId) {
    return res.status(400).json({ message: "Reservation ID is required." });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const reservationResult = await client.query(
      `
        SELECT id
        FROM reservations
        WHERE id = $1
        FOR UPDATE
      `,
      [reservationId]
    );

    if (reservationResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Reservation not found." });
    }

    await client.query(`DELETE FROM reservation_site_stays WHERE reservation_id = $1`, [reservationId]);
    await client.query(`DELETE FROM reservations WHERE id = $1`, [reservationId]);

    await client.query("COMMIT");
    res.status(204).send();
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(500).json({ message: error.message });
  } finally {
    client.release();
  }
});

app.listen(port, () => {
  console.log(`RV Park server listening on port ${port}`);
});
