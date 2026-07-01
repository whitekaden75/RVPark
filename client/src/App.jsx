import { useEffect, useRef, useState } from "react";
import { CardElement, Elements, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe } from "@stripe/stripe-js";

const apiBaseUrl = (
  import.meta.env.VITE_API_BASE_URL || "https://rvpark-production.up.railway.app/api"
).replace(/\/+$/, "");
const appPasscode = import.meta.env.VITE_APP_PASSCODE || "rvpark2026";
const stripePublishableKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || "";
const unlockStorageKey = "rvpark-unlocked";
const lastBookedSiteStorageKey = "rvpark-last-booked-site";
const openEndedStayDate = "9999-12-31";
const cardElementOptions = {
  style: {
    base: {
      color: "#274032",
      "::placeholder": {
        color: "#7b8577"
      }
    },
    invalid: {
      color: "#9a2c2c"
    }
  }
};

let cachedStripePromise = null;

function getStripePromise() {
  if (!stripePublishableKey) {
    return null;
  }

  if (!cachedStripePromise) {
    cachedStripePromise = loadStripe(stripePublishableKey);
  }

  return cachedStripePromise;
}

function getStripeReturnState() {
  if (typeof window === "undefined") {
    return {
      paymentStatus: "",
      reservationId: "",
      sessionId: "",
      shouldBypassPasscode: false
    };
  }

  const params = new URLSearchParams(window.location.search);
  const paymentStatus = params.get("payment") || "";
  const reservationId = params.get("reservationId") || "";
  const sessionId = params.get("session_id") || "";

  return {
    paymentStatus,
    reservationId,
    sessionId,
    shouldBypassPasscode: paymentStatus === "success" && Boolean(sessionId)
  };
}

const emptySearch = {
  arrivalDate: "",
  leaveDate: "",
  minSizeFeet: "",
  riverfrontOnly: false
};

const emptyCustomer = {
  firstName: "",
  lastName: "",
  email: "",
  phoneNumber: ""
};

function createEmptySiteStay(defaultSite = null) {
  return {
    siteId: defaultSite?.siteId || "",
    siteSearch: defaultSite?.siteSearch || "",
    arrivalDate: "",
    leaveDate: ""
  };
}

function createEmptyReservation(defaultSite = null) {
  return {
    customerId: "",
    bookedDate: "",
    status: "active",
    reservationTerm: "standard",
    billingMode: "manual_total",
    depositAmount: "",
    totalPrice: "",
    monthlyRentPrice: "",
    electricMeterReading: "",
    rvKind: "camper",
    motorhomeClassA: false,
    motorhomeClassC: false,
    motorhomeWithTow: false,
    rigLengthFeet: "",
    amountPaid: "",
    notes: "",
    siteStays: [createEmptySiteStay(defaultSite)]
  };
}

function createSchedulePaymentForm(reservation = null) {
  return {
    depositAmount:
      reservation?.depositAmount !== null && reservation?.depositAmount !== undefined
        ? String(reservation.depositAmount)
        : "",
    totalPrice:
      reservation?.totalPrice !== null && reservation?.totalPrice !== undefined
        ? String(reservation.totalPrice)
        : "",
    amountPaid:
      reservation?.amountPaid !== null && reservation?.amountPaid !== undefined
        ? String(reservation.amountPaid)
        : ""
  };
}

function createReservationEditorState(reservation) {
  return {
    customer: {
      id: String(reservation.customer_id || ""),
      firstName: reservation.first_name || "",
      lastName: reservation.last_name || "",
      email: reservation.email || "",
      phoneNumber: formatPhoneNumber(reservation.phone_number || "")
    },
    reservation: {
      bookedDate: reservation.booked_date,
      status: reservation.status || "active",
      reservationTerm: reservation.reservation_term || "standard",
      totalPrice:
        reservation.totalPrice !== null && reservation.totalPrice !== undefined
          ? String(reservation.totalPrice)
          : "",
      depositAmount:
        reservation.depositAmount !== null && reservation.depositAmount !== undefined
          ? String(reservation.depositAmount)
          : "",
      amountPaid:
        reservation.amountPaid !== null && reservation.amountPaid !== undefined
          ? String(reservation.amountPaid)
          : "",
      rvKind: reservation.rv_kind,
      motorhomeClassA: Boolean(reservation.motorhome_class_a),
      motorhomeClassC: Boolean(reservation.motorhome_class_c),
      motorhomeWithTow: Boolean(reservation.motorhome_with_tow),
      rigLengthFeet: String(reservation.rig_length_feet ?? ""),
      notes: reservation.notes || "",
      siteStays: reservation.siteStays.map((segment) => ({
        siteId: String(segment.site_id),
        siteSearch: segment.site_number,
        arrivalDate: segment.arrival_date,
        leaveDate: isOpenEndedStay(segment.leave_date) ? "" : segment.leave_date
      }))
    }
  };
}

function CardActionMenu({ menuId, openMenuId, onToggle, onClose, actions }) {
  const isOpen = openMenuId === menuId;

  return (
    <div className="card-action-menu" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        className="ghost-button card-action-trigger"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => onToggle(menuId)}
      >
        ...
      </button>
      {isOpen ? (
        <div className="card-action-dropdown" role="menu">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              role="menuitem"
              className={`card-action-item ${action.danger ? "danger" : ""}`}
              onClick={() => {
                onClose();
                action.onClick();
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const rvKinds = ["camper", "van", "5th wheel", "motor home", "trailer"];
const siteNumberCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base"
});
const siteTypeOptions = [
  { value: "riverfront", label: "Riverfront" },
  { value: "standard", label: "Standard" },
  { value: "prime_river", label: "Prime river" },
  { value: "normal_river", label: "Non-prime river" },
  { value: "big_rig", label: "Big rig" },
  { value: "small_rig", label: "Small rig" }
];

const emptySiteFilters = {
  siteLookup: "",
  types: siteTypeOptions.map((option) => option.value),
  minSizeFeet: "",
  maxSizeFeet: ""
};

function nightsBetween(arrivalDate, leaveDate) {
  if (!arrivalDate || !leaveDate || leaveDate === openEndedStayDate) {
    return null;
  }

  const start = new Date(`${arrivalDate}T00:00:00Z`);
  const end = new Date(`${leaveDate}T00:00:00Z`);
  return Math.round((end - start) / 86400000);
}

function formatDateInput(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(dateString, numberOfDays) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + numberOfDays);
  return formatDateInput(date);
}

function startOfMonth(dateString) {
  const date = new Date(`${dateString}T00:00:00Z`);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function startOfNextMonth(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
}

function formatMonthLabel(date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC"
  }).format(date);
}

function getOrdinalSuffix(day) {
  if (day >= 11 && day <= 13) {
    return "th";
  }

  switch (day % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

function formatDisplayDate(dateString) {
  if (!dateString) {
    return "";
  }

  const date = new Date(`${dateString}T00:00:00Z`);
  const month = new Intl.DateTimeFormat("en-US", {
    month: "long",
    timeZone: "UTC"
  }).format(date);
  const day = date.getUTCDate();
  const year = date.getUTCFullYear();

  return `${month} ${day}${getOrdinalSuffix(day)} ${year}`;
}

function formatShortDate(dateString) {
  if (!dateString) {
    return "";
  }

  const date = new Date(`${dateString}T00:00:00Z`);
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
}

function isDateWithinRange(dateString, startDate, endDate) {
  return dateString >= startDate && dateString < endDate;
}

function formatCurrency(value) {
  if (value === null || value === undefined) {
    return "Not set";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
  }).format(Number(value));
}

function formatPricingCategory(value) {
  if (!value) {
    return "unknown";
  }

  return value.replaceAll("_", " ");
}

function formatReservationStatus(value) {
  if (value === "canceled") {
    return "Canceled";
  }

  if (value === "pending") {
    return "Pending";
  }

  return "Active";
}

function getReservationStatusClass(value) {
  if (value === "canceled") {
    return "canceled";
  }

  if (value === "pending") {
    return "pending";
  }

  return "active";
}

function formatReservationTerm(value) {
  return value === "yearly" ? "Yearly" : "Standard";
}

function isOpenEndedStay(dateString) {
  return dateString === openEndedStayDate;
}

function formatLeaveDate(dateString) {
  return isOpenEndedStay(dateString) ? "Ongoing" : formatDisplayDate(dateString);
}

function formatPhoneNumber(value) {
  const digits = String(value || "").replaceAll(/\D/g, "").slice(0, 10);

  if (digits.length <= 3) {
    return digits.length ? `(${digits}` : "";
  }

  if (digits.length <= 6) {
    return `(${digits.slice(0, 3)})${digits.slice(3)}`;
  }

  return `(${digits.slice(0, 3)})${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function normalizePhoneForSms(value) {
  return String(value || "").replaceAll(/\D/g, "").slice(0, 10);
}

function formatArrivalReference(dateString) {
  if (!dateString) {
    return "soon";
  }

  const today = formatDateInput(new Date());
  const tomorrow = addDays(today, 1);

  if (dateString === today) {
    return "today";
  }

  if (dateString === tomorrow) {
    return "tomorrow";
  }

  return formatShortDate(dateString);
}

function normalizeNamePart(value) {
  return String(value || "").trim().toLowerCase();
}

function formatBillingMode(value) {
  if (value === "manual_total") {
    return "Manual total";
  }

  if (value === "monthly") {
    return "Monthly";
  }

  return "Standard";
}

function formatMotorhomeDetails(reservation) {
  if (reservation.rv_kind !== "motor home") {
    return "";
  }

  const details = [];

  if (reservation.motorhome_class_a) {
    details.push("Class A");
  }

  if (reservation.motorhome_class_c) {
    details.push("Class C");
  }

  if (reservation.motorhome_with_tow) {
    details.push("With tow");
  }

  return details.length ? ` • ${details.join(" • ")}` : "";
}

function formatPaymentSource(value) {
  if (value === "office_card_reader") {
    return "Office card reader";
  }

  return "Stripe";
}

function buildConfirmationCode(reservation) {
  if (!reservation?.id) {
    return "";
  }

  const bookedDate = String(reservation.booked_date || "").replaceAll("-", "").slice(2);
  return `#${reservation.id}${bookedDate ? `-${bookedDate}` : ""}`;
}

function buildReservationConfirmationText(reservation, paymentLink) {
  if (!reservation) {
    return "";
  }

  const primaryStay = reservation.siteStays?.[0] || null;
  const customerName = `${reservation.first_name || ""} ${reservation.last_name || ""}`.trim();
  const depositAmount = formatCurrency(
    paymentLink?.reservationId === reservation.id ? paymentLink.amount : reservation.depositAmount ?? null
  );

  return [
    "Riverpark RV Resort",
    "RESERVATION CONFIRMATION",
    `Confirmation: ${buildConfirmationCode(reservation)}`,
    "",
    `Hi ${customerName || "Guest"},`,
    "",
    `Email: ${reservation.email || "Not set"}`,
    `Phone: ${formatPhoneNumber(reservation.phone_number || "") || "Not set"}`,
    "",
    "Deposit",
    "Non Refundable",
    "1 night per reservation, per week. We have a 3% surcharge for credit card. (No Debit cards) you may write a check, or cash with no surcharge on arrival balance.",
    `Deposit amount: ${depositAmount}`,
    `Arrival: ${primaryStay?.arrival_date ? formatShortDate(primaryStay.arrival_date) : "Not set"}`,
    "(Check-in 1:00 P.M.)",
    `Depart: ${primaryStay?.leave_date ? formatShortDate(primaryStay.leave_date) : "Not set"}`,
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
  ]
    .filter(Boolean)
    .join("\n");
}

function buildArrivalReminderText(reservation, arrivalDate) {
  if (!reservation) {
    return "";
  }

  const customerName = `${reservation.first_name || ""} ${reservation.last_name || ""}`.trim();
  const arrivingSegment =
    reservation.arrivingSiteStays?.find((segment) => segment.arrival_date === arrivalDate) ||
    reservation.siteStays?.find((segment) => segment.arrival_date === arrivalDate) ||
    reservation.siteStays?.[0] ||
    null;

  return [
    "RIVERPARK RV RESORT",
    "",
    `Hi ${customerName || "Guest"},`,
    `We have you coming in ${formatArrivalReference(arrivalDate)}.`,
    "",
    "CHECK-IN TIME IS 1:00 PM",
    `Arrival: ${arrivingSegment?.arrival_date ? formatShortDate(arrivingSegment.arrival_date) : "Not set"}`,
    `Depart: ${arrivingSegment?.leave_date ? formatShortDate(arrivingSegment.leave_date) : "Not set"}`,
    `Balance due: ${formatCurrency(reservation.remainingBalance)}`,
    "",
    "The balance due will be charged to your card on file unless otherwise requested.",
    "",
    "PLEASE NOTE:",
    "- We do NOT accept debit cards.",
    "- Credit cards have a 3% surcharge.",
    "- Check or cash: no surcharge.",
    "",
    "Please confirm your arrival in a return text, along with your APPROXIMATE ARRIVAL TIME.",
    "",
    "If the office is closed, you will find your receipt and park map in the \"Late Arrivals\" box to the left of the office door. The park map will direct you to your site.",
    "",
    "All sites are back-in only. If you need assistance backing in, or have any questions, please ring the bell to the right of the door, or call 541-295-1269. It will be answered if we are available, within reasonable hours.",
    "",
    "Thank you!!",
    "-Makayla",
    "",
    "2956 Rogue River Hwy",
    "Grants Pass, OR 97527"
  ]
    .filter(Boolean)
    .join("\n");
}

function buildSmsComposeUrl(phoneNumber, messageBody) {
  const separator = phoneNumber ? "?&" : "?";
  return `sms:${phoneNumber}${separator}body=${encodeURIComponent(messageBody)}`;
}

function buildGmailComposeUrl(reservation, paymentLink) {
  if (!reservation?.email) {
    return "";
  }

  const params = new URLSearchParams({
    view: "cm",
    fs: "1",
    to: reservation.email,
    su: `Riverpark RV Resort reservation confirmation ${buildConfirmationCode(reservation)}`,
    body: buildReservationConfirmationText(reservation, paymentLink)
  });

  return `https://mail.google.com/mail/?${params.toString()}`;
}

function calculateUtilityPrice(electricMeterReading) {
  if (electricMeterReading === "" || electricMeterReading === null || electricMeterReading === undefined) {
    return null;
  }

  return Number(electricMeterReading) * 0.17 - 75;
}

function getSiteTypeLabel(site) {
  return site.is_on_river || site.isOnRiver ? "Riverfront" : "Standard";
}

function matchesSiteTypeFilter(site, selectedTypes) {
  const matches = {
    riverfront: site.is_on_river,
    standard: !site.is_on_river,
    prime_river: site.river_category === "prime_river",
    normal_river: site.river_category === "normal_river",
    big_rig: site.is_big_rig,
    small_rig: !site.is_big_rig
  };

  return selectedTypes.some((type) => matches[type]);
}

function getPricingRuleForNights(site, numberOfNights) {
  if (!numberOfNights || !Array.isArray(site.pricing_rules)) {
    return null;
  }

  return site.pricing_rules.find((rule) => rule.numberOfDays === numberOfNights) || null;
}

function ensureArray(value, label) {
  if (Array.isArray(value)) {
    return value;
  }

  throw new Error(`${label} response was not a list. Check VITE_API_BASE_URL.`);
}

async function apiRequest(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    "x-app-passcode": appPasscode,
    ...(options.headers || {})
  };

  const response = await fetch(`${apiBaseUrl}${path}`, {
    headers,
    ...options
  });

  const contentType = response.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");
  const data = isJson ? await response.json().catch(() => ({})) : null;

  if (!response.ok) {
    throw new Error(data?.message || "Request failed.");
  }

  if (response.status === 204 || response.status === 205) {
    return null;
  }

  if (!isJson) {
    const text = await response.text().catch(() => "");

    if (!text.trim()) {
      return null;
    }

    throw new Error(
      `Expected JSON from ${apiBaseUrl}${path}. Check that VITE_API_BASE_URL points to your backend /api URL.`
    );
  }

  return data;
}

function readLastBookedSite() {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const rawValue = window.localStorage.getItem(lastBookedSiteStorageKey);

    if (!rawValue) {
      return null;
    }

    const parsed = JSON.parse(rawValue);

    if (!parsed?.siteId || !parsed?.siteSearch) {
      return null;
    }

    return {
      siteId: String(parsed.siteId),
      siteSearch: String(parsed.siteSearch)
    };
  } catch {
    return null;
  }
}

function writeLastBookedSite(site) {
  if (typeof window === "undefined" || !site?.siteId || !site?.siteSearch) {
    return;
  }

  window.localStorage.setItem(lastBookedSiteStorageKey, JSON.stringify(site));
}

function BookingSiteCalendar({ segment, bookedRanges, onSelectRange, reservationTerm }) {
  const [monthCursor, setMonthCursor] = useState(() =>
    startOfMonth(segment.arrivalDate || formatDateInput(new Date()))
  );

  useEffect(() => {
    if (segment.arrivalDate) {
      setMonthCursor(startOfMonth(segment.arrivalDate));
    }
  }, [segment.arrivalDate]);

  const monthStart = new Date(monthCursor);
  const monthLabel = formatMonthLabel(monthStart);
  const calendarStart = new Date(monthStart);
  calendarStart.setUTCDate(calendarStart.getUTCDate() - calendarStart.getUTCDay());
  const selectedEndDate =
    segment.leaveDate || (segment.arrivalDate ? addDays(segment.arrivalDate, 1) : "");
  const days = Array.from({ length: 42 }, (_, index) => {
    const current = new Date(calendarStart);
    current.setUTCDate(calendarStart.getUTCDate() + index);
    const dateString = formatDateInput(current);
    const isDepartureDate = Boolean(segment.leaveDate) && dateString === segment.leaveDate;

    return {
      dateString,
      dayNumber: current.getUTCDate(),
      isCurrentMonth: current.getUTCMonth() === monthStart.getUTCMonth(),
      isSelectedWindow:
        segment.arrivalDate &&
        selectedEndDate &&
        dateString >= segment.arrivalDate &&
        dateString < selectedEndDate,
      isDepartureDate,
      isBooked: bookedRanges.some((range) =>
        isDateWithinRange(dateString, range.arrival_date, range.leave_date)
      )
    };
  });

  function changeMonth(offset) {
    setMonthCursor((current) => {
      const next = new Date(current);
      next.setUTCMonth(next.getUTCMonth() + offset);
      return new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth(), 1));
    });
  }

  function handleDaySelect(dateString) {
    if (reservationTerm === "yearly") {
      onSelectRange(dateString, "");
      return;
    }

    if (!segment.arrivalDate || segment.leaveDate) {
      onSelectRange(dateString, "");
      return;
    }

    if (dateString <= segment.arrivalDate) {
      onSelectRange(dateString, "");
      return;
    }

    onSelectRange(segment.arrivalDate, dateString);
  }

  return (
    <div className="calendar-card compact-calendar">
      <div className="result-header">
        <button type="button" className="ghost-button" onClick={() => changeMonth(-1)}>
          Previous
        </button>
        <h3>{monthLabel}</h3>
        <button type="button" className="ghost-button" onClick={() => changeMonth(1)}>
          Next
        </button>
      </div>
      <p className="muted calendar-hint">
        {reservationTerm === "yearly"
          ? "Click an arrival day for an open-ended yearly stay."
          : "Click once for arrival. Click a later day for the departure date."}
      </p>
      <div className="calendar-grid calendar-weekdays">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>
      <div className="calendar-grid">
        {days.map((day, index) => (
          <button
            key={`${day.dateString}-${index}`}
            type="button"
            className={`calendar-day ${day.isCurrentMonth ? "" : "outside"} ${
              day.isSelectedWindow ? "selected" : ""
            } ${day.isDepartureDate ? "departure" : ""} ${day.isBooked ? "booked" : ""}`}
            onClick={() => handleDaySelect(day.dateString)}
          >
            <span>{day.dayNumber}</span>
            {day.isDepartureDate ? <small className="calendar-day-tag">Depart</small> : null}
          </button>
        ))}
      </div>
      <div className="calendar-legend">
        <span><i className="legend-box selected" /> selected stay</span>
        <span><i className="legend-box departure" /> depart</span>
        <span><i className="legend-box booked" /> booked</span>
      </div>
    </div>
  );
}

function SiteStayFields({
  segment,
  index,
  sites,
  bookedRangesBySite,
  reservationTerm,
  onChange,
  onRemove,
  canRemove
}) {
  const siteSearch = segment.siteSearch?.trim().toLowerCase() || "";
  const filteredSites = sites.filter((site) =>
    siteSearch ? site.site_number.toLowerCase().includes(siteSearch) : true
  );
  const bookedRanges = bookedRangesBySite[String(segment.siteId)] || [];

  return (
    <div className="segment-card">
      <div className="segment-header">
        <h4>Stay Segment {index + 1}</h4>
        {canRemove ? (
          <button type="button" className="ghost-button" onClick={() => onRemove(index)}>
            Remove
          </button>
        ) : null}
      </div>
      <div className="field-grid compact-grid">
        <label>
          Search site
          <input
            placeholder="Type site number or letter"
            value={segment.siteSearch || ""}
            onChange={(event) => onChange(index, "siteSearch", event.target.value)}
          />
        </label>
        <label>
          Site
          <select
            value={segment.siteId}
            onChange={(event) => onChange(index, "siteId", event.target.value)}
          >
            <option value="">Select a site</option>
            {filteredSites.map((site) => (
              <option key={site.id} value={site.id}>
                Site {site.site_number} • {site.size_feet} ft •{" "}
                {formatPricingCategory(site.pricing_category)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {segment.arrivalDate ? (
        <p className="muted">
          {reservationTerm === "yearly"
            ? `Yearly stay starts ${formatDisplayDate(
                segment.arrivalDate
              )} and continues until canceled.`
            : segment.leaveDate
            ? `Selected stay: ${formatDisplayDate(segment.arrivalDate)} through ${formatDisplayDate(
                segment.leaveDate
              )} (${nightsBetween(segment.arrivalDate, segment.leaveDate)} nights)`
            : `Arrival selected: ${formatDisplayDate(
                segment.arrivalDate
              )}. Pick a later day to finish the stay.`}
        </p>
      ) : null}
      {segment.siteId ? (
        <BookingSiteCalendar
          segment={segment}
          bookedRanges={bookedRanges}
          reservationTerm={reservationTerm}
          onSelectRange={(arrivalDate, leaveDate) => {
            onChange(index, "arrivalDate", arrivalDate);
            onChange(index, "leaveDate", leaveDate);
          }}
        />
      ) : null}
    </div>
  );
}

function SiteTimelineCalendar({
  monthCursor,
  selectedStartDate,
  selectedEndDate,
  bookedRanges,
  onChangeMonth,
  onSelectDate
}) {
  const monthStart = new Date(monthCursor);
  const monthLabel = formatMonthLabel(monthStart);
  const calendarStart = new Date(monthStart);
  calendarStart.setUTCDate(calendarStart.getUTCDate() - calendarStart.getUTCDay());
  const days = Array.from({ length: 42 }, (_, index) => {
    const current = new Date(calendarStart);
    current.setUTCDate(calendarStart.getUTCDate() + index);
    const dateString = formatDateInput(current);
    const isCurrentMonth = current.getUTCMonth() === monthStart.getUTCMonth();
    const isSelectedWindow = dateString >= selectedStartDate && dateString < selectedEndDate;
    const matchingBookings = bookedRanges.filter((range) =>
      isDateWithinRange(dateString, range.arrival_date, range.leave_date)
    );
    const isBooked = matchingBookings.length > 0;

    return {
      dateString,
      dayNumber: current.getUTCDate(),
      isCurrentMonth,
      isSelectedWindow,
      isBooked,
      bookingNames: [...new Set(matchingBookings.map((range) => range.customerName))]
    };
  });

  return (
    <div className="calendar-card">
      <div className="result-header">
        <button type="button" className="ghost-button" onClick={() => onChangeMonth(-1)}>
          Previous
        </button>
        <h3>{monthLabel}</h3>
        <button type="button" className="ghost-button" onClick={() => onChangeMonth(1)}>
          Next
        </button>
      </div>
      <div className="calendar-grid calendar-weekdays">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>
      <div className="calendar-grid">
        {days.map((day, index) => (
          <button
            key={`${day.dateString}-${index}`}
            type="button"
            className={`calendar-day ${day.isCurrentMonth ? "" : "outside"} ${
              day.isSelectedWindow ? "selected" : ""
            } ${day.isBooked ? "booked" : ""}`}
            onClick={() => onSelectDate(day.dateString)}
            title={day.bookingNames.join(", ")}
          >
            <span>{day.dayNumber}</span>
            {day.bookingNames.length ? (
              <div className="calendar-day-names">
                {day.bookingNames.slice(0, 2).map((name) => (
                  <small key={name}>{name}</small>
                ))}
                {day.bookingNames.length > 2 ? (
                  <small>+{day.bookingNames.length - 2} more</small>
                ) : null}
              </div>
            ) : null}
          </button>
        ))}
      </div>
      <div className="calendar-legend">
        <span><i className="legend-box selected" /> selected window</span>
        <span><i className="legend-box booked" /> booked</span>
      </div>
    </div>
  );
}

function BookingHistoryCalendar({
  monthCursor,
  selectedDate,
  reservationsByDate,
  onChangeMonth,
  onSelectDate
}) {
  const monthStart = new Date(monthCursor);
  const monthLabel = formatMonthLabel(monthStart);
  const calendarStart = new Date(monthStart);
  calendarStart.setUTCDate(calendarStart.getUTCDate() - calendarStart.getUTCDay());
  const days = Array.from({ length: 42 }, (_, index) => {
    const current = new Date(calendarStart);
    current.setUTCDate(calendarStart.getUTCDate() + index);
    const dateString = formatDateInput(current);
    const dayReservations = reservationsByDate.get(dateString) || [];

    return {
      dateString,
      dayNumber: current.getUTCDate(),
      isCurrentMonth: current.getUTCMonth() === monthStart.getUTCMonth(),
      isSelected: dateString === selectedDate,
      totalCount: dayReservations.length,
      canceledCount: dayReservations.filter((reservation) => reservation.status === "canceled")
        .length
    };
  });

  return (
    <div className="calendar-card">
      <div className="result-header">
        <button type="button" className="ghost-button" onClick={() => onChangeMonth(-1)}>
          Previous
        </button>
        <h3>{monthLabel}</h3>
        <button type="button" className="ghost-button" onClick={() => onChangeMonth(1)}>
          Next
        </button>
      </div>
      <div className="calendar-grid calendar-weekdays">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>
      <div className="calendar-grid">
        {days.map((day, index) => (
          <button
            key={`${day.dateString}-${index}`}
            type="button"
            className={`calendar-day ${day.isCurrentMonth ? "" : "outside"} ${
              day.isSelected ? "selected" : ""
            } ${day.totalCount ? "history-booked" : ""} ${
              day.totalCount && day.canceledCount === day.totalCount ? "history-canceled" : ""
            }`}
            onClick={() => onSelectDate(day.dateString)}
          >
            <span>{day.dayNumber}</span>
            {day.totalCount ? (
              <div className="calendar-day-names">
                <small>{day.totalCount} booked</small>
                {day.canceledCount ? <small>{day.canceledCount} canceled</small> : null}
              </div>
            ) : null}
          </button>
        ))}
      </div>
      <div className="calendar-legend">
        <span><i className="legend-box selected" /> selected day</span>
        <span><i className="legend-box history-booked" /> has bookings</span>
        <span><i className="legend-box history-canceled" /> only canceled</span>
      </div>
    </div>
  );
}

function CardPaymentForm({
  amountLabel,
  clientSecret,
  reservation,
  onCancel,
  onSuccess
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  async function handleSubmit(event) {
    event.preventDefault();
    setErrorMessage("");

    if (!stripe || !elements) {
      setErrorMessage("Stripe card entry is still loading.");
      return;
    }

    const cardElement = elements.getElement(CardElement);

    if (!cardElement) {
      setErrorMessage("Card entry is not ready yet.");
      return;
    }

    setIsSubmitting(true);

    try {
      const result = await stripe.confirmCardPayment(clientSecret, {
        payment_method: {
          card: cardElement,
          billing_details: {
            name: `${reservation.first_name || ""} ${reservation.last_name || ""}`.trim() || undefined,
            email: reservation.email || undefined,
            phone: reservation.phone_number || undefined
          }
        }
      });

      if (result.error) {
        throw new Error(result.error.message || "Payment failed.");
      }

      if (!result.paymentIntent) {
        throw new Error("Stripe did not return a payment result.");
      }

      await onSuccess(result.paymentIntent);
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form className="card-payment-form" onSubmit={handleSubmit}>
      <div className="result-header">
        <h3>Card payment</h3>
        <span className="balance-pill">{amountLabel}</span>
      </div>
      <div className="card-element-shell">
        <CardElement options={cardElementOptions} />
      </div>
      {errorMessage ? <div className="message error">{errorMessage}</div> : null}
      <div className="button-row">
        <button type="submit" className="primary-button" disabled={!stripe || isSubmitting}>
          {isSubmitting ? "Processing..." : "Charge card"}
        </button>
        <button type="button" className="ghost-button" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export default function App() {
  const stripeReturnState = getStripeReturnState();
  const [isUnlocked, setIsUnlocked] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }

    return (
      window.sessionStorage.getItem(unlockStorageKey) === "true" ||
      stripeReturnState.shouldBypassPasscode
    );
  });
  const [passcodeInput, setPasscodeInput] = useState("");
  const [passcodeError, setPasscodeError] = useState("");
  const [sites, setSites] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [reservations, setReservations] = useState([]);
  const [timelineSiteId, setTimelineSiteId] = useState("");
  const [timelineSiteSearch, setTimelineSiteSearch] = useState("");
  const [selectedTimelineDate, setSelectedTimelineDate] = useState(formatDateInput(new Date()));
  const [selectedArrivalDate, setSelectedArrivalDate] = useState(formatDateInput(new Date()));
  const [timelineMonthCursor, setTimelineMonthCursor] = useState(() =>
    startOfMonth(formatDateInput(new Date()))
  );
  const [selectedHistoryDate, setSelectedHistoryDate] = useState(formatDateInput(new Date()));
  const [historyMonthCursor, setHistoryMonthCursor] = useState(() =>
    startOfMonth(formatDateInput(new Date()))
  );
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerBookingSearch, setCustomerBookingSearch] = useState("");
  const [isTypeMenuOpen, setIsTypeMenuOpen] = useState(false);
  const [isWholeScheduleOpen, setIsWholeScheduleOpen] = useState(false);
  const [isArrivalsTodayOpen, setIsArrivalsTodayOpen] = useState(false);
  const [activeScheduleReservation, setActiveScheduleReservation] = useState(null);
  const [siteFilters, setSiteFilters] = useState(emptySiteFilters);
  const [openSitePricing, setOpenSitePricing] = useState({});
  const [searchForm, setSearchForm] = useState(emptySearch);
  const [customerForm, setCustomerForm] = useState(emptyCustomer);
  const [lastBookedSite, setLastBookedSite] = useState(() => readLastBookedSite());
  const [reservationForm, setReservationForm] = useState(() =>
    createEmptyReservation(readLastBookedSite())
  );
  const [directMatches, setDirectMatches] = useState([]);
  const [switchPlan, setSwitchPlan] = useState(null);
  const [switchPlanTotals, setSwitchPlanTotals] = useState(null);
  const [showAllDirectMatches, setShowAllDirectMatches] = useState(false);
  const [showAllSwitchPlanSegments, setShowAllSwitchPlanSegments] = useState(false);
  const [createdReservation, setCreatedReservation] = useState(null);
  const [editingReservationId, setEditingReservationId] = useState(null);
  const [reservationEditFocusSection, setReservationEditFocusSection] = useState("");
  const [reservationEditor, setReservationEditor] = useState(null);
  const [reservationEditorErrorMessage, setReservationEditorErrorMessage] = useState("");
  const [reservationEditorSuccessMessage, setReservationEditorSuccessMessage] = useState("");
  const [activeSchedulePaymentAmount, setActiveSchedulePaymentAmount] = useState("");
  const [generatedPaymentLink, setGeneratedPaymentLink] = useState(null);
  const [paymentLinkErrorMessage, setPaymentLinkErrorMessage] = useState("");
  const [paymentLinkSuccessMessage, setPaymentLinkSuccessMessage] = useState("");
  const [reservationCardPayment, setReservationCardPayment] = useState(null);
  const [scheduleCardPayment, setScheduleCardPayment] = useState(null);
  const [openCardActionMenuId, setOpenCardActionMenuId] = useState("");
  const [isEditingSchedulePaymentInfo, setIsEditingSchedulePaymentInfo] = useState(false);
  const [schedulePaymentForm, setSchedulePaymentForm] = useState(() =>
    createSchedulePaymentForm()
  );
  const [schedulePaymentErrorMessage, setSchedulePaymentErrorMessage] = useState("");
  const [schedulePaymentSuccessMessage, setSchedulePaymentSuccessMessage] = useState("");
  const [confirmationCopyMessage, setConfirmationCopyMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [reservationErrorMessage, setReservationErrorMessage] = useState("");
  const [reservationSuccessMessage, setReservationSuccessMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [isStripeSyncing, setIsStripeSyncing] = useState(false);
  const reservationFormRef = useRef(null);
  const reservationCustomerSectionRef = useRef(null);
  const reservationDatesSectionRef = useRef(null);
  const reservationRigSectionRef = useRef(null);
  const reservationNotesSectionRef = useRef(null);
  const reservationSiteSectionRef = useRef(null);
  const [openSections, setOpenSections] = useState({
    availability: false,
    reservation: false,
    schedule: false,
    history: false,
    yearly: false,
    sites: false
  });

  useEffect(() => {
    async function loadInitialData() {
      try {
        const [siteData, customerData, reservationData] = await Promise.all([
          apiRequest("/sites"),
          apiRequest("/customers"),
          apiRequest("/reservations")
        ]);

        setSites(ensureArray(siteData, "Sites"));
        setCustomers(ensureArray(customerData, "Customers"));
        setReservations(ensureArray(reservationData, "Reservations"));
      } catch (error) {
        setErrorMessage(error.message);
      }
    }

    loadInitialData();
  }, []);

  useEffect(() => {
    if (!stripeReturnState.paymentStatus) {
      return;
    }

    if (stripeReturnState.shouldBypassPasscode) {
      window.sessionStorage.setItem(unlockStorageKey, "true");
      setIsUnlocked(true);
      setSuccessMessage(
        stripeReturnState.reservationId
          ? `Payment return opened reservation #${stripeReturnState.reservationId}.`
          : "Payment return opened the app."
      );
    }

    const nextUrl = `${window.location.pathname}${window.location.hash || ""}`;
    window.history.replaceState({}, document.title, nextUrl);
  }, [stripeReturnState.paymentStatus, stripeReturnState.reservationId, stripeReturnState.shouldBypassPasscode]);

  useEffect(() => {
    if (!activeScheduleReservation) {
      return;
    }

    const refreshedReservation = reservations.find(
      (reservation) => reservation.id === activeScheduleReservation.id
    );

    if (!refreshedReservation) {
      setActiveScheduleReservation(null);
      return;
    }

    if (refreshedReservation !== activeScheduleReservation) {
      setActiveScheduleReservation(refreshedReservation);
    }
  }, [activeScheduleReservation, reservations]);

  useEffect(() => {
    if (!activeScheduleReservation) {
      setIsEditingSchedulePaymentInfo(false);
      setSchedulePaymentForm(createSchedulePaymentForm());
      setSchedulePaymentErrorMessage("");
      setSchedulePaymentSuccessMessage("");
      return;
    }

    setSchedulePaymentForm(createSchedulePaymentForm(activeScheduleReservation));
    setSchedulePaymentErrorMessage("");
    setSchedulePaymentSuccessMessage("");
  }, [activeScheduleReservation]);

  useEffect(() => {
    if (!timelineSiteId && sites.length > 0) {
      setTimelineSiteId(String(sites[0].id));
    }
  }, [sites, timelineSiteId]);

  useEffect(() => {
    function handleDocumentClick() {
      setOpenCardActionMenuId("");
    }

    document.addEventListener("click", handleDocumentClick);

    return () => {
      document.removeEventListener("click", handleDocumentClick);
    };
  }, []);

  useEffect(() => {
    function preventNumberInputScroll(event) {
      const activeElement = document.activeElement;

      if (
        activeElement instanceof HTMLInputElement &&
        activeElement.type === "number"
      ) {
        event.preventDefault();
      }
    }

    window.addEventListener("wheel", preventNumberInputScroll, { passive: false });

    return () => {
      window.removeEventListener("wheel", preventNumberInputScroll);
    };
  }, []);

  useEffect(() => {
    setReservationForm((current) => {
      let hasChanges = false;
      const nextSiteStays = current.siteStays.map((stay) => {
        if (!stay.siteId) {
          return stay;
        }

        const selectedSite = sites.find((site) => String(site.id) === String(stay.siteId));

        if (!selectedSite || stay.siteSearch === selectedSite.site_number) {
          return stay;
        }

        hasChanges = true;
        return {
          ...stay,
          siteSearch: selectedSite.site_number
        };
      });

      return hasChanges
        ? {
            ...current,
            siteStays: nextSiteStays
          }
        : current;
    });
  }, [sites]);

  useEffect(() => {
    if (!activeScheduleReservation) {
      return undefined;
    }

    function handleEscape(event) {
      if (event.key === "Escape") {
        setActiveScheduleReservation(null);
      }
    }

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [activeScheduleReservation]);

  useEffect(() => {
    function handleVisibilityOrFocus() {
      if (document.visibilityState === "hidden") {
        return;
      }

      refreshSites().catch((error) => {
        setErrorMessage(error.message);
      });
    }

    window.addEventListener("focus", handleVisibilityOrFocus);
    document.addEventListener("visibilitychange", handleVisibilityOrFocus);

    return () => {
      window.removeEventListener("focus", handleVisibilityOrFocus);
      document.removeEventListener("visibilitychange", handleVisibilityOrFocus);
    };
  }, []);

  useEffect(() => {
    if (reservationForm.reservationTerm !== "yearly") {
      return;
    }

    setReservationForm((current) => ({
      ...current,
      siteStays: current.siteStays.length
        ? [{ ...current.siteStays[0], leaveDate: "" }]
        : [createEmptySiteStay(lastBookedSite)]
    }));
  }, [lastBookedSite, reservationForm.reservationTerm]);

  const visibleSites = [...sites]
    .sort((left, right) => siteNumberCollator.compare(left.site_number, right.site_number))
    .filter((site) => {
      const siteLookup = siteFilters.siteLookup.trim().toLowerCase();

      if (siteLookup && !site.site_number.toLowerCase().includes(siteLookup)) {
        return false;
      }

      if (siteFilters.types.length > 0 && !matchesSiteTypeFilter(site, siteFilters.types)) {
        return false;
      }

      const minSizeFeet = siteFilters.minSizeFeet ? Number(siteFilters.minSizeFeet) : null;
      const maxSizeFeet = siteFilters.maxSizeFeet ? Number(siteFilters.maxSizeFeet) : null;

      if (minSizeFeet && site.size_feet < minSizeFeet) {
        return false;
      }

      if (maxSizeFeet && site.size_feet > maxSizeFeet) {
        return false;
      }

      return true;
    });
  const siteLookup = new Map(sites.map((site) => [String(site.id), site]));
  const reservationPricingPreview = reservationForm.siteStays
    .map((segment, index) => {
      const site = siteLookup.get(String(segment.siteId));
      const numberOfNights = nightsBetween(segment.arrivalDate, segment.leaveDate);

      if (!site || !numberOfNights || numberOfNights <= 0) {
        return null;
      }

      const pricingRule = getPricingRuleForNights(site, numberOfNights);

      return {
        index,
        siteNumber: site.site_number,
        pricingCategory: site.pricing_category,
        numberOfNights,
        normalPrice: pricingRule?.normalPrice ?? null,
        discountPrice: pricingRule?.discountPrice ?? null
      };
    })
    .filter(Boolean);
  const reservationPricingTotals = reservationPricingPreview.reduce(
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
  const utilityPricePreview = calculateUtilityPrice(reservationForm.electricMeterReading);
  const effectiveTotalPreview =
    reservationForm.billingMode === "manual_total"
      ? (reservationForm.totalPrice === "" ? null : Number(reservationForm.totalPrice))
      : reservationForm.billingMode === "monthly"
        ? reservationForm.monthlyRentPrice === "" || utilityPricePreview === null
          ? null
          : Number(reservationForm.monthlyRentPrice) + utilityPricePreview
        : reservationPricingTotals.discountPrice !== null
          ? reservationPricingTotals.discountPrice
          : reservationPricingTotals.normalPrice;
  const visibleCustomers = customers.filter((customer) => {
    const searchValue = customerSearch.trim().toLowerCase();

    if (!searchValue) {
      return true;
    }

    const fullName = `${customer.first_name} ${customer.last_name}`.toLowerCase();
    return fullName.includes(searchValue);
  });
  const suggestedCustomers = customers.filter((customer) => {
    const firstName = normalizeNamePart(customerForm.firstName);
    const lastName = normalizeNamePart(customerForm.lastName);

    if (!firstName || !lastName) {
      return false;
    }

    return (
      normalizeNamePart(customer.first_name) === firstName &&
      normalizeNamePart(customer.last_name) === lastName
    );
  });
  const customerBookingSearchValue = customerBookingSearch.trim().toLowerCase();
  const yearlyReservations = reservations
    .filter(
      (reservation) =>
        reservation.reservation_term === "yearly" && reservation.status !== "canceled"
    )
    .sort((left, right) => (left.booked_date || "").localeCompare(right.booked_date || ""));
  const activeReservations = reservations.filter((reservation) => reservation.status !== "canceled");
  const scheduleReservations = [...activeReservations].sort((left, right) => {
    const leftDate = left.siteStays[0]?.arrival_date || "";
    const rightDate = right.siteStays[0]?.arrival_date || "";
    return leftDate.localeCompare(rightDate);
  });
  const bookedRangesBySite = scheduleReservations.reduce((rangesBySite, reservation) => {
    reservation.siteStays.forEach((segment) => {
      const siteId = String(segment.site_id);

      if (!rangesBySite[siteId]) {
        rangesBySite[siteId] = [];
      }

      rangesBySite[siteId].push(segment);
    });

    return rangesBySite;
  }, {});
  const today = formatDateInput(new Date());
  const currentOccupancy = scheduleReservations
    .map((reservation) => {
      const activeSiteStays = reservation.siteStays.filter(
        (segment) => segment.arrival_date <= today && segment.leave_date > today
      );

      if (!activeSiteStays.length) {
        return null;
      }

      return {
        ...reservation,
        activeSiteStays
      };
    })
    .filter(Boolean);
  const arrivalsToday = scheduleReservations
    .map((reservation) => {
      const arrivingSiteStays = reservation.siteStays.filter(
        (segment) => segment.arrival_date === today
      );

      if (!arrivingSiteStays.length) {
        return null;
      }

      return {
        ...reservation,
        arrivingSiteStays
      };
    })
    .filter(Boolean);
  const arrivalsOnSelectedDate = scheduleReservations
    .map((reservation) => {
      const arrivingSiteStays = reservation.siteStays.filter(
        (segment) => segment.arrival_date === selectedArrivalDate
      );

      if (!arrivingSiteStays.length) {
        return null;
      }

      return {
        ...reservation,
        arrivingSiteStays
      };
    })
    .filter(Boolean);
  const customerScheduleResults = [...reservations]
    .filter((reservation) => {
      if (!customerBookingSearchValue) {
        return false;
      }

      return `${reservation.first_name} ${reservation.last_name}`
        .toLowerCase()
        .includes(customerBookingSearchValue);
    })
    .sort((left, right) => {
      const leftDate = left.siteStays[0]?.arrival_date || left.booked_date || "";
      const rightDate = right.siteStays[0]?.arrival_date || right.booked_date || "";
      return leftDate.localeCompare(rightDate);
    });
  const timelineStartDate = formatDateInput(timelineMonthCursor);
  const timelineEndDate = formatDateInput(startOfNextMonth(timelineMonthCursor));
  const selectedTimelineSite = sites.find((site) => String(site.id) === timelineSiteId) || null;
  const timelineSiteOptions = sites.filter((site) => {
    const searchValue = timelineSiteSearch.trim().toLowerCase();
    return searchValue ? site.site_number.toLowerCase().includes(searchValue) : true;
  });
  const selectedSiteBookedRanges = scheduleReservations.flatMap((reservation) =>
    reservation.siteStays
      .filter((segment) => String(segment.site_id) === timelineSiteId)
      .map((segment) => ({
        ...segment,
        customerName: `${reservation.first_name} ${reservation.last_name}`
      }))
  );
  const selectedSiteTimeline = scheduleReservations
    .flatMap((reservation) =>
      reservation.siteStays
        .filter(
          (segment) =>
            String(segment.site_id) === timelineSiteId &&
            segment.arrival_date < timelineEndDate &&
            segment.leave_date > timelineStartDate
        )
        .map((segment) => ({
          reservationId: reservation.id,
          reservation,
          customerName: `${reservation.first_name} ${reservation.last_name}`,
          rvKind: reservation.rv_kind,
          rigLengthFeet: reservation.rig_length_feet,
          segment
        }))
    )
    .sort((left, right) => left.segment.arrival_date.localeCompare(right.segment.arrival_date));
  const selectedDateReservations = selectedSiteTimeline.filter((entry) =>
    isDateWithinRange(selectedTimelineDate, entry.segment.arrival_date, entry.segment.leave_date)
  );

  useEffect(() => {
    if (!timelineSiteOptions.length) {
      return;
    }

    const hasSelectedSite = timelineSiteOptions.some(
      (site) => String(site.id) === timelineSiteId
    );

    if (!hasSelectedSite) {
      setTimelineSiteId(String(timelineSiteOptions[0].id));
    }
  }, [timelineSiteId, timelineSiteOptions]);
  const reservationsByBookedDate = reservations.reduce((summary, reservation) => {
    const bookedDate = reservation.booked_date;

    if (!bookedDate) {
      return summary;
    }

    const current = summary.get(bookedDate) || [];
    current.push(reservation);
    summary.set(bookedDate, current);
    return summary;
  }, new Map());
  const selectedHistoryReservations = [...(reservationsByBookedDate.get(selectedHistoryDate) || [])].sort(
    (left, right) => right.id - left.id
  );
  const hasReservationCardPayment =
    Boolean(createdReservation?.id) &&
    reservationCardPayment?.reservationId === createdReservation?.id &&
    reservationCardPayment?.amount !== null &&
    reservationCardPayment?.amount !== undefined &&
    Boolean(reservationCardPayment?.clientSecret);
  const hasScheduleCardPayment =
    Boolean(activeScheduleReservation?.id) &&
    scheduleCardPayment?.reservationId === activeScheduleReservation.id &&
    scheduleCardPayment?.amount !== null &&
    scheduleCardPayment?.amount !== undefined &&
    Boolean(scheduleCardPayment?.clientSecret);
  const reservationEditFocusLabel = {
    customer: "customer information",
    dates: "dates and site",
    rig: "rig details",
    notes: "notes"
  }[reservationEditFocusSection];

  function scrollReservationEditor(sectionKey = "") {
    const sectionMap = {
      customer: reservationCustomerSectionRef,
      dates: reservationDatesSectionRef,
      rig: reservationRigSectionRef,
      notes: reservationNotesSectionRef,
      site: reservationSiteSectionRef
    };
    const targetRef = sectionMap[sectionKey] || reservationFormRef;

    window.requestAnimationFrame(() => {
      targetRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start"
      });
    });
  }

  async function refreshSites() {
    const siteData = await apiRequest("/sites");
    setSites(ensureArray(siteData, "Sites"));
  }

  async function refreshReservationAndSiteData() {
    const [reservationData, siteData] = await Promise.all([
      apiRequest("/reservations"),
      apiRequest("/sites")
    ]);

    setReservations(ensureArray(reservationData, "Reservations"));
    setSites(ensureArray(siteData, "Sites"));
  }

  function resetReservationForm(defaultSite = lastBookedSite) {
    setReservationForm(createEmptyReservation(defaultSite));
    setCustomerSearch("");
    setCustomerForm(emptyCustomer);
    setEditingReservationId(null);
    setReservationEditFocusSection("");
  }

  function clearSection(sectionKey) {
    const todayDate = formatDateInput(new Date());

    if (sectionKey === "availability") {
      setSearchForm(emptySearch);
      setDirectMatches([]);
      setSwitchPlan(null);
      setSwitchPlanTotals(null);
      setShowAllDirectMatches(false);
      setShowAllSwitchPlanSegments(false);
      return;
    }

    if (sectionKey === "reservation") {
      resetReservationForm();
      setCreatedReservation(null);
      setGeneratedPaymentLink(null);
      setPaymentLinkErrorMessage("");
      setPaymentLinkSuccessMessage("");
      setReservationCardPayment(null);
      setConfirmationCopyMessage("");
      setReservationErrorMessage("");
      setReservationSuccessMessage("");
      return;
    }

    if (sectionKey === "schedule") {
      setCustomerBookingSearch("");
      setSelectedArrivalDate(todayDate);
      setTimelineSiteSearch("");
      setSelectedTimelineDate(todayDate);
      setTimelineMonthCursor(startOfMonth(todayDate));
      setIsWholeScheduleOpen(false);
      setIsArrivalsTodayOpen(false);
      setActiveScheduleReservation(null);
      setIsEditingSchedulePaymentInfo(false);
      return;
    }

    if (sectionKey === "history") {
      setSelectedHistoryDate(todayDate);
      setHistoryMonthCursor(startOfMonth(todayDate));
      return;
    }

    if (sectionKey === "yearly") {
      setActiveScheduleReservation(null);
      return;
    }

    if (sectionKey === "sites") {
      setSiteFilters(emptySiteFilters);
      setIsTypeMenuOpen(false);
      setOpenSitePricing({});
    }
  }

  function updateSearchField(field, value) {
    setSearchForm((current) => ({ ...current, [field]: value }));
  }

  function handleUnlock(event) {
    event.preventDefault();

    if (passcodeInput !== appPasscode) {
      setPasscodeError("Incorrect passcode.");
      return;
    }

    window.sessionStorage.setItem(unlockStorageKey, "true");
    setPasscodeError("");
    setIsUnlocked(true);
  }

  function updateSiteFilter(field, value) {
    setSiteFilters((current) => ({ ...current, [field]: value }));
  }

  function toggleSiteTypeFilter(type) {
    setSiteFilters((current) => {
      const nextTypes = current.types.includes(type)
        ? current.types.filter((value) => value !== type)
        : [...current.types, type];

      return {
        ...current,
        types: nextTypes
      };
    });
  }

  function toggleSitePricing(siteId) {
    setOpenSitePricing((current) => {
      if (current[siteId]) {
        const next = { ...current };
        delete next[siteId];
        return next;
      }

      return { ...current, [siteId]: [] };
    });
  }

  function toggleSitePricingDay(siteId, numberOfDays) {
    setOpenSitePricing((current) => {
      const selectedDays = current[siteId] || [];
      const nextDays = selectedDays.includes(numberOfDays)
        ? selectedDays.filter((value) => value !== numberOfDays)
        : [...selectedDays, numberOfDays].sort((left, right) => left - right);

      return {
        ...current,
        [siteId]: nextDays
      };
    });
  }

  function updateCustomerField(field, value) {
    setCustomerForm((current) => ({ ...current, [field]: value }));
  }

  function useExistingCustomer(customer) {
    setReservationForm((current) => ({
      ...current,
      customerId: String(customer.id)
    }));
    setCustomerSearch(`${customer.first_name} ${customer.last_name}`);
    setCustomerForm({
      firstName: customer.first_name || "",
      lastName: customer.last_name || "",
      email: customer.email || "",
      phoneNumber: formatPhoneNumber(customer.phone_number || "")
    });
  }

  async function cancelReservation(reservationId) {
    setErrorMessage("");
    setSuccessMessage("");

    const shouldCancel = window.confirm("Cancel this reservation?");

    if (!shouldCancel) {
      return;
    }

    try {
      const reservation = await apiRequest(`/reservations/${reservationId}`);

      const payload = {
        customerId: reservation.customer_id,
        bookedDate: reservation.booked_date,
        status: "canceled",
        reservationTerm: reservation.reservation_term || "standard",
        billingMode: reservation.billing_mode || "standard",
        totalPrice: reservation.totalPrice,
        monthlyRentPrice: reservation.monthlyRentPrice,
        electricMeterReading: reservation.electricMeterReading,
        rvKind: reservation.rv_kind,
        rigLengthFeet: reservation.rig_length_feet,
        amountPaid: reservation.amountPaid,
        notes: reservation.notes || "",
        siteStays: reservation.siteStays.map((segment) => ({
          siteId: String(segment.site_id),
          arrivalDate: segment.arrival_date,
          leaveDate: isOpenEndedStay(segment.leave_date) ? "" : segment.leave_date
        }))
      };

      await apiRequest(`/reservations/${reservationId}`, {
        method: "PUT",
        body: JSON.stringify(payload)
      });

      if (activeScheduleReservation?.id === reservationId) {
        setActiveScheduleReservation(null);
      }

      await refreshReservationAndSiteData();
      setSuccessMessage(`Canceled reservation #${reservationId}.`);
    } catch (error) {
      setErrorMessage(error.message);
    }
  }

  function updateReservationField(field, value) {
    setReservationForm((current) => {
      if (field === "rvKind") {
        return {
          ...current,
          rvKind: value,
          motorhomeClassA: value === "motor home" ? current.motorhomeClassA : false,
          motorhomeClassC: value === "motor home" ? current.motorhomeClassC : false,
          motorhomeWithTow: value === "motor home" ? current.motorhomeWithTow : false
        };
      }

      return { ...current, [field]: value };
    });
  }

  function updateSiteStay(index, field, value) {
    setReservationForm((current) => {
      const nextSiteStays = current.siteStays.map((stay, stayIndex) => {
        if (stayIndex !== index) {
          return stay;
        }

        if (field === "siteId") {
          const selectedSite = sites.find((site) => String(site.id) === String(value));

          return {
            ...stay,
            siteId: value,
            siteSearch: selectedSite?.site_number || stay.siteSearch
          };
        }

        return { ...stay, [field]: value };
      });

      return {
        ...current,
        siteStays: nextSiteStays
      };
    });
  }

  function addSiteStay() {
    setReservationForm((current) => ({
      ...current,
      siteStays: [
        ...current.siteStays,
        createEmptySiteStay()
      ]
    }));
  }

  function removeSiteStay(index) {
    setReservationForm((current) => ({
      ...current,
      siteStays: current.siteStays.filter((_, stayIndex) => stayIndex !== index)
    }));
  }

  async function handleAvailabilitySearch(event) {
    event.preventDefault();
    setErrorMessage("");
    setSuccessMessage("");
    setReservationErrorMessage("");
    setReservationSuccessMessage("");
    setCreatedReservation(null);
    setDirectMatches([]);
    setSwitchPlan(null);
    setSwitchPlanTotals(null);
    setShowAllDirectMatches(false);
    setShowAllSwitchPlanSegments(false);

    try {
      const [searchResult, planResult] = await Promise.all([
        apiRequest("/availability/search", {
          method: "POST",
          body: JSON.stringify(searchForm)
        }),
        apiRequest("/availability/plan", {
          method: "POST",
          body: JSON.stringify(searchForm)
        })
      ]);

      setDirectMatches(ensureArray(searchResult.directMatches, "Availability"));
      setSwitchPlan(planResult.plan);
      setSwitchPlanTotals(planResult.totals);
    } catch (error) {
      setErrorMessage(error.message);
    }
  }

  async function handleReservationCreate(event) {
    event.preventDefault();
    setErrorMessage("");
    setSuccessMessage("");
    setReservationErrorMessage("");
    setReservationSuccessMessage("");
    setGeneratedPaymentLink(null);
    setPaymentLinkErrorMessage("");
    setPaymentLinkSuccessMessage("");
    setReservationCardPayment(null);
    setConfirmationCopyMessage("");

    try {
      let customerId = reservationForm.customerId
        ? Number(reservationForm.customerId)
        : null;
      const depositAmountNumber = Number(reservationForm.depositAmount);
      const isCreatingReservation = !editingReservationId;

      if (
        isCreatingReservation &&
        (!Number.isFinite(depositAmountNumber) || depositAmountNumber <= 0)
      ) {
        throw new Error("A deposit amount is required to create a reservation.");
      }

      if (!customerId) {
        const createdCustomer = await apiRequest("/customers", {
          method: "POST",
          body: JSON.stringify(customerForm)
        });

        setCustomers((current) => [...current, createdCustomer]);
        setCustomerSearch(`${createdCustomer.first_name} ${createdCustomer.last_name}`);
        customerId = createdCustomer.id;
      } else {
        const existingCustomer =
          customers.find((customer) => customer.id === customerId) ||
          customers.find((customer) => String(customer.id) === String(customerId));
        const shouldUpdateCustomer =
          !existingCustomer ||
          customerForm.firstName !== (existingCustomer.first_name || "") ||
          customerForm.lastName !== (existingCustomer.last_name || "") ||
          customerForm.email !== (existingCustomer.email || "") ||
          customerForm.phoneNumber !== formatPhoneNumber(existingCustomer.phone_number || "");

        if (shouldUpdateCustomer) {
          const updatedCustomer = await apiRequest(`/customers/${customerId}`, {
            method: "PUT",
            body: JSON.stringify(customerForm)
          });

          setCustomers((current) =>
            current.map((customer) =>
              customer.id === updatedCustomer.id ? updatedCustomer : customer
            )
          );
          setCustomerSearch(`${updatedCustomer.first_name} ${updatedCustomer.last_name}`);
        } else if (existingCustomer) {
          setCustomerSearch(`${existingCustomer.first_name} ${existingCustomer.last_name}`);
        }
      }

      const payload = {
        ...reservationForm,
        billingMode: "manual_total",
        motorhomeClassA:
          reservationForm.rvKind === "motor home" ? reservationForm.motorhomeClassA : false,
        motorhomeClassC:
          reservationForm.rvKind === "motor home" ? reservationForm.motorhomeClassC : false,
        motorhomeWithTow:
          reservationForm.rvKind === "motor home" ? reservationForm.motorhomeWithTow : false,
        customerId,
        status: reservationForm.status
      };
      const created = await apiRequest(
        editingReservationId ? `/reservations/${editingReservationId}` : "/reservations",
        {
          method: editingReservationId ? "PUT" : "POST",
          body: JSON.stringify(payload)
        }
      );

      if (editingReservationId) {
        setCreatedReservation(created);
        setSuccessMessage(`Updated reservation #${created.id}.`);
        setReservationSuccessMessage(`Updated reservation #${created.id}.`);
      } else {
        setCreatedReservation(created);
        setSuccessMessage(`Created active reservation #${created.id}.`);
        setReservationSuccessMessage(`Created active reservation #${created.id}.`);
      }

      const lastUsedSegment = [...reservationForm.siteStays]
        .reverse()
        .find((segment) => segment.siteId);

      let rememberedSite = lastBookedSite;

      if (lastUsedSegment) {
        rememberedSite = {
          siteId: String(lastUsedSegment.siteId),
          siteSearch: lastUsedSegment.siteSearch
        };

        setLastBookedSite(rememberedSite);
        writeLastBookedSite(rememberedSite);
      }

      await refreshReservationAndSiteData();
      if (isCreatingReservation) {
        const paymentIntent = await createCardPaymentIntent(created.id, depositAmountNumber, true);

        if (paymentIntent) {
          setReservationCardPayment(paymentIntent);
          setPaymentLinkSuccessMessage("Card form is ready.");
        }
      }
      resetReservationForm(rememberedSite);
    } catch (error) {
      setReservationErrorMessage(error.message);
    }
  }

  async function startEditingReservation(reservationId, focusSection = "") {
    setErrorMessage("");
    setCreatedReservation(null);
    setGeneratedPaymentLink(null);
    setPaymentLinkErrorMessage("");
    setPaymentLinkSuccessMessage("");
    setReservationCardPayment(null);
    setReservationEditFocusSection(focusSection);
    setOpenSections((current) => ({
      ...current,
      reservation: true
    }));

    try {
      const reservation = await apiRequest(`/reservations/${reservationId}`);
      setEditingReservationId(reservation.id);
      setCustomerForm({
        firstName: reservation.first_name || "",
        lastName: reservation.last_name || "",
        email: reservation.email || "",
        phoneNumber: formatPhoneNumber(reservation.phone_number || "")
      });
      setReservationForm({
        customerId: String(reservation.customer_id),
        bookedDate: reservation.booked_date,
        status: reservation.status || "active",
        reservationTerm: reservation.reservation_term || "standard",
        billingMode: "manual_total",
        depositAmount:
          reservation.depositAmount !== null && reservation.depositAmount !== undefined
            ? String(reservation.depositAmount)
            : "",
        totalPrice: reservation.totalPrice !== null && reservation.totalPrice !== undefined
          ? String(reservation.totalPrice)
          : "",
        monthlyRentPrice:
          reservation.monthlyRentPrice !== null && reservation.monthlyRentPrice !== undefined
            ? String(reservation.monthlyRentPrice)
            : "",
        electricMeterReading:
          reservation.electricMeterReading !== null &&
          reservation.electricMeterReading !== undefined
            ? String(reservation.electricMeterReading)
            : "",
        rvKind: reservation.rv_kind,
        motorhomeClassA: Boolean(reservation.motorhome_class_a),
        motorhomeClassC: Boolean(reservation.motorhome_class_c),
        motorhomeWithTow: Boolean(reservation.motorhome_with_tow),
        rigLengthFeet: String(reservation.rig_length_feet ?? ""),
        amountPaid: String(reservation.amountPaid ?? ""),
        notes: reservation.notes || "",
        siteStays: reservation.siteStays.map((segment) => ({
          siteId: String(segment.site_id),
          siteSearch: segment.site_number,
          arrivalDate: segment.arrival_date,
          leaveDate: isOpenEndedStay(segment.leave_date) ? "" : segment.leave_date
        }))
      });
      setCustomerSearch(`${reservation.first_name} ${reservation.last_name}`);
      setCreatedReservation(null);
      scrollReservationEditor(focusSection);
    } catch (error) {
      setErrorMessage(error.message);
    }
  }

  function cancelEditingReservation() {
    resetReservationForm();
  }

  async function copyReservationConfirmation() {
    if (!createdReservation) {
      return;
    }

    const paymentContext =
      reservationCardPayment?.reservationId === createdReservation.id
        ? reservationCardPayment
        : generatedPaymentLink?.reservationId === createdReservation.id
          ? generatedPaymentLink
          : null;

    try {
      await navigator.clipboard.writeText(
        buildReservationConfirmationText(createdReservation, paymentContext)
      );
      setConfirmationCopyMessage(`Copied confirmation for reservation #${createdReservation.id}.`);
    } catch {
      setConfirmationCopyMessage("Copy failed. You can still copy the confirmation text below.");
    }
  }

  function openReservationConfirmationInGmail(reservation) {
    if (!reservation?.email) {
      setErrorMessage("Add a customer email address before opening Gmail compose.");
      return;
    }

    const paymentContext =
      reservationCardPayment?.reservationId === reservation.id
        ? reservationCardPayment
        : generatedPaymentLink?.reservationId === reservation.id
          ? generatedPaymentLink
          : null;
    const composeUrl = buildGmailComposeUrl(reservation, paymentContext);
    window.open(composeUrl, "_blank", "noopener,noreferrer");
    setSuccessMessage(`Opened Gmail draft for reservation #${reservation.id}.`);
    setErrorMessage("");
  }

  function openConfirmationInGmail() {
    if (!createdReservation?.email) {
      setConfirmationCopyMessage("Add a customer email address before opening Gmail compose.");
      return;
    }

    openReservationConfirmationInGmail(createdReservation);
    setConfirmationCopyMessage(`Opened Gmail draft for reservation #${createdReservation.id}.`);
  }

  function openArrivalTextMessage(reservation, arrivalDate) {
    const phoneNumber = normalizePhoneForSms(reservation?.phone_number);

    if (!phoneNumber) {
      setErrorMessage("Add a customer phone number before opening a text message.");
      return;
    }

    const messageBody = buildArrivalReminderText(reservation, arrivalDate);
    const smsUrl = buildSmsComposeUrl(phoneNumber, messageBody);
    window.location.href = smsUrl;
    setSuccessMessage(`Opened text draft for reservation #${reservation.id}.`);
    setErrorMessage("");
  }

  async function copyPaymentLinkToClipboard() {
    if (!generatedPaymentLink?.checkoutUrl) {
      return;
    }

    try {
      await navigator.clipboard.writeText(generatedPaymentLink.checkoutUrl);
      setPaymentLinkSuccessMessage(`${generatedPaymentLink.label} copied.`);
      setPaymentLinkErrorMessage("");
    } catch {
      setPaymentLinkErrorMessage("Copy failed. Open the payment link instead.");
    }
  }

  async function createCardPaymentIntent(reservationId, amount, activateReservationOnPayment) {
    if (!stripePublishableKey) {
      setPaymentLinkErrorMessage(
        "Add VITE_STRIPE_PUBLISHABLE_KEY to the client before collecting card details on-site."
      );
      return null;
    }

    setPaymentLinkErrorMessage("");
    setPaymentLinkSuccessMessage("");

    try {
      const amountNumber = Number(amount);

      if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
        throw new Error("Enter a payment amount greater than zero.");
      }

      return await apiRequest(`/reservations/${reservationId}/payment-intents`, {
        method: "POST",
        body: JSON.stringify({
          amount: amountNumber.toFixed(2),
          activateReservationOnPayment
        })
      });
    } catch (error) {
      setPaymentLinkErrorMessage(error.message);
      return null;
    }
  }

  async function handleReservationRefresh() {
    setErrorMessage("");

    try {
      await refreshReservationAndSiteData();
    } catch (error) {
      setErrorMessage(error.message);
    }
  }

  async function handleStripeSync() {
    setIsStripeSyncing(true);
    setErrorMessage("");
    setSuccessMessage("");

    try {
      const result = await apiRequest("/stripe/sync", {
        method: "POST"
      });

      await refreshReservationAndSiteData();
      setSuccessMessage(
        `Stripe sync finished. Checked ${result.checkedCount || 0} open payments and updated ${result.updatedCount || 0}.`
      );
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsStripeSyncing(false);
    }
  }

  async function generatePaymentLink(reservationId, amount, activateReservationOnPayment, label) {
    setPaymentLinkErrorMessage("");
    setPaymentLinkSuccessMessage("");

    try {
      const amountNumber = Number(amount);

      if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
        throw new Error("Enter a payment amount greater than zero.");
      }

      const result = await apiRequest(`/reservations/${reservationId}/payment-links`, {
        method: "POST",
        body: JSON.stringify({
          amount: amountNumber.toFixed(2),
          baseUrl: window.location.origin,
          activateReservationOnPayment
        })
      });

      setGeneratedPaymentLink({
        reservationId,
        amount: amountNumber.toFixed(2),
        checkoutUrl: result.checkoutUrl,
        label
      });
      setPaymentLinkSuccessMessage(`${label} generated for reservation #${reservationId}.`);
      await refreshReservationAndSiteData();
      return result;
    } catch (error) {
      setPaymentLinkErrorMessage(error.message);
      return null;
    }
  }

  async function handleSchedulePaymentLink(reservation) {
    const result = await createCardPaymentIntent(
      reservation.id,
      activeSchedulePaymentAmount,
      false
    );

    if (result) {
      setScheduleCardPayment(result);
      setPaymentLinkSuccessMessage("Card form is ready.");
    }
  }

  async function markReservationPaid(reservation) {
    setErrorMessage("");
    setSuccessMessage("");
    setPaymentLinkErrorMessage("");

    try {
      const updatedReservation = await apiRequest(`/reservations/${reservation.id}/mark-paid`, {
        method: "POST",
        body: JSON.stringify({
          paymentSource: "office_card_reader"
        })
      });

      setReservations((current) =>
        current.map((entry) => (entry.id === updatedReservation.id ? updatedReservation : entry))
      );

      if (activeScheduleReservation?.id === updatedReservation.id) {
        setActiveScheduleReservation(updatedReservation);
      }

      if (scheduleCardPayment?.reservationId === updatedReservation.id) {
        setScheduleCardPayment(null);
      }

      setSuccessMessage(`Marked reservation #${updatedReservation.id} as fully paid.`);
    } catch (error) {
      setErrorMessage(error.message);
    }
  }

  async function recordOfficePayment(reservation) {
    setErrorMessage("");
    setSuccessMessage("");
    setPaymentLinkErrorMessage("");
    setPaymentLinkSuccessMessage("");

    try {
      const amountNumber = Number(activeSchedulePaymentAmount);

      if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
        throw new Error("Enter an office payment amount greater than zero.");
      }

      const updatedReservation = await apiRequest(`/reservations/${reservation.id}/record-payment`, {
        method: "POST",
        body: JSON.stringify({
          amount: amountNumber.toFixed(2),
          paymentSource: "office_card_reader"
        })
      });

      setReservations((current) =>
        current.map((entry) => (entry.id === updatedReservation.id ? updatedReservation : entry))
      );

      if (activeScheduleReservation?.id === updatedReservation.id) {
        setActiveScheduleReservation(updatedReservation);
      }

      if (scheduleCardPayment?.reservationId === updatedReservation.id) {
        setScheduleCardPayment(null);
      }

      setActiveSchedulePaymentAmount(
        Number(updatedReservation.remainingBalance || 0) > 0
          ? Number(updatedReservation.remainingBalance).toFixed(2)
          : ""
      );
      setSuccessMessage(`Recorded office payment for reservation #${updatedReservation.id}.`);
    } catch (error) {
      setPaymentLinkErrorMessage(error.message);
    }
  }

  async function finalizeCardPayment(reservationId) {
    await apiRequest("/stripe/sync", { method: "POST" });
    const refreshedReservation = await apiRequest(`/reservations/${reservationId}`);

    setReservations((current) =>
      current.map((entry) => (entry.id === refreshedReservation.id ? refreshedReservation : entry))
    );

    if (activeScheduleReservation?.id === refreshedReservation.id) {
      setActiveScheduleReservation(refreshedReservation);
    }

    if (createdReservation?.id === refreshedReservation.id) {
      setCreatedReservation(refreshedReservation);
    }

    return refreshedReservation;
  }

  function updateSchedulePaymentField(field, value) {
    setSchedulePaymentForm((current) => ({
      ...current,
      [field]: value
    }));
  }

  async function saveSchedulePaymentInfo() {
    if (!activeScheduleReservation) {
      return;
    }

    setSchedulePaymentErrorMessage("");
    setSchedulePaymentSuccessMessage("");
    setErrorMessage("");
    setSuccessMessage("");

    try {
      const updatedReservation = await apiRequest(`/reservations/${activeScheduleReservation.id}`, {
        method: "PUT",
        body: JSON.stringify({
          customerId: activeScheduleReservation.customer_id,
          bookedDate: activeScheduleReservation.booked_date,
          status: activeScheduleReservation.status || "active",
          reservationTerm: activeScheduleReservation.reservation_term || "standard",
          billingMode: activeScheduleReservation.billing_mode || "manual_total",
          depositAmount: schedulePaymentForm.depositAmount,
          totalPrice: schedulePaymentForm.totalPrice,
          monthlyRentPrice: activeScheduleReservation.monthlyRentPrice,
          electricMeterReading: activeScheduleReservation.electricMeterReading,
          rvKind: activeScheduleReservation.rv_kind,
          motorhomeClassA: Boolean(activeScheduleReservation.motorhome_class_a),
          motorhomeClassC: Boolean(activeScheduleReservation.motorhome_class_c),
          motorhomeWithTow: Boolean(activeScheduleReservation.motorhome_with_tow),
          rigLengthFeet: activeScheduleReservation.rig_length_feet ?? "",
          amountPaid: schedulePaymentForm.amountPaid,
          notes: activeScheduleReservation.notes || "",
          siteStays: (activeScheduleReservation.siteStays || []).map((segment) => ({
            siteId: String(segment.site_id),
            arrivalDate: segment.arrival_date,
            leaveDate: isOpenEndedStay(segment.leave_date) ? "" : segment.leave_date
          }))
        })
      });

      setReservations((current) =>
        current.map((entry) => (entry.id === updatedReservation.id ? updatedReservation : entry))
      );
      setActiveScheduleReservation(updatedReservation);

      if (createdReservation?.id === updatedReservation.id) {
        setCreatedReservation(updatedReservation);
      }

      setActiveSchedulePaymentAmount(
        Number(updatedReservation.remainingBalance || 0) > 0
          ? Number(updatedReservation.remainingBalance).toFixed(2)
          : ""
      );
      setSchedulePaymentSuccessMessage(`Saved payment info for reservation #${updatedReservation.id}.`);
      setSuccessMessage(`Saved payment info for reservation #${updatedReservation.id}.`);
      setIsEditingSchedulePaymentInfo(false);
    } catch (error) {
      setSchedulePaymentErrorMessage(error.message);
    }
  }

  async function deleteReservation(reservation) {
    const shouldDelete = window.confirm(
      `Delete reservation #${reservation.id} for ${reservation.first_name} ${reservation.last_name}? This cannot be undone.`
    );

    if (!shouldDelete) {
      return;
    }

    setErrorMessage("");
    setSuccessMessage("");

    try {
      await apiRequest(`/reservations/${reservation.id}`, {
        method: "DELETE"
      });

      setReservations((current) =>
        current.filter((entry) => entry.id !== reservation.id)
      );

      if (activeScheduleReservation?.id === reservation.id) {
        setActiveScheduleReservation(null);
      }

      if (createdReservation?.id === reservation.id) {
        setCreatedReservation(null);
      }

      if (reservationEditor?.id === reservation.id) {
        closeReservationEditor();
      }

      if (editingReservationId === reservation.id) {
        resetReservationForm();
      }

      await refreshReservationAndSiteData();
      setSuccessMessage(`Deleted reservation #${reservation.id}.`);
    } catch (error) {
      setErrorMessage(error.message);
    }
  }

  function toggleCardActionMenu(menuId) {
    setOpenCardActionMenuId((current) => (current === menuId ? "" : menuId));
  }

  function closeCardActionMenu() {
    setOpenCardActionMenuId("");
  }

  function buildReservationEditActions(reservationId) {
    return [
      {
        label: "Edit customer information",
        onClick: () => openReservationEditor(reservationId, "customer")
      },
      {
        label: "Edit dates/site",
        onClick: () => openReservationEditor(reservationId, "dates")
      },
      {
        label: "Edit rig",
        onClick: () => openReservationEditor(reservationId, "rig")
      },
      {
        label: "Edit notes",
        onClick: () => openReservationEditor(reservationId, "notes")
      }
    ];
  }

  function updateReservationEditorCustomerField(field, value) {
    setReservationEditor((current) =>
      current
        ? {
            ...current,
            customer: {
              ...current.customer,
              [field]: value
            }
          }
        : current
    );
  }

  function updateReservationEditorField(field, value) {
    setReservationEditor((current) => {
      if (!current) {
        return current;
      }

      if (field === "rvKind") {
        return {
          ...current,
          reservation: {
            ...current.reservation,
            rvKind: value,
            motorhomeClassA:
              value === "motor home" ? current.reservation.motorhomeClassA : false,
            motorhomeClassC:
              value === "motor home" ? current.reservation.motorhomeClassC : false,
            motorhomeWithTow:
              value === "motor home" ? current.reservation.motorhomeWithTow : false
          }
        };
      }

      return {
        ...current,
        reservation: {
          ...current.reservation,
          [field]: value
        }
      };
    });
  }

  function updateReservationEditorSiteStay(index, field, value) {
    setReservationEditor((current) => {
      if (!current) {
        return current;
      }

      const nextSiteStays = current.reservation.siteStays.map((stay, stayIndex) => {
        if (stayIndex !== index) {
          return stay;
        }

        if (field === "siteId") {
          const selectedSite = sites.find((site) => String(site.id) === String(value));

          return {
            ...stay,
            siteId: value,
            siteSearch: selectedSite?.site_number || stay.siteSearch
          };
        }

        return { ...stay, [field]: value };
      });

      return {
        ...current,
        reservation: {
          ...current.reservation,
          siteStays: nextSiteStays
        }
      };
    });
  }

  function addReservationEditorSiteStay() {
    setReservationEditor((current) =>
      current
        ? {
            ...current,
            reservation: {
              ...current.reservation,
              siteStays: [...current.reservation.siteStays, createEmptySiteStay()]
            }
          }
        : current
    );
  }

  function removeReservationEditorSiteStay(index) {
    setReservationEditor((current) =>
      current
        ? {
            ...current,
            reservation: {
              ...current.reservation,
              siteStays: current.reservation.siteStays.filter((_, stayIndex) => stayIndex !== index)
            }
          }
        : current
    );
  }

  function openScheduleReservation(reservation, options = {}) {
    const { openPaymentEditor = false } = options;

    setActiveSchedulePaymentAmount(
      Number(reservation.remainingBalance || 0) > 0
        ? Number(reservation.remainingBalance).toFixed(2)
        : ""
    );
    setPaymentLinkErrorMessage("");
    setPaymentLinkSuccessMessage("");
    setScheduleCardPayment(null);
    setSchedulePaymentForm(createSchedulePaymentForm(reservation));
    setSchedulePaymentErrorMessage("");
    setSchedulePaymentSuccessMessage("");
    setIsEditingSchedulePaymentInfo(openPaymentEditor);
    setActiveScheduleReservation(reservation);
  }

  async function openReservationEditor(reservationId, focusSection = "customer") {
    setErrorMessage("");
    setReservationEditorErrorMessage("");
    setReservationEditorSuccessMessage("");
    setReservationEditFocusSection(focusSection);

    try {
      const reservation = await apiRequest(`/reservations/${reservationId}`);
      setReservationEditor({
        id: reservation.id,
        focusSection,
        ...createReservationEditorState(reservation)
      });
    } catch (error) {
      setErrorMessage(error.message);
    }
  }

  function closeReservationEditor() {
    setReservationEditor(null);
    setReservationEditorErrorMessage("");
    setReservationEditorSuccessMessage("");
    setReservationEditFocusSection("");
  }

  async function saveReservationEditor() {
    if (!reservationEditor) {
      return;
    }

    setReservationEditorErrorMessage("");
    setReservationEditorSuccessMessage("");
    setErrorMessage("");
    setSuccessMessage("");

    try {
      const customerPayload = {
        firstName: reservationEditor.customer.firstName,
        lastName: reservationEditor.customer.lastName,
        email: reservationEditor.customer.email,
        phoneNumber: reservationEditor.customer.phoneNumber
      };
      const customerId = Number(reservationEditor.customer.id);
      const updatedCustomer = await apiRequest(`/customers/${customerId}`, {
        method: "PUT",
        body: JSON.stringify(customerPayload)
      });

      setCustomers((current) =>
        current.map((customer) =>
          customer.id === updatedCustomer.id ? updatedCustomer : customer
        )
      );

      const reservationPayload = {
        customerId,
        bookedDate: reservationEditor.reservation.bookedDate,
        status: reservationEditor.reservation.status,
        reservationTerm: reservationEditor.reservation.reservationTerm,
        billingMode: "manual_total",
        totalPrice: reservationEditor.reservation.totalPrice,
        depositAmount: reservationEditor.reservation.depositAmount,
        rvKind: reservationEditor.reservation.rvKind,
        motorhomeClassA:
          reservationEditor.reservation.rvKind === "motor home"
            ? reservationEditor.reservation.motorhomeClassA
            : false,
        motorhomeClassC:
          reservationEditor.reservation.rvKind === "motor home"
            ? reservationEditor.reservation.motorhomeClassC
            : false,
        motorhomeWithTow:
          reservationEditor.reservation.rvKind === "motor home"
            ? reservationEditor.reservation.motorhomeWithTow
            : false,
        rigLengthFeet: reservationEditor.reservation.rigLengthFeet,
        amountPaid: reservationEditor.reservation.amountPaid,
        notes: reservationEditor.reservation.notes,
        siteStays: reservationEditor.reservation.siteStays
      };

      const updatedReservation = await apiRequest(`/reservations/${reservationEditor.id}`, {
        method: "PUT",
        body: JSON.stringify(reservationPayload)
      });

      setReservations((current) =>
        current.map((entry) => (entry.id === updatedReservation.id ? updatedReservation : entry))
      );

      if (activeScheduleReservation?.id === updatedReservation.id) {
        setActiveScheduleReservation(updatedReservation);
      }

      if (createdReservation?.id === updatedReservation.id) {
        setCreatedReservation(updatedReservation);
      }

      setReservationEditor({
        id: updatedReservation.id,
        focusSection: reservationEditor.focusSection,
        ...createReservationEditorState(updatedReservation)
      });
      setReservationEditorSuccessMessage(`Saved reservation #${updatedReservation.id}.`);
      setSuccessMessage(`Saved reservation #${updatedReservation.id}.`);
    } catch (error) {
      setReservationEditorErrorMessage(error.message);
    }
  }

  function openReservationSection() {
    setOpenSections((current) => ({
      ...current,
      reservation: true
    }));

    window.requestAnimationFrame(() => {
      reservationFormRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start"
      });
    });
  }

  function applyDirectMatchToReservation(site) {
    setReservationForm((current) => ({
      ...current,
      siteStays: [
        {
          siteId: String(site.id),
          siteSearch: site.siteNumber,
          arrivalDate: searchForm.arrivalDate,
          leaveDate: searchForm.leaveDate
        }
      ]
    }));
    openReservationSection();
  }

  function applyPlanToReservation() {
    if (!switchPlan?.length) {
      return;
    }

    setReservationForm((current) => ({
      ...current,
      siteStays: switchPlan.map((segment) => ({
        siteId: String(segment.siteId),
        siteSearch: segment.siteNumber,
        arrivalDate: segment.arrivalDate,
        leaveDate: segment.leaveDate
      }))
    }));
    openReservationSection();
  }

  function changeTimelineMonth(offset) {
    setTimelineMonthCursor((current) => {
      const next = new Date(current);
      next.setUTCMonth(next.getUTCMonth() + offset);
      return new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth(), 1));
    });
  }

  function changeHistoryMonth(offset) {
    setHistoryMonthCursor((current) => {
      const next = new Date(current);
      next.setUTCMonth(next.getUTCMonth() + offset);
      return new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth(), 1));
    });
  }

  function toggleSection(sectionKey) {
    setOpenSections((current) => ({
      ...current,
      [sectionKey]: !current[sectionKey]
    }));
  }

  if (!isUnlocked) {
    return (
      <div className="passcode-shell">
        <form className="passcode-card" onSubmit={handleUnlock}>
          <h1>RV Park Access</h1>
          <p className="muted">Enter the passcode to open the reservation app.</p>
          <label>
            Passcode
            <input
              type="password"
              value={passcodeInput}
              onChange={(event) => setPasscodeInput(event.target.value)}
            />
          </label>
          {passcodeError ? <div className="message error">{passcodeError}</div> : null}
          <button type="submit" className="primary-button">
            Unlock
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="page-shell">
      {errorMessage ? <div className="message error">{errorMessage}</div> : null}
      {successMessage ? <div className="message success">{successMessage}</div> : null}

      <main className="layout">
        <section className="card">
          <div className="section-toggle-row">
            <h2>Stripe Sync</h2>
            <div className="section-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={handleStripeSync}
                disabled={isStripeSyncing}
              >
                {isStripeSyncing ? "Syncing Stripe..." : "Sync Stripe payments"}
              </button>
            </div>
          </div>
          <div className="section-heading">
            <p>Use this to backfill older Stripe payments into reservation balances after webhooks go live.</p>
          </div>
        </section>

        <section className="card">
          <div className="section-toggle-row">
            <h2>Availability Search</h2>
            <div className="section-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => clearSection("availability")}
              >
                Clear section
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => toggleSection("availability")}
              >
                {openSections.availability ? "Hide search" : "Open search"}
              </button>
            </div>
          </div>
          {openSections.availability ? (
            <>
              <div className="section-heading">
                <p>Find sites that fit the full stay or build a switch plan across multiple sites.</p>
              </div>
              <form onSubmit={handleAvailabilitySearch}>
                <div className="field-grid">
                  <label>
                    Arrival
                    <input
                      type="date"
                      value={searchForm.arrivalDate}
                      onChange={(event) => updateSearchField("arrivalDate", event.target.value)}
                    />
                  </label>
                  <label>
                    Leave
                    <input
                      type="date"
                      value={searchForm.leaveDate}
                      onChange={(event) => updateSearchField("leaveDate", event.target.value)}
                    />
                  </label>
                  <label>
                    Minimum size
                    <input
                      type="number"
                      min="1"
                      placeholder="Any"
                      value={searchForm.minSizeFeet}
                      onChange={(event) => updateSearchField("minSizeFeet", event.target.value)}
                    />
                  </label>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={searchForm.riverfrontOnly}
                      onChange={(event) => updateSearchField("riverfrontOnly", event.target.checked)}
                    />
                    Riverfront only
                  </label>
                </div>
                <button type="submit" className="primary-button">
                  Search availability
                </button>
              </form>

              <div className="results-grid">
                <div className="result-panel">
                  <div className="result-header">
                    <h3>Direct matches</h3>
                    {directMatches.length > 5 ? (
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => setShowAllDirectMatches((current) => !current)}
                      >
                        {showAllDirectMatches ? "View less" : `View more (${directMatches.length - 5})`}
                      </button>
                    ) : null}
                  </div>
                  {directMatches.length ? (
                    <ul className="result-list">
                      {(showAllDirectMatches ? directMatches : directMatches.slice(0, 5)).map((site) => (
                        <li key={site.id}>
                          <div className="result-header">
                            <strong>Site {site.siteNumber}</strong>
                            <button
                              type="button"
                              className="ghost-button"
                              onClick={() => applyDirectMatchToReservation(site)}
                            >
                              Use this plan
                            </button>
                          </div>
                          <span>
                            {site.sizeFeet} ft • {getSiteTypeLabel(site)} •{" "}
                            {formatPricingCategory(site.pricingCategory)} • {site.numberOfNights} nights
                            {" "}• Actually open for{" "}
                            {site.openEnded
                              ? "an open-ended stay"
                              : `${site.availableDays} day${site.availableDays === 1 ? "" : "s"}`}
                            {site.availableUntil && !site.openEnded
                              ? ` (until ${formatDisplayDate(site.availableUntil)})`
                              : ""}
                            {" "}• Normal {formatCurrency(site.normalPrice)} • Discount{" "}
                            {formatCurrency(site.discountPrice)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted">No single site currently covers the full stay.</p>
                  )}
                </div>

                <div className="result-panel">
                  <div className="result-header">
                    <h3>Switch plan</h3>
                    {switchPlan?.length ? (
                      <button type="button" className="ghost-button" onClick={applyPlanToReservation}>
                        Use this plan
                      </button>
                    ) : null}
                  </div>
                  {switchPlan?.length ? (
                    <>
                      <ol className="timeline-list">
                        {(showAllSwitchPlanSegments ? switchPlan : switchPlan.slice(0, 5)).map((segment, index) => (
                          <li key={`${segment.siteId}-${index}`}>
                            Site {segment.siteNumber}: {segment.arrivalDate} to {segment.leaveDate} •{" "}
                            {segment.numberOfNights} nights •{" "}
                            {formatPricingCategory(segment.pricingCategory)} • Normal{" "}
                            {formatCurrency(segment.normalPrice)} • Discount{" "}
                            {formatCurrency(segment.discountPrice)}
                          </li>
                        ))}
                      </ol>
                      {switchPlan.length > 5 ? (
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() => setShowAllSwitchPlanSegments((current) => !current)}
                        >
                          {showAllSwitchPlanSegments
                            ? "View less"
                            : `View more (${switchPlan.length - 5})`}
                        </button>
                      ) : null}
                      <div className="pricing-summary">
                        <span>Total normal: {formatCurrency(switchPlanTotals?.normalPrice)}</span>
                        <span>Total discount: {formatCurrency(switchPlanTotals?.discountPrice)}</span>
                      </div>
                    </>
                  ) : (
                    <p className="muted">No multi-site plan is available for that date range.</p>
                  )}
                </div>
              </div>
            </>
          ) : null}
        </section>

        <section ref={reservationFormRef} className="card">
          <div className="section-toggle-row">
            <h2>{editingReservationId ? `Edit Reservation #${editingReservationId}` : "Create Reservation"}</h2>
            <div className="section-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => clearSection("reservation")}
              >
                Clear section
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => toggleSection("reservation")}
              >
                {openSections.reservation ? "Hide booking form" : "Open booking form"}
              </button>
            </div>
          </div>
          {openSections.reservation ? (
            <div>
              <div className="section-heading">
                <p>
                  {editingReservationId && reservationEditFocusLabel
                    ? `Editing ${reservationEditFocusLabel} for reservation #${editingReservationId}.`
                    : "Create the customer and reservation together, or pick an existing customer."}
                </p>
              </div>
              <form onSubmit={handleReservationCreate}>
                <div className="field-grid">
                  <div ref={reservationCustomerSectionRef} className="reservation-form-anchor">
                    <span className="small-text">Customer information</span>
                  </div>
                  <label>
                    First name
                    <input
                      value={customerForm.firstName}
                      onChange={(event) => updateCustomerField("firstName", event.target.value)}
                    />
                  </label>
                  <label>
                    Last name
                    <input
                      value={customerForm.lastName}
                      onChange={(event) => updateCustomerField("lastName", event.target.value)}
                    />
                  </label>
                  <label>
                    Email
                    <input
                      type="email"
                      value={customerForm.email}
                      onChange={(event) => updateCustomerField("email", event.target.value)}
                    />
                  </label>
                  <label>
                    Phone
                    <input
                      type="tel"
                      inputMode="numeric"
                      placeholder="(123)123-1234"
                      value={customerForm.phoneNumber}
                      onChange={(event) =>
                        updateCustomerField("phoneNumber", formatPhoneNumber(event.target.value))
                      }
                    />
                  </label>
                  {suggestedCustomers.length ? (
                    <div className="suggestion-card notes-field">
                      <div className="result-header">
                        <h3>Possible existing customer</h3>
                        <span className="muted">
                          Verify email and phone before using
                        </span>
                      </div>
                      <div className="schedule-list">
                        {suggestedCustomers.map((customer) => (
                          <article key={customer.id} className="timeline-entry-card">
                            <div className="result-header">
                              <h4>
                                #{customer.id} {customer.first_name} {customer.last_name}
                              </h4>
                              <button
                                type="button"
                                className="ghost-button"
                                onClick={() => useExistingCustomer(customer)}
                              >
                                Use customer
                              </button>
                            </div>
                            <p className="muted">
                              Email: {customer.email || "Not set"} • Phone:{" "}
                              {formatPhoneNumber(customer.phone_number || "") || "Not set"}
                            </p>
                          </article>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  <label>
                    Search customer
                    <input
                      placeholder="Type a customer name"
                      value={customerSearch}
                      onChange={(event) => setCustomerSearch(event.target.value)}
                    />
                  </label>
                  <label>
                    Customer
                    <select
                      value={reservationForm.customerId}
                      onChange={(event) => {
                        const selectedCustomerId = event.target.value;

                        if (!selectedCustomerId) {
                          updateReservationField("customerId", "");
                          return;
                        }

                        const selectedCustomer = customers.find(
                          (customer) => String(customer.id) === selectedCustomerId
                        );

                        if (selectedCustomer) {
                          useExistingCustomer(selectedCustomer);
                          return;
                        }

                        updateReservationField("customerId", selectedCustomerId);
                      }}
                    >
                      <option value="">Create a new customer from the fields above</option>
                      {visibleCustomers.map((customer) => (
                        <option key={customer.id} value={customer.id}>
                          #{customer.id} {customer.first_name} {customer.last_name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div ref={reservationDatesSectionRef} className="reservation-form-anchor">
                    <span className="small-text">Dates and site</span>
                  </div>
                  <label>
                    Booked date
                    <input
                      type="date"
                      value={reservationForm.bookedDate}
                      onChange={(event) => updateReservationField("bookedDate", event.target.value)}
                    />
                  </label>
                  <label>
                    Booking status
                    <select
                      value={reservationForm.status}
                      onChange={(event) => updateReservationField("status", event.target.value)}
                    >
                      <option value="active">Active</option>
                      <option value="pending">Pending</option>
                      <option value="canceled">Canceled</option>
                    </select>
                  </label>
                  <label>
                    Reservation term
                    <select
                      value={reservationForm.reservationTerm}
                      onChange={(event) => updateReservationField("reservationTerm", event.target.value)}
                    >
                      <option value="standard">Standard</option>
                      <option value="yearly">Yearly</option>
                    </select>
                  </label>
                  <label>
                    Total price
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="0.00"
                      value={reservationForm.totalPrice}
                      onChange={(event) =>
                        updateReservationField("totalPrice", event.target.value)
                      }
                    />
                  </label>
                  {!editingReservationId ? (
                    <label>
                      Deposit amount
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        placeholder="Required"
                        value={reservationForm.depositAmount}
                        onChange={(event) =>
                          updateReservationField("depositAmount", event.target.value)
                        }
                        onWheel={(event) => event.currentTarget.blur()}
                      />
                    </label>
                  ) : (
                    <label>
                      Deposit amount
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="0.00"
                        value={reservationForm.depositAmount}
                        onChange={(event) =>
                          updateReservationField("depositAmount", event.target.value)
                        }
                        onWheel={(event) => event.currentTarget.blur()}
                      />
                    </label>
                  )}
                  <div ref={reservationRigSectionRef} className="reservation-form-anchor">
                    <span className="small-text">Rig details</span>
                  </div>
                  <label>
                    RV kind
                    <select
                      value={reservationForm.rvKind}
                      onChange={(event) => updateReservationField("rvKind", event.target.value)}
                    >
                      {rvKinds.map((kind) => (
                        <option key={kind} value={kind}>
                          {kind}
                        </option>
                      ))}
                    </select>
                  </label>
                  {reservationForm.rvKind === "motor home" ? (
                    <div className="motorhome-options">
                      <span className="small-text">Motor home details</span>
                      <label className="checkbox-row compact-checkbox">
                        <input
                          type="checkbox"
                          checked={reservationForm.motorhomeClassA}
                          onChange={(event) =>
                            updateReservationField("motorhomeClassA", event.target.checked)
                          }
                        />
                        Class A
                      </label>
                      <label className="checkbox-row compact-checkbox">
                        <input
                          type="checkbox"
                          checked={reservationForm.motorhomeClassC}
                          onChange={(event) =>
                            updateReservationField("motorhomeClassC", event.target.checked)
                          }
                        />
                        Class C
                      </label>
                      <label className="checkbox-row compact-checkbox">
                        <input
                          type="checkbox"
                          checked={reservationForm.motorhomeWithTow}
                          onChange={(event) =>
                            updateReservationField("motorhomeWithTow", event.target.checked)
                          }
                        />
                        With tow
                      </label>
                    </div>
                  ) : null}
                  <label>
                    Rig size (feet)
                    <input
                      type="number"
                      min="1"
                      placeholder="Example: 32"
                      value={reservationForm.rigLengthFeet}
                      onChange={(event) =>
                        updateReservationField("rigLengthFeet", event.target.value)
                      }
                    />
                  </label>
                  <div ref={reservationNotesSectionRef} className="reservation-form-anchor">
                    <span className="small-text">Notes</span>
                  </div>
                  <label className="notes-field">
                    Notes
                    <textarea
                      rows="4"
                      value={reservationForm.notes}
                      onChange={(event) => updateReservationField("notes", event.target.value)}
                    />
                  </label>
                </div>

                <div ref={reservationSiteSectionRef} className="segment-list">
                  {reservationForm.siteStays.map((segment, index) => (
                    <SiteStayFields
                      key={index}
                      segment={segment}
                      index={index}
                      sites={sites}
                      bookedRangesBySite={bookedRangesBySite}
                      reservationTerm={reservationForm.reservationTerm}
                      onChange={updateSiteStay}
                      onRemove={removeSiteStay}
                      canRemove={
                        reservationForm.reservationTerm !== "yearly" &&
                        reservationForm.siteStays.length > 1
                      }
                    />
                  ))}
                </div>

                {reservationForm.totalPrice ? (
                  <div className="pricing-preview-card">
                    <h3>Booking Total</h3>
                    <div className="pricing-summary">
                      <span>Manual total: {formatCurrency(reservationForm.totalPrice || null)}</span>
                      <span>Effective total: {formatCurrency(effectiveTotalPreview)}</span>
                      <span>
                        Remaining balance:{" "}
                        {formatCurrency(
                          effectiveTotalPreview !== null
                            ? effectiveTotalPreview - (Number(reservationForm.amountPaid || 0) || 0)
                            : null
                        )}
                      </span>
                    </div>
                  </div>
                ) : null}

                <div className="button-row">
                  {reservationForm.reservationTerm !== "yearly" ? (
                    <button type="button" className="ghost-button" onClick={addSiteStay}>
                      Add site stay
                    </button>
                  ) : null}
                  {editingReservationId ? (
                    <button type="button" className="ghost-button" onClick={cancelEditingReservation}>
                      Cancel edit
                    </button>
                  ) : null}
                  <button type="submit" className="primary-button">
                    {editingReservationId ? "Save reservation" : "Create reservation"}
                  </button>
                </div>
                {reservationErrorMessage ? (
                  <div className="message error">{reservationErrorMessage}</div>
                ) : null}
                {reservationSuccessMessage ? (
                  <div className="message success">{reservationSuccessMessage}</div>
                ) : null}
                {paymentLinkErrorMessage ? (
                  <div className="message error">{paymentLinkErrorMessage}</div>
                ) : null}
                {paymentLinkSuccessMessage && hasReservationCardPayment ? (
                  <div className="message success">{paymentLinkSuccessMessage}</div>
                ) : null}
                {hasReservationCardPayment ? (
                  <div className="payment-panel">
                    <div className="result-header">
                      <h3>Collect deposit card</h3>
                      <span className="balance-pill">
                        {formatCurrency(reservationCardPayment.amount)}
                      </span>
                    </div>
                    <p className="muted">
                      Reservation #{reservationCardPayment.reservationId} will stay pending until this card payment goes through.
                    </p>
                    <Elements stripe={getStripePromise()}>
                      <CardPaymentForm
                        amountLabel={formatCurrency(reservationCardPayment.amount)}
                        clientSecret={reservationCardPayment.clientSecret}
                        reservation={createdReservation}
                        onCancel={() => setReservationCardPayment(null)}
                        onSuccess={async () => {
                          const refreshedReservation = await finalizeCardPayment(createdReservation.id);
                          setReservationCardPayment(null);
                          setPaymentLinkSuccessMessage(
                            `Deposit payment completed for reservation #${refreshedReservation.id}.`
                          );
                        }}
                      />
                    </Elements>
                  </div>
                ) : null}
                {createdReservation && !editingReservationId ? (
                  <div className="confirmation-card">
                    <div className="result-header">
                      <h3>Customer confirmation</h3>
                      <div className="button-row">
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={openConfirmationInGmail}
                        >
                          Open in Gmail
                        </button>
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={copyReservationConfirmation}
                        >
                          Copy confirmation
                        </button>
                      </div>
                    </div>
                    <div className="pricing-summary">
                      <span>
                        Confirmation {buildConfirmationCode(createdReservation)}
                      </span>
                      <span>Email: {createdReservation.email || "Not set"}</span>
                      <span>
                        Phone:{" "}
                        {formatPhoneNumber(createdReservation.phone_number || "") || "Not set"}
                      </span>
                    </div>
                    {confirmationCopyMessage ? (
                      <div
                        className={`message ${
                          confirmationCopyMessage.startsWith("Copied") ? "success" : "error"
                        }`}
                      >
                        {confirmationCopyMessage}
                      </div>
                    ) : null}
                    <p className="muted">
                      The customer confirmation is ready to copy and send.
                    </p>
                  </div>
                ) : null}
              </form>
            </div>
          ) : null}
        </section>

        <section className="card">
          <div className="section-toggle-row">
            <h2>Schedule</h2>
            <div className="section-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => clearSection("schedule")}
              >
                Clear section
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => toggleSection("schedule")}
              >
                {openSections.schedule ? "Hide schedule" : "Open schedule"}
              </button>
            </div>
          </div>
          {openSections.schedule ? (
            <>
              <div className="section-heading">
                <p>See who is in a site today, then inspect a single site timeline for any date window.</p>
              </div>
              <div className="button-row">
                <span className="muted">{currentOccupancy.length} current stays today</span>
                <button type="button" className="ghost-button" onClick={handleReservationRefresh}>
                  Refresh schedule
                </button>
              </div>
              <div className="timeline-controls schedule-search-controls">
                <label>
                  Search name
                  <input
                    placeholder="Type a customer name"
                    value={customerBookingSearch}
                    onChange={(event) => setCustomerBookingSearch(event.target.value)}
                  />
                </label>
                <label>
                  Arrival date
                  <input
                    type="date"
                    value={selectedArrivalDate}
                    onChange={(event) => setSelectedArrivalDate(event.target.value)}
                  />
                </label>
              </div>
              {customerBookingSearchValue ? (
                <div className="timeline-card">
                  <div className="result-header">
                    <h3>Customer booking search</h3>
                    <span className="muted">{customerScheduleResults.length} matches</span>
                  </div>
                  {customerScheduleResults.length ? (
                    <div className="schedule-list">
                      {customerScheduleResults.map((reservation) => (
                        <article key={reservation.id} className="timeline-card history-reservation-card">
                          <div className="result-header">
                            <h3>
                              {reservation.first_name} {reservation.last_name}
                            </h3>
                            <div className="button-row schedule-card-actions">
                              <span
                                className={`status-badge ${getReservationStatusClass(reservation.status)}`}
                              >
                                {formatReservationStatus(reservation.status)}
                              </span>
                              <CardActionMenu
                                menuId={`customer-search-${reservation.id}`}
                                openMenuId={openCardActionMenuId}
                                onToggle={toggleCardActionMenu}
                                onClose={closeCardActionMenu}
                                actions={[
                                  {
                                    label: "View booking",
                                    onClick: () => openScheduleReservation(reservation)
                                  },
                                  {
                                    label: "Edit payment info",
                                    onClick: () =>
                                      openScheduleReservation(reservation, {
                                        openPaymentEditor: true
                                      })
                                  }
                                ].concat(buildReservationEditActions(reservation.id))}
                              />
                            </div>
                          </div>
                          <p className="muted">
                            Booked {formatDisplayDate(reservation.booked_date)} •{" "}
                            {formatReservationTerm(reservation.reservation_term)} •{" "}
                            {reservation.rv_kind}
                            {formatMotorhomeDetails(reservation)}
                            {reservation.rig_length_feet
                              ? ` • ${reservation.rig_length_feet} ft rig`
                              : ""}
                            {` • Paid ${formatCurrency(reservation.amountPaid)} • Balance ${formatCurrency(reservation.remainingBalance)}`}
                          </p>
                          <ol className="timeline-list">
                            {reservation.siteStays.map((segment) => (
                              <li key={segment.id}>
                                <strong>Site {segment.site_number}</strong>:{" "}
                                {formatDisplayDate(segment.arrival_date)} to{" "}
                                {formatLeaveDate(segment.leave_date)}
                                {segment.numberOfNights ? ` • ${segment.numberOfNights} nights` : ""}
                              </li>
                            ))}
                          </ol>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="muted">No customer bookings match that search.</p>
                  )}
                </div>
              ) : null}

              <div className="schedule-dropdown-grid">
            <div className="schedule-dropdown">
              <button
                type="button"
                className="schedule-dropdown-trigger"
                onClick={() => setIsWholeScheduleOpen((current) => !current)}
              >
                <span>Whole schedule</span>
                <span className="muted">
                  {currentOccupancy.length} guests • {isWholeScheduleOpen ? "Hide" : "Show"}
                </span>
              </button>
              {isWholeScheduleOpen ? (
                <div className="schedule-dropdown-panel">
                  {currentOccupancy.length ? (
                    <div className="schedule-list">
                      {currentOccupancy.map((reservation) => (
                        <article key={reservation.id} className="timeline-card schedule-summary-card">
                          <div className="result-header">
                            <h3>
                              {reservation.first_name} {reservation.last_name}
                            </h3>
                            <div className="button-row schedule-card-actions">
                              <CardActionMenu
                                menuId={`whole-schedule-${reservation.id}`}
                                openMenuId={openCardActionMenuId}
                                onToggle={toggleCardActionMenu}
                                onClose={closeCardActionMenu}
                                actions={[
                                  ...(Number(reservation.remainingBalance || 0) > 0
                                    ? [
                                        {
                                          label: "Add payment",
                                          onClick: () => openScheduleReservation(reservation)
                                        }
                                      ]
                                    : []),
                                  {
                                    label: "View booking",
                                    onClick: () => openScheduleReservation(reservation)
                                  },
                                  {
                                    label: "Edit payment info",
                                    onClick: () =>
                                      openScheduleReservation(reservation, {
                                        openPaymentEditor: true
                                      })
                                  }
                                ].concat(buildReservationEditActions(reservation.id))}
                              />
                            </div>
                          </div>
                          <p className="muted">
                            {reservation.activeSiteStays.map((segment, index) => (
                              <span key={segment.id}>
                                {index > 0 ? ", " : ""}
                                <strong>Site {segment.site_number}</strong>
                              </span>
                            ))}{" "}
                            • Booked {formatDisplayDate(reservation.booked_date)} •{" "}
                            {reservation.rv_kind}
                            {formatMotorhomeDetails(reservation)}
                            {reservation.rig_length_feet
                              ? ` • ${reservation.rig_length_feet} ft rig`
                              : ""}
                            {` • Paid ${formatCurrency(reservation.amountPaid)} • Balance ${formatCurrency(reservation.remainingBalance)}`}
                          </p>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="muted">No guests are currently in a site today.</p>
                  )}
                </div>
              ) : null}
            </div>

                <div className="schedule-dropdown">
                  <button
                    type="button"
                    className="schedule-dropdown-trigger"
                    onClick={() => setIsArrivalsTodayOpen((current) => !current)}
                  >
                    <span>
                      {selectedArrivalDate === today
                        ? "Who's coming in today"
                        : `Who's coming in ${formatDisplayDate(selectedArrivalDate)}`}
                    </span>
                    <span className="muted">
                      {arrivalsOnSelectedDate.length} arrivals • {isArrivalsTodayOpen ? "Hide" : "Show"}
                    </span>
                  </button>
                  {isArrivalsTodayOpen ? (
                    <div className="schedule-dropdown-panel">
                      {arrivalsOnSelectedDate.length ? (
                        <div className="schedule-list">
                          {arrivalsOnSelectedDate.map((reservation) => (
                            <article key={reservation.id} className="timeline-card schedule-summary-card">
                              <div className="result-header">
                                <h3>
                                  {reservation.first_name} {reservation.last_name}
                                </h3>
                                <div className="button-row schedule-card-actions">
                                  <CardActionMenu
                                    menuId={`arrivals-${reservation.id}`}
                                    openMenuId={openCardActionMenuId}
                                    onToggle={toggleCardActionMenu}
                                    onClose={closeCardActionMenu}
                                    actions={[
                                      ...(Number(reservation.remainingBalance || 0) > 0
                                        ? [
                                            {
                                              label: "Add payment",
                                              onClick: () => openScheduleReservation(reservation)
                                            },
                                            {
                                              label: "Mark paid",
                                              onClick: () => markReservationPaid(reservation)
                                            }
                                          ]
                                        : []),
                                      {
                                        label: "Open text",
                                        onClick: () =>
                                          openArrivalTextMessage(reservation, selectedArrivalDate)
                                      },
                                      {
                                        label: "View booking",
                                        onClick: () => openScheduleReservation(reservation)
                                      },
                                      {
                                        label: "Edit payment info",
                                        onClick: () =>
                                          openScheduleReservation(reservation, {
                                            openPaymentEditor: true
                                          })
                                      }
                                    ].concat(buildReservationEditActions(reservation.id))}
                                  />
                                </div>
                              </div>
                              <p className="muted">
                                {reservation.arrivingSiteStays.map((segment, index) => (
                                  <span key={segment.id}>
                                    {index > 0 ? ", " : ""}
                                    <strong>Site {segment.site_number}</strong>
                                  </span>
                                ))}{" "}
                                • Arriving {formatDisplayDate(selectedArrivalDate)} • {reservation.rv_kind}
                                {formatMotorhomeDetails(reservation)}
                                {reservation.rig_length_feet
                                  ? ` • ${reservation.rig_length_feet} ft rig`
                                  : ""}
                                {` • Paid ${formatCurrency(reservation.amountPaid)} • Balance ${formatCurrency(reservation.remainingBalance)}`}
                              </p>
                            </article>
                          ))}
                        </div>
                      ) : (
                        <p className="muted">
                          No guests are arriving {selectedArrivalDate === today ? "today" : formatDisplayDate(selectedArrivalDate)}.
                        </p>
                      )}
                    </div>
                  ) : null}
            </div>
              </div>

              <div className="timeline-controls">
            <label>
              Search site
              <input
                placeholder="Type a site number"
                value={timelineSiteSearch}
                onChange={(event) => setTimelineSiteSearch(event.target.value)}
              />
            </label>
            <label>
              Site
              <select
                value={timelineSiteId}
                onChange={(event) => setTimelineSiteId(event.target.value)}
                disabled={!timelineSiteOptions.length}
              >
                {timelineSiteOptions.length ? (
                  timelineSiteOptions.map((site) => (
                    <option key={site.id} value={site.id}>
                      Site {site.site_number}
                    </option>
                  ))
                ) : (
                  <option value="">No matching sites</option>
                )}
              </select>
            </label>
              </div>

              <SiteTimelineCalendar
                monthCursor={timelineMonthCursor}
                selectedStartDate={selectedTimelineDate}
                selectedEndDate={addDays(selectedTimelineDate, 1)}
                bookedRanges={selectedSiteBookedRanges}
                onChangeMonth={changeTimelineMonth}
                onSelectDate={(dateString) => {
                  setSelectedTimelineDate(dateString);
                  setTimelineMonthCursor(startOfMonth(dateString));
                }}
              />

              <div className="timeline-card">
                <h3>
                  {selectedTimelineSite
                    ? `Site ${selectedTimelineSite.site_number} booking details`
                    : "Site booking details"}
                </h3>
                <p className="muted">{formatDisplayDate(selectedTimelineDate)}</p>
                {selectedDateReservations.length ? (
                  <div className="schedule-list">
                    {selectedDateReservations.map((entry, index) => (
                      <article
                        key={`${entry.reservationId}-${entry.segment.id}-${index}`}
                        className="timeline-entry-card"
                      >
                        <div className="result-header">
                          <h4>
                            {entry.customerName}
                          </h4>
                          <div className="button-row schedule-card-actions">
                            <CardActionMenu
                              menuId={`timeline-${entry.reservationId}-${entry.segment.id}`}
                              openMenuId={openCardActionMenuId}
                              onToggle={toggleCardActionMenu}
                              onClose={closeCardActionMenu}
                              actions={[
                                {
                                  label: "View booking",
                                  onClick: () => openScheduleReservation(entry.reservation)
                                },
                                {
                                  label: "Edit payment info",
                                  onClick: () =>
                                    openScheduleReservation(entry.reservation, {
                                      openPaymentEditor: true
                                    })
                                }
                              ].concat(buildReservationEditActions(entry.reservationId))}
                            />
                          </div>
                        </div>
                        <p className="muted">
                          {formatDisplayDate(entry.segment.arrival_date)} to{" "}
                          {formatLeaveDate(entry.segment.leave_date)} • {entry.rvKind}
                          {entry.rigLengthFeet ? ` • ${entry.rigLengthFeet} ft rig` : ""}
                        </p>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="muted">No booking is assigned to this site on the selected date.</p>
                )}
              </div>
            </>
          ) : null}
        </section>

        <section className="card">
          <div className="section-toggle-row">
            <h2>Reservation History</h2>
            <div className="section-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => clearSection("history")}
              >
                Clear section
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => toggleSection("history")}
              >
                {openSections.history ? "Hide history" : "Open history"}
              </button>
            </div>
          </div>
          {openSections.history ? (
            <>
              <div className="section-heading">
                <p>Browse reservations by booked date, then open a day to review and edit bookings.</p>
              </div>

              <BookingHistoryCalendar
                monthCursor={historyMonthCursor}
                selectedDate={selectedHistoryDate}
                reservationsByDate={reservationsByBookedDate}
                onChangeMonth={changeHistoryMonth}
                onSelectDate={(dateString) => {
                  setSelectedHistoryDate(dateString);
                  setHistoryMonthCursor(startOfMonth(dateString));
                }}
              />

              <div className="timeline-card">
                <h3>Booked on {formatDisplayDate(selectedHistoryDate)}</h3>
                {selectedHistoryReservations.length ? (
                  <div className="schedule-list">
                    {selectedHistoryReservations.map((reservation) => (
                      <article key={reservation.id} className="timeline-card history-reservation-card">
                        <div className="result-header">
                          <h3>
                            {reservation.first_name} {reservation.last_name}
                          </h3>
                          <div className="button-row schedule-card-actions">
                            <span
                              className={`status-badge ${getReservationStatusClass(reservation.status)}`}
                            >
                              {formatReservationStatus(reservation.status)}
                            </span>
                            <CardActionMenu
                              menuId={`history-${reservation.id}`}
                              openMenuId={openCardActionMenuId}
                              onToggle={toggleCardActionMenu}
                              onClose={closeCardActionMenu}
                              actions={[
                                {
                                  label: "Open in Gmail",
                                  onClick: () => openReservationConfirmationInGmail(reservation)
                                },
                                {
                                  label: "View booking",
                                  onClick: () => openScheduleReservation(reservation)
                                },
                                {
                                  label: "Edit payment info",
                                  onClick: () =>
                                    openScheduleReservation(reservation, {
                                      openPaymentEditor: true
                                    })
                                }
                              ].concat(buildReservationEditActions(reservation.id))}
                            />
                          </div>
                        </div>
                        <p className="muted">
                          {reservation.rv_kind}
                          {formatMotorhomeDetails(reservation)}
                          {reservation.rig_length_feet
                            ? ` • ${reservation.rig_length_feet} ft rig`
                            : ""}{" "}
                          • {formatReservationTerm(reservation.reservation_term)} • Amount paid{" "}
                          {formatCurrency(reservation.amountPaid)}
                        </p>
                        <div className="pricing-summary">
                          <span>Deposit amount: {formatCurrency(reservation.depositAmount)}</span>
                          <span>Manual total: {formatCurrency(reservation.totalPrice)}</span>
                          <span>Remaining balance: {formatCurrency(reservation.remainingBalance)}</span>
                        </div>
                        <ol className="timeline-list">
                          {reservation.siteStays.map((segment) => (
                            <li key={segment.id}>
                              Site {segment.site_number}: {formatDisplayDate(segment.arrival_date)} to{" "}
                              {formatLeaveDate(segment.leave_date)}
                              {segment.numberOfNights ? ` • ${segment.numberOfNights} nights` : ""}
                            </li>
                          ))}
                        </ol>
                        {reservation.status === "canceled" && reservation.canceled_at ? (
                          <p className="muted">
                            Canceled {new Date(reservation.canceled_at).toLocaleString()}
                          </p>
                        ) : null}
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="muted">No reservations were booked on this day.</p>
                )}
              </div>
            </>
          ) : null}
        </section>

        <section className="card">
          <div className="section-toggle-row">
            <h2>Yearly Bookings</h2>
            <div className="section-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => clearSection("yearly")}
              >
                Clear section
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => toggleSection("yearly")}
              >
                {openSections.yearly ? "Hide yearly bookings" : "Open yearly bookings"}
              </button>
            </div>
          </div>
          {openSections.yearly ? (
            <>
              <div className="section-heading">
                <p>Manage open-ended yearly guests with quick booking, edit, and cancel actions.</p>
              </div>
              {yearlyReservations.length ? (
                <div className="schedule-list">
                  {yearlyReservations.map((reservation) => (
                    <article key={reservation.id} className="timeline-card history-reservation-card">
                      <div className="result-header">
                        <h3>
                          {reservation.first_name} {reservation.last_name}
                        </h3>
                        <div className="button-row schedule-card-actions">
                          <CardActionMenu
                            menuId={`yearly-${reservation.id}`}
                            openMenuId={openCardActionMenuId}
                            onToggle={toggleCardActionMenu}
                            onClose={closeCardActionMenu}
                            actions={[
                              {
                                label: "View booking",
                                onClick: () => openScheduleReservation(reservation)
                              },
                              {
                                label: "Edit payment info",
                                onClick: () =>
                                  openScheduleReservation(reservation, {
                                    openPaymentEditor: true
                                  })
                              },
                              ...buildReservationEditActions(reservation.id),
                              {
                                label: "Cancel",
                                onClick: () => cancelReservation(reservation.id),
                                danger: true
                              }
                            ]}
                          />
                        </div>
                      </div>
                      <p className="muted">
                        Site {reservation.siteStays[0]?.site_number || "Not set"} • Starts{" "}
                        {reservation.siteStays[0]?.arrival_date
                          ? formatDisplayDate(reservation.siteStays[0].arrival_date)
                          : "Not set"}{" "}
                        • {reservation.rv_kind}
                        {formatMotorhomeDetails(reservation)}
                        {reservation.rig_length_feet
                          ? ` • ${reservation.rig_length_feet} ft rig`
                          : ""}
                      </p>
                      <div className="pricing-summary">
                        <span>Email: {reservation.email || "Not set"}</span>
                        <span>
                          Phone:{" "}
                          {formatPhoneNumber(reservation.phone_number || "") || "Not set"}
                        </span>
                        <span>Manual total: {formatCurrency(reservation.totalPrice)}</span>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="muted">No active yearly bookings.</p>
              )}
            </>
          ) : null}
        </section>

        <section className="card">
          <div className="section-toggle-row">
            <h2>RV Sites</h2>
            <div className="section-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => clearSection("sites")}
              >
                Clear section
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => toggleSection("sites")}
              >
                {openSections.sites ? "Hide site list" : "Open site list"}
              </button>
            </div>
          </div>
          {openSections.sites ? (
            <>
              <div className="section-heading">
                <p>Current site inventory with size and riverfront details.</p>
              </div>
              <div className="site-filter-bar">
                <label>
                  Site lookup
                  <input
                    placeholder="Type a site number or letter"
                    value={siteFilters.siteLookup}
                    onChange={(event) => updateSiteFilter("siteLookup", event.target.value)}
                  />
                </label>
                <label>
                  Site types
                  <div className="type-dropdown">
                    <button
                      type="button"
                      className="type-dropdown-trigger"
                      onClick={() => setIsTypeMenuOpen((current) => !current)}
                    >
                      {siteFilters.types.length === siteTypeOptions.length
                        ? "All site types"
                        : `${siteFilters.types.length} selected`}
                    </button>
                    {isTypeMenuOpen ? (
                      <div className="type-dropdown-menu">
                        {siteTypeOptions.map((option) => (
                          <label key={option.value} className="type-dropdown-option">
                            <input
                              type="checkbox"
                              checked={siteFilters.types.includes(option.value)}
                              onChange={() => toggleSiteTypeFilter(option.value)}
                            />
                            <span>{option.label}</span>
                          </label>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <span className="muted small-text">
                    {siteFilters.types.length
                      ? `${siteFilters.types.length} type filters active`
                      : "No type filters selected"}
                  </span>
                </label>
                <label>
                  Min size
                  <input
                    type="number"
                    min="1"
                    placeholder="Any"
                    value={siteFilters.minSizeFeet}
                    onChange={(event) => updateSiteFilter("minSizeFeet", event.target.value)}
                  />
                </label>
                <label>
                  Max size
                  <input
                    type="number"
                    min="1"
                    placeholder="Any"
                    value={siteFilters.maxSizeFeet}
                    onChange={(event) => updateSiteFilter("maxSizeFeet", event.target.value)}
                  />
                </label>
              </div>
              <div className="site-grid">
                {visibleSites.map((site) => (
                  <article
                    key={site.id}
                    className={`site-tile ${site.is_on_river ? "river" : ""} ${
                      openSitePricing[site.id] ? "expanded" : ""
                    }`}
                  >
                    <h3>Site {site.site_number}</h3>
                    <p>{site.size_feet} feet</p>
                    <p>{getSiteTypeLabel(site)}</p>
                    <p>River category: {formatPricingCategory(site.river_category)}</p>
                    <p>Big rig: {site.is_big_rig ? "Yes" : "No"}</p>
                    <p>Pricing category: {formatPricingCategory(site.pricing_category)}</p>
                    <button
                      type="button"
                      className="ghost-button site-price-button"
                      onClick={() => toggleSitePricing(site.id)}
                    >
                      {openSitePricing[site.id] ? "Hide prices" : "Prices"}
                    </button>
                    {openSitePricing[site.id] ? (
                      <>
                        <div className="day-chip-row">
                          {site.pricing_rules.map((rule) => (
                            <button
                              key={rule.numberOfDays}
                              type="button"
                              className={`day-chip ${
                                openSitePricing[site.id].includes(rule.numberOfDays) ? "active" : ""
                              }`}
                              onClick={() => toggleSitePricingDay(site.id, rule.numberOfDays)}
                            >
                              {rule.numberOfDays} day{rule.numberOfDays === 1 ? "" : "s"}
                            </button>
                          ))}
                        </div>
                        <div className="pricing-table">
                          {openSitePricing[site.id].length ? (
                            site.pricing_rules
                              .filter((rule) => openSitePricing[site.id].includes(rule.numberOfDays))
                              .map((rule) => (
                                <div key={rule.numberOfDays} className="pricing-row">
                                  <span>{rule.numberOfDays} nights</span>
                                  <span>Normal {formatCurrency(rule.normalPrice)}</span>
                                  <span>Discount {formatCurrency(rule.discountPrice)}</span>
                                </div>
                              ))
                          ) : (
                            <p className="muted">Select one or more day counts to view pricing.</p>
                          )}
                        </div>
                      </>
                    ) : null}
                    <span>{site.is_on_river ? "Riverfront" : "Standard"}</span>
                  </article>
                ))}
              </div>
              {!visibleSites.length ? (
                <p className="muted">No sites match the current filters.</p>
              ) : null}
            </>
          ) : null}
        </section>

        {reservationEditor ? (
          <div
            className="modal-backdrop"
            role="presentation"
            onClick={closeReservationEditor}
          >
            <div
              className="modal-card"
              role="dialog"
              aria-modal="true"
              aria-labelledby="reservation-editor-modal-title"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="result-header">
                <div>
                  <h3 id="reservation-editor-modal-title">
                    Edit {reservationEditFocusLabel || "reservation"}
                  </h3>
                  <p className="muted">
                    Reservation #{reservationEditor.id} • {reservationEditor.customer.firstName}{" "}
                    {reservationEditor.customer.lastName}
                  </p>
                </div>
                <div className="button-row schedule-card-actions">
                  <button type="button" className="ghost-button" onClick={closeReservationEditor}>
                    Close
                  </button>
                </div>
              </div>
              {reservationEditor.focusSection === "customer" ? (
                <div className="field-grid">
                  <label>
                    First name
                    <input
                      value={reservationEditor.customer.firstName}
                      onChange={(event) =>
                        updateReservationEditorCustomerField("firstName", event.target.value)
                      }
                    />
                  </label>
                  <label>
                    Last name
                    <input
                      value={reservationEditor.customer.lastName}
                      onChange={(event) =>
                        updateReservationEditorCustomerField("lastName", event.target.value)
                      }
                    />
                  </label>
                  <label>
                    Email
                    <input
                      type="email"
                      value={reservationEditor.customer.email}
                      onChange={(event) =>
                        updateReservationEditorCustomerField("email", event.target.value)
                      }
                    />
                  </label>
                  <label>
                    Phone
                    <input
                      type="tel"
                      inputMode="numeric"
                      value={reservationEditor.customer.phoneNumber}
                      onChange={(event) =>
                        updateReservationEditorCustomerField(
                          "phoneNumber",
                          formatPhoneNumber(event.target.value)
                        )
                      }
                    />
                  </label>
                </div>
              ) : null}
              {reservationEditor.focusSection === "rig" ? (
                <div className="field-grid">
                  <label>
                    RV kind
                    <select
                      value={reservationEditor.reservation.rvKind}
                      onChange={(event) =>
                        updateReservationEditorField("rvKind", event.target.value)
                      }
                    >
                      {rvKinds.map((kind) => (
                        <option key={kind} value={kind}>
                          {kind}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Rig size (feet)
                    <input
                      type="number"
                      min="1"
                      value={reservationEditor.reservation.rigLengthFeet}
                      onChange={(event) =>
                        updateReservationEditorField("rigLengthFeet", event.target.value)
                      }
                    />
                  </label>
                  {reservationEditor.reservation.rvKind === "motor home" ? (
                    <div className="motorhome-options notes-field">
                      <span className="small-text">Motor home details</span>
                      <label className="checkbox-row compact-checkbox">
                        <input
                          type="checkbox"
                          checked={reservationEditor.reservation.motorhomeClassA}
                          onChange={(event) =>
                            updateReservationEditorField("motorhomeClassA", event.target.checked)
                          }
                        />
                        Class A
                      </label>
                      <label className="checkbox-row compact-checkbox">
                        <input
                          type="checkbox"
                          checked={reservationEditor.reservation.motorhomeClassC}
                          onChange={(event) =>
                            updateReservationEditorField("motorhomeClassC", event.target.checked)
                          }
                        />
                        Class C
                      </label>
                      <label className="checkbox-row compact-checkbox">
                        <input
                          type="checkbox"
                          checked={reservationEditor.reservation.motorhomeWithTow}
                          onChange={(event) =>
                            updateReservationEditorField("motorhomeWithTow", event.target.checked)
                          }
                        />
                        With tow
                      </label>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {reservationEditor.focusSection === "notes" ? (
                <label className="notes-field">
                  Notes
                  <textarea
                    rows="8"
                    value={reservationEditor.reservation.notes}
                    onChange={(event) =>
                      updateReservationEditorField("notes", event.target.value)
                    }
                  />
                </label>
              ) : null}
              {reservationEditor.focusSection === "dates" ? (
                <>
                  <div className="field-grid">
                    <label>
                      Booked date
                      <input
                        type="date"
                        value={reservationEditor.reservation.bookedDate}
                        onChange={(event) =>
                          updateReservationEditorField("bookedDate", event.target.value)
                        }
                      />
                    </label>
                    <label>
                      Booking status
                      <select
                        value={reservationEditor.reservation.status}
                        onChange={(event) =>
                          updateReservationEditorField("status", event.target.value)
                        }
                      >
                        <option value="active">Active</option>
                        <option value="pending">Pending</option>
                        <option value="canceled">Canceled</option>
                      </select>
                    </label>
                    <label>
                      Reservation term
                      <select
                        value={reservationEditor.reservation.reservationTerm}
                        onChange={(event) =>
                          updateReservationEditorField("reservationTerm", event.target.value)
                        }
                      >
                        <option value="standard">Standard</option>
                        <option value="yearly">Yearly</option>
                      </select>
                    </label>
                  </div>
                  <div className="segment-list">
                    {reservationEditor.reservation.siteStays.map((segment, index) => (
                      <SiteStayFields
                        key={`${reservationEditor.id}-${index}`}
                        segment={segment}
                        index={index}
                        sites={sites}
                        bookedRangesBySite={bookedRangesBySite}
                        reservationTerm={reservationEditor.reservation.reservationTerm}
                        onChange={updateReservationEditorSiteStay}
                        onRemove={removeReservationEditorSiteStay}
                        canRemove={
                          reservationEditor.reservation.reservationTerm !== "yearly" &&
                          reservationEditor.reservation.siteStays.length > 1
                        }
                      />
                    ))}
                    {reservationEditor.reservation.reservationTerm !== "yearly" ? (
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={addReservationEditorSiteStay}
                      >
                        Add stay segment
                      </button>
                    ) : null}
                  </div>
                </>
              ) : null}
              <div className="button-row">
                <button type="button" className="ghost-button" onClick={closeReservationEditor}>
                  Cancel
                </button>
                <button type="button" className="primary-button" onClick={saveReservationEditor}>
                  Save changes
                </button>
              </div>
              {reservationEditorErrorMessage ? (
                <div className="message error">{reservationEditorErrorMessage}</div>
              ) : null}
              {reservationEditorSuccessMessage ? (
                <div className="message success">{reservationEditorSuccessMessage}</div>
              ) : null}
            </div>
          </div>
        ) : null}

        {activeScheduleReservation ? (
          <div
            className="modal-backdrop"
            role="presentation"
            onClick={() => setActiveScheduleReservation(null)}
          >
            <div
              className="modal-card"
              role="dialog"
              aria-modal="true"
              aria-labelledby="today-schedule-modal-title"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="result-header">
                <h3 id="today-schedule-modal-title">
                  {activeScheduleReservation.first_name} {activeScheduleReservation.last_name}
                </h3>
                <div className="button-row schedule-card-actions">
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => setIsEditingSchedulePaymentInfo((current) => !current)}
                  >
                    {isEditingSchedulePaymentInfo ? "Hide payment info" : "Edit payment info"}
                  </button>
                  <button
                    type="button"
                    className="ghost-button danger-button"
                    onClick={() => deleteReservation(activeScheduleReservation)}
                  >
                    Delete reservation
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => setActiveScheduleReservation(null)}
                  >
                    Close
                  </button>
                </div>
              </div>
              <p className="muted">
                Booked {formatDisplayDate(activeScheduleReservation.booked_date)} •{" "}
                {formatReservationTerm(activeScheduleReservation.reservation_term)} •{" "}
                {activeScheduleReservation.rv_kind}
                {formatMotorhomeDetails(activeScheduleReservation)}
                {activeScheduleReservation.rig_length_feet
                  ? ` • ${activeScheduleReservation.rig_length_feet} ft rig`
                  : ""}
              </p>
              <div className="pricing-summary">
                <span>Email: {activeScheduleReservation.email || "Not set"}</span>
                <span>
                  Phone:{" "}
                  {formatPhoneNumber(activeScheduleReservation.phone_number || "") || "Not set"}
                </span>
                <span>
                  Rig size:{" "}
                  {activeScheduleReservation.rig_length_feet
                    ? `${activeScheduleReservation.rig_length_feet} ft`
                    : "Not set"}
                </span>
              </div>
              <div className="pricing-summary">
                <span>Deposit amount: {formatCurrency(activeScheduleReservation.depositAmount)}</span>
                <span>
                  Manual total: {formatCurrency(activeScheduleReservation.totalPrice)}
                </span>
                <span>
                  Remaining balance: {formatCurrency(activeScheduleReservation.remainingBalance)}
                </span>
              </div>
              <ol className="timeline-list">
                {(
                  activeScheduleReservation.activeSiteStays ||
                  activeScheduleReservation.arrivingSiteStays ||
                  activeScheduleReservation.siteStays ||
                  []
                ).map((segment) => (
                  <li key={segment.id}>
                    <strong>Site {segment.site_number}</strong>: arrival {formatDisplayDate(
                      segment.arrival_date
                    )} • leave {formatLeaveDate(segment.leave_date)}
                    {segment.numberOfNights ? ` • ${segment.numberOfNights} nights` : " • Yearly stay"}
                  </li>
                ))}
              </ol>
              <div className="pricing-summary">
                <span>Deposit amount: {formatCurrency(activeScheduleReservation.depositAmount)}</span>
                <span>Manual total: {formatCurrency(activeScheduleReservation.totalPrice)}</span>
                <span>Amount paid: {formatCurrency(activeScheduleReservation.amountPaid)}</span>
                <span>Remaining balance: {formatCurrency(activeScheduleReservation.remainingBalance)}</span>
              </div>
              {activeScheduleReservation.paymentEvents?.length ? (
                <div className="timeline-card payment-history-card">
                  <h3>Payment history</h3>
                  <ul className="timeline-list">
                    {activeScheduleReservation.paymentEvents.map((paymentEvent) => (
                      <li key={paymentEvent.id}>
                        {formatPaymentSource(paymentEvent.paymentSource)} •{" "}
                        {formatCurrency(paymentEvent.amount)} •{" "}
                        {new Date(paymentEvent.recordedAt).toLocaleString()}
                        {paymentEvent.note ? ` • ${paymentEvent.note}` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {isEditingSchedulePaymentInfo ? (
                <div className="payment-panel">
                  <div className="result-header">
                    <h3>Edit payment info</h3>
                    <span className="balance-pill">
                      Balance {formatCurrency(activeScheduleReservation.remainingBalance)}
                    </span>
                  </div>
                  <div className="field-grid compact-grid">
                    <label>
                      Deposit amount
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={schedulePaymentForm.depositAmount}
                        onChange={(event) =>
                          updateSchedulePaymentField("depositAmount", event.target.value)
                        }
                        onWheel={(event) => event.currentTarget.blur()}
                      />
                    </label>
                    <label>
                      Manual total
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={schedulePaymentForm.totalPrice}
                        onChange={(event) =>
                          updateSchedulePaymentField("totalPrice", event.target.value)
                        }
                        onWheel={(event) => event.currentTarget.blur()}
                      />
                    </label>
                    <label>
                      Amount paid
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={schedulePaymentForm.amountPaid}
                        onChange={(event) =>
                          updateSchedulePaymentField("amountPaid", event.target.value)
                        }
                        onWheel={(event) => event.currentTarget.blur()}
                      />
                    </label>
                    <label>
                      Office payment amount
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={activeSchedulePaymentAmount}
                        onChange={(event) => setActiveSchedulePaymentAmount(event.target.value)}
                        onWheel={(event) => event.currentTarget.blur()}
                      />
                    </label>
                  </div>
                  <div className="button-row">
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => {
                        setSchedulePaymentForm(createSchedulePaymentForm(activeScheduleReservation));
                        setSchedulePaymentErrorMessage("");
                        setSchedulePaymentSuccessMessage("");
                        setIsEditingSchedulePaymentInfo(false);
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => recordOfficePayment(activeScheduleReservation)}
                    >
                      Record office payment
                    </button>
                    <button
                      type="button"
                      className="primary-button"
                      onClick={saveSchedulePaymentInfo}
                    >
                      Save payment info
                    </button>
                  </div>
                  {schedulePaymentErrorMessage ? (
                    <div className="message error">{schedulePaymentErrorMessage}</div>
                  ) : null}
                  {schedulePaymentSuccessMessage ? (
                    <div className="message success">{schedulePaymentSuccessMessage}</div>
                  ) : null}
                </div>
              ) : null}
              {activeScheduleReservation.status !== "canceled" ? (
                <div className="payment-panel">
                  <div className="result-header">
                    <h3>Collect card payment</h3>
                    <span className="balance-pill">
                      Balance {formatCurrency(activeScheduleReservation.remainingBalance)}
                    </span>
                  </div>
                  <div className="payment-grid">
                    <label>
                      Payment amount
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={activeSchedulePaymentAmount}
                        onChange={(event) => setActiveSchedulePaymentAmount(event.target.value)}
                        onWheel={(event) => event.currentTarget.blur()}
                      />
                    </label>
                    <div className="pricing-summary">
                      <span>Office payment: use this amount box, then record it below.</span>
                      <span>Status: {formatReservationStatus(activeScheduleReservation.status)}</span>
                      <span>Amount paid: {formatCurrency(activeScheduleReservation.amountPaid)}</span>
                      <span>
                        Remaining balance: {formatCurrency(activeScheduleReservation.remainingBalance)}
                      </span>
                    </div>
                  </div>
                  <div className="button-row">
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => recordOfficePayment(activeScheduleReservation)}
                    >
                      Record office payment
                    </button>
                    {Number(activeScheduleReservation.remainingBalance || 0) > 0 ? (
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => markReservationPaid(activeScheduleReservation)}
                      >
                        Mark fully paid
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() => handleSchedulePaymentLink(activeScheduleReservation)}
                    >
                      Pull up card info
                    </button>
                  </div>
                  {paymentLinkErrorMessage ? (
                    <div className="message error">{paymentLinkErrorMessage}</div>
                  ) : null}
                  {paymentLinkSuccessMessage && hasScheduleCardPayment ? (
                    <div className="message success">{paymentLinkSuccessMessage}</div>
                  ) : null}
                  {hasScheduleCardPayment ? (
                    <Elements stripe={getStripePromise()}>
                      <CardPaymentForm
                        amountLabel={formatCurrency(scheduleCardPayment.amount)}
                        clientSecret={scheduleCardPayment.clientSecret}
                        reservation={activeScheduleReservation}
                        onCancel={() => setScheduleCardPayment(null)}
                        onSuccess={async () => {
                          const refreshedReservation = await finalizeCardPayment(
                            activeScheduleReservation.id
                          );
                          setScheduleCardPayment(null);
                          setPaymentLinkSuccessMessage(
                            `Card payment completed for reservation #${refreshedReservation.id}.`
                          );
                        }}
                      />
                    </Elements>
                  ) : null}
                </div>
              ) : null}
              {activeScheduleReservation.notes ? (
                <p className="muted">Notes: {activeScheduleReservation.notes}</p>
              ) : null}
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
}
