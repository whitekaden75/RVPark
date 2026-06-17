import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { pool } from "./db.js";
import {
  buildAvailabilityMap,
  buildSiteSwitchPlan,
  getDirectMatches,
  normalizeSegments,
  validateReservationSegments
} from "./planner.js";

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 4000);
const appPasscode = process.env.APP_PASSCODE || "rvpark2026";
const appPasscodeHeader = "x-app-passcode";

app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN?.split(",").map((value) => value.trim()) || "*",
    allowedHeaders: ["Content-Type", appPasscodeHeader]
  })
);
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

function toPriceNumber(value) {
  return value === null || value === undefined ? null : Number(value);
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

app.post("/api/customers", async (req, res) => {
  const { firstName, lastName, email, phoneNumber } = req.body;

  if (!firstName || !lastName || !email || !phoneNumber) {
    return res.status(400).json({ message: "All customer fields are required." });
  }

  try {
    const result = await pool.query(
      `
        INSERT INTO customers (first_name, last_name, email, phone_number)
        VALUES ($1, $2, $3, $4)
        RETURNING id, first_name, last_name, email, phone_number
      `,
      [firstName, lastName, email, phoneNumber]
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

app.get("/api/reservations/:id", async (req, res) => {
  try {
    const reservationResult = await pool.query(
      `
        SELECT
          r.id,
          r.customer_id,
          r.booked_date::text,
          r.rv_kind,
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
      [req.params.id]
    );

    if (reservationResult.rowCount === 0) {
      return res.status(404).json({ message: "Reservation not found." });
    }

    const staysResult = await pool.query(
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
      [req.params.id]
    );

    const uniqueNightCounts = [
      ...new Set(
        staysResult.rows.map((segment) => nightsBetween(segment.arrival_date, segment.leave_date))
      )
    ];
    const pricingLookup = buildPricingRuleLookup(await loadPricingRules(uniqueNightCounts));
    const pricedSiteStays = staysResult.rows.map((segment) => ({
      ...segment,
      ...getPricingForSiteAndNights(
        segment,
        nightsBetween(segment.arrival_date, segment.leave_date),
        pricingLookup
      )
    }));

    const totals = pricedSiteStays.reduce(
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
    const balances = applyBalanceSummary(reservationResult.rows[0].amount_paid, totals);

    res.json({
      ...reservationResult.rows[0],
      totals,
      ...balances,
      siteStays: pricedSiteStays
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post("/api/reservations", async (req, res) => {
  const { customerId, bookedDate, rvKind, amountPaid, notes, siteStays } = req.body;

  if (!customerId || !bookedDate || !rvKind) {
    return res.status(400).json({ message: "Customer, booked date, and RV kind are required." });
  }

  const validationMessage = validateReservationSegments(siteStays);

  if (validationMessage) {
    return res.status(400).json({ message: validationMessage });
  }

  const normalizedSegments = normalizeSegments(siteStays);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const reservationResult = await client.query(
      `
        INSERT INTO reservations (customer_id, booked_date, rv_kind, amount_paid, notes)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
      `,
      [customerId, bookedDate, rvKind, toPriceNumber(amountPaid) ?? 0, notes || ""]
    );

    const reservationId = reservationResult.rows[0].id;

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

    const createdReservation = await pool.query(
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

    const uniqueNightCounts = [
      ...new Set(
        createdReservation.rows.map((segment) =>
          nightsBetween(segment.arrival_date, segment.leave_date)
        )
      )
    ];
    const pricingLookup = buildPricingRuleLookup(await loadPricingRules(uniqueNightCounts));
    const pricedSiteStays = createdReservation.rows.map((segment) => ({
      ...segment,
      ...getPricingForSiteAndNights(
        segment,
        nightsBetween(segment.arrival_date, segment.leave_date),
        pricingLookup
      )
    }));
    const totals = pricedSiteStays.reduce(
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

    res.status(201).json({
      id: reservationId,
      ...applyBalanceSummary(toPriceNumber(amountPaid) ?? 0, totals),
      totals,
      siteStays: pricedSiteStays
    });
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

app.listen(port, () => {
  console.log(`RV Park server listening on port ${port}`);
});
