import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import Stripe from "stripe";
import { pool } from "./db.js";
import {
  buildAvailabilityMap,
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
  if (req.path === "/health") {
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

function formatDisplayDate(dateString) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  }).format(new Date(`${dateString}T00:00:00Z`));
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

  if (totals.discountPrice !== null && totals.discountPrice !== undefined) {
    return totals.discountPrice;
  }

  if (totals.normalPrice !== null && totals.normalPrice !== undefined) {
    return totals.normalPrice;
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

function buildPricingRuleLookup(pricingRules) {
  const lookup = new Map();

  for (const rule of pricingRules) {
    lookup.set(`${rule.site_category}:${rule.number_of_days}`, {
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
    const current = byCategory.get(rule.site_category) || [];
    current.push({
      numberOfDays: rule.number_of_days,
      normalPrice: toPriceNumber(rule.normal_price),
      discountPrice: toPriceNumber(rule.discount_price)
    });
    byCategory.set(rule.site_category, current);
  }

  for (const [category, rules] of byCategory) {
    byCategory.set(
      category,
      rules.sort((left, right) => left.numberOfDays - right.numberOfDays)
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
    totalPrice: toPriceNumber(reservationRow.total_price),
    monthlyRentPrice: toPriceNumber(reservationRow.monthly_rent_price),
    electricMeterReading: toMeterNumber(reservationRow.electric_meter_reading),
    utilityPrice,
    effectiveTotalPrice,
    remainingBalance:
      effectiveTotalPrice !== null && effectiveTotalPrice !== undefined
        ? effectiveTotalPrice - (toPriceNumber(reservationRow.amount_paid) ?? 0)
        : null
  };
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
        Number(paymentRecord.amount_cents) / 100,
        paymentRecord.activate_reservation_on_payment
      ]
    );
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

    try {
      session = await stripe.checkout.sessions.retrieve(paymentRecord.stripe_checkout_session_id);
    } catch (error) {
      console.error("Unable to refresh Stripe checkout session", paymentRecord.stripe_checkout_session_id, error);
      summary.errorCount += 1;
      continue;
    }

    if (session.payment_status !== "paid") {
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
          typeof session.payment_intent === "string" ? session.payment_intent : null,
          session.payment_status,
          session.status === "complete" ? new Date().toISOString() : null
        ]
      );

      summary.updatedCount += 1;
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      summary.errorCount += 1;
      console.error("Unable to record Stripe payment", paymentRecord.stripe_checkout_session_id, error);
    } finally {
      client.release();
    }
  }

  return summary;
}

function getPricingForSiteAndNights(site, numberOfNights, pricingLookup) {
  const pricingCategory = getPricingCategory(site);
  const rule = pricingLookup.get(`${pricingCategory}:${numberOfNights}`) || null;

  return {
    pricingCategory,
    numberOfNights,
    pricingConfigured: Boolean(rule),
    normalPrice: rule?.normalPrice ?? null,
    discountPrice: rule?.discountPrice ?? null
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

  if (!arrivalDate || !leaveDate || arrivalDate >= leaveDate) {
    return { error: "Arrival date must be before leave date." };
  }

  return {
    arrivalDate,
    leaveDate,
    minSizeFeet,
    riverfrontOnly
  };
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

async function loadConflictingStays(siteIds, arrivalDate, leaveDate) {
  if (siteIds.length === 0) {
    return [];
  }

  const result = await pool.query(
    `
      SELECT site_id, arrival_date::text, leave_date::text
      FROM reservation_site_stays
      WHERE site_id = ANY($1::bigint[])
        AND arrival_date < $3
        AND leave_date > $2
      ORDER BY arrival_date
    `,
    [siteIds, arrivalDate, leaveDate]
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

async function loadFutureStays(siteIds, arrivalDate) {
  if (siteIds.length === 0) {
    return [];
  }

  const result = await pool.query(
    `
      SELECT site_id, arrival_date::text, leave_date::text
      FROM reservation_site_stays
      WHERE site_id = ANY($1::bigint[])
        AND leave_date > $2
      ORDER BY site_id, arrival_date
    `,
    [siteIds, arrivalDate]
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

  const uniqueNightCounts = [
    ...new Set(
      stayRows
        .filter((segment) => !isOpenEndedSegment(segment, reservationRow.reservation_term))
        .map((segment) => nightsBetween(segment.arrival_date, segment.leave_date))
    )
  ];
  const pricingLookup = buildPricingRuleLookup(await loadPricingRules(uniqueNightCounts));
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
    siteStays: pricedSiteStays
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

  try {
    const sites = await loadCandidateSites(filters.minSizeFeet, filters.riverfrontOnly);
    const numberOfNights = nightsBetween(filters.arrivalDate, filters.leaveDate);
    const pricingLookup = buildPricingRuleLookup(await loadPricingRules(numberOfNights));
    const siteIds = sites.map((site) => site.id);
    const conflictingStays = await loadConflictingStays(
      siteIds,
      filters.arrivalDate,
      filters.leaveDate
    );
    const futureStays = await loadFutureStays(siteIds, filters.arrivalDate);
    const availability = buildAvailabilityMap(
      sites,
      conflictingStays,
      filters.arrivalDate,
      filters.leaveDate
    );
    const availabilityLeadTimes = buildAvailabilityLeadTimes(
      sites,
      futureStays,
      filters.arrivalDate
    );
    const directMatches = getDirectMatches(
      availability,
      filters.arrivalDate,
      filters.leaveDate
    ).map((site) => ({
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
      ...getPricingForSiteAndNights(site, numberOfNights, pricingLookup)
    }));

    res.json({ numberOfNights, directMatches });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post("/api/availability/plan", async (req, res) => {
  const filters = parseAvailabilityFilters(req.body);

  if (filters.error) {
    return res.status(400).json({ message: filters.error });
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

    const uniqueNightCounts = [...new Set(plan.map((segment) => nightsBetween(segment.arrivalDate, segment.leaveDate)))];
    const pricingLookup = buildPricingRuleLookup(await loadPricingRules(uniqueNightCounts));
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

app.get("/api/reservations", async (_req, res) => {
  try {
    await syncOpenStripePayments();

    const reservationsResult = await pool.query(
      `
        SELECT r.id
        FROM reservations r
        ORDER BY r.booked_date DESC, r.id DESC
      `
    );

    const reservations = await Promise.all(
      reservationsResult.rows.map((row) => fetchReservationDetails(pool, row.id))
    );

    res.json(reservations.filter(Boolean));
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
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, $16, $17)
        RETURNING id
      `,
      [
        customerId,
        bookedDate,
        reservationStatus,
        normalizedReservationTerm,
        reservationBillingMode,
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
          total_price = $7,
          monthly_rent_price = $8,
          electric_meter_reading = $9,
          canceled_at = $10,
          canceled_site_stays = $11::jsonb,
          rv_kind = $12,
          motorhome_class_a = $13,
          motorhome_class_c = $14,
          motorhome_with_tow = $15,
          rig_length_feet = $16,
          amount_paid = $17,
          notes = $18
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

    const remainingBalanceCents = toAmountCents(reservation.remainingBalance);

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

    await pool.query(
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

    const updatedReservation = await fetchReservationDetails(pool, reservationId);
    res.json(updatedReservation);
  } catch (error) {
    res.status(500).json({ message: error.message });
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
