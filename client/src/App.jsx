import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Alert,
  Box,
  Button,
  Container,
  Paper,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import {
  CardElement,
  Elements,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { loadStripe } from "@stripe/stripe-js";

const apiBaseUrl = (
  import.meta.env.VITE_API_BASE_URL ||
  "https://api.riverparkrvresort.com/api"
).replace(/\/+$/, "");
const stripePublishableKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || "";
const lastBookedSiteStorageKey = "rvpark-last-booked-site";
const guestAccessTokenStorageKey = "rvpark-guest-access-token";
const adminClientId =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `admin-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const openEndedStayDate = "9999-12-31";
const cardElementOptions = {
  style: {
    base: {
      color: "#274032",
      "::placeholder": {
        color: "#7b8577",
      },
    },
    invalid: {
      color: "#9a2c2c",
    },
  },
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
      shouldBypassPasscode: false,
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
    shouldBypassPasscode: paymentStatus === "success" && Boolean(sessionId),
  };
}

const emptySearch = {
  searchMode: "exact",
  arrivalDate: "",
  leaveDate: "",
  flexibleStartDate: "",
  flexibleEndDate: "",
  stayLengthRange: "3-5",
  minSizeFeet: "",
  rigLengthFeet: "",
  rigOverTenYears: false,
  rvKind: "",
  motorhomeClassA: false,
  motorhomeClassC: false,
  motorhomeWithTow: false,
  towVehicleLengthFeet: "",
  towVehicleType: "",
  slideDriverSide: false,
  slidePassengerSide: false,
  riverfrontOnly: false,
};

const emptyCustomer = {
  firstName: "",
  lastName: "",
  email: "",
  phoneNumber: "",
};

function createEmptySiteStay(defaultSite = null) {
  return {
    siteId: defaultSite?.siteId || "",
    siteSearch: defaultSite?.siteSearch || "",
    arrivalDate: "",
    leaveDate: "",
  };
}

function createEmptyReservation(defaultSite = null) {
  return {
    customerId: "",
    bookedDate: formatDateInput(new Date()),
    status: "active",
    reservationTerm: "standard",
    billingMode: "manual_total",
    discounts: [],
    paymentMethod: "bank",
    depositAmount: "",
    totalPrice: "",
    monthlyRentPrice: "",
    electricMeterReading: "",
    rvKind: "camper",
    motorhomeClassA: false,
    motorhomeClassC: false,
    motorhomeWithTow: false,
    slideDriverSide: false,
    slidePassengerSide: false,
    rigLengthFeet: "",
    amountPaid: "",
    notes: "",
    siteStays: [createEmptySiteStay(defaultSite)],
  };
}

function createSchedulePaymentForm(reservation = null) {
  const displayedTotalPrice =
    reservation?.billing_mode === "manual_total"
      ? reservation?.totalPrice
      : reservation?.effectiveTotalPrice ?? reservation?.totalPrice;

  return {
    depositAmount:
      reservation?.depositAmount !== null &&
      reservation?.depositAmount !== undefined
        ? String(reservation.depositAmount)
        : "",
    totalPrice:
      displayedTotalPrice !== null && displayedTotalPrice !== undefined
        ? String(displayedTotalPrice)
        : "",
    amountPaid:
      reservation?.amountPaid !== null && reservation?.amountPaid !== undefined
        ? String(reservation.amountPaid)
        : "",
    discountQualified: Boolean(reservation?.requestedDiscounts?.length),
  };
}

function createReservationEditorState(reservation) {
  return {
    customer: {
      id: String(reservation.customer_id || ""),
      firstName: reservation.first_name || "",
      lastName: reservation.last_name || "",
      email: reservation.email || "",
      phoneNumber: formatPhoneNumber(reservation.phone_number || ""),
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
        reservation.depositAmount !== null &&
        reservation.depositAmount !== undefined
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
      slideDriverSide: Boolean(reservation.slide_driver_side),
      slidePassengerSide: Boolean(reservation.slide_passenger_side),
      rigLengthFeet: String(reservation.rig_length_feet ?? ""),
      notes: reservation.notes || "",
      siteStays: reservation.siteStays.map((segment) => ({
        siteId: String(segment.site_id),
        siteSearch: segment.site_number,
        arrivalDate: segment.arrival_date,
        leaveDate: isOpenEndedStay(segment.leave_date)
          ? ""
          : segment.leave_date,
      })),
    },
  };
}

function getReservationNotesSnippet(notes, maxLength = 120) {
  const normalized = String(notes || "")
    .replaceAll(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return "";
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength).trimEnd()}...`;
}

function CardActionMenu({ menuId, openMenuId, onToggle, onClose, actions }) {
  const isOpen = openMenuId === menuId;
  const inlineActions = actions.filter((action) => action.placement === "card");
  const menuActions = actions.filter((action) => action.placement !== "card");
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const [menuPosition, setMenuPosition] = useState(null);

  useLayoutEffect(() => {
    if (!isOpen || !triggerRef.current || !menuRef.current) {
      setMenuPosition(null);
      return undefined;
    }

    function updateMenuPosition() {
      if (!triggerRef.current || !menuRef.current) {
        return;
      }

      const viewportMargin = 12;
      const menuGap = 8;
      const triggerBounds = triggerRef.current.getBoundingClientRect();
      const menuBounds = menuRef.current.getBoundingClientRect();
      const menuHeight = Math.min(
        menuBounds.height,
        window.innerHeight - viewportMargin * 2
      );
      const availableBelow =
        window.innerHeight - triggerBounds.bottom - menuGap;
      const availableAbove = triggerBounds.top - menuGap;
      const opensUpward =
        availableBelow < menuHeight && availableAbove > availableBelow;
      const preferredTop = opensUpward
        ? triggerBounds.top - menuGap - menuHeight
        : triggerBounds.bottom + menuGap;
      const maxTop = Math.max(
        viewportMargin,
        window.innerHeight - menuHeight - viewportMargin
      );
      const maxLeft = Math.max(
        viewportMargin,
        window.innerWidth - menuBounds.width - viewportMargin
      );

      setMenuPosition({
        left: Math.min(
          Math.max(viewportMargin, triggerBounds.right - menuBounds.width),
          maxLeft
        ),
        top: Math.min(Math.max(viewportMargin, preferredTop), maxTop),
      });
    }

    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);

    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [isOpen, menuActions.length]);

  return (
    <>
      <div
        className="card-action-menu"
        onClick={(event) => event.stopPropagation()}>
        <button
          ref={triggerRef}
          type="button"
          className="ghost-button card-action-trigger"
          aria-haspopup="menu"
          aria-expanded={isOpen}
          onClick={() => onToggle(menuId)}>
          ...
        </button>
        {inlineActions.map((action) => (
          <button
            key={action.label}
            type="button"
            className="ghost-button card-inline-action"
            disabled={action.disabled}
            onClick={() => {
              onClose();
              action.onClick();
            }}>
            {action.label}
          </button>
        ))}
      </div>
      {isOpen && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={menuRef}
              className="card-action-dropdown card-action-dropdown-portal"
              role="menu"
              style={{
                left: menuPosition?.left ?? 0,
                top: menuPosition?.top ?? 0,
                visibility: menuPosition ? "visible" : "hidden",
              }}
              onClick={(event) => event.stopPropagation()}>
              {menuActions.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  role="menuitem"
                  className={`card-action-item ${
                    action.danger ? "danger" : ""
                  }`}
                  disabled={action.disabled}
                  onClick={() => {
                    onClose();
                    action.onClick();
                  }}>
                  {action.label}
                </button>
              ))}
            </div>,
            document.body
          )
        : null}
    </>
  );
}

const rvKinds = ["camper", "van", "5th wheel", "motor home", "trailer"];
const stayLengthOptions = [
  { value: "1-2", label: "1-2 days", minNights: 1, maxNights: 2 },
  { value: "3-5", label: "3-5 days", minNights: 3, maxNights: 5 },
  { value: "7-10", label: "7-10 days", minNights: 7, maxNights: 10 },
  { value: "14-21", label: "14-21 days", minNights: 14, maxNights: 21 },
];
const siteNumberCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});
const siteTypeOptions = [
  { value: "riverfront", label: "Riverfront" },
  { value: "standard", label: "Standard" },
  { value: "prime_river", label: "Prime river" },
  { value: "normal_river", label: "Non-prime river" },
  { value: "big_rig", label: "Big rig" },
  { value: "small_rig", label: "Small rig" },
];

const emptySiteFilters = {
  siteLookup: "",
  types: siteTypeOptions.map((option) => option.value),
  minSizeFeet: "",
  maxSizeFeet: "",
};

const riverCategoryOptions = [
  { value: "normal_river", label: "Non-prime river" },
  { value: "prime_river", label: "Prime river" },
];
const publicDiscountOptions = [
  "AAA",
  "US veteran",
  "Good Sam",
  "AARP",
  "Military",
  "Senior",
  "FMCA",
  "Passport America",
];

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

function getParkDateFromTimestamp(value) {
  if (!value) {
    return "";
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "America/Los_Angeles",
  }).formatToParts(new Date(value));
  const dateParts = Object.fromEntries(
    parts.map((part) => [part.type, part.value])
  );

  return `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
}

function getStayExtensionAvailability(reservation, reservations) {
  if (
    !reservation ||
    reservation.status === "canceled" ||
    reservation.reservation_term === "yearly"
  ) {
    return null;
  }

  const finalStay = [...(reservation.siteStays || [])]
    .filter((stay) => stay.leave_date && !isOpenEndedStay(stay.leave_date))
    .sort((left, right) =>
      `${left.leave_date}-${left.arrival_date}`.localeCompare(
        `${right.leave_date}-${right.arrival_date}`
      )
    )
    .at(-1);

  if (!finalStay) {
    return null;
  }

  const nextStay = reservations
    .filter(
      (entry) =>
        entry.id !== reservation.id && entry.status !== "canceled"
    )
    .flatMap((entry) => entry.siteStays || [])
    .filter(
      (stay) =>
        String(stay.site_id) === String(finalStay.site_id) &&
        stay.arrival_date >= finalStay.leave_date
    )
    .sort((left, right) => left.arrival_date.localeCompare(right.arrival_date))[0];

  return {
    finalStay,
    nextStay: nextStay || null,
    maximumDays: nextStay
      ? Math.max(nightsBetween(finalStay.leave_date, nextStay.arrival_date), 0)
      : null,
  };
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
    timeZone: "UTC",
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
    timeZone: "UTC",
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

function getStayLengthOption(value) {
  return (
    stayLengthOptions.find((option) => option.value === value) ||
    stayLengthOptions[1]
  );
}

function getSearchModeSummary(searchForm) {
  if (searchForm.searchMode === "flexible") {
    if (!searchForm.flexibleStartDate || !searchForm.flexibleEndDate) {
      return "";
    }

    return `Flexible window: ${formatDisplayDate(
      searchForm.flexibleStartDate
    )} through ${formatDisplayDate(searchForm.flexibleEndDate)} for ${
      getStayLengthOption(searchForm.stayLengthRange).label
    }.`;
  }

  if (!searchForm.arrivalDate) {
    return "";
  }

  return searchForm.leaveDate
    ? `Selected stay: ${formatDisplayDate(
        searchForm.arrivalDate
      )} through ${formatDisplayDate(searchForm.leaveDate)} (${nightsBetween(
        searchForm.arrivalDate,
        searchForm.leaveDate
      )} nights)`
    : `Arrival selected: ${formatDisplayDate(
        searchForm.arrivalDate
      )}. Pick a later day to finish the stay.`;
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
    currency: "USD",
  }).format(Number(value));
}

function getCardPrice(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const cardAmount = Number(value) * 1.03;
  return Math.round((Math.ceil(cardAmount - 0.99) + 0.99) * 100) / 100;
}

function getCardStayTotal(value, chargeableNights) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const nights = Number(chargeableNights);

  if (!Number.isFinite(nights) || nights <= 0) {
    return getCardPrice(value);
  }

  const nightlyBasePrice = Math.round((Number(value) / nights) * 100) / 100;
  const nightlyCardPrice = getCardPrice(nightlyBasePrice);
  return Math.round(nightlyCardPrice * nights * 100) / 100;
}

function formatSelectedPaymentMethod(value) {
  return value === "card" ? "Card" : "Bank / cash / check";
}

function roundUpToDollar99(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const amountInCents = Math.round(Number(value) * 100);

  if (!Number.isFinite(amountInCents)) {
    return null;
  }

  const wholeDollars = Math.floor(amountInCents / 100);
  const candidateInCents = wholeDollars * 100 + 99;

  return (candidateInCents >= amountInCents
    ? candidateInCents
    : candidateInCents + 100) / 100;
}

function BookingPriceComparison({
  title,
  bankPrice,
  cardPrice = getCardPrice(bankPrice),
  discountBankPrice = null,
  discountCardPrice = getCardPrice(discountBankPrice),
  perNight = false,
  numberOfNights = null,
  className = "",
}) {
  const displayPrice = (price) =>
    perNight ? getNightlyPrice(price, numberOfNights) : price;
  const displayedBankPrice = displayPrice(bankPrice);
  const displayedDiscountBankPrice = displayPrice(discountBankPrice);
  const displayedCardPrice = perNight
    ? getCardPrice(displayedBankPrice)
    : roundUpToDollar99(cardPrice);
  const displayedDiscountCardPrice = perNight
    ? getCardPrice(displayedDiscountBankPrice)
    : roundUpToDollar99(discountCardPrice);

  return (
    <div className={`booking-price-comparison ${className}`.trim()}>
      {title ? <p className="booking-price-title">{title}</p> : null}
      <div className="booking-price-options">
        <div className="booking-price-option bank-price-option">
          <span>Bank / cash / check</span>
          <strong>{formatCurrency(displayedBankPrice)}</strong>
          {discountBankPrice !== null && discountBankPrice !== undefined ? (
            <small>
              Eligible discount:{" "}
              {formatCurrency(displayedDiscountBankPrice)}
            </small>
          ) : null}
        </div>
        <div className="booking-price-option card-price-option">
          <span>Card</span>
          <strong>{formatCurrency(displayedCardPrice)}</strong>
          {discountCardPrice !== null && discountCardPrice !== undefined ? (
            <small>
              Eligible discount: {formatCurrency(displayedDiscountCardPrice)}
            </small>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function calculateChargeableNights(numberOfNights) {
  if (!Number.isFinite(numberOfNights) || numberOfNights <= 0 || numberOfNights > 28) {
    return null;
  }

  return numberOfNights - Math.floor(numberOfNights / 7);
}

function getNightlyPrice(totalPrice, numberOfNights) {
  const chargeableNights = calculateChargeableNights(Number(numberOfNights));

  if (
    totalPrice === null ||
    totalPrice === undefined ||
    chargeableNights === null
  ) {
    return null;
  }

  return Math.round((Number(totalPrice) / chargeableNights) * 100) / 100;
}

function getPublicBookingDeposit(totalPrice, numberOfNights) {
  const nightlyPrice = getNightlyPrice(totalPrice, numberOfNights);

  if (nightlyPrice === null) {
    return null;
  }

  const depositNights = Number(numberOfNights) > 7 ? 2 : 1;
  const depositAmount = Math.round(nightlyPrice * depositNights * 100) / 100;
  return Math.min(depositAmount, Number(totalPrice));
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
  return isOpenEndedStay(dateString)
    ? "Ongoing"
    : formatDisplayDate(dateString);
}

function formatPhoneNumber(value) {
  const rawDigits = String(value || "").replaceAll(/\D/g, "");
  const digits = (
    rawDigits.length === 11 && rawDigits.startsWith("1")
      ? rawDigits.slice(1)
      : rawDigits
  ).slice(0, 10);

  if (digits.length <= 3) {
    return digits.length ? `(${digits}` : "";
  }

  if (digits.length <= 6) {
    return `(${digits.slice(0, 3)})${digits.slice(3)}`;
  }

  return `(${digits.slice(0, 3)})${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function normalizePhoneForSms(value) {
  const digits = String(value || "").replaceAll(/\D/g, "");
  return (
    digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits
  ).slice(0, 10);
}

function formatTextMessageTimestamp(value) {
  if (!value) {
    return "Pending";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Pending" : date.toLocaleString();
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
  return String(value || "")
    .trim()
    .toLowerCase();
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
  const details = [];

  if (reservation.rv_kind === "motor home") {
    if (reservation.motorhome_class_a) {
      details.push("Class A");
    }

    if (reservation.motorhome_class_c) {
      details.push("Class C");
    }

    if (reservation.motorhome_with_tow) {
      details.push("With tow");
    }
  }

  if (reservation.slide_driver_side) {
    details.push("Driver-side slide");
  }

  if (reservation.slide_passenger_side) {
    details.push("Passenger-side slide");
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

  const bookedDate = String(reservation.booked_date || "")
    .replaceAll("-", "")
    .slice(2);
  return `#${reservation.id}${bookedDate ? `-${bookedDate}` : ""}`;
}

function buildReservationConfirmationText(reservation, paymentLink) {
  if (!reservation) {
    return "";
  }

  const siteStays = Array.isArray(reservation.siteStays)
    ? reservation.siteStays
    : [];
  const customerName = `${reservation.first_name || ""} ${
    reservation.last_name || ""
  }`.trim();
  const depositAmount = formatCurrency(
    paymentLink?.reservationId === reservation.id
      ? paymentLink.amount
      : reservation.depositAmount ?? null
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
    "A one-night deposit is required for stays of 7 nights or fewer. Stays longer than 7 nights require a two-night deposit. We have a 3% surcharge for credit card. (No Debit cards) you may write a check, or cash with no surcharge on arrival balance.",
    `Deposit amount: ${depositAmount}`,
    "",
    ...(siteStays.length
      ? siteStays.flatMap((stay, index) => [
          siteStays.length > 1 ? `Stay ${index + 1}` : "Stay details",
          `Site: ${stay.site_number || "To be assigned"}`,
          `Arrival: ${
            stay.arrival_date ? formatShortDate(stay.arrival_date) : "Not set"
          }`,
          "(Check-in 1:00 P.M.)",
          `Depart: ${
            stay.isOpenEnded
              ? "Open-ended yearly stay"
              : stay.leave_date
                ? formatShortDate(stay.leave_date)
                : "Not set"
          }`,
          "(Check-out 11:00 A.M.)",
          ...(index < siteStays.length - 1 ? [""] : [])
        ])
      : [
          "Stay details",
          "Site: To be assigned",
          "Arrival: Not set",
          "(Check-in 1:00 P.M.)",
          "Depart: Not set",
          "(Check-out 11:00 A.M.)"
        ]),
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
    "Text message okay",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildArrivalReminderText(reservation, arrivalDate) {
  if (!reservation) {
    return "";
  }

  const customerName = `${reservation.first_name || ""} ${
    reservation.last_name || ""
  }`.trim();
  const arrivingSegment =
    reservation.arrivingSiteStays?.find(
      (segment) => segment.arrival_date === arrivalDate
    ) ||
    reservation.siteStays?.find(
      (segment) => segment.arrival_date === arrivalDate
    ) ||
    reservation.siteStays?.[0] ||
    null;
  const balanceAmount = Number(reservation.remainingBalance || 0);
  const formattedBalance = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Number.isInteger(balanceAmount) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(balanceAmount);

  return [
    "Riverpark RV Resort",
    "",
    `Hello ${customerName || "Guest"},`,
    "",
    `We're looking forward to your arrival ${formatArrivalReference(
      arrivalDate
    )}!`,
    "",
    "Reservation Details",
    `Arrival: ${
      arrivingSegment?.arrival_date
        ? formatDisplayDate(arrivingSegment.arrival_date)
        : "Not set"
    }`,
    `Departure: ${
      arrivingSegment?.leave_date
        ? formatDisplayDate(arrivingSegment.leave_date)
        : "Not set"
    }`,
    "Check-in: 1:00 PM",
    `Balance Due: ${formattedBalance}`,
    "",
    "Payment Information",
    "We do not accept debit cards.",
    "Credit card payments are subject to a 3% processing fee.",
    "Cash and checks are accepted with no additional fee.",
    "",
    "Please reply to this message to confirm your arrival and provide your approximate arrival time. Any questions? Call (541) 295-1269",
    "",
    "Thank you!",
    "",
    "Makayla",
    "Riverpark RV Resort",
    "2956 Rogue River Hwy",
    "Grants Pass, OR 97527",
  ].join("\n");
}

function buildSmsComposeUrl(phoneNumber, messageBody) {
  const separator = phoneNumber ? "?&" : "?";
  return `sms:${phoneNumber}${separator}body=${encodeURIComponent(
    messageBody
  )}`;
}

function calculateUtilityPrice(electricMeterReading) {
  if (
    electricMeterReading === "" ||
    electricMeterReading === null ||
    electricMeterReading === undefined
  ) {
    return null;
  }

  return Number(electricMeterReading) * 0.17 - 75;
}

function getSiteTypeLabel(site) {
  if (
    (site.is_on_river || site.isOnRiver) &&
    (site.river_category === "prime_river" ||
      site.riverCategory === "prime_river")
  ) {
    return "Prime Riverfront";
  }

  return site.is_on_river || site.isOnRiver ? "Riverfront" : "Standard";
}

function createSiteEditorForm(site) {
  return {
    siteNumber: site.site_number || "",
    sizeFeet: String(site.size_feet ?? ""),
    isOnRiver: Boolean(site.is_on_river),
    riverCategory: site.river_category || "normal_river",
    isBigRig: Boolean(site.is_big_rig),
  };
}

function matchesSiteTypeFilter(site, selectedTypes) {
  const matches = {
    riverfront: site.is_on_river,
    standard: !site.is_on_river,
    prime_river: site.river_category === "prime_river",
    normal_river: site.river_category === "normal_river",
    big_rig: site.is_big_rig,
    small_rig: !site.is_big_rig,
  };

  return selectedTypes.some((type) => matches[type]);
}

function getPricingRuleForNights(site, numberOfNights) {
  if (!numberOfNights || !Array.isArray(site.pricing_rules)) {
    return null;
  }

  const exactRule =
    site.pricing_rules.find((rule) => rule.numberOfDays === numberOfNights) ||
    null;

  if (exactRule) {
    return exactRule;
  }

  const baseRule =
    site.pricing_rules.find((rule) => rule.numberOfDays === 1) ||
    site.pricing_rules[0] ||
    null;

  if (!baseRule) {
    return null;
  }

  const chargeableNights = calculateChargeableNights(numberOfNights);

  if (chargeableNights === null) {
    return null;
  }

  return {
    numberOfDays: numberOfNights,
    normalPrice:
      baseRule.normalPrice !== null && baseRule.normalPrice !== undefined
        ? Math.round(baseRule.normalPrice * chargeableNights * 100) / 100
        : null,
    discountPrice:
      baseRule.discountPrice !== null && baseRule.discountPrice !== undefined
        ? Math.round(baseRule.discountPrice * chargeableNights * 100) / 100
        : null,
  };
}

function ensureArray(value, label) {
  if (Array.isArray(value)) {
    return value;
  }

  throw new Error(`${label} response was not a list. Check VITE_API_BASE_URL.`);
}

async function apiRequest(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const headers = {
    "Content-Type": "application/json",
    "X-RVPark-Client-Id": adminClientId,
    ...(options.headers || {}),
  };

  const response = await fetch(`${apiBaseUrl}${path}`, {
    credentials: "include",
    headers,
    ...options,
  });

  const contentType = response.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");
  const data = isJson ? await response.json().catch(() => ({})) : null;

  if (!response.ok) {
    if (
      response.status === 401 &&
      typeof window !== "undefined" &&
      !(path === "/admin/session" && (method === "GET" || method === "POST"))
    ) {
      window.dispatchEvent(new CustomEvent("rvpark-admin-unauthorized"));
    }

    const error = new Error(data?.message || "Request failed.");
    error.status = response.status;
    error.data = data;
    throw error;
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

function urlBase64ToUint8Array(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replaceAll("-", "+").replaceAll("_", "/");
  const bytes = window.atob(base64);
  return Uint8Array.from(bytes, (character) => character.charCodeAt(0));
}

function supportsBookingPushNotifications() {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

async function getBookingNotificationRegistration() {
  await navigator.serviceWorker.register("/booking-notifications-sw.js", {
    scope: "/",
  });
  return navigator.serviceWorker.ready;
}

async function guestApiRequest(path, options = {}) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await response.json().catch(() => ({}))
    : null;

  if (!response.ok) {
    throw new Error(data?.message || "Request failed.");
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
      siteSearch: String(parsed.siteSearch),
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

function BookingSiteCalendar({
  segment,
  bookedRanges,
  onSelectRange,
  reservationTerm,
}) {
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
  calendarStart.setUTCDate(
    calendarStart.getUTCDate() - calendarStart.getUTCDay()
  );
  const selectedEndDate =
    segment.leaveDate ||
    (segment.arrivalDate ? addDays(segment.arrivalDate, 1) : "");
  const days = Array.from({ length: 42 }, (_, index) => {
    const current = new Date(calendarStart);
    current.setUTCDate(calendarStart.getUTCDate() + index);
    const dateString = formatDateInput(current);
    const isDepartureDate =
      Boolean(segment.leaveDate) && dateString === segment.leaveDate;

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
      ),
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
        <button
          type="button"
          className="ghost-button"
          onClick={() => changeMonth(-1)}>
          Previous
        </button>
        <h3>{monthLabel}</h3>
        <button
          type="button"
          className="ghost-button"
          onClick={() => changeMonth(1)}>
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
            } ${day.isDepartureDate ? "departure" : ""} ${
              day.isBooked ? "booked" : ""
            }`}
            onClick={() => handleDaySelect(day.dateString)}>
            <span>{day.dayNumber}</span>
            {day.isDepartureDate ? (
              <small className="calendar-day-tag">Depart</small>
            ) : null}
          </button>
        ))}
      </div>
      <div className="calendar-legend">
        <span>
          <i className="legend-box selected" /> selected stay
        </span>
        <span>
          <i className="legend-box departure" /> depart
        </span>
        <span>
          <i className="legend-box booked" /> booked
        </span>
      </div>
    </div>
  );
}

function AvailabilitySearchCalendar({ arrivalDate, leaveDate, onSelectRange }) {
  const [monthCursor, setMonthCursor] = useState(() =>
    startOfMonth(arrivalDate || formatDateInput(new Date()))
  );

  useEffect(() => {
    if (arrivalDate) {
      setMonthCursor(startOfMonth(arrivalDate));
    }
  }, [arrivalDate]);

  const monthStart = new Date(monthCursor);
  const monthLabel = formatMonthLabel(monthStart);
  const calendarStart = new Date(monthStart);
  calendarStart.setUTCDate(
    calendarStart.getUTCDate() - calendarStart.getUTCDay()
  );
  const selectedEndDate =
    leaveDate || (arrivalDate ? addDays(arrivalDate, 1) : "");
  const days = Array.from({ length: 42 }, (_, index) => {
    const current = new Date(calendarStart);
    current.setUTCDate(calendarStart.getUTCDate() + index);
    const dateString = formatDateInput(current);
    const isDepartureDate = Boolean(leaveDate) && dateString === leaveDate;

    return {
      dateString,
      dayNumber: current.getUTCDate(),
      isCurrentMonth: current.getUTCMonth() === monthStart.getUTCMonth(),
      isSelectedWindow:
        arrivalDate &&
        selectedEndDate &&
        dateString >= arrivalDate &&
        dateString < selectedEndDate,
      isDepartureDate,
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
    if (!arrivalDate || leaveDate) {
      onSelectRange(dateString, "");
      return;
    }

    if (dateString <= arrivalDate) {
      onSelectRange(dateString, "");
      return;
    }

    onSelectRange(arrivalDate, dateString);
  }

  return (
    <div className="calendar-card">
      <div className="result-header">
        <button
          type="button"
          className="ghost-button"
          onClick={() => changeMonth(-1)}>
          Previous
        </button>
        <h3>{monthLabel}</h3>
        <button
          type="button"
          className="ghost-button"
          onClick={() => changeMonth(1)}>
          Next
        </button>
      </div>
      <p className="muted calendar-hint">
        Click once for arrival. Click a later day for the departure date.
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
            } ${day.isDepartureDate ? "departure" : ""}`}
            onClick={() => handleDaySelect(day.dateString)}>
            <span>{day.dayNumber}</span>
            {day.isDepartureDate ? (
              <small className="calendar-day-tag">Depart</small>
            ) : null}
          </button>
        ))}
      </div>
      <div className="calendar-legend">
        <span>
          <i className="legend-box selected" /> selected stay
        </span>
        <span>
          <i className="legend-box departure" /> depart
        </span>
      </div>
    </div>
  );
}

function StaySearchModeFields({
  searchForm,
  onChange,
  isCalendarOpen = false,
  onToggleCalendar = null,
  publicLayout = false,
}) {
  const summary = getSearchModeSummary(searchForm);

  return (
    <div className="stay-search-mode-layout">
      <div className="search-mode-toggle" role="radiogroup" aria-label="Search type">
        <button
          type="button"
          className={`search-mode-button ${
            searchForm.searchMode === "exact" ? "active" : ""
          }`}
          aria-pressed={searchForm.searchMode === "exact"}
          onClick={() => onChange("searchMode", "exact")}>
          Exact dates
        </button>
        <button
          type="button"
          className={`search-mode-button ${
            searchForm.searchMode === "flexible" ? "active" : ""
          }`}
          aria-pressed={searchForm.searchMode === "flexible"}
          onClick={() => onChange("searchMode", "flexible")}>
          Flexible window
        </button>
      </div>

      {searchForm.searchMode === "exact" ? (
        <>
          {onToggleCalendar ? (
            <button
              type="button"
              className="public-calendar-toggle booking-date-button"
              onClick={onToggleCalendar}>
              {isCalendarOpen ? "Close calendar" : "Choose dates"}
            </button>
          ) : null}
          {summary ? (
            publicLayout ? (
              <div className="selected-date-banner">
                <span>{formatDisplayDate(searchForm.arrivalDate)}</span>
                <strong>to</strong>
                <span>
                  {searchForm.leaveDate
                    ? formatDisplayDate(searchForm.leaveDate)
                    : "Choose departure"}
                </span>
              </div>
            ) : (
              <p className="muted">{summary}</p>
            )
          ) : publicLayout ? (
            <p className="booking-helper">
              Open the calendar and choose an arrival and departure date.
            </p>
          ) : null}
          {isCalendarOpen ? (
            <AvailabilitySearchCalendar
              arrivalDate={searchForm.arrivalDate}
              leaveDate={searchForm.leaveDate}
              onSelectRange={(arrivalDate, leaveDate) => {
                onChange("arrivalDate", arrivalDate);
                onChange("leaveDate", leaveDate);
              }}
            />
          ) : null}
        </>
      ) : (
        <>
          {summary ? <p className={publicLayout ? "booking-helper" : "muted"}>{summary}</p> : null}
          <div
            className={
              publicLayout
                ? "public-flexible-search-fields"
                : "field-grid flexible-search-fields"
            }>
            <label>
              Date range looking
              <input
                type="date"
                value={searchForm.flexibleStartDate}
                onChange={(event) =>
                  onChange("flexibleStartDate", event.target.value)
                }
              />
            </label>
            <label>
              Through
              <input
                type="date"
                value={searchForm.flexibleEndDate}
                onChange={(event) =>
                  onChange("flexibleEndDate", event.target.value)
                }
              />
            </label>
            <label>
              About how many days?
              <select
                value={searchForm.stayLengthRange}
                onChange={(event) =>
                  onChange("stayLengthRange", event.target.value)
                }>
                {stayLengthOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </>
      )}
    </div>
  );
}

function SlideSideFields({
  slideDriverSide,
  slidePassengerSide,
  onChange,
  className = "",
}) {
  return (
    <div className={`motorhome-options ${className}`.trim()}>
      <span className="small-text">Slide-outs — select both if needed</span>
      <label className="checkbox-row compact-checkbox">
        <input
          type="checkbox"
          checked={slideDriverSide}
          onChange={(event) =>
            onChange("slideDriverSide", event.target.checked)
          }
        />
        Driver’s side
      </label>
      <label className="checkbox-row compact-checkbox">
        <input
          type="checkbox"
          checked={slidePassengerSide}
          onChange={(event) =>
            onChange("slidePassengerSide", event.target.checked)
          }
        />
        Passenger side
      </label>
    </div>
  );
}

function RigSearchFields({ searchForm, onChange, publicLayout = false }) {
  const towVehicleOptions =
    searchForm.rvKind === "trailer" || searchForm.rvKind === "camper"
      ? [
          { value: "suv", label: "SUV" },
          { value: "truck_short_bed", label: "Truck — short bed" },
          { value: "truck_long_bed", label: "Truck — long bed" },
          {
            value: "dually",
            label: "Dually",
          },
        ]
      : searchForm.rvKind === "5th wheel"
      ? [
          { value: "truck_short_bed", label: "Truck — short bed" },
          { value: "truck_long_bed", label: "Truck — long bed" },
          {
            value: "dually",
            label: "Dually",
          },
        ]
      : [];

  return (
    <div
      className={
        publicLayout
          ? "public-rig-fields"
          : "field-grid availability-rig-fields"
      }>
      {publicLayout ? (
        <div className="motorhome-options public-motorhome-options public-rv-type-picker">
          <span className="small-text">RV type</span>
          {searchForm.rvKind ? (
            <div className="checkbox-row compact-checkbox">
              <button
                type="button"
                className="ghost-button rv-type-clear-button"
                aria-label={`Clear ${searchForm.rvKind} RV type`}
                onClick={() => onChange("rvKind", "")}>
                ×
              </button>
              <span>
                {searchForm.rvKind.charAt(0).toUpperCase() +
                  searchForm.rvKind.slice(1)}
              </span>
            </div>
          ) : (
            rvKinds.map((kind) => (
              <label key={kind} className="checkbox-row compact-checkbox">
                <input
                  type="checkbox"
                  checked={false}
                  onChange={() => onChange("rvKind", kind)}
                />
                {kind.charAt(0).toUpperCase() + kind.slice(1)}
              </label>
            ))
          )}
        </div>
      ) : (
        <label>
          RV type
          <select
            value={searchForm.rvKind}
            onChange={(event) => onChange("rvKind", event.target.value)}>
            <option value="">Choose RV type</option>
            {rvKinds.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </label>
      )}
      {!publicLayout || searchForm.rvKind ? (
        <>
          <label>
            Rig length (feet)
            <input
              type="number"
              min="1"
              placeholder="Example: 32"
              value={searchForm.rigLengthFeet}
              onChange={(event) =>
                onChange("rigLengthFeet", event.target.value)
              }
            />
          </label>
          {searchForm.rvKind === "motor home" ? (
        <div className="motorhome-options public-motorhome-options">
          <span className="small-text">Motor home details</span>
          <label className="checkbox-row compact-checkbox">
            <input
              type="checkbox"
              checked={searchForm.motorhomeClassA}
              onChange={(event) =>
                onChange("motorhomeClassA", event.target.checked)
              }
            />
            Class A
          </label>
          <label className="checkbox-row compact-checkbox">
            <input
              type="checkbox"
              checked={searchForm.motorhomeClassC}
              onChange={(event) =>
                onChange("motorhomeClassC", event.target.checked)
              }
            />
            Class C
          </label>
          <label className="checkbox-row compact-checkbox">
            <input
              type="checkbox"
              checked={searchForm.motorhomeWithTow}
              onChange={(event) =>
                onChange("motorhomeWithTow", event.target.checked)
              }
            />
            With tow
          </label>
          {publicLayout && searchForm.motorhomeWithTow ? (
            <label>
              Tow vehicle length (feet)
              <input
                type="number"
                min="1"
                placeholder="Example: 18"
                value={searchForm.towVehicleLengthFeet}
                onChange={(event) =>
                  onChange("towVehicleLengthFeet", event.target.value)
                }
              />
            </label>
          ) : null}
        </div>
          ) : null}
          {publicLayout && towVehicleOptions.length ? (
            <div className="motorhome-options public-motorhome-options">
              <span className="small-text">Tow vehicle — choose one</span>
              {towVehicleOptions.map((option) => (
                <label
                  key={option.value}
                  className="checkbox-row compact-checkbox">
                  <input
                    type="checkbox"
                    checked={searchForm.towVehicleType === option.value}
                    onChange={(event) =>
                      onChange(
                        "towVehicleType",
                        event.target.checked ? option.value : ""
                      )
                    }
                  />
                  {option.label}
                </label>
              ))}
            </div>
          ) : null}
          {publicLayout ? (
            <SlideSideFields
              slideDriverSide={searchForm.slideDriverSide}
              slidePassengerSide={searchForm.slidePassengerSide}
              onChange={onChange}
              className="public-motorhome-options"
            />
          ) : null}
        </>
      ) : null}
      {publicLayout ? (
        <div className="public-rig-age-section">
          <label className="public-rig-age-checkbox">
            <input
              type="checkbox"
              checked={searchForm.rigOverTenYears}
              onChange={(event) =>
                onChange("rigOverTenYears", event.target.checked)
              }
            />
            <span>
              <strong>My RV is a classic—more than 10 years old.</strong>
              <small>
                We’d love to learn a little more about it before booking your
                stay.
              </small>
            </span>
          </label>
        </div>
      ) : null}
    </div>
  );
}

function PublicTermsAndConditions() {
  return (
    <main className="public-terms-page">
      <article className="public-terms-card">
        <a className="public-terms-brand" href="/">
          Riverpark RV Resort
        </a>
        <p className="eyebrow">Booking policies</p>
        <h1>Terms &amp; Conditions</h1>
        <p className="public-terms-updated">Effective August 15, 2026</p>

        <section>
          <h2>Reservations and deposits</h2>
          <p>
            A one-night deposit is required for stays of 7 nights or fewer.
            Stays longer than 7 nights require a two-night deposit. Deposits are
            non-refundable unless Riverpark RV Resort declines or cancels the
            stay. No reservation is confirmed until the required payment is
            successfully received.
          </p>
          <p>
            Credit-card payments include a 3% surcharge. Debit cards are not
            accepted. The remaining balance may be paid by check or cash upon
            arrival without a surcharge.
          </p>
        </section>

        <section>
          <h2>Site assignments</h2>
          <p>
            Riverpark RV Resort may move a reservation to another site within
            the same price range when necessary to best accommodate guests. We
            will make every reasonable effort to keep guests in their selected
            site. Site assignments and rates are subject to change.
          </p>
        </section>

        <section>
          <h2>RV eligibility</h2>
          <p>
            RVs more than 10 years old must be reviewed by park management
            before a reservation can be accepted. Please call 541-295-1269 so
            we can learn more about the RV and help select an appropriate site.
          </p>
        </section>

        <section>
          <h2>Admission and cancellation by the resort</h2>
          <p>
            Management reserves the right to decline or cancel a stay when
            reasonably necessary, in accordance with applicable law and park
            policies. If the resort declines or cancels a stay, any payment
            collected for that stay will be refunded to the original payment
            method.
          </p>
        </section>

        <section>
          <h2>Saved payment methods</h2>
          <p className="public-terms-authorization">
            <strong>
              I authorize Stripe to securely save my payment method for future
              reservation-related payments. Saving it does not authorize a new
              charge without my separate approval.
            </strong>
          </p>
          <p>
            With the guest’s separate consent during booking, Stripe securely
            saves the payment method and provides Riverpark RV Resort with a
            reusable Stripe payment-method reference and limited details such
            as the payment type, brand, expiration date, and last four digits.
            Riverpark RV Resort does not receive or store the full card or bank
            account number or the card security code.
          </p>
          <p>
            Saving a payment method does not by itself authorize a new charge.
            It may be used for a future reservation-related payment only after
            the guest separately authorizes that payment. Guests may request
            removal of a saved payment method by calling or texting
            541-295-1269.
          </p>
        </section>

        <section>
          <h2>Text messaging terms</h2>
          <p>
            Guests may separately choose to receive text messages from
            Riverpark RV Resort. Messages may include reservation
            confirmations, arrival and check-in reminders, balance reminders,
            reservation changes, cancellation notices, responses to guest
            questions, and park-wide operational updates or alerts such as
            weather, safety, closure, or utility notices.
          </p>
          <p>
            Consent to receive text messages is optional and is not a condition
            of making a reservation. Message frequency varies according to
            reservation and park activity. Message and data rates may apply.
            Reply <strong>STOP</strong> to unsubscribe or <strong>HELP</strong>{" "}
            for assistance. For additional help, call 541-295-1269. Carriers
            are not liable for delayed or undelivered messages.
          </p>
        </section>

        <section>
          <h2>Park rules</h2>
          <ul>
            <li>Check-in is at 1:00 p.m. and check-out is at 11:00 a.m.</li>
            <li>Pets must remain leashed and waste must be picked up immediately.</li>
            <li>Wood fires are prohibited; charcoal barbecues and propane are allowed.</li>
            <li>One car or truck is included per site; an additional vehicle is $5.</li>
            <li>Guests may not walk through another occupied site.</li>
          </ul>
        </section>

        <section>
          <h2>Contact</h2>
          <p>
            Questions about these terms may be directed to Riverpark RV Resort
            at <a href="tel:+15412951269">541-295-1269</a> or 2956 Rogue River
            Hwy, Grants Pass, OR 97527. Please also review our{" "}
            <a href="/?page=privacy">Privacy Policy</a>.
          </p>
        </section>

        <a className="public-terms-return" href="/#availability">
          Return to booking
        </a>
      </article>
    </main>
  );
}

function PublicPrivacyPolicy() {
  return (
    <main className="public-terms-page">
      <article className="public-terms-card">
        <a className="public-terms-brand" href="/">
          Riverpark RV Resort
        </a>
        <p className="eyebrow">Guest information</p>
        <h1>Privacy Policy</h1>
        <p className="public-terms-updated">Effective August 15, 2026</p>

        <section>
          <h2>Information we collect</h2>
          <p>
            Riverpark RV Resort may collect information that guests provide
            when checking availability, making or managing a reservation, or
            contacting the resort. This may include a guest’s name, email
            address, mobile phone number, stay dates, RV information, requested
            discounts, payment choice, and reservation communications.
          </p>
          <p>
            Payment information is processed securely by Stripe. Riverpark RV
            Resort does not receive or store full card or bank account numbers
            or card security codes.
          </p>
        </section>

        <section>
          <h2>How we use information</h2>
          <p>
            We use guest information to process and manage reservations,
            collect authorized payments, provide customer service, maintain
            resort records, protect the safety and operation of the park, and
            comply with legal obligations.
          </p>
          <p>
            When a guest separately opts in to text messaging, we may use the
            provided mobile number for reservation-related messages and
            park-wide operational updates or alerts, including weather, safety,
            closure, and utility notices.
          </p>
        </section>

        <section>
          <h2>Mobile information and text messaging</h2>
          <p>
            Mobile information will not be shared with third parties or
            affiliates for marketing or promotional purposes. Text-message
            opt-in data and consent will not be shared with any third parties,
            except service providers that help us deliver messages and are
            required to protect that information, or when disclosure is
            required by law.
          </p>
          <p>
            Message frequency varies. Message and data rates may apply. Reply
            <strong> STOP</strong> to unsubscribe or <strong>HELP</strong> for
            assistance. Opting out of texts does not cancel a reservation or
            prevent a guest from contacting the resort by phone or email.
          </p>
        </section>

        <section>
          <h2>When information may be shared</h2>
          <p>
            We may share information with service providers only as reasonably
            necessary to operate the resort and provide requested services,
            such as payment processing, website hosting, email delivery, and
            text-message delivery. We may also disclose information when
            required by law or to protect guests, the resort, or others. We do
            not sell personal information.
          </p>
        </section>

        <section>
          <h2>Information security and retention</h2>
          <p>
            We use reasonable administrative and technical safeguards to
            protect guest information. We retain information only as long as
            reasonably necessary for reservations, business records, legal
            obligations, dispute resolution, and enforcement of agreements.
            No method of electronic storage or transmission can be guaranteed
            to be completely secure.
          </p>
        </section>

        <section>
          <h2>Your choices</h2>
          <p>
            Guests may ask to review or correct their contact information and
            may withdraw text-message consent at any time by replying STOP.
            Guests may also contact Riverpark RV Resort about their information
            or communication preferences.
          </p>
        </section>

        <section>
          <h2>Contact</h2>
          <p>
            Privacy questions may be directed to Riverpark RV Resort at{" "}
            <a href="tel:+15412951269">541-295-1269</a> or 2956 Rogue River
            Hwy, Grants Pass, OR 97527. Please also review our{" "}
            <a href="/?page=terms">Terms of Service</a>.
          </p>
        </section>

        <a className="public-terms-return" href="/#availability">
          Return to booking
        </a>
      </article>
    </main>
  );
}

function PublicPaymentPage({ token }) {
  const [paymentDetails, setPaymentDetails] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [openingPaymentMethod, setOpeningPaymentMethod] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const params = new URLSearchParams(window.location.search);
  const returnStatus = params.get("pay_status") || "";
  const returnPaymentChoice = params.get("payment_choice") || "";

  useEffect(() => {
    let isCancelled = false;

    async function loadPaymentDetails() {
      setIsLoading(true);
      setErrorMessage("");

      try {
        const result = await guestApiRequest(
          `/guest/payment-links/${encodeURIComponent(token)}`
        );

        if (!isCancelled) {
          setPaymentDetails(result);
        }
      } catch (error) {
        if (!isCancelled) {
          setErrorMessage(error.message);
        }
      } finally {
        if (!isCancelled) {
          setIsLoading(false);
        }
      }
    }

    loadPaymentDetails();
    return () => {
      isCancelled = true;
    };
  }, [token]);

  async function startPayment(paymentMethod) {
    setOpeningPaymentMethod(paymentMethod);
    setErrorMessage("");

    try {
      const checkout = await guestApiRequest(
        `/guest/payment-links/${encodeURIComponent(token)}/checkouts`,
        {
          method: "POST",
          body: JSON.stringify({
            paymentMethod,
            baseUrl: window.location.origin,
          }),
        }
      );
      window.location.assign(checkout.checkoutUrl);
    } catch (error) {
      setErrorMessage(error.message);
      setOpeningPaymentMethod("");
    }
  }

  return (
    <main className="public-payment-page">
      <section className="public-payment-card">
        <a className="public-terms-brand" href="/">
          Riverpark RV Resort
        </a>
        <p className="eyebrow">Secure reservation payment</p>
        <h1>Pay your remaining balance</h1>

        {returnStatus === "success" ? (
          <div className="message success public-payment-message">
            {returnPaymentChoice === "bank"
              ? "Your bank payment was submitted. It may take several business days to be confirmed."
              : "Your card payment was submitted. Your balance will update when Stripe confirms it."}
          </div>
        ) : null}
        {returnStatus === "cancel" ? (
          <div className="message error public-payment-message">
            Payment was canceled. No new payment was submitted.
          </div>
        ) : null}
        {errorMessage ? (
          <div className="message error public-payment-message">
            {errorMessage}
          </div>
        ) : null}

        {isLoading ? (
          <p className="muted">Loading your reservation balance...</p>
        ) : paymentDetails ? (
          <>
            <div className="public-payment-reservation">
              <div>
                <span>Guest</span>
                <strong>{paymentDetails.guestName}</strong>
              </div>
              <div>
                <span>Reservation</span>
                <strong>#{paymentDetails.reservationId}</strong>
              </div>
              {paymentDetails.siteStays.map((stay, index) => (
                <div key={`${stay.siteNumber}-${stay.arrivalDate}-${index}`}>
                  <span>Site {stay.siteNumber}</span>
                  <strong>
                    {formatDisplayDate(stay.arrivalDate)} to{" "}
                    {isOpenEndedStay(stay.leaveDate)
                      ? "Ongoing"
                      : formatDisplayDate(stay.leaveDate)}
                  </strong>
                </div>
              ))}
              <div>
                <span>Already paid</span>
                <strong>{formatCurrency(paymentDetails.amountPaid)}</strong>
              </div>
            </div>

            {paymentDetails.paymentComplete ? (
              <div className="public-payment-complete">
                <strong>Your reservation balance is paid.</strong>
                <span>No additional payment is due.</span>
              </div>
            ) : (
              <div className="public-payment-options">
                <article>
                  <span className="eyebrow">No processing fee</span>
                  <h2>Bank payment</h2>
                  <strong className="public-payment-amount">
                    {formatCurrency(paymentDetails.bankAmount)}
                  </strong>
                  <p>
                    Pay the remaining balance from a bank account. Bank
                    payments may take several business days to confirm.
                  </p>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={Boolean(openingPaymentMethod)}
                    onClick={() => startPayment("bank")}>
                    {openingPaymentMethod === "bank"
                      ? "Opening secure payment..."
                      : "Pay by bank account"}
                  </button>
                </article>
                <article>
                  <span className="eyebrow">3% processing fee included</span>
                  <h2>Credit card</h2>
                  <strong className="public-payment-amount">
                    {formatCurrency(paymentDetails.cardAmount)}
                  </strong>
                  <p>
                    Pay by credit card through Stripe. Debit cards are not
                    accepted. Processing fee: {formatCurrency(paymentDetails.cardFee)}.
                  </p>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={Boolean(openingPaymentMethod)}
                    onClick={() => startPayment("card")}>
                    {openingPaymentMethod === "card"
                      ? "Opening secure payment..."
                      : "Pay by credit card"}
                  </button>
                </article>
              </div>
            )}
          </>
        ) : null}

        <p className="public-payment-help">
          Questions about your balance? Call Riverpark RV Resort at{" "}
          <a href="tel:+15412951269">(541) 295-1269</a>.
        </p>
      </section>
    </main>
  );
}

function PublicHome({
  searchForm,
  onSearchChange,
  onSearch,
  isCalendarOpen,
  onToggleCalendar,
  directMatches,
  flexibleMatches,
  switchPlan,
  availabilityRestriction,
  hasSearched,
  isSearching,
  errorMessage,
  onOpenGuest,
  onOpenAdmin,
}) {
  const isFlexibleSearch = searchForm.searchMode === "flexible";
  const matchingSiteCount = directMatches.length;
  const flexibleSiteCount = flexibleMatches.length;
  const numberOfNights = isFlexibleSearch
    ? null
    : nightsBetween(searchForm.arrivalDate, searchForm.leaveDate);
  const isLongStay = Number(numberOfNights) > 14;
  const requiresPhoneBooking = searchForm.rigOverTenYears;
  const isPublicOnlineBookingEnabled = true;
  const [selectedBookingSite, setSelectedBookingSite] = useState(null);
  const [publicBookingForm, setPublicBookingForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phoneNumber: "",
    smsConsent: false,
    discounts: [],
    termsAccepted: false,
  });
  const [bookingCheckoutStatus, setBookingCheckoutStatus] = useState(null);
  const [isCreatingPublicReservation, setIsCreatingPublicReservation] =
    useState(false);
  const [publicBookingError, setPublicBookingError] = useState("");
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
  const [showAllPublicDirectMatches, setShowAllPublicDirectMatches] =
    useState(false);
  const selectedBookingBankPrice = selectedBookingSite
    ? publicBookingForm.discounts.length
      ? selectedBookingSite.discountPrice ?? selectedBookingSite.normalPrice
      : selectedBookingSite.normalPrice ?? selectedBookingSite.discountPrice
    : null;
  const selectedBookingDepositPrice = getPublicBookingDeposit(
    selectedBookingBankPrice,
    numberOfNights
  );
  const publicBookingPhoneDigits = String(
    publicBookingForm.phoneNumber || ""
  ).replaceAll(/\D/g, "");
  const isPublicBookingFormComplete = Boolean(
    publicBookingForm.firstName.trim() &&
      publicBookingForm.lastName.trim() &&
      publicBookingForm.email.includes("@") &&
      publicBookingPhoneDigits.length === 10 &&
      publicBookingForm.termsAccepted
  );
  const bookingCheckoutParams =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search);
  const returnedBookingCheckoutToken =
    bookingCheckoutParams?.get("checkout_token") || "";
  const returnedBookingCheckoutState =
    bookingCheckoutParams?.get("booking_checkout") || "";
  const bookingCheckoutIsError =
    ["failed", "expired", "conflict"].includes(
      bookingCheckoutStatus?.status
    ) ||
    (returnedBookingCheckoutState === "cancel" &&
      bookingCheckoutStatus?.status === "open");
  const bookingCheckoutMessage =
    returnedBookingCheckoutState === "cancel" &&
    bookingCheckoutStatus?.status === "open"
      ? "Stripe Checkout was canceled. No reservation was created and no payment was taken."
      : bookingCheckoutStatus?.message || "Checking your Stripe payment...";

  useEffect(() => {
    setSelectedBookingSite(null);
    setPublicBookingError("");
    setShowAllPublicDirectMatches(false);
    setPublicBookingForm((current) => ({
      ...current,
      smsConsent: false,
      termsAccepted: false,
    }));
  }, [
    searchForm.arrivalDate,
    searchForm.leaveDate,
    searchForm.flexibleStartDate,
    searchForm.flexibleEndDate,
    searchForm.stayLengthRange,
    searchForm.searchMode,
    searchForm.rvKind,
    searchForm.rigLengthFeet,
    searchForm.rigOverTenYears,
    searchForm.motorhomeClassA,
    searchForm.motorhomeClassC,
    searchForm.motorhomeWithTow,
    searchForm.towVehicleLengthFeet,
    searchForm.towVehicleType,
    searchForm.slideDriverSide,
    searchForm.slidePassengerSide,
    searchForm.riverfrontOnly,
  ]);

  useEffect(() => {
    setIsMobileNavOpen(false);
  }, [isCalendarOpen]);

  useEffect(() => {
    if (!returnedBookingCheckoutToken) {
      return undefined;
    }

    let isCancelled = false;
    let timeoutId;

    async function loadCheckoutStatus() {
      try {
        const result = await guestApiRequest(
          `/guest/booking-checkouts/${returnedBookingCheckoutToken}`
        );

        if (isCancelled) {
          return;
        }

        setBookingCheckoutStatus(result);

        if (
          ["open", "processing", "paid"].includes(result.status) &&
          !(returnedBookingCheckoutState === "cancel" && result.status === "open")
        ) {
          timeoutId = window.setTimeout(loadCheckoutStatus, 4000);
        }
      } catch (error) {
        if (!isCancelled) {
          setBookingCheckoutStatus({
            status: "failed",
            message: error.message,
          });
        }
      }
    }

    loadCheckoutStatus();

    return () => {
      isCancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [returnedBookingCheckoutState, returnedBookingCheckoutToken]);

  function choosePublicSite(site) {
    if (!isPublicOnlineBookingEnabled || requiresPhoneBooking) {
      return;
    }

    setSelectedBookingSite(site);
    setPublicBookingError("");
    setPublicBookingForm((current) => ({
      ...current,
      smsConsent: false,
      termsAccepted: false,
    }));

    window.requestAnimationFrame(() => {
      document.getElementById("public-reservation-form")?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    });
  }

  function runPublicAvailabilitySearch(event) {
    setSelectedBookingSite(null);
    setPublicBookingError("");
    onSearch(event, { applySiteFitRestrictions: false });
  }

  function handlePublicBookingSubmit(event) {
    if (requiresPhoneBooking) {
      event.preventDefault();
      return;
    }

    if (isFlexibleSearch) {
      runPublicAvailabilitySearch(event);
      return;
    }

    if (selectedBookingSite) {
      event.preventDefault();

      return;
    }

    runPublicAvailabilitySearch(event);
  }

  async function startPublicBookingCheckout(paymentMethod) {
    if (
      !selectedBookingSite ||
      !isPublicBookingFormComplete ||
      requiresPhoneBooking
    ) {
      return;
    }

    setIsCreatingPublicReservation(true);
    setPublicBookingError("");

    try {
      const checkout = await guestApiRequest("/guest/booking-checkouts", {
        method: "POST",
        body: JSON.stringify({
          ...publicBookingForm,
          paymentMethodStorageAccepted: publicBookingForm.termsAccepted,
          discounts: publicBookingForm.discounts,
          paymentMethod,
          baseUrl: window.location.origin,
          siteId: selectedBookingSite.id,
          arrivalDate: searchForm.arrivalDate,
          leaveDate: searchForm.leaveDate,
          rvKind: searchForm.rvKind,
          motorhomeClassA: searchForm.motorhomeClassA,
          motorhomeClassC: searchForm.motorhomeClassC,
          motorhomeWithTow: searchForm.motorhomeWithTow,
          rigLengthFeet: searchForm.rigLengthFeet,
          towVehicleLengthFeet: searchForm.towVehicleLengthFeet,
          towVehicleType: searchForm.towVehicleType,
          slideDriverSide: searchForm.slideDriverSide,
          slidePassengerSide: searchForm.slidePassengerSide,
          rigOverTenYears: searchForm.rigOverTenYears,
        }),
      });

      window.location.assign(checkout.checkoutUrl);
    } catch (error) {
      setPublicBookingError(error.message);
      setIsCreatingPublicReservation(false);
    }
  }

  if (
    returnedBookingCheckoutToken &&
    bookingCheckoutStatus?.status === "completed" &&
    bookingCheckoutStatus.reservation
  ) {
    const confirmedReservation = bookingCheckoutStatus.reservation;
    const confirmedStay = confirmedReservation.siteStays?.[0] || null;

    return (
      <div className="public-site public-booking-confirmation-page">
        <header className="public-confirmation-header">
          <a className="public-brand" href="/" aria-label="Riverpark RV Resort home">
            <span className="brand-mark">RP</span>
            <span>
              <strong>Riverpark</strong>
              <small>RV Resort</small>
            </span>
          </a>
        </header>
        <main className="public-confirmation-main">
          <section className="public-confirmation-card" aria-labelledby="booking-confirmed-title">
            <div className="public-confirmation-check" aria-hidden="true">
              &#10003;
            </div>
            <p className="eyebrow">Your stay is reserved</p>
            <h1 id="booking-confirmed-title">Booking confirmed</h1>
            <p className="public-confirmation-lead">
              Thank you, {confirmedReservation.first_name || "Guest"}. We sent your
              confirmation email to
              <strong> {confirmedReservation.email}</strong>.
            </p>
            {confirmedStay ? (
              <div className="public-confirmation-stay">
                <div>
                  <span>Site</span>
                  <strong>{confirmedStay.site_number || "Confirmed"}</strong>
                </div>
                <div>
                  <span>Arrival</span>
                  <strong>{formatDisplayDate(confirmedStay.arrival_date)}</strong>
                </div>
                <div>
                  <span>Departure</span>
                  <strong>{formatDisplayDate(confirmedStay.leave_date)}</strong>
                </div>
              </div>
            ) : null}
            <p className="public-confirmation-note">
              If you do not see the email within a few minutes, please check your spam
              or junk folder.
            </p>
            <div className="public-confirmation-actions">
              <button type="button" className="public-primary-button" onClick={onOpenGuest}>
                Manage booking
              </button>
              <a className="public-text-link" href="/">
                Return to homepage
              </a>
            </div>
            <p className="public-confirmation-contact">
              Need help? <a href="tel:+15412951269">Call or text 541-295-1269</a>
            </p>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="public-site">
      <header className="public-header-shell">
        <div className="public-header">
          <a
            className="public-brand"
            href="#top"
            aria-label="Riverpark RV Resort home"
            onClick={() => setIsMobileNavOpen(false)}>
            <span className="brand-mark">RP</span>
            <span>
              <strong>Riverpark</strong>
              <small>RV Resort</small>
            </span>
          </a>
          <nav className="public-nav" aria-label="Resort navigation">
            <a href="#stay">The park</a>
            <a href="#availability">Availability</a>
            <a href="#explore">Explore</a>
            <a href="#map">Find us</a>
            <button type="button" onClick={onOpenGuest}>
              Manage booking
            </button>
          </nav>
          <a className="public-nav-cta" href="#availability">
            Plan your stay
          </a>
          <button
            type="button"
            className="public-mobile-nav-button"
            aria-expanded={isMobileNavOpen}
            aria-controls="public-mobile-nav"
            onClick={() => setIsMobileNavOpen((current) => !current)}>
            {isMobileNavOpen ? "Close" : "Menu"}
          </button>
        </div>
        {isMobileNavOpen ? (
          <div className="public-mobile-nav-panel" id="public-mobile-nav">
            <a href="#stay" onClick={() => setIsMobileNavOpen(false)}>
              The park
            </a>
            <a href="#availability" onClick={() => setIsMobileNavOpen(false)}>
              Availability
            </a>
            <a href="#explore" onClick={() => setIsMobileNavOpen(false)}>
              Explore
            </a>
            <a href="#map" onClick={() => setIsMobileNavOpen(false)}>
              Find us
            </a>
            <a
              className="public-mobile-primary-link"
              href="#availability"
              onClick={() => setIsMobileNavOpen(false)}>
              Plan your stay
            </a>
            <button
              type="button"
              onClick={() => {
                setIsMobileNavOpen(false);
                onOpenGuest();
              }}>
              Manage booking
            </button>
            <button
              type="button"
              onClick={() => {
                setIsMobileNavOpen(false);
                onOpenAdmin();
              }}>
              Admin
            </button>
          </div>
        ) : null}
      </header>

      <main id="top">
        <section className="public-hero">
          <div className="hero-copy">
            <p className="eyebrow">Grants Pass, Oregon</p>
            <h1>Slow down by the Rogue.</h1>
            <p className="hero-lead">
              A welcoming full-hookup RV stay on the river, minutes from Grants
              Pass and surrounded by the wild beauty of Southern Oregon.
            </p>
            <div className="hero-actions">
              <a className="public-primary-button" href="#availability">
                Check availability
              </a>
              <a className="public-text-link" href="tel:+15412951269">
                Call 541-295-1269
              </a>
            </div>
            <div className="hero-details" aria-label="Park highlights">
              <span>Full hookups</span>
              <span>Riverfront setting</span>
              <span>No freeway noise</span>
              <span>Back-in RV sites</span>
              <span>Pet-friendly stays</span>
            </div>
          </div>
          <div className="hero-photo-placeholder park-hero-photo">
            <img
              src="/Images/parklandscape.png"
              alt="Tree-lined RV sites and landscaped grounds at Riverpark RV Resort"
            />
          </div>
          <div className="hero-river-label">On the Rogue River</div>
        </section>

        <section className="welcome-strip" id="stay">
          <p className="eyebrow">A quiet place to land</p>
          <div>
            <h2>Easy days. River evenings. A little more room to breathe.</h2>
            <p>
              Settle in close to the water, enjoy the shade, and use Riverpark
              as your home base for fishing, exploring, or simply taking the day
              slowly. Once you arrive, you cannot hear freeway traffic from the
              park.
            </p>
          </div>
        </section>

        <section className="photo-story-grid" aria-label="Park photo spaces">
          <div className="tall-photo-placeholder riverfront-photo-frame">
            <img
              src="/Images/riverfront.jpeg"
              alt="Shaded riverfront RV site beside the Rogue River"
            />
          </div>
          <article className="story-card">
            <span className="story-number">01</span>
            <p className="eyebrow">Stay your way</p>
            <h2>See which sites are open for your stay.</h2>
            <p>
              Search by your travel dates, then compare the available sites and
              their listed lengths.
            </p>
            <a href="#availability">Start a site search</a>
          </article>
          <div className="wide-photo-placeholder park-grounds-photo">
            <img
              src="/Images/backofriver.jpg"
              alt="Shaded RV sites along the tree-lined road through Riverpark RV Resort"
            />
          </div>
        </section>

        <section className="public-booking-section" id="availability">
          <div className="booking-intro">
            <p className="eyebrow light">Plan your stay</p>
            <h2>Find your place by the river.</h2>
            <p>
              Choose your dates and tell us about your RV. We’ll show every site
              that is open for the full stay.
            </p>
            <p className="public-pricing-note">
              Stays longer than 2 weeks must be booked by phone.
            </p>
            <p className="public-pricing-note">
              Stay 6 consecutive nights and get the 7th night on us—free.
            </p>
            <p className="public-pricing-note">
              Prime riverfront sites give you more room around your RV, with
              extra space to relax and enjoy the river scenery.
            </p>
            <p className="public-pricing-note">
              If you hate computers and would rather talk to a person, call us
              and we can book you over the phone.
            </p>
            {selectedBookingSite ? (
              <div className="booking-intro-price-panel">
                <BookingPriceComparison
                  title={
                    publicBookingForm.discounts.length
                      ? "Discounted price per night"
                      : "Selected price per night"
                  }
                  bankPrice={selectedBookingBankPrice}
                  perNight
                  numberOfNights={numberOfNights}
                />
                <BookingPriceComparison
                  title={
                    Number(numberOfNights) > 7
                      ? "Two-night deposit due"
                      : "One-night deposit due"
                  }
                  bankPrice={selectedBookingDepositPrice}
                />
              </div>
            ) : null}
            <a href="tel:+15412951269">Questions? Call or text 541-295-1269</a>
          </div>
          <form
            className="public-booking-card"
            onSubmit={handlePublicBookingSubmit}>
            {returnedBookingCheckoutToken ? (
              <div
                className={`public-checkout-return ${
                  bookingCheckoutIsError ? "error" : "success"
                }`}
                role="status"
                aria-live="polite">
                <p className="eyebrow">
                  {bookingCheckoutStatus?.status === "completed"
                    ? "Booking confirmed"
                    : bookingCheckoutStatus?.status === "processing"
                      ? "Bank payment processing"
                      : "Booking payment"}
                </p>
                <h3>{bookingCheckoutMessage}</h3>
                {bookingCheckoutStatus?.reservation ? (
                  <p>
                    Site{" "}
                    {bookingCheckoutStatus.reservation.siteStays?.[0]
                      ?.site_number || "confirmed"}{" "}
                    · Reservation #{bookingCheckoutStatus.reservation.id}
                  </p>
                ) : null}
                {bookingCheckoutStatus?.status === "completed" ? (
                  <button
                    type="button"
                    className="public-search-button"
                    onClick={onOpenGuest}>
                    Manage booking
                  </button>
                ) : null}
              </div>
            ) : null}
            <div className="booking-card-heading">
              <div>
                <span>Step 1</span>
                <h3>
                  {isFlexibleSearch
                    ? "What part of the month are you looking at?"
                    : "When are you coming?"}
                </h3>
              </div>
            </div>
            <StaySearchModeFields
              searchForm={searchForm}
              onChange={onSearchChange}
              isCalendarOpen={isCalendarOpen}
              onToggleCalendar={onToggleCalendar}
              publicLayout
            />
            <div className="booking-step-divider" />
            <div className="booking-card-heading">
              <div>
                <span>Step 2</span>
                <h3>
                  {isFlexibleSearch
                    ? "What rig size should we fit in that window?"
                    : "Tell us about your rig."}
                </h3>
              </div>
            </div>
            <RigSearchFields
              searchForm={searchForm}
              onChange={onSearchChange}
              publicLayout
            />
            <label className="public-river-checkbox">
              <input
                type="checkbox"
                checked={searchForm.riverfrontOnly}
                onChange={(event) =>
                  onSearchChange("riverfrontOnly", event.target.checked)
                }
              />
              Only show riverfront sites
            </label>
            {!requiresPhoneBooking && errorMessage ? (
              <div className="public-search-message error">{errorMessage}</div>
            ) : null}
            {requiresPhoneBooking ? (
              <div className="public-rig-age-callout" aria-live="polite">
                <div>
                  <strong>Let’s plan your stay together.</strong>
                  <span>
                    For RVs more than 10 years old, please give us a call so we
                    can find the right site for you.
                  </span>
                </div>
                <a href="tel:+15412951269">Call 541-295-1269</a>
              </div>
            ) : (
              <button
                className="public-search-button"
                type="button"
                disabled={isSearching}
                onClick={runPublicAvailabilitySearch}>
                {isSearching ? "Searching..." : "Search available sites"}
              </button>
            )}

            {hasSearched && !requiresPhoneBooking ? (
              <div className="public-search-results" aria-live="polite">
                <div className="result-header">
                  <div>
                    <p className="eyebrow">Your results</p>
                    <h3>
                      {availabilityRestriction === "oversized_fifth_wheel"
                        ? "No sites fit fifth wheels over 43 feet"
                        : isFlexibleSearch
                        ? flexibleSiteCount
                          ? `${flexibleSiteCount} site${
                              flexibleSiteCount === 1 ? "" : "s"
                            } have flexible openings`
                          : "No sites match that flexible window"
                        : matchingSiteCount
                        ? `${matchingSiteCount} site${
                            matchingSiteCount === 1 ? "" : "s"
                          } available for your stay`
                        : "No single site covers the full stay"}
                    </h3>
                  </div>
                  {switchPlan?.length ? (
                    <span className="switch-plan-pill">
                      Switch plan available
                    </span>
                  ) : null}
                </div>
                {availabilityRestriction === "oversized_fifth_wheel" ? (
                  <div className="oversized-rig-message">
                    <strong>
                      We do not have room for a fifth wheel over 43 feet.
                    </strong>
                    <span>
                      Please call us if you have questions about measuring your
                      rig.
                    </span>
                  </div>
                ) : isFlexibleSearch ? (
                  flexibleSiteCount ? (
                    <div className="public-site-results flexible-site-results">
                      {flexibleMatches.slice(0, 6).map((site) => (
                        <article key={site.siteId}>
                          <div>
                            <span>Flexible openings</span>
                            <h4>Site {site.siteNumber}</h4>
                          </div>
                          <p>
                            {site.sizeFeet} ft · {getSiteTypeLabel(site)} · up to{" "}
                            {site.maxAvailableNights} open nights in your window
                          </p>
                          <div className="flexible-window-list">
                            {site.openWindows.slice(0, 3).map((window, index) => (
                              <span key={`${site.siteId}-${index}`}>
                                {formatDisplayDate(window.arrivalDate)} to{" "}
                                {formatDisplayDate(window.leaveDate)} ·{" "}
                                {window.minStayNights === window.maxStayNights
                                  ? `${window.minStayNights} days`
                                  : `${window.minStayNights}-${window.maxStayNights} days`}
                              </span>
                            ))}
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p>
                      Nothing is showing online for that window. Please call us
                      and we’ll see whether we can make something work.
                    </p>
                  )
                ) : matchingSiteCount ? (
                  <div className="public-site-results">
                    {(showAllPublicDirectMatches
                      ? directMatches
                      : directMatches.slice(0, 6)
                    ).map((site) => (
                      <article
                        key={site.id}
                        className="public-site-result-card"
                        tabIndex={0}>
                        <div>
                          <span>Available</span>
                          <h4>Site {site.siteNumber}</h4>
                        </div>
                        <p>
                          {site.sizeFeet} ft · {getSiteTypeLabel(site)} ·{" "}
                          {site.numberOfNights} nights
                        </p>
                        <BookingPriceComparison
                          title="Price per night"
                          bankPrice={site.normalPrice}
                          discountBankPrice={site.discountPrice}
                          perNight
                          numberOfNights={site.numberOfNights}
                        />
                        {!isLongStay ? (
                          isPublicOnlineBookingEnabled ? (
                            <button
                              type="button"
                              className="public-reserve-site-button"
                              onClick={() => choosePublicSite(site)}>
                              Reserve this site
                            </button>
                          ) : (
                            <a
                              className="public-reserve-site-button"
                              href="tel:+15412951269">
                              Call to book
                            </a>
                          )
                        ) : null}
                      </article>
                    ))}
                    {directMatches.length > 6 ? (
                      <button
                        type="button"
                        className="public-search-button"
                        onClick={() =>
                          setShowAllPublicDirectMatches((current) => !current)
                        }>
                        {showAllPublicDirectMatches
                          ? "Show fewer sites"
                          : `See all ${directMatches.length} available sites`}
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <p>
                    Nothing is showing online for the full stay, but that
                    doesn’t always mean we’re out of options.
                  </p>
                )}
                {availabilityRestriction !== "oversized_fifth_wheel" &&
                ((isFlexibleSearch && !flexibleSiteCount) ||
                  (!isFlexibleSearch && !matchingSiteCount)) ? (
                  <div className="public-result-cta short-stay-callout">
                    <div>
                      <strong>Please call us—we may be able to help.</strong>
                      <span>
                        We can check for options that may not appear online,
                        adjust the dates, or arrange a stay that moves between
                        sites.
                      </span>
                    </div>
                    <a href="tel:+15412951269">Call 541-295-1269</a>
                  </div>
                ) : isFlexibleSearch ? (
                  <div className="public-result-cta short-stay-callout">
                    <div>
                      <strong>These are flexible options for your rig size.</strong>
                      <span>
                        Pick exact dates later, or call us and we can help place
                        you in one of these openings.
                      </span>
                    </div>
                    <a href="tel:+15412951269">Call 541-295-1269</a>
                  </div>
                ) : isLongStay ? (
                  <div className="public-result-cta long-stay-callout">
                    <div>
                      <strong>Planning to stay longer than two weeks?</strong>
                      <span>
                        These sites are available, but longer stays must be
                        reserved by phone.
                      </span>
                    </div>
                    <a href="tel:+15412951269">Call 541-295-1269</a>
                  </div>
                ) : matchingSiteCount ? (
                  <div className="public-result-cta short-stay-callout">
                    <div>
                      <strong>
                        {isPublicOnlineBookingEnabled
                          ? "Choose an available site above."
                          : "These sites are available for your stay."}
                      </strong>
                      <span>
                        {isPublicOnlineBookingEnabled
                          ? "We’ll take you to the reservation form to finish booking."
                          : "Call us and we can book one of these sites for you over the phone."}
                      </span>
                    </div>
                    {!isPublicOnlineBookingEnabled ? (
                      <a href="tel:+15412951269">Call 541-295-1269</a>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}

            {selectedBookingSite &&
            isPublicOnlineBookingEnabled &&
            !isLongStay &&
            !requiresPhoneBooking &&
            !isFlexibleSearch ? (
              <section
                className="public-create-reservation"
                id="public-reservation-form">
                <div className="booking-step-divider" />
                <div className="booking-card-heading">
                  <div>
                    <span>Step 3</span>
                    <h3>Complete your reservation.</h3>
                  </div>
                </div>

                <div className="public-create-fields">
                    <div className="selected-public-site">
                      <div>
                        <span>Your site</span>
                        <strong>Site {selectedBookingSite.siteNumber}</strong>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSelectedBookingSite(null)}>
                        Change site
                      </button>
                    </div>
                    <div className="public-guest-fields">
                      <label>
                        First name
                        <input
                          autoComplete="given-name"
                          value={publicBookingForm.firstName}
                          onChange={(event) =>
                            setPublicBookingForm((current) => ({
                              ...current,
                              firstName: event.target.value,
                            }))
                          }
                        />
                      </label>
                      <label>
                        Last name
                        <input
                          autoComplete="family-name"
                          value={publicBookingForm.lastName}
                          onChange={(event) =>
                            setPublicBookingForm((current) => ({
                              ...current,
                              lastName: event.target.value,
                            }))
                          }
                        />
                      </label>
                      <label>
                        Email
                        <input
                          type="email"
                          autoComplete="email"
                          value={publicBookingForm.email}
                          onChange={(event) =>
                            setPublicBookingForm((current) => ({
                              ...current,
                              email: event.target.value,
                            }))
                          }
                        />
                      </label>
                      <label>
                        Phone number
                        <input
                          type="tel"
                          autoComplete="tel"
                          inputMode="numeric"
                          placeholder="(541)555-1234"
                          value={publicBookingForm.phoneNumber}
                          onChange={(event) =>
                            setPublicBookingForm((current) => ({
                              ...current,
                              phoneNumber: formatPhoneNumber(
                                event.target.value
                              ),
                            }))
                          }
                        />
                      </label>
                    </div>
                    <div className="public-sms-opt-in">
                      <label className="checkbox-row public-sms-consent">
                        <input
                          type="checkbox"
                          checked={publicBookingForm.smsConsent}
                          onChange={(event) =>
                            setPublicBookingForm((current) => ({
                              ...current,
                              smsConsent: event.target.checked,
                            }))
                          }
                        />
                        <span>
                          Yes, I agree to receive reservation-related text
                          messages and park-wide updates or alerts from
                          Riverpark RV Resort at the mobile number provided.
                        </span>
                      </label>
                      <p>
                        Message frequency varies. Message and data rates may
                        apply. Reply HELP for help or STOP to unsubscribe.
                        Consent is optional and is not a condition of booking.{" "}
                        <a href="/?page=terms" target="_blank" rel="noreferrer">
                          Terms of Service
                        </a>{" "}
                        and{" "}
                        <a href="/?page=privacy" target="_blank" rel="noreferrer">
                          Privacy Policy
                        </a>
                        .
                      </p>
                    </div>
                    <div className="public-discount-panel">
                      <span className="small-text">Discounts</span>
                      <p className="muted">
                        Select any that apply and we will use the discounted
                        stay price.
                      </p>
                      <div className="public-discount-options">
                        {publicDiscountOptions.map((discount) => (
                          <label
                            key={discount}
                            className="checkbox-row compact-checkbox">
                            <input
                              type="checkbox"
                              checked={publicBookingForm.discounts.includes(
                                discount
                              )}
                              onChange={(event) =>
                                setPublicBookingForm((current) => ({
                                  ...current,
                                  discounts: event.target.checked
                                    ? [...current.discounts, discount]
                                    : current.discounts.filter(
                                        (value) => value !== discount
                                      ),
                                }))
                              }
                            />
                            {discount}
                          </label>
                        ))}
                      </div>
                    </div>
                    <BookingPriceComparison
                      title={
                        publicBookingForm.discounts.length
                          ? "Discounted price per night"
                          : "Price per night"
                      }
                      bankPrice={selectedBookingBankPrice}
                      perNight
                      numberOfNights={numberOfNights}
                    />
                    <div className="public-discount-panel">
                      <label className="checkbox-row compact-checkbox">
                        <input
                          type="checkbox"
                          checked={publicBookingForm.termsAccepted}
                          onChange={(event) =>
                            setPublicBookingForm((current) => ({
                              ...current,
                              termsAccepted: event.target.checked,
                            }))
                          }
                        />
                        <span>
                          I have read and agree to Riverpark RV Resort’s{" "}
                          <a
                            href="/?page=terms"
                            target="_blank"
                            rel="noreferrer">
                            Terms &amp; Conditions
                          </a>
                          , including the saved-payment authorization.
                        </span>
                      </label>
                    </div>
                    <div className="public-reservation-review">
                      <span>{formatDisplayDate(searchForm.arrivalDate)}</span>
                      <strong>to</strong>
                      <span>{formatDisplayDate(searchForm.leaveDate)}</span>
                      <span>
                        {searchForm.rvKind} · {searchForm.rigLengthFeet} ft
                      </span>
                      {searchForm.rvKind === "motor home" &&
                      searchForm.motorhomeWithTow ? (
                        <span>
                          Tow vehicle · {searchForm.towVehicleLengthFeet} ft
                        </span>
                      ) : null}
                      {searchForm.towVehicleType ? (
                        <span>
                          Tow vehicle ·{" "}
                          {
                            {
                              suv: "SUV",
                              truck_short_bed: "Truck — short bed",
                              truck_long_bed: "Truck — long bed",
                              dually: "Dually",
                            }[searchForm.towVehicleType]
                          }
                        </span>
                      ) : null}
                      {searchForm.slideDriverSide ? (
                        <span>Slide · Driver’s side</span>
                      ) : null}
                      {searchForm.slidePassengerSide ? (
                        <span>Slide · Passenger side</span>
                      ) : null}
                    </div>
                    {publicBookingError ? (
                      <div className="public-search-message error">
                        {publicBookingError}
                      </div>
                    ) : null}
                    <div className="public-created-summary public-inline-deposit-summary">
                      <p className="eyebrow">Deposit payment</p>
                      <h3>Pay securely with Stripe.</h3>
                      <p>
                        No reservation is created until Stripe confirms the
                        deposit payment.
                      </p>
                      <BookingPriceComparison
                        title={
                          Number(numberOfNights) > 7
                            ? "Two-night deposit due"
                            : "One-night deposit due"
                        }
                        bankPrice={selectedBookingDepositPrice}
                      />
                    </div>
                    {!isPublicBookingFormComplete ? (
                      <p className="public-payment-disabled-hint">
                        Complete your contact information and accept the Terms
                        &amp; Conditions above to enable payment.
                      </p>
                    ) : null}
                    <div className="public-checkout-methods">
                      <button
                        type="button"
                        className="public-search-button"
                        disabled={
                          isCreatingPublicReservation ||
                          !isPublicBookingFormComplete
                        }
                        onClick={() => startPublicBookingCheckout("bank")}>
                        {isCreatingPublicReservation
                          ? "Opening Stripe..."
                          : `Pay ${formatCurrency(
                              selectedBookingDepositPrice
                            )} by bank with Stripe`}
                      </button>
                      <button
                        type="button"
                        className="public-search-button card-checkout-button"
                        disabled={
                          isCreatingPublicReservation ||
                          !isPublicBookingFormComplete
                        }
                        onClick={() => startPublicBookingCheckout("card")}>
                        {isCreatingPublicReservation
                          ? "Opening Stripe..."
                          : `Pay ${formatCurrency(
                              getCardPrice(selectedBookingDepositPrice)
                            )} by card with Stripe`}
                      </button>
                    </div>
                  </div>
              </section>
            ) : null}
          </form>
        </section>

        <section className="explore-section" id="explore">
          <div className="explore-heading">
            <div>
              <p className="eyebrow">Beyond the park</p>
              <h2>Wild rivers, marble caves, and small-town days.</h2>
            </div>
            <p>
              Riverpark puts the best of Grants Pass and Southern Oregon within
              reach.
            </p>
          </div>
          <div className="explore-grid">
            <a
              href="https://hellgate.com/"
              target="_blank"
              rel="noreferrer"
              className="explore-card river-card">
              <span>On the water</span>
              <h3>Rogue River adventures</h3>
              <p>
                Spend a day rafting, fishing, or taking a jetboat trip through
                the Rogue.
              </p>
              <strong>Explore the river →</strong>
            </a>
            <a
              href="https://www.nps.gov/orca/"
              target="_blank"
              rel="noreferrer"
              className="explore-card cave-card">
              <span>Day trip</span>
              <h3>Oregon Caves</h3>
              <p>
                Tour the marble halls and hike among old-growth forest in the
                Siskiyou Mountains.
              </p>
              <strong>Plan a cave visit →</strong>
            </a>
            <a
              href="https://wildlifeimages.org/"
              target="_blank"
              rel="noreferrer"
              className="explore-card wildlife-card">
              <span>For all ages</span>
              <h3>Wildlife Images</h3>
              <p>
                Meet rescued wildlife at the rehabilitation and education center
                near Grants Pass.
              </p>
              <strong>Meet the animals →</strong>
            </a>
            <a
              href="https://traveloregon.com/things-to-do/outdoor-recreation/fishing/"
              target="_blank"
              rel="noreferrer"
              className="explore-card fishing-card">
              <span>Cast a line</span>
              <h3>Rogue River fishing</h3>
              <p>
                Around Grants Pass, anglers chase salmon, steelhead, smallmouth
                bass, and trout. Fish low light hours, work current seams and
                eddies, and match your bait or lures to the season and water
                clarity.
              </p>
              <strong>Plan a fishing day →</strong>
            </a>
            <a
              href="https://visitgrantspass.com/"
              target="_blank"
              rel="noreferrer"
              className="explore-card town-card">
              <span>In town</span>
              <h3>Downtown Grants Pass</h3>
              <p>
                Browse local shops, find a relaxed meal, and explore the
                historic downtown streets.
              </p>
              <strong>See what’s nearby →</strong>
            </a>
          </div>
        </section>

        <section className="map-section" id="map">
          <div className="map-copy">
            <p className="eyebrow">Come find us</p>
            <h2>
              Close to town.
              <br />
              Right on the river.
            </h2>
            <p>
              2956 Rogue River Hwy
              <br />
              Grants Pass, OR 97527
            </p>
            <a
              href="https://maps.google.com/?q=2956+Rogue+River+Hwy+Grants+Pass+OR+97527"
              target="_blank"
              rel="noreferrer">
              Open driving directions
            </a>
          </div>
          <div className="park-map-frame">
            <img
              src="/Images/ParkMap.png"
              alt="Map of RV sites, roads, office, parking, and amenities at Riverpark RV Resort"
            />
          </div>
        </section>
      </main>

      <footer className="public-footer">
        <div className="footer-brand-block">
          <span className="brand-mark footer-mark">RP</span>
          <div>
            <strong>Riverpark RV Resort</strong>
            <span>Grants Pass, Oregon</span>
          </div>
        </div>
        <div className="footer-contact">
          <a href="tel:+15412951269">541-295-1269</a>
          <span>2956 Rogue River Hwy, Grants Pass, OR</span>
          <nav className="footer-policy-links" aria-label="Legal policies">
            <a href="/?page=privacy">Privacy Policy</a>
            <a href="/?page=terms">Terms of Service</a>
          </nav>
        </div>
        <div className="footer-actions">
          <button
            type="button"
            className="guest-footer-button"
            onClick={onOpenGuest}>
            Manage booking
          </button>
          <button
            type="button"
            className="admin-footer-button"
            onClick={onOpenAdmin}>
            Admin
          </button>
        </div>
      </footer>
    </div>
  );
}

function createGuestReservationEditor(reservation) {
  return {
    email: reservation.email || "",
    rvKind: reservation.rv_kind || "camper",
    motorhomeClassA: Boolean(reservation.motorhome_class_a),
    motorhomeClassC: Boolean(reservation.motorhome_class_c),
    motorhomeWithTow: Boolean(reservation.motorhome_with_tow),
    slideDriverSide: Boolean(reservation.slide_driver_side),
    slidePassengerSide: Boolean(reservation.slide_passenger_side),
    rigLengthFeet: String(reservation.rig_length_feet || ""),
    siteStays: reservation.siteStays.map((segment) => ({
      siteId: String(segment.site_id),
      siteNumber: segment.site_number,
      arrivalDate: segment.arrival_date,
      leaveDate: segment.isOpenEnded ? "" : segment.leave_date,
    })),
  };
}

function GuestPortal({ onBackHome }) {
  const [credentials, setCredentials] = useState({
    email: "",
  });
  const [verificationCode, setVerificationCode] = useState("");
  const [emailChallengeToken, setEmailChallengeToken] = useState("");
  const [guestAccessToken, setGuestAccessToken] = useState(() => {
    if (typeof window === "undefined") {
      return "";
    }

    return window.sessionStorage.getItem(guestAccessTokenStorageKey) || "";
  });
  const [reservations, setReservations] = useState([]);
  const [activeReservationId, setActiveReservationId] = useState(() => {
    if (typeof window === "undefined") {
      return null;
    }

    const reservationId = Number(
      new URLSearchParams(window.location.search).get("reservationId")
    );
    return reservationId || null;
  });
  const [editor, setEditor] = useState(null);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [cardPayment, setCardPayment] = useState(null);
  const [isOpeningBankPayment, setIsOpeningBankPayment] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isCanceling, setIsCanceling] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [guestAvailabilityByStay, setGuestAvailabilityByStay] = useState({});
  const [isLoadingGuestAvailability, setIsLoadingGuestAvailability] =
    useState(false);
  const [guestAvailabilityError, setGuestAvailabilityError] = useState("");
  const activeReservation =
    reservations.find(
      (reservation) => reservation.id === activeReservationId
    ) || null;
  const activeReservationNightCount = activeReservation?.siteStays.reduce(
    (total, stay) =>
      total +
      Number(
        stay.numberOfNights ??
          nightsBetween(stay.arrival_date, stay.leave_date) ??
          0
      ),
    0
  );
  const guestAvailabilitySignature = editor
    ? JSON.stringify({
        rvKind: editor.rvKind,
        rigLengthFeet: editor.rigLengthFeet,
        slideDriverSide: editor.slideDriverSide,
        slidePassengerSide: editor.slidePassengerSide,
        siteStays: editor.siteStays.map((stay) => ({
          siteId: stay.siteId,
          arrivalDate: stay.arrivalDate,
          leaveDate: stay.leaveDate,
        })),
      })
    : "";

  function selectReservation(reservation) {
    setActiveReservationId(reservation.id);
    setEditor(createGuestReservationEditor(reservation));
    setPaymentAmount(
      Number(reservation.cardRemainingBalance || 0) > 0
        ? Number(reservation.cardRemainingBalance).toFixed(2)
        : ""
    );
    setCardPayment(null);
    setErrorMessage("");
    setSuccessMessage("");
  }

  async function loadGuestReservations({ showLoading = true } = {}) {
    if (showLoading) {
      setIsSigningIn(true);
    }

    setErrorMessage("");

    try {
      const result = await guestApiRequest("/guest/reservations/sign-in", {
        method: "POST",
        body: JSON.stringify(
          guestAccessToken
            ? { accessToken: guestAccessToken }
            : {
                challengeToken: emailChallengeToken,
                verificationCode,
              }
        ),
      });
      const nextReservations = ensureArray(result.reservations, "Reservations");

      const nextAccessToken = result.accessToken || guestAccessToken;
      setGuestAccessToken(nextAccessToken);
      window.sessionStorage.setItem(guestAccessTokenStorageKey, nextAccessToken);
      setReservations(nextReservations);

      if (!nextReservations.length) {
        setActiveReservationId(null);
        setEditor(null);
        setErrorMessage("No reservations were found for this guest.");
        return;
      }

      const nextActiveReservation =
        nextReservations.find(
          (reservation) => reservation.id === activeReservationId
        ) || nextReservations[0];
      setActiveReservationId(nextActiveReservation.id);
      setEditor(createGuestReservationEditor(nextActiveReservation));
      setGuestAvailabilityByStay({});
      setGuestAvailabilityError("");
      setPaymentAmount(
        Number(nextActiveReservation.cardRemainingBalance || 0) > 0
          ? Number(nextActiveReservation.cardRemainingBalance).toFixed(2)
          : ""
      );
    } catch (error) {
      setErrorMessage(error.message);
      setReservations([]);
      setActiveReservationId(null);
      setEditor(null);
      setGuestAvailabilityByStay({});
    } finally {
      setIsSigningIn(false);
    }
  }

  function handleSignIn(event) {
    event.preventDefault();
    setSuccessMessage("");
    loadGuestReservations();
  }

  useEffect(() => {
    if (!guestAccessToken) {
      return;
    }

    const returnState = new URLSearchParams(window.location.search).get(
      "guest_payment"
    );

    loadGuestReservations({ showLoading: true });

    if (returnState === "return") {
      setSuccessMessage(
        "Your bank payment was submitted. Bank payments can take several business days for Stripe to confirm."
      );
    } else if (returnState === "cancel") {
      setErrorMessage("Bank payment was canceled. No new payment was submitted.");
    }
  }, []);

  async function requestGuestVerificationCode(event) {
    event.preventDefault();
    setIsSigningIn(true);
    setErrorMessage("");
    setSuccessMessage("");

    try {
      const result = await guestApiRequest(
        "/guest/reservations/request-code",
        {
          method: "POST",
          body: JSON.stringify({ email: credentials.email }),
        }
      );

      setEmailChallengeToken(result.challengeToken || "");
      setVerificationCode("");
      setSuccessMessage(
        result.message || "Check your email for a verification code."
      );
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsSigningIn(false);
    }
  }

  function resetGuestEmailVerification() {
    setEmailChallengeToken("");
    setVerificationCode("");
    setErrorMessage("");
    setSuccessMessage("");
  }

  function updateEditorField(field, value) {
    setEditor((current) => {
      if (field === "rvKind") {
        return {
          ...current,
          rvKind: value,
          motorhomeClassA:
            value === "motor home" ? current.motorhomeClassA : false,
          motorhomeClassC:
            value === "motor home" ? current.motorhomeClassC : false,
          motorhomeWithTow:
            value === "motor home" ? current.motorhomeWithTow : false,
        };
      }

      return { ...current, [field]: value };
    });
  }

  function updateGuestStay(index, field, value) {
    setEditor((current) => ({
      ...current,
      siteStays: current.siteStays.map((stay, stayIndex) =>
        stayIndex === index ? { ...stay, [field]: value } : stay
      ),
    }));
  }

  useEffect(() => {
    let isCancelled = false;

    async function loadGuestAvailabilityPreview() {
      if (!activeReservation || !editor) {
        return;
      }

      const hasIncompleteStay = editor.siteStays.some((stay) => {
        if (!stay.siteId || !stay.arrivalDate) {
          return true;
        }

        if (activeReservation.reservation_term === "yearly") {
          return false;
        }

        return !stay.leaveDate;
      });

      if (hasIncompleteStay) {
        setGuestAvailabilityByStay({});
        setGuestAvailabilityError("");
        return;
      }

      setIsLoadingGuestAvailability(true);
      setGuestAvailabilityError("");

      try {
        const result = await guestApiRequest(
          `/guest/reservations/${activeReservation.id}/availability-preview`,
          {
            method: "POST",
            body: JSON.stringify({
              credentials: { accessToken: guestAccessToken },
              rvKind: editor.rvKind,
              rigLengthFeet: editor.rigLengthFeet,
              slideDriverSide: editor.slideDriverSide,
              slidePassengerSide: editor.slidePassengerSide,
              siteStays: editor.siteStays.map((stay) => ({
                siteId: stay.siteId,
                arrivalDate: stay.arrivalDate,
                leaveDate:
                  activeReservation.reservation_term === "yearly"
                    ? ""
                    : stay.leaveDate,
              })),
            }),
          }
        );

        if (isCancelled) {
          return;
        }

        const nextAvailability = {};
        ensureArray(result.stays, "Guest availability").forEach((stay) => {
          nextAvailability[`${stay.siteId}-${stay.index}`] = {
            currentSiteAvailable: stay.currentSiteAvailable,
            bookedRanges: ensureArray(stay.bookedRanges || [], "Site bookings"),
            directMatches: ensureArray(stay.directMatches || [], "Site matches"),
            previousBookedUntil: stay.previousBookedUntil || null,
            nextBookedFrom: stay.nextBookedFrom || null,
          };
        });

        setGuestAvailabilityByStay(nextAvailability);
      } catch (error) {
        if (!isCancelled) {
          setGuestAvailabilityError(error.message);
          setGuestAvailabilityByStay({});
        }
      } finally {
        if (!isCancelled) {
          setIsLoadingGuestAvailability(false);
        }
      }
    }

    loadGuestAvailabilityPreview();

    return () => {
      isCancelled = true;
    };
  }, [
    activeReservation?.id,
    activeReservation?.reservation_term,
    guestAccessToken,
    editor,
    guestAvailabilitySignature,
  ]);

  async function saveGuestChanges(event) {
    event.preventDefault();

    if (!activeReservation || !editor) {
      return;
    }

    setIsSaving(true);
    setErrorMessage("");
    setSuccessMessage("");

    try {
      const updatedReservation = await guestApiRequest(
        `/guest/reservations/${activeReservation.id}`,
        {
          method: "PUT",
          body: JSON.stringify({
            credentials: { accessToken: guestAccessToken },
            email: editor.email,
            rvKind: editor.rvKind,
            motorhomeClassA: editor.motorhomeClassA,
            motorhomeClassC: editor.motorhomeClassC,
            motorhomeWithTow: editor.motorhomeWithTow,
            slideDriverSide: editor.slideDriverSide,
            slidePassengerSide: editor.slidePassengerSide,
            rigLengthFeet: editor.rigLengthFeet,
            siteStays: editor.siteStays.map((stay) => ({
              siteId: stay.siteId,
              arrivalDate: stay.arrivalDate,
              leaveDate: stay.leaveDate,
            })),
          }),
        }
      );

      setReservations((current) =>
        current.map((reservation) =>
          reservation.id === updatedReservation.id
            ? updatedReservation
            : reservation
        )
      );
      setEditor(createGuestReservationEditor(updatedReservation));
      setSuccessMessage("Your reservation changes have been saved.");
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsSaving(false);
    }
  }

  async function prepareGuestPayment() {
    if (!activeReservation) {
      return;
    }

    setErrorMessage("");
    setSuccessMessage("");
    setCardPayment(null);

    try {
      const payment = await guestApiRequest(
        `/guest/reservations/${activeReservation.id}/payment-intents`,
        {
          method: "POST",
          body: JSON.stringify({
            credentials: { accessToken: guestAccessToken },
            amount: paymentAmount,
          }),
        }
      );
      setCardPayment(payment);
    } catch (error) {
      setErrorMessage(error.message);
    }
  }

  async function startGuestBankPayment() {
    if (!activeReservation) {
      return;
    }

    setIsOpeningBankPayment(true);
    setErrorMessage("");
    setSuccessMessage("");

    try {
      window.sessionStorage.setItem(
        guestAccessTokenStorageKey,
        guestAccessToken
      );
      const checkout = await guestApiRequest(
        `/guest/reservations/${activeReservation.id}/bank-checkouts`,
        {
          method: "POST",
          body: JSON.stringify({
            credentials: { accessToken: guestAccessToken },
            baseUrl: window.location.origin,
          }),
        }
      );
      window.location.assign(checkout.checkoutUrl);
    } catch (error) {
      setErrorMessage(error.message);
      setIsOpeningBankPayment(false);
    }
  }

  async function finishGuestPayment() {
    setCardPayment(null);
    setSuccessMessage("Your card payment was received.");
    await loadGuestReservations({ showLoading: false });
    setSuccessMessage(
      "Your card payment was received and your balance has been updated."
    );
  }

  async function cancelGuestReservation() {
    if (!activeReservation || activeReservation.status === "canceled") {
      return;
    }

    const shouldCancel = window.confirm(
      "Cancel this reservation? Your site will be released, and payments are not automatically refunded."
    );

    if (!shouldCancel) {
      return;
    }

    setIsCanceling(true);
    setErrorMessage("");
    setSuccessMessage("");

    try {
      const canceledReservation = await guestApiRequest(
        `/guest/reservations/${activeReservation.id}/cancel`,
        {
          method: "POST",
          body: JSON.stringify({
            credentials: { accessToken: guestAccessToken },
          }),
        }
      );

      setReservations((current) =>
        current.map((reservation) =>
          reservation.id === canceledReservation.id
            ? canceledReservation
            : reservation
        )
      );
      setEditor(createGuestReservationEditor(canceledReservation));
      setCardPayment(null);
      setSuccessMessage(
        "Your reservation has been canceled. Please call the office with any payment questions."
      );
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsCanceling(false);
    }
  }

  function signOut() {
    setReservations([]);
    setActiveReservationId(null);
    setEditor(null);
    setCardPayment(null);
    setPaymentAmount("");
    setCredentials({ email: "" });
    setVerificationCode("");
    setEmailChallengeToken("");
    setGuestAccessToken("");
    window.sessionStorage.removeItem(guestAccessTokenStorageKey);
    setErrorMessage("");
    setSuccessMessage("");
    setGuestAvailabilityByStay({});
    setGuestAvailabilityError("");
  }

  if (!reservations.length) {
    return (
      <div className="guest-portal-shell">
        <header className="guest-portal-header">
          <button
            type="button"
            className="guest-home-link"
            onClick={onBackHome}>
            <span className="brand-mark">RP</span>
            <span>Riverpark RV Resort</span>
          </button>
          <button
            type="button"
            className="public-calendar-toggle"
            onClick={onBackHome}>
            Back home
          </button>
        </header>
        <main className="guest-signin-layout">
          <div className="guest-signin-copy">
            <p className="eyebrow">Guest reservations</p>
            <h1>
              Your stay,
              <br />
              all in one place.
            </h1>
            <p>
              View your dates and site, update your reservation details, and
              make a secure card payment.
            </p>
            <p>
              If you hate computers and would rather talk to a person, call us
              and we can help with your reservation.
            </p>
            <p>
              <a href="tel:+15412951269">Call or text 541-295-1269</a>
            </p>
            <div className="guest-security-note">
              <strong>Secure email verification.</strong>
              <span>
                We will email a short-lived code to the address on your
                booking.
              </span>
            </div>
          </div>
          <form
            className="guest-signin-card"
            onSubmit={
              emailChallengeToken ? handleSignIn : requestGuestVerificationCode
            }>
            <p className="eyebrow">Find my booking</p>
            <h2>
              {emailChallengeToken
                ? "Enter your email code"
                : "Sign in to your stay"}
            </h2>
            {!emailChallengeToken ? (
              <label>
                Email address
                <input
                  type="email"
                  autoComplete="email"
                  value={credentials.email}
                  onChange={(event) =>
                    setCredentials({ email: event.target.value })
                  }
                  required
                />
              </label>
            ) : (
              <>
                <p className="guest-verification-copy">
                  Enter the six-digit code sent to{" "}
                  <strong>{credentials.email}</strong>.
                </p>
                <label>
                  Verification code
                  <input
                    type="text"
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    maxLength="6"
                    placeholder="123456"
                    value={verificationCode}
                    onChange={(event) =>
                      setVerificationCode(
                        event.target.value.replaceAll(/\D/g, "").slice(0, 6)
                      )
                    }
                    required
                  />
                </label>
              </>
            )}
            {errorMessage ? (
              <div className="public-search-message error">{errorMessage}</div>
            ) : null}
            {successMessage ? (
              <div className="public-search-message success">
                {successMessage}
              </div>
            ) : null}
            <button
              type="submit"
              className="public-search-button"
              disabled={isSigningIn}>
              {isSigningIn
                ? emailChallengeToken
                  ? "Verifying..."
                  : "Sending code..."
                : emailChallengeToken
                  ? "Verify and view booking"
                  : "Email me a code"}
            </button>
            {emailChallengeToken ? (
              <div className="guest-verification-actions">
                <button
                  type="button"
                  className="guest-change-email-button"
                  disabled={isSigningIn}
                  onClick={requestGuestVerificationCode}>
                  Send another code
                </button>
                <button
                  type="button"
                  className="guest-change-email-button"
                  onClick={resetGuestEmailVerification}>
                  Use a different email
                </button>
              </div>
            ) : null}
            <p className="guest-help-copy">
              Trouble signing in? Call or text{" "}
              <a href="tel:+15412951269">541-295-1269</a>.
            </p>
          </form>
        </main>
      </div>
    );
  }

  return (
    <div className="guest-portal-shell guest-dashboard-shell">
      <header className="guest-portal-header">
        <button type="button" className="guest-home-link" onClick={onBackHome}>
          <span className="brand-mark">RP</span>
          <span>Riverpark RV Resort</span>
        </button>
        <div className="guest-header-actions">
          <span>Welcome, {activeReservation?.first_name || "Guest"}</span>
          <button
            type="button"
            className="public-calendar-toggle"
            onClick={signOut}>
            Sign out
          </button>
          <button
            type="button"
            className="public-calendar-toggle"
            onClick={onBackHome}>
            Home
          </button>
        </div>
      </header>

      <main className="guest-dashboard">
        <div className="guest-dashboard-heading">
          <div>
            <p className="eyebrow">My reservations</p>
            <h1>Your Riverpark stay</h1>
          </div>
          {reservations.length > 1 ? (
            <div className="guest-reservation-tabs">
              {reservations.map((reservation) => (
                <button
                  key={reservation.id}
                  type="button"
                  className={
                    reservation.id === activeReservationId ? "active" : ""
                  }
                  onClick={() => selectReservation(reservation)}>
                  #{reservation.id}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {errorMessage ? (
          <div className="public-search-message error guest-message">
            {errorMessage}
          </div>
        ) : null}
        {successMessage ? (
          <div className="public-search-message success guest-message">
            {successMessage}
          </div>
        ) : null}
        {guestAvailabilityError ? (
          <div className="public-search-message error guest-message">
            {guestAvailabilityError}
          </div>
        ) : null}

        {activeReservation && editor ? (
          <div className="guest-dashboard-grid">
            <section className="guest-summary-card">
              <div className="guest-card-kicker">
                <span>Reservation #{activeReservation.id}</span>
                <span
                  className={`status-badge ${getReservationStatusClass(
                    activeReservation.status
                  )}`}>
                  {formatReservationStatus(activeReservation.status)}
                </span>
              </div>
              <h2>
                {activeReservation.siteStays.length === 1
                  ? `Site ${activeReservation.siteStays[0].site_number}`
                  : `${activeReservation.siteStays.length} site stay`}
              </h2>
              <div className="guest-stay-dates">
                <div>
                  <span>Arrival</span>
                  <strong>
                    {formatDisplayDate(
                      activeReservation.siteStays[0]?.arrival_date
                    )}
                  </strong>
                  <small>Check-in 1:00 PM</small>
                </div>
                <div>
                  <span>Departure</span>
                  <strong>
                    {formatLeaveDate(
                      activeReservation.siteStays.at(-1)?.leave_date
                    )}
                  </strong>
                  <small>Check-out 11:00 AM</small>
                </div>
              </div>
              <div className="guest-balance-panel">
                <BookingPriceComparison
                  title="Price per night"
                  bankPrice={activeReservation.effectiveTotalPrice}
                  cardPrice={
                    activeReservation.cardTotalPrice ??
                    getCardPrice(activeReservation.effectiveTotalPrice)
                  }
                  perNight
                  numberOfNights={activeReservationNightCount}
                />
                <BookingPriceComparison
                  title="Balance due"
                  bankPrice={activeReservation.remainingBalance}
                  cardPrice={
                    activeReservation.cardRemainingBalance ??
                    getCardPrice(activeReservation.remainingBalance)
                  }
                />
                <div className="guest-paid-summary">
                  <span>Paid</span>
                  <strong>{formatCurrency(activeReservation.amountPaid)}</strong>
                </div>
              </div>
              <p className="guest-reservation-meta">
                {activeReservation.rv_kind} ·{" "}
                {activeReservation.rig_length_feet || "No size"} ft
                {formatMotorhomeDetails(activeReservation)}
              </p>
              {activeReservation.status !== "canceled" ? (
                <button
                  type="button"
                  className="guest-cancel-reservation-button"
                  disabled={isCanceling}
                  onClick={cancelGuestReservation}>
                  {isCanceling ? "Canceling..." : "Cancel reservation"}
                </button>
              ) : null}
            </section>

            {activeReservation.status !== "canceled" ? (
              <section className="guest-payment-card">
              <p className="eyebrow light">Secure payment</p>
              <h2>Pay toward your stay</h2>
              {Number(activeReservation.remainingBalance || 0) > 0 ? (
                <>
                  <BookingPriceComparison
                    title="Remaining payment options"
                    bankPrice={activeReservation.remainingBalance}
                    cardPrice={
                      activeReservation.cardRemainingBalance ??
                      getCardPrice(activeReservation.remainingBalance)
                    }
                    className="guest-payment-options"
                  />
                  <p className="guest-pricing-note">
                    Choose a secure bank-account payment with no card surcharge,
                    or pay online by card.
                  </p>
                  <button
                    type="button"
                    className="guest-payment-button guest-bank-payment-button"
                    disabled={isOpeningBankPayment}
                    onClick={startGuestBankPayment}>
                    {isOpeningBankPayment
                      ? "Opening Stripe..."
                      : `Pay ${formatCurrency(
                          activeReservation.remainingBalance
                        )} by bank account`}
                  </button>
                  <div className="guest-payment-divider">
                    <span>or pay by card</span>
                  </div>
                  <label>
                    Card payment amount
                    <input
                      type="number"
                      min="0.01"
                      max={
                        activeReservation.cardRemainingBalance ??
                        getCardPrice(activeReservation.remainingBalance)
                      }
                      step="0.01"
                      value={paymentAmount}
                      onChange={(event) => setPaymentAmount(event.target.value)}
                    />
                  </label>
                  {!stripePublishableKey ? (
                    <div className="public-search-message error">
                      Online card payments are not configured yet. Please call
                      the office.
                    </div>
                  ) : cardPayment?.clientSecret ? (
                    <Elements
                      stripe={getStripePromise()}
                      options={{ clientSecret: cardPayment.clientSecret }}>
                      <CardPaymentForm
                        amountLabel={formatCurrency(cardPayment.amount)}
                        clientSecret={cardPayment.clientSecret}
                        reservation={activeReservation}
                        onCancel={() => setCardPayment(null)}
                        onSuccess={finishGuestPayment}
                      />
                    </Elements>
                  ) : (
                    <button
                      type="button"
                      className="guest-payment-button"
                      onClick={prepareGuestPayment}>
                      Continue to card payment
                    </button>
                  )}
                </>
              ) : (
                <div className="guest-paid-state">
                  <strong>Paid in full</strong>
                  <span>
                    There is no remaining balance on this reservation.
                  </span>
                </div>
              )}
              {activeReservation.paymentEvents.length ? (
                <div className="guest-payment-history">
                  <strong>Recent payments</strong>
                  {activeReservation.paymentEvents.slice(0, 3).map((event) => (
                    <div key={event.id}>
                      <span>
                        {formatDisplayDate(
                          String(event.recordedAt).slice(0, 10)
                        )}
                      </span>
                      <strong>{formatCurrency(event.amount)}</strong>
                    </div>
                  ))}
                </div>
              ) : null}
              </section>
            ) : (
              <section className="guest-payment-card guest-canceled-card">
                <p className="eyebrow light">Reservation canceled</p>
                <h2>This stay is canceled.</h2>
                <p>
                  The site has been released. Payments are not automatically
                  refunded; call or text 541-295-1269 with payment questions.
                </p>
                {activeReservation.paymentEvents.length ? (
                  <div className="guest-payment-history">
                    <strong>Recent payments</strong>
                    {activeReservation.paymentEvents.slice(0, 3).map((event) => (
                      <div key={event.id}>
                        <span>
                          {formatDisplayDate(String(event.recordedAt).slice(0, 10))}
                        </span>
                        <strong>{formatCurrency(event.amount)}</strong>
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>
            )}

            {activeReservation.status !== "canceled" ? (
              <form className="guest-edit-card" onSubmit={saveGuestChanges}>
              <div className="guest-edit-heading">
                <div>
                  <p className="eyebrow">Reservation details</p>
                  <h2>Make a change</h2>
                </div>
                <span>Site changes require a call to the office.</span>
              </div>
              <div className="guest-edit-grid">
                <label>
                  Email for receipts
                  <input
                    type="email"
                    value={editor.email}
                    onChange={(event) =>
                      updateEditorField("email", event.target.value)
                    }
                  />
                </label>
                <label>
                  RV type
                  <select
                    value={editor.rvKind}
                    onChange={(event) =>
                      updateEditorField("rvKind", event.target.value)
                    }>
                    {rvKinds.map((kind) => (
                      <option key={kind} value={kind}>
                        {kind}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Rig length (feet)
                  <input
                    type="number"
                    min="1"
                    value={editor.rigLengthFeet}
                    onChange={(event) =>
                      updateEditorField("rigLengthFeet", event.target.value)
                    }
                  />
                </label>
                {editor.rvKind === "motor home" ? (
                  <div className="motorhome-options guest-motorhome-options">
                    <span className="small-text">Motor home details</span>
                    {[
                      ["motorhomeClassA", "Class A"],
                      ["motorhomeClassC", "Class C"],
                      ["motorhomeWithTow", "With tow"],
                    ].map(([field, label]) => (
                      <label
                        key={field}
                        className="checkbox-row compact-checkbox">
                        <input
                          type="checkbox"
                          checked={editor[field]}
                          onChange={(event) =>
                            updateEditorField(field, event.target.checked)
                          }
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                ) : null}
                <SlideSideFields
                  slideDriverSide={editor.slideDriverSide}
                  slidePassengerSide={editor.slidePassengerSide}
                  onChange={updateEditorField}
                  className="guest-motorhome-options"
                />
              </div>
              <div className="guest-date-edit-list">
                {editor.siteStays.map((stay, index) => (
                  <div
                    key={`${stay.siteId}-${index}`}
                    className="guest-stay-editor-card">
                    <div className="guest-date-row">
                      <strong>Site {stay.siteNumber}</strong>
                      <div className="guest-date-pill">
                        <span>Arrival</span>
                        <b>{formatDisplayDate(stay.arrivalDate)}</b>
                      </div>
                      <div className="guest-date-pill">
                        <span>Departure</span>
                        <b>
                          {activeReservation.reservation_term === "yearly"
                            ? "Open ended"
                            : formatDisplayDate(stay.leaveDate)}
                        </b>
                      </div>
                    </div>
                    <p className="muted guest-calendar-helper">
                      Click the calendar to move your dates and check whether
                      this site is still open around your stay.
                    </p>
                    <BookingSiteCalendar
                      segment={stay}
                      bookedRanges={
                        guestAvailabilityByStay[`${stay.siteId}-${index}`]
                          ?.bookedRanges || []
                      }
                      reservationTerm={activeReservation.reservation_term}
                      onSelectRange={(arrivalDate, leaveDate) => {
                        updateGuestStay(index, "arrivalDate", arrivalDate);
                        updateGuestStay(index, "leaveDate", leaveDate);
                      }}
                    />
                    {stay.arrivalDate ? (
                      <p className="muted">
                        {activeReservation.reservation_term === "yearly"
                          ? `Arrival selected: ${formatDisplayDate(
                              stay.arrivalDate
                            )}.`
                          : stay.leaveDate
                          ? `Selected stay: ${formatDisplayDate(
                              stay.arrivalDate
                            )} through ${formatDisplayDate(
                              stay.leaveDate
                            )} (${nightsBetween(
                              stay.arrivalDate,
                              stay.leaveDate
                            )} nights)`
                          : `Arrival selected: ${formatDisplayDate(
                              stay.arrivalDate
                            )}. Pick a later day to finish the stay.`}
                      </p>
                    ) : null}
                    {isLoadingGuestAvailability ? (
                      <div className="public-search-message success guest-availability-message">
                        Checking availability for these dates...
                      </div>
                    ) : guestAvailabilityByStay[`${stay.siteId}-${index}`]
                        ?.currentSiteAvailable === true ? (
                      <div className="public-search-message success guest-availability-message">
                        Site {stay.siteNumber} is open for the dates you
                        selected.
                      </div>
                    ) : guestAvailabilityByStay[`${stay.siteId}-${index}`]
                        ?.currentSiteAvailable === false ? (
                      <div className="guest-alt-site-panel">
                        <div className="public-search-message error guest-availability-message">
                          Site {stay.siteNumber} is not open for the dates you
                          selected.
                        </div>
                        {guestAvailabilityByStay[`${stay.siteId}-${index}`]
                          ?.previousBookedUntil ||
                        guestAvailabilityByStay[`${stay.siteId}-${index}`]
                          ?.nextBookedFrom ? (
                          <div className="guest-availability-context">
                            {guestAvailabilityByStay[`${stay.siteId}-${index}`]
                              ?.previousBookedUntil ? (
                              <span>
                                Booked before this stay through{" "}
                                {formatDisplayDate(
                                  guestAvailabilityByStay[
                                    `${stay.siteId}-${index}`
                                  ].previousBookedUntil
                                )}
                              </span>
                            ) : null}
                            {guestAvailabilityByStay[`${stay.siteId}-${index}`]
                              ?.nextBookedFrom ? (
                              <span>
                                Booked after this stay starting{" "}
                                {formatDisplayDate(
                                  guestAvailabilityByStay[
                                    `${stay.siteId}-${index}`
                                  ].nextBookedFrom
                                )}
                              </span>
                            ) : null}
                          </div>
                        ) : null}
                        <div className="guest-alt-site-results">
                          <strong>Search for other sites available</strong>
                          <span>
                            If you want to move sites, call the office and use
                            these matches as a starting point.
                          </span>
                          <div className="public-site-results guest-site-results">
                            {guestAvailabilityByStay[
                              `${stay.siteId}-${index}`
                            ]?.directMatches.filter(
                              (site) => String(site.id) !== String(stay.siteId)
                            ).length ? (
                              guestAvailabilityByStay[
                                `${stay.siteId}-${index}`
                              ].directMatches
                                .filter(
                                  (site) =>
                                    String(site.id) !== String(stay.siteId)
                                )
                                .slice(0, 4)
                                .map((site) => (
                                  <article key={site.id}>
                                    <div>
                                      <span>Available</span>
                                      <h4>Site {site.siteNumber}</h4>
                                    </div>
                                    <p>
                                      {site.sizeFeet} ft ·{" "}
                                      {getSiteTypeLabel(site)} ·{" "}
                                      {site.numberOfNights} nights
                                    </p>
                                  </article>
                                ))
                            ) : (
                              <p className="guest-no-alt-sites">
                                No single alternate site is open for those
                                exact dates. Call the office and we can help.
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
              <button
                type="submit"
                className="public-search-button"
                disabled={isSaving}>
                {isSaving ? "Saving changes..." : "Save reservation changes"}
              </button>
              </form>
            ) : null}
          </div>
        ) : null}
      </main>
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
  canRemove,
}) {
  const siteSearch = segment.siteSearch?.trim().toLowerCase() || "";
  const filteredSites = [...sites]
    .sort((left, right) =>
      siteNumberCollator.compare(left.site_number, right.site_number)
    )
    .filter((site) =>
      siteSearch ? site.site_number.toLowerCase().includes(siteSearch) : true
    );
  const bookedRanges = bookedRangesBySite[String(segment.siteId)] || [];

  return (
    <div className="segment-card">
      <div className="segment-header">
        <h4>Stay Segment {index + 1}</h4>
        {canRemove ? (
          <button
            type="button"
            className="ghost-button"
            onClick={() => onRemove(index)}>
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
            onChange={(event) =>
              onChange(index, "siteSearch", event.target.value)
            }
          />
        </label>
        <label>
          Site
          <select
            value={segment.siteId}
            onChange={(event) => onChange(index, "siteId", event.target.value)}>
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
            ? `Selected stay: ${formatDisplayDate(
                segment.arrivalDate
              )} through ${formatDisplayDate(
                segment.leaveDate
              )} (${nightsBetween(
                segment.arrivalDate,
                segment.leaveDate
              )} nights)`
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
  onSelectDate,
  isLoading = false,
}) {
  const monthStart = new Date(monthCursor);
  const monthLabel = formatMonthLabel(monthStart);
  const calendarStart = new Date(monthStart);
  calendarStart.setUTCDate(
    calendarStart.getUTCDate() - calendarStart.getUTCDay()
  );
  const days = Array.from({ length: 42 }, (_, index) => {
    const current = new Date(calendarStart);
    current.setUTCDate(calendarStart.getUTCDate() + index);
    const dateString = formatDateInput(current);
    const isCurrentMonth = current.getUTCMonth() === monthStart.getUTCMonth();
    const isSelectedWindow =
      dateString >= selectedStartDate && dateString < selectedEndDate;
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
      bookingNames: [
        ...new Set(matchingBookings.map((range) => range.customerName)),
      ],
    };
  });

  return (
    <div className={`calendar-card ${isLoading ? "loading" : ""}`}>
      <div className="result-header">
        <button
          type="button"
          className="ghost-button"
          onClick={() => onChangeMonth(-1)}>
          Previous
        </button>
        <h3>{monthLabel}</h3>
        <button
          type="button"
          className="ghost-button"
          onClick={() => onChangeMonth(1)}>
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
            title={day.bookingNames.join(", ")}>
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
        <span>
          <i className="legend-box selected" /> selected window
        </span>
        <span>
          <i className="legend-box booked" /> booked
        </span>
      </div>
      {isLoading ? (
        <div className="calendar-loading-overlay" aria-live="polite">
          <div className="loading-spinner" aria-hidden="true" />
          <span>Loading schedule...</span>
        </div>
      ) : null}
    </div>
  );
}

function BookingHistoryCalendar({
  monthCursor,
  selectedDate,
  reservationsByDate,
  onChangeMonth,
  onSelectDate,
}) {
  const monthStart = new Date(monthCursor);
  const monthLabel = formatMonthLabel(monthStart);
  const calendarStart = new Date(monthStart);
  calendarStart.setUTCDate(
    calendarStart.getUTCDate() - calendarStart.getUTCDay()
  );
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
      canceledCount: dayReservations.filter(
        (reservation) => reservation.status === "canceled"
      ).length,
    };
  });

  return (
    <div className="calendar-card">
      <div className="result-header">
        <button
          type="button"
          className="ghost-button"
          onClick={() => onChangeMonth(-1)}>
          Previous
        </button>
        <h3>{monthLabel}</h3>
        <button
          type="button"
          className="ghost-button"
          onClick={() => onChangeMonth(1)}>
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
              day.totalCount && day.canceledCount === day.totalCount
                ? "history-canceled"
                : ""
            }`}
            onClick={() => onSelectDate(day.dateString)}>
            <span>{day.dayNumber}</span>
            {day.totalCount ? (
              <div className="calendar-day-names">
                <small>
                  {day.totalCount} {day.totalCount === 1 ? "activity" : "activities"}
                </small>
                {day.canceledCount ? (
                  <small>{day.canceledCount} canceled</small>
                ) : null}
              </div>
            ) : null}
          </button>
        ))}
      </div>
      <div className="calendar-legend">
        <span>
          <i className="legend-box selected" /> selected day
        </span>
        <span>
          <i className="legend-box history-booked" /> has activity
        </span>
        <span>
          <i className="legend-box history-canceled" /> only canceled
        </span>
      </div>
    </div>
  );
}

function CardPaymentForm({
  amountLabel,
  clientSecret,
  reservation,
  onCancel,
  onSuccess,
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  async function handleSubmit(event) {
    event?.preventDefault?.();
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
            name:
              `${reservation.first_name || ""} ${
                reservation.last_name || ""
              }`.trim() || undefined,
            email: reservation.email || undefined,
            phone: reservation.phone_number || undefined,
          },
        },
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
    <div className="card-payment-form">
      <div className="result-header">
        <h3>Card payment</h3>
        <span className="balance-pill">{amountLabel}</span>
      </div>
      <div className="card-element-shell">
        <CardElement options={cardElementOptions} />
      </div>
      {errorMessage ? <Alert severity="error">{errorMessage}</Alert> : null}
      <div className="button-row">
        <Button
          type="button"
          variant="contained"
          onClick={handleSubmit}
          disabled={!stripe || isSubmitting}>
          {isSubmitting ? "Processing..." : "Charge card"}
        </Button>
        <Button
          type="button"
          variant="outlined"
          onClick={onCancel}
          disabled={isSubmitting}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export default function App() {
  const appPages = [
    { key: "availability", label: "Availability" },
    { key: "reservation", label: "Reservations" },
    { key: "schedule", label: "Schedule" },
    { key: "history", label: "History" },
    { key: "yearly", label: "Yearly" },
    { key: "messages", label: "Text Messages" },
    { key: "sites", label: "Sites" },
  ];
  const stripeReturnState = getStripeReturnState();
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [isCheckingAdminSession, setIsCheckingAdminSession] = useState(false);
  const [adminLoginForm, setAdminLoginForm] = useState({
    username: "",
    password: "",
  });
  const [adminLoginError, setAdminLoginError] = useState("");
  const [isSigningInAdmin, setIsSigningInAdmin] = useState(false);
  const [bookingNotificationStatus, setBookingNotificationStatus] =
    useState("checking");
  const [bookingNotificationMessage, setBookingNotificationMessage] =
    useState("");
  const [isUpdatingBookingNotifications, setIsUpdatingBookingNotifications] =
    useState(false);
  const [textMessageForm, setTextMessageForm] = useState({
    to: "",
    body: "",
  });
  const [textMessages, setTextMessages] = useState([]);
  const [isTextMessagingConfigured, setIsTextMessagingConfigured] =
    useState(null);
  const [missingTextMessageConfig, setMissingTextMessageConfig] = useState([]);
  const [isLoadingTextMessages, setIsLoadingTextMessages] = useState(false);
  const [isSendingTextMessage, setIsSendingTextMessage] = useState(false);
  const [textMessageError, setTextMessageError] = useState("");
  const [textMessageSuccess, setTextMessageSuccess] = useState("");
  const [sites, setSites] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [reservations, setReservations] = useState([]);
  const [hasLoadedSites, setHasLoadedSites] = useState(false);
  const [hasLoadedCustomers, setHasLoadedCustomers] = useState(false);
  const [hasLoadedReservations, setHasLoadedReservations] = useState(false);
  const [isLoadingSites, setIsLoadingSites] = useState(false);
  const [isLoadingCustomers, setIsLoadingCustomers] = useState(false);
  const [isLoadingReservations, setIsLoadingReservations] = useState(false);
  const [timelineSiteId, setTimelineSiteId] = useState("");
  const [timelineSiteSearch, setTimelineSiteSearch] = useState("");
  const [selectedTimelineDate, setSelectedTimelineDate] = useState(
    formatDateInput(new Date())
  );
  const [selectedArrivalDate, setSelectedArrivalDate] = useState(
    formatDateInput(new Date())
  );
  const [timelineMonthCursor, setTimelineMonthCursor] = useState(() =>
    startOfMonth(formatDateInput(new Date()))
  );
  const [selectedHistoryDate, setSelectedHistoryDate] = useState(
    formatDateInput(new Date())
  );
  const [historyMonthCursor, setHistoryMonthCursor] = useState(() =>
    startOfMonth(formatDateInput(new Date()))
  );
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerBookingSearch, setCustomerBookingSearch] = useState("");
  const [isTypeMenuOpen, setIsTypeMenuOpen] = useState(false);
  const [isAvailabilityCalendarOpen, setIsAvailabilityCalendarOpen] =
    useState(false);
  const [isWholeScheduleOpen, setIsWholeScheduleOpen] = useState(false);
  const [isArrivalsTodayOpen, setIsArrivalsTodayOpen] = useState(false);
  const [isSiteMovesOpen, setIsSiteMovesOpen] = useState(false);
  const [activeScheduleReservation, setActiveScheduleReservation] =
    useState(null);
  const [siteFilters, setSiteFilters] = useState(emptySiteFilters);
  const [openSitePricing, setOpenSitePricing] = useState({});
  const [searchForm, setSearchForm] = useState(emptySearch);
  const [customerForm, setCustomerForm] = useState(emptyCustomer);
  const [lastBookedSite, setLastBookedSite] = useState(() =>
    readLastBookedSite()
  );
  const [reservationForm, setReservationForm] = useState(() =>
    createEmptyReservation(readLastBookedSite())
  );
  const [isReservationTotalOverridden, setIsReservationTotalOverridden] =
    useState(false);
  const [isReservationDepositOverridden, setIsReservationDepositOverridden] =
    useState(false);
  const [directMatches, setDirectMatches] = useState([]);
  const [flexibleMatches, setFlexibleMatches] = useState([]);
  const [switchPlan, setSwitchPlan] = useState(null);
  const [switchPlanTotals, setSwitchPlanTotals] = useState(null);
  const [showAllDirectMatches, setShowAllDirectMatches] = useState(false);
  const [showAllSwitchPlanSegments, setShowAllSwitchPlanSegments] =
    useState(false);
  const [availabilityHasSearched, setAvailabilityHasSearched] = useState(false);
  const [availabilityRestriction, setAvailabilityRestriction] = useState("");
  const [isSearchingAvailability, setIsSearchingAvailability] = useState(false);
  const [createdReservation, setCreatedReservation] = useState(null);
  const [editingReservationId, setEditingReservationId] = useState(null);
  const [activePage, setActivePage] = useState(() => {
    if (typeof window === "undefined") {
      return "home";
    }

    const params = new URLSearchParams(window.location.search);
    const requestedAdminPage = params.get("admin");

    if (appPages.some((page) => page.key === requestedAdminPage)) {
      return requestedAdminPage;
    }

    return params.has("guest_payment") ? "guest" : "home";
  });
  const [reservationEditFocusSection, setReservationEditFocusSection] =
    useState("");
  const [reservationEditor, setReservationEditor] = useState(null);
  const [reservationEditorErrorMessage, setReservationEditorErrorMessage] =
    useState("");
  const [reservationEditorSuccessMessage, setReservationEditorSuccessMessage] =
    useState("");
  const [activeReservationNote, setActiveReservationNote] = useState(null);
  const [stayExtensionForm, setStayExtensionForm] = useState(null);
  const [stayExtensionError, setStayExtensionError] = useState("");
  const [isSavingStayExtension, setIsSavingStayExtension] = useState(false);
  const [reservationCardPaymentAmount, setReservationCardPaymentAmount] =
    useState("");
  const [activeSchedulePaymentAmount, setActiveSchedulePaymentAmount] =
    useState("");
  const [generatedPaymentLink, setGeneratedPaymentLink] = useState(null);
  const [paymentLinkErrorMessage, setPaymentLinkErrorMessage] = useState("");
  const [paymentLinkSuccessMessage, setPaymentLinkSuccessMessage] =
    useState("");
  const [reservationCardPayment, setReservationCardPayment] = useState(null);
  const [scheduleCardPayment, setScheduleCardPayment] = useState(null);
  const [openCardActionMenuId, setOpenCardActionMenuId] = useState("");
  const [isEditingSchedulePaymentInfo, setIsEditingSchedulePaymentInfo] =
    useState(false);
  const [activeSiteEditorId, setActiveSiteEditorId] = useState(null);
  const [siteEditorForm, setSiteEditorForm] = useState(null);
  const [siteEditorErrorMessage, setSiteEditorErrorMessage] = useState("");
  const [siteEditorSuccessMessage, setSiteEditorSuccessMessage] = useState("");
  const [schedulePaymentForm, setSchedulePaymentForm] = useState(() =>
    createSchedulePaymentForm()
  );
  const [schedulePaymentErrorMessage, setSchedulePaymentErrorMessage] =
    useState("");
  const [schedulePaymentSuccessMessage, setSchedulePaymentSuccessMessage] =
    useState("");
  const [isOpeningReservationEditor, setIsOpeningReservationEditor] =
    useState(false);
  const [isSavingAdminEdit, setIsSavingAdminEdit] = useState(false);
  const [adminSaveNotice, setAdminSaveNotice] = useState("");
  const [adminConflictNotice, setAdminConflictNotice] = useState("");
  const [confirmationCopyMessage, setConfirmationCopyMessage] = useState("");
  const [sendingConfirmationReservationId, setSendingConfirmationReservationId] =
    useState(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [reservationErrorMessage, setReservationErrorMessage] = useState("");
  const [reservationSuccessMessage, setReservationSuccessMessage] =
    useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [isAdminHeaderCompact, setIsAdminHeaderCompact] = useState(false);
  const [isAdminMobileMenuOpen, setIsAdminMobileMenuOpen] = useState(false);
  const reservationFormRef = useRef(null);
  const reservationCustomerSectionRef = useRef(null);
  const reservationDatesSectionRef = useRef(null);
  const reservationRigSectionRef = useRef(null);
  const reservationNotesSectionRef = useRef(null);
  const reservationSiteSectionRef = useRef(null);
  const sitesRequestRef = useRef(null);
  const customersRequestRef = useRef(null);
  const reservationsRequestRef = useRef(null);
  const liveRefreshTimeoutRef = useRef(null);

  useEffect(() => {
    if (!stripeReturnState.paymentStatus) {
      return;
    }

    const nextUrl = `${window.location.pathname}${window.location.hash || ""}`;
    window.history.replaceState({}, document.title, nextUrl);
  }, [stripeReturnState.paymentStatus]);

  useEffect(() => {
    let isCancelled = false;

    async function checkAdminSession() {
      setIsCheckingAdminSession(true);

      try {
        await apiRequest("/admin/session");

        if (!isCancelled) {
          setIsUnlocked(true);
          setAdminLoginError("");
        }
      } catch {
        if (!isCancelled) {
          setIsUnlocked(false);
        }
      } finally {
        if (!isCancelled) {
          setIsCheckingAdminSession(false);
        }
      }
    }

    checkAdminSession();

    return () => {
      isCancelled = true;
    };
  }, []);

  useEffect(() => {
    function handleUnauthorized() {
      setIsUnlocked(false);
      setAdminLoginError("Your admin session expired. Sign in again.");
      setIsAdminMobileMenuOpen(false);
      setOpenCardActionMenuId("");
    }

    window.addEventListener("rvpark-admin-unauthorized", handleUnauthorized);
    return () => {
      window.removeEventListener("rvpark-admin-unauthorized", handleUnauthorized);
    };
  }, []);

  useEffect(() => {
    if (!isUnlocked || typeof EventSource === "undefined") {
      return undefined;
    }

    let isClosed = false;
    const eventUrl = `${apiBaseUrl}/admin/events?clientId=${encodeURIComponent(
      adminClientId
    )}`;
    const eventSource = new EventSource(eventUrl, { withCredentials: true });

    async function refreshLiveAdminData() {
      try {
        const [reservationData, siteData, customerData] = await Promise.all([
          apiRequest("/reservations"),
          apiRequest("/sites"),
          apiRequest("/customers"),
        ]);

        if (isClosed) {
          return;
        }

        setReservations(ensureArray(reservationData, "Reservations"));
        setSites(ensureArray(siteData, "Sites"));
        setCustomers(ensureArray(customerData, "Customers"));
        setHasLoadedReservations(true);
        setHasLoadedSites(true);
        setHasLoadedCustomers(true);
        setDirectMatches([]);
        setFlexibleMatches([]);
        setSwitchPlan(null);
        setAvailabilityHasSearched(false);
        setAdminSaveNotice("Booking calendar updated from another device.");
      } catch (error) {
        if (!isClosed) {
          setErrorMessage(error.message);
        }
      }
    }

    function handleDataChanged() {
      window.clearTimeout(liveRefreshTimeoutRef.current);
      liveRefreshTimeoutRef.current = window.setTimeout(
        refreshLiveAdminData,
        250
      );
    }

    eventSource.addEventListener("data-changed", handleDataChanged);

    return () => {
      isClosed = true;
      window.clearTimeout(liveRefreshTimeoutRef.current);
      eventSource.removeEventListener("data-changed", handleDataChanged);
      eventSource.close();
    };
  }, [isUnlocked]);

  useEffect(() => {
    if (!isUnlocked) {
      setBookingNotificationStatus("checking");
      setBookingNotificationMessage("");
      return undefined;
    }

    let isCancelled = false;

    async function checkBookingNotificationStatus() {
      if (!supportsBookingPushNotifications()) {
        if (!isCancelled) {
          setBookingNotificationStatus("unsupported");
        }
        return;
      }

      if (Notification.permission === "denied") {
        if (!isCancelled) {
          setBookingNotificationStatus("blocked");
          setBookingNotificationMessage(
            "Notifications are blocked in this phone’s browser settings."
          );
        }
        return;
      }

      try {
        const config = await apiRequest("/push/config");

        if (!config.configured) {
          if (!isCancelled) {
            setBookingNotificationStatus("unconfigured");
          }
          return;
        }

        const registration = await getBookingNotificationRegistration();
        const subscription = await registration.pushManager.getSubscription();

        if (!isCancelled) {
          setBookingNotificationStatus(subscription ? "enabled" : "disabled");
        }
      } catch (error) {
        if (!isCancelled) {
          setBookingNotificationStatus("error");
          setBookingNotificationMessage(error.message);
        }
      }
    }

    checkBookingNotificationStatus();

    return () => {
      isCancelled = true;
    };
  }, [isUnlocked]);

  useEffect(() => {
    if (!isUnlocked || activePage === "home" || activePage === "guest") {
      setIsAdminHeaderCompact(false);
      return undefined;
    }

    function updateAdminHeaderState() {
      setIsAdminHeaderCompact(window.scrollY > 72);
    }

    updateAdminHeaderState();
    window.addEventListener("scroll", updateAdminHeaderState, {
      passive: true,
    });

    return () => {
      window.removeEventListener("scroll", updateAdminHeaderState);
    };
  }, [activePage, isUnlocked]);

  useEffect(() => {
    setIsAdminMobileMenuOpen(false);
  }, [activePage]);

  useEffect(() => {
    if (!adminSaveNotice) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => setAdminSaveNotice(""), 4000);
    return () => window.clearTimeout(timeoutId);
  }, [adminSaveNotice]);

  useEffect(() => {
    if (!adminConflictNotice) {
      return undefined;
    }

    const timeoutId = window.setTimeout(
      () => setAdminConflictNotice(""),
      10000
    );
    return () => window.clearTimeout(timeoutId);
  }, [adminConflictNotice]);

  useEffect(() => {
    if (!isUnlocked) {
      return;
    }

    async function loadDataForActivePage() {
      try {
        if (activePage === "reservation") {
          await Promise.all([
            ensureSitesLoaded(),
            ensureCustomersLoaded(),
            ensureReservationsLoaded(),
          ]);
          return;
        }

        if (activePage === "schedule" || activePage === "history" || activePage === "yearly") {
          await Promise.all([
            ensureSitesLoaded(),
            ensureReservationsLoaded(),
          ]);
          return;
        }

        if (activePage === "messages") {
          await Promise.all([
            ensureCustomersLoaded(),
            loadTextMessageHistory(),
          ]);
          return;
        }

        if (activePage === "sites") {
          await ensureSitesLoaded();
        }
      } catch (error) {
        setErrorMessage(error.message);
      }
    }

    loadDataForActivePage();
  }, [activePage, isUnlocked]);

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

    setSchedulePaymentForm(
      createSchedulePaymentForm(activeScheduleReservation)
    );
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

    window.addEventListener("wheel", preventNumberInputScroll, {
      passive: false,
    });

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

        const selectedSite = sites.find(
          (site) => String(site.id) === String(stay.siteId)
        );

        if (!selectedSite || stay.siteSearch === selectedSite.site_number) {
          return stay;
        }

        hasChanges = true;
        return {
          ...stay,
          siteSearch: selectedSite.site_number,
        };
      });

      return hasChanges
        ? {
            ...current,
            siteStays: nextSiteStays,
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
      if (
        document.visibilityState === "hidden" ||
        !isUnlocked ||
        !hasLoadedSites
      ) {
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
  }, [hasLoadedSites, isUnlocked]);

  useEffect(() => {
    if (reservationForm.reservationTerm !== "yearly") {
      return;
    }

    setReservationForm((current) => ({
      ...current,
      siteStays: current.siteStays.length
        ? [{ ...current.siteStays[0], leaveDate: "" }]
        : [createEmptySiteStay(lastBookedSite)],
    }));
  }, [lastBookedSite, reservationForm.reservationTerm]);

  useEffect(() => {
    setDirectMatches([]);
    setFlexibleMatches([]);
    setSwitchPlan(null);
    setSwitchPlanTotals(null);
    setAvailabilityRestriction("");
    setAvailabilityHasSearched(false);
    setShowAllDirectMatches(false);
    setShowAllSwitchPlanSegments(false);
  }, [searchForm.searchMode]);

  const visibleSites = [...sites]
    .sort((left, right) =>
      siteNumberCollator.compare(left.site_number, right.site_number)
    )
    .filter((site) => {
      const siteLookup = siteFilters.siteLookup.trim().toLowerCase();

      if (siteLookup && !site.site_number.toLowerCase().includes(siteLookup)) {
        return false;
      }

      if (
        siteFilters.types.length > 0 &&
        !matchesSiteTypeFilter(site, siteFilters.types)
      ) {
        return false;
      }

      const minSizeFeet = siteFilters.minSizeFeet
        ? Number(siteFilters.minSizeFeet)
        : null;
      const maxSizeFeet = siteFilters.maxSizeFeet
        ? Number(siteFilters.maxSizeFeet)
        : null;

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
      const numberOfNights = nightsBetween(
        segment.arrivalDate,
        segment.leaveDate
      );

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
        discountPrice: pricingRule?.discountPrice ?? null,
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
          : null,
    }),
    { normalPrice: 0, discountPrice: 0 }
  );
  const reservationNightCount = reservationPricingPreview.reduce(
    (total, segment) => total + segment.numberOfNights,
    0
  );
  const hasRequestedReservationDiscount = reservationForm.discounts.length > 0;
  const selectedSegmentBasePrices = reservationPricingPreview.map((segment) =>
    hasRequestedReservationDiscount
      ? segment.discountPrice ?? segment.normalPrice
      : segment.normalPrice ?? segment.discountPrice
  );
  const selectedBaseReservationTotal =
    selectedSegmentBasePrices.length &&
    selectedSegmentBasePrices.every(
      (price) => price !== null && price !== undefined
    )
      ? selectedSegmentBasePrices.reduce((total, price) => total + price, 0)
      : null;
  const selectedCardReservationTotal =
    reservationPricingPreview.length &&
    selectedSegmentBasePrices.every(
      (price) => price !== null && price !== undefined
    )
      ? reservationPricingPreview.reduce((total, segment, index) => {
          const segmentBasePrice = selectedSegmentBasePrices[index];
          const chargeableNights = calculateChargeableNights(
            segment.numberOfNights
          );

          return chargeableNights === null
            ? null
            : total === null
              ? null
              : total + getCardStayTotal(segmentBasePrice, chargeableNights);
        }, 0)
      : null;
  const needsManualReservationPricing =
    reservationForm.reservationTerm === "yearly" ||
    (reservationForm.siteStays.some(
      (segment) => segment.arrivalDate && segment.leaveDate
    ) && reservationPricingPreview.length !== reservationForm.siteStays.length);
  const utilityPricePreview = calculateUtilityPrice(
    reservationForm.electricMeterReading
  );
  const firstAutoPricedSegment = reservationPricingPreview[0] || null;
  const autoPricedReservationTotal =
    reservationForm.paymentMethod === "card"
      ? selectedCardReservationTotal
      : selectedBaseReservationTotal;
  const firstNightPricingRule = firstAutoPricedSegment?.siteNumber
    ? getPricingRuleForNights(
        siteLookup.get(String(reservationForm.siteStays[0]?.siteId)),
        1
      )
    : null;
  const selectedOneNightPrice = hasRequestedReservationDiscount
    ? firstNightPricingRule?.discountPrice ?? firstNightPricingRule?.normalPrice
    : firstNightPricingRule?.normalPrice ?? firstNightPricingRule?.discountPrice;
  const selectedBankDepositAmount =
    selectedOneNightPrice !== null &&
    selectedOneNightPrice !== undefined &&
    selectedBaseReservationTotal !== null
      ? Math.min(
          selectedOneNightPrice * (reservationNightCount > 7 ? 2 : 1),
          selectedBaseReservationTotal
        )
      : null;
  const selectedCardDepositAmount = getCardPrice(selectedBankDepositAmount);
  const autoPricedDepositAmount =
    reservationForm.paymentMethod === "card"
      ? selectedCardDepositAmount
      : selectedBankDepositAmount;
  const effectiveTotalPreview =
    reservationForm.billingMode === "manual_total"
      ? reservationForm.totalPrice === ""
        ? null
        : Number(reservationForm.totalPrice)
      : reservationForm.billingMode === "monthly"
      ? reservationForm.monthlyRentPrice === "" || utilityPricePreview === null
        ? null
        : Number(reservationForm.monthlyRentPrice) + utilityPricePreview
      : reservationPricingTotals.normalPrice !== null
      ? reservationPricingTotals.normalPrice
      : reservationPricingTotals.discountPrice;

  useEffect(() => {
    if (reservationForm.billingMode !== "manual_total") {
      return;
    }

    const nextTotalPrice =
      autoPricedReservationTotal !== null &&
      autoPricedReservationTotal !== undefined
        ? String(autoPricedReservationTotal)
        : "";
    const nextDepositAmount =
      autoPricedDepositAmount !== null &&
      autoPricedDepositAmount !== undefined
        ? String(autoPricedDepositAmount)
        : "";

    if (!editingReservationId || !isReservationTotalOverridden) {
      setReservationForm((current) =>
        current.totalPrice === nextTotalPrice
          ? current
          : { ...current, totalPrice: nextTotalPrice }
      );
    }

    if (!editingReservationId || !isReservationDepositOverridden) {
      setReservationForm((current) =>
        current.depositAmount === nextDepositAmount
          ? current
          : { ...current, depositAmount: nextDepositAmount }
      );
    }
  }, [
    autoPricedDepositAmount,
    autoPricedReservationTotal,
    isReservationDepositOverridden,
    isReservationTotalOverridden,
    editingReservationId,
    reservationForm.billingMode,
  ]);
  const visibleCustomers = customers.filter((customer) => {
    const searchValue = customerSearch.trim().toLowerCase();
    const searchPhoneDigits = customerSearch.replaceAll(/\D/g, "");

    if (!searchValue) {
      return true;
    }

    const fullName =
      `${customer.first_name} ${customer.last_name}`.toLowerCase();
    const customerPhoneDigits = String(customer.phone_number || "").replaceAll(
      /\D/g,
      ""
    );

    return (
      fullName.includes(searchValue) ||
      (searchPhoneDigits && customerPhoneDigits.includes(searchPhoneDigits))
    );
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
  const customerBookingSearchPhoneDigits = customerBookingSearch.replaceAll(
    /\D/g,
    ""
  );
  const yearlyReservations = reservations
    .filter(
      (reservation) =>
        reservation.reservation_term === "yearly" &&
        reservation.status !== "canceled"
    )
    .sort((left, right) =>
      (left.booked_date || "").localeCompare(right.booked_date || "")
    );
  const activeReservations = reservations.filter(
    (reservation) => reservation.status !== "canceled"
  );
  const scheduleReservations = [...activeReservations].sort((left, right) => {
    const leftDate = left.siteStays[0]?.arrival_date || "";
    const rightDate = right.siteStays[0]?.arrival_date || "";
    return leftDate.localeCompare(rightDate);
  });
  const bookedRangesBySite = scheduleReservations.reduce(
    (rangesBySite, reservation) => {
      reservation.siteStays.forEach((segment) => {
        const siteId = String(segment.site_id);

        if (!rangesBySite[siteId]) {
          rangesBySite[siteId] = [];
        }

        rangesBySite[siteId].push(segment);
      });

      return rangesBySite;
    },
    {}
  );
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
        activeSiteStays,
      };
    })
    .filter(Boolean);
  const selectedDateArrivalEntries = scheduleReservations
    .map((reservation) => {
      const arrivingSiteStays = reservation.siteStays.filter(
        (segment) => segment.arrival_date === selectedArrivalDate
      );
      const departingSiteStays = reservation.siteStays.filter(
        (segment) => segment.leave_date === selectedArrivalDate
      );

      if (!arrivingSiteStays.length) {
        return null;
      }

      return {
        ...reservation,
        arrivingSiteStays,
        departingSiteStays,
      };
    })
    .filter(Boolean);
  const siteMovesOnSelectedDate = selectedDateArrivalEntries.filter(
    (reservation) => reservation.departingSiteStays.length
  );
  const arrivalsOnSelectedDate = selectedDateArrivalEntries.filter(
    (reservation) => !reservation.departingSiteStays.length
  );
  const customerScheduleResults = [...reservations]
    .filter((reservation) => {
      if (!customerBookingSearchValue) {
        return false;
      }

      const matchesName = `${reservation.first_name} ${reservation.last_name}`
        .toLowerCase()
        .includes(customerBookingSearchValue);
      const reservationPhoneDigits = String(
        reservation.phone_number || ""
      ).replaceAll(/\D/g, "");

      return (
        matchesName ||
        (customerBookingSearchPhoneDigits &&
          reservationPhoneDigits.includes(customerBookingSearchPhoneDigits))
      );
    })
    .sort((left, right) => {
      const leftDate =
        left.siteStays[0]?.arrival_date || left.booked_date || "";
      const rightDate =
        right.siteStays[0]?.arrival_date || right.booked_date || "";
      return leftDate.localeCompare(rightDate);
    });
  const timelineStartDate = formatDateInput(timelineMonthCursor);
  const timelineEndDate = formatDateInput(
    startOfNextMonth(timelineMonthCursor)
  );
  const selectedTimelineSite =
    sites.find((site) => String(site.id) === timelineSiteId) || null;
  const timelineSiteOptions = [...sites]
    .sort((left, right) =>
      siteNumberCollator.compare(left.site_number, right.site_number)
    )
    .filter((site) => {
      const searchValue = timelineSiteSearch.trim().toLowerCase();
      return searchValue
        ? site.site_number.toLowerCase().includes(searchValue)
        : true;
    });
  const selectedSiteBookedRanges = scheduleReservations.flatMap((reservation) =>
    reservation.siteStays
      .filter((segment) => String(segment.site_id) === timelineSiteId)
      .map((segment) => ({
        ...segment,
        customerName: `${reservation.first_name} ${reservation.last_name}`,
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
          segment,
        }))
    )
    .sort((left, right) =>
      left.segment.arrival_date.localeCompare(right.segment.arrival_date)
    );
  const selectedDateReservations = selectedSiteTimeline.filter((entry) =>
    isDateWithinRange(
      selectedTimelineDate,
      entry.segment.arrival_date,
      entry.segment.leave_date
    )
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
  const reservationsByHistoryDate = reservations.reduce(
    (summary, reservation) => {
      const historyDate =
        reservation.status === "canceled" && reservation.canceled_at
          ? getParkDateFromTimestamp(reservation.canceled_at)
          : reservation.booked_date;

      if (!historyDate) {
        return summary;
      }

      const current = summary.get(historyDate) || [];
      current.push(reservation);
      summary.set(historyDate, current);
      return summary;
    },
    new Map()
  );
  const selectedHistoryReservations = [
    ...(reservationsByHistoryDate.get(selectedHistoryDate) || []),
  ].sort((left, right) => right.id - left.id);
  const stayExtensionReservation = stayExtensionForm
    ? reservations.find(
        (reservation) => reservation.id === stayExtensionForm.reservationId
      ) || null
    : null;
  const stayExtensionAvailability = getStayExtensionAvailability(
    stayExtensionReservation,
    reservations
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
    notes: "notes",
  }[reservationEditFocusSection];
  const isReservationPageLoading = isLoadingSites || isLoadingCustomers;
  const isSchedulePageLoading = isLoadingSites || isLoadingReservations;
  const isHistoryPageLoading = isLoadingReservations;
  const isYearlyPageLoading = isLoadingReservations;
  const isSitesPageLoading = isLoadingSites;

  function scrollReservationEditor(sectionKey = "") {
    const sectionMap = {
      customer: reservationCustomerSectionRef,
      dates: reservationDatesSectionRef,
      rig: reservationRigSectionRef,
      notes: reservationNotesSectionRef,
      site: reservationSiteSectionRef,
    };
    const targetRef = sectionMap[sectionKey] || reservationFormRef;

    window.requestAnimationFrame(() => {
      targetRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  }

  async function ensureSitesLoaded({ force = false } = {}) {
    if (hasLoadedSites && !force) {
      return sites;
    }

    if (!force && sitesRequestRef.current) {
      return sitesRequestRef.current;
    }

    setIsLoadingSites(true);

    const request = apiRequest("/sites")
      .then((siteData) => {
        const nextSites = ensureArray(siteData, "Sites");
        setSites(nextSites);
        setHasLoadedSites(true);
        return nextSites;
      })
      .finally(() => {
        setIsLoadingSites(false);
        if (sitesRequestRef.current === request) {
          sitesRequestRef.current = null;
        }
      });

    sitesRequestRef.current = request;
    return request;
  }

  async function ensureCustomersLoaded({ force = false } = {}) {
    if (hasLoadedCustomers && !force) {
      return customers;
    }

    if (!force && customersRequestRef.current) {
      return customersRequestRef.current;
    }

    setIsLoadingCustomers(true);

    const request = apiRequest("/customers")
      .then((customerData) => {
        const nextCustomers = ensureArray(customerData, "Customers");
        setCustomers(nextCustomers);
        setHasLoadedCustomers(true);
        return nextCustomers;
      })
      .finally(() => {
        setIsLoadingCustomers(false);
        if (customersRequestRef.current === request) {
          customersRequestRef.current = null;
        }
      });

    customersRequestRef.current = request;
    return request;
  }

  async function ensureReservationsLoaded({ force = false } = {}) {
    if (hasLoadedReservations && !force) {
      return reservations;
    }

    if (!force && reservationsRequestRef.current) {
      return reservationsRequestRef.current;
    }

    setIsLoadingReservations(true);

    const request = apiRequest("/reservations")
      .then((reservationData) => {
        const nextReservations = ensureArray(
          reservationData,
          "Reservations"
        );
        setReservations(nextReservations);
        setHasLoadedReservations(true);
        return nextReservations;
      })
      .finally(() => {
        setIsLoadingReservations(false);
        if (reservationsRequestRef.current === request) {
          reservationsRequestRef.current = null;
        }
      });

    reservationsRequestRef.current = request;
    return request;
  }

  async function refreshSites() {
    return ensureSitesLoaded({ force: true });
  }

  async function refreshReservationAndSiteData() {
    const [reservationData, siteData] = await Promise.all([
      ensureReservationsLoaded({ force: true }),
      ensureSitesLoaded({ force: true }),
    ]);

    return {
      reservations: reservationData,
      sites: siteData,
    };
  }

  async function handleReservationConflict(error, setLocalMessage) {
    const message =
      error.data?.message ||
      "That site was just booked on another device for overlapping dates.";
    const conflictMessage = `${message} The calendar has been refreshed so you can choose another site.`;

    setLocalMessage(conflictMessage);
    setAdminConflictNotice(conflictMessage);
    setDirectMatches([]);
    setFlexibleMatches([]);
    setSwitchPlan(null);
    setAvailabilityHasSearched(false);

    try {
      await refreshReservationAndSiteData();
    } catch (refreshError) {
      setErrorMessage(refreshError.message);
    }
  }

  function resetReservationForm(defaultSite = lastBookedSite) {
    setReservationForm(createEmptyReservation(defaultSite));
    setIsReservationTotalOverridden(false);
    setIsReservationDepositOverridden(false);
    setCustomerSearch("");
    setCustomerForm(emptyCustomer);
    setEditingReservationId(null);
    setReservationEditFocusSection("");
  }

  function clearSection(sectionKey) {
    const todayDate = formatDateInput(new Date());

    if (sectionKey === "availability") {
      setSearchForm(emptySearch);
      setIsAvailabilityCalendarOpen(false);
      setDirectMatches([]);
      setFlexibleMatches([]);
      setSwitchPlan(null);
      setSwitchPlanTotals(null);
      setAvailabilityHasSearched(false);
      setAvailabilityRestriction("");
      setShowAllDirectMatches(false);
      setShowAllSwitchPlanSegments(false);
      return;
    }

    if (sectionKey === "reservation") {
      resetReservationForm();
      setCreatedReservation(null);
      setReservationCardPaymentAmount("");
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
      setIsSiteMovesOpen(false);
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

    if (sectionKey === "messages") {
      setTextMessageForm({ to: "", body: "" });
      setTextMessageError("");
      setTextMessageSuccess("");
      return;
    }

    if (sectionKey === "sites") {
      setSiteFilters(emptySiteFilters);
      setIsTypeMenuOpen(false);
      setOpenSitePricing({});
      setActiveSiteEditorId(null);
      setSiteEditorForm(null);
      setSiteEditorErrorMessage("");
      setSiteEditorSuccessMessage("");
    }
  }

  function updateSearchField(field, value) {
    setAvailabilityHasSearched(false);
    setDirectMatches([]);
    setFlexibleMatches([]);
    setSwitchPlan(null);
    setSwitchPlanTotals(null);
    setAvailabilityRestriction("");

    setSearchForm((current) => {
      if (field === "rvKind") {
        return {
          ...current,
          rvKind: value,
          motorhomeClassA:
            value === "motor home" ? current.motorhomeClassA : false,
          motorhomeClassC:
            value === "motor home" ? current.motorhomeClassC : false,
          motorhomeWithTow:
            value === "motor home" ? current.motorhomeWithTow : false,
          towVehicleLengthFeet:
            value === "motor home" ? current.towVehicleLengthFeet : "",
          towVehicleType:
            value === "5th wheel" && current.towVehicleType === "suv"
              ? ""
              : ["camper", "trailer", "5th wheel"].includes(value)
              ? current.towVehicleType
              : "",
          rigLengthFeet: value ? current.rigLengthFeet : "",
          slideDriverSide: value ? current.slideDriverSide : false,
          slidePassengerSide: value ? current.slidePassengerSide : false,
        };
      }

      if (field === "motorhomeWithTow") {
        return {
          ...current,
          motorhomeWithTow: value,
          towVehicleLengthFeet: value
            ? current.towVehicleLengthFeet
            : "",
        };
      }

      if (field === "searchMode") {
        return {
          ...current,
          searchMode: value,
        };
      }

      return { ...current, [field]: value };
    });
  }

  async function handleUnlock(event) {
    event.preventDefault();

    setAdminLoginError("");
    setIsSigningInAdmin(true);

    try {
      await apiRequest("/admin/session", {
        method: "POST",
        body: JSON.stringify(adminLoginForm),
      });

      setIsUnlocked(true);
      setAdminLoginForm((current) => ({ ...current, password: "" }));
    } catch (error) {
      setAdminLoginError(error.message);
    } finally {
      setIsSigningInAdmin(false);
    }
  }

  async function toggleBookingNotifications() {
    setBookingNotificationMessage("");

    if (!supportsBookingPushNotifications()) {
      setBookingNotificationStatus("unsupported");
      setBookingNotificationMessage(
        "On iPhone, open this site in Safari, choose Share → Add to Home Screen, then open the new Riverpark icon and enable alerts."
      );
      return;
    }

    setIsUpdatingBookingNotifications(true);

    try {
      const registration = await getBookingNotificationRegistration();
      const existingSubscription =
        await registration.pushManager.getSubscription();

      if (existingSubscription && bookingNotificationStatus === "enabled") {
        await apiRequest("/push/subscriptions", {
          method: "DELETE",
          body: JSON.stringify({ endpoint: existingSubscription.endpoint }),
        });
        await existingSubscription.unsubscribe();
        setBookingNotificationStatus("disabled");
        setBookingNotificationMessage(
          "Online-booking alerts are off on this phone."
        );
        return;
      }

      const config = await apiRequest("/push/config");

      if (!config.configured || !config.publicKey) {
        setBookingNotificationStatus("unconfigured");
        throw new Error(
          "Add the VAPID server variables before enabling booking alerts."
        );
      }

      const permission = await Notification.requestPermission();

      if (permission !== "granted") {
        setBookingNotificationStatus(
          permission === "denied" ? "blocked" : "disabled"
        );
        throw new Error(
          permission === "denied"
            ? "Notifications were blocked. Allow them in this phone’s browser settings, then try again."
            : "Notification permission was not granted."
        );
      }

      const subscription =
        existingSubscription ||
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(config.publicKey),
        }));

      await apiRequest("/push/subscriptions", {
        method: "POST",
        body: JSON.stringify(subscription.toJSON()),
      });

      setBookingNotificationStatus("enabled");
      setBookingNotificationMessage(
        "This phone will now alert you when an online booking is paid and confirmed."
      );
    } catch (error) {
      setBookingNotificationMessage(error.message);
    } finally {
      setIsUpdatingBookingNotifications(false);
    }
  }

  async function loadTextMessageHistory() {
    setIsLoadingTextMessages(true);
    setTextMessageError("");

    try {
      const result = await apiRequest("/messages");
      setIsTextMessagingConfigured(Boolean(result.configured));
      setMissingTextMessageConfig(
        Array.isArray(result.missing) ? result.missing : []
      );
      setTextMessages(Array.isArray(result.messages) ? result.messages : []);

      if (result.historyError) {
        setTextMessageError(result.historyError);
      }
    } catch (error) {
      setTextMessageError(error.message);
    } finally {
      setIsLoadingTextMessages(false);
    }
  }

  async function sendTextMessage(event) {
    event.preventDefault();
    setIsSendingTextMessage(true);
    setTextMessageError("");
    setTextMessageSuccess("");

    try {
      const sentMessage = await apiRequest("/messages", {
        method: "POST",
        body: JSON.stringify(textMessageForm),
      });

      setTextMessages((current) => [
        sentMessage,
        ...current.filter((message) => message.sid !== sentMessage.sid),
      ]);
      setTextMessageForm((current) => ({ ...current, body: "" }));
      setTextMessageSuccess(
        `Message queued for ${formatPhoneNumber(sentMessage.to)}.`
      );
    } catch (error) {
      setTextMessageError(error.message);
    } finally {
      setIsSendingTextMessage(false);
    }
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
        types: nextTypes,
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
        [siteId]: nextDays,
      };
    });
  }

  function updateCustomerField(field, value) {
    setCustomerForm((current) => ({ ...current, [field]: value }));
  }

  function useExistingCustomer(customer) {
    setReservationForm((current) => ({
      ...current,
      customerId: String(customer.id),
    }));
    setCustomerSearch(`${customer.first_name} ${customer.last_name}`);
    setCustomerForm({
      firstName: customer.first_name || "",
      lastName: customer.last_name || "",
      email: customer.email || "",
      phoneNumber: formatPhoneNumber(customer.phone_number || ""),
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
        discounts: reservation.requestedDiscounts || [],
        paymentMethod: reservation.selectedPaymentMethod || "bank",
        depositAmount: reservation.depositAmount,
        totalPrice: reservation.totalPrice,
        monthlyRentPrice: reservation.monthlyRentPrice,
        electricMeterReading: reservation.electricMeterReading,
        rvKind: reservation.rv_kind,
        motorhomeClassA: Boolean(reservation.motorhome_class_a),
        motorhomeClassC: Boolean(reservation.motorhome_class_c),
        motorhomeWithTow: Boolean(reservation.motorhome_with_tow),
        slideDriverSide: Boolean(reservation.slide_driver_side),
        slidePassengerSide: Boolean(reservation.slide_passenger_side),
        rigLengthFeet: reservation.rig_length_feet,
        amountPaid: reservation.amountPaid,
        notes: reservation.notes || "",
        siteStays: reservation.siteStays.map((segment) => ({
          siteId: String(segment.site_id),
          arrivalDate: segment.arrival_date,
          leaveDate: isOpenEndedStay(segment.leave_date)
            ? ""
            : segment.leave_date,
        })),
      };

      const canceledReservation = await apiRequest(`/reservations/${reservationId}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });

      if (activeScheduleReservation?.id === reservationId) {
        setActiveScheduleReservation(null);
      }

      await refreshReservationAndSiteData();
      const cancellationEmailMessage =
        canceledReservation.cancellationEmail?.message || "";

      setSuccessMessage(
        `Canceled reservation #${reservationId}.${
          canceledReservation.cancellationEmail?.sent && cancellationEmailMessage
            ? ` ${cancellationEmailMessage}`
            : ""
        }`
      );

      if (
        canceledReservation.cancellationEmail &&
        !canceledReservation.cancellationEmail.sent &&
        cancellationEmailMessage
      ) {
        setErrorMessage(cancellationEmailMessage);
      }
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
          motorhomeClassA:
            value === "motor home" ? current.motorhomeClassA : false,
          motorhomeClassC:
            value === "motor home" ? current.motorhomeClassC : false,
          motorhomeWithTow:
            value === "motor home" ? current.motorhomeWithTow : false,
        };
      }

      return { ...current, [field]: value };
    });
  }

  function updateReservationPriceChoice(field, value) {
    setIsReservationTotalOverridden(false);
    setIsReservationDepositOverridden(false);
    updateReservationField(field, value);
  }

  function updateSiteStay(index, field, value) {
    setReservationForm((current) => {
      const nextSiteStays = current.siteStays.map((stay, stayIndex) => {
        if (stayIndex !== index) {
          return stay;
        }

        if (field === "siteId") {
          return {
            ...stay,
            siteId: value,
          };
        }

        return { ...stay, [field]: value };
      });

      return {
        ...current,
        siteStays: nextSiteStays,
      };
    });
  }

  function addSiteStay() {
    setReservationForm((current) => ({
      ...current,
      siteStays: [...current.siteStays, createEmptySiteStay()],
    }));
  }

  function removeSiteStay(index) {
    setReservationForm((current) => ({
      ...current,
      siteStays: current.siteStays.filter(
        (_, stayIndex) => stayIndex !== index
      ),
    }));
  }

  async function handleAvailabilitySearch(
    event,
    { applySiteFitRestrictions = true } = {}
  ) {
    event.preventDefault();
    setErrorMessage("");
    setSuccessMessage("");
    setReservationErrorMessage("");
    setReservationSuccessMessage("");
    setCreatedReservation(null);
    setDirectMatches([]);
    setFlexibleMatches([]);
    setSwitchPlan(null);
    setSwitchPlanTotals(null);
    setAvailabilityRestriction("");
    setShowAllDirectMatches(false);
    setShowAllSwitchPlanSegments(false);
    setAvailabilityHasSearched(false);
    setIsSearchingAvailability(true);

    try {
      if (!searchForm.rvKind) {
        throw new Error("Choose an RV type.");
      }

      const rigLength = Number(searchForm.rigLengthFeet);

      if (!Number.isFinite(rigLength) || rigLength <= 0) {
        throw new Error("Enter your rig length in feet.");
      }

      const isPublicMotorhomeWithTow =
        !applySiteFitRestrictions &&
        searchForm.rvKind === "motor home" &&
        searchForm.motorhomeWithTow;
      const towVehicleLength = Number(searchForm.towVehicleLengthFeet);

      if (
        isPublicMotorhomeWithTow &&
        (!Number.isFinite(towVehicleLength) || towVehicleLength <= 0)
      ) {
        throw new Error("Enter the tow vehicle length in feet.");
      }

      const motorhomeRequiredSiteLength = isPublicMotorhomeWithTow
        ? rigLength + towVehicleLength + 3
        : null;
      const needsTowVehicleType =
        !applySiteFitRestrictions &&
        ["camper", "trailer", "5th wheel"].includes(searchForm.rvKind);

      if (needsTowVehicleType && !searchForm.towVehicleType) {
        throw new Error("Choose the vehicle used with your RV.");
      }

      const towVehicleAdditionalFeet =
        {
          suv: 10,
          truck_short_bed: 15,
          truck_long_bed: 18,
          dually: 18,
        }[searchForm.towVehicleType] ?? null;
      const towableRequiredSiteLength =
        needsTowVehicleType && towVehicleAdditionalFeet !== null
          ? rigLength + towVehicleAdditionalFeet
          : null;
      const publicRequiredSiteLength =
        motorhomeRequiredSiteLength ?? towableRequiredSiteLength ?? rigLength;

      const searchPayload = {
        ...searchForm,
        minSizeFeet: applySiteFitRestrictions
          ? Math.max(1, rigLength - 5)
          : publicRequiredSiteLength,
        rvKind: searchForm.rvKind,
        isPublicGuestSearch: !applySiteFitRestrictions,
      };

      if (searchForm.searchMode === "flexible") {
        const flexibleResult = await apiRequest("/availability/flexible-search", {
          method: "POST",
          body: JSON.stringify(searchPayload),
        });

        setFlexibleMatches(
          ensureArray(flexibleResult.matches, "Flexible availability")
        );
        setAvailabilityRestriction(flexibleResult.restriction || "");
      } else {
        if (!searchForm.arrivalDate || !searchForm.leaveDate) {
          throw new Error("Choose both an arrival and departure date.");
        }

        const [searchResult, planResult] = await Promise.all([
          apiRequest("/availability/search", {
            method: "POST",
            body: JSON.stringify(searchPayload),
          }),
          apiRequest("/availability/plan", {
            method: "POST",
            body: JSON.stringify(searchPayload),
          }),
        ]);

        setDirectMatches(
          ensureArray(searchResult.directMatches, "Availability")
        );
        setSwitchPlan(planResult.plan);
        setSwitchPlanTotals(planResult.totals);
        setAvailabilityRestriction(
          searchResult.restriction || planResult.restriction || ""
        );
      }
      setAvailabilityHasSearched(true);
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsSearchingAvailability(false);
    }
  }

  async function handleReservationCreate(event) {
    event.preventDefault();
    const isSavingExistingReservation = Boolean(editingReservationId);

    if (isSavingExistingReservation) {
      setIsSavingAdminEdit(true);
    }
    setErrorMessage("");
    setSuccessMessage("");
    setReservationErrorMessage("");
    setReservationSuccessMessage("");
    setGeneratedPaymentLink(null);
    setPaymentLinkErrorMessage("");
    setPaymentLinkSuccessMessage("");
    setReservationCardPayment(null);
    setReservationCardPaymentAmount("");
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
        throw new Error(
          "A deposit amount is required to create a reservation."
        );
      }

      if (!customerId) {
        const createdCustomer = await apiRequest("/customers", {
          method: "POST",
          body: JSON.stringify(customerForm),
        });

        setCustomers((current) => [...current, createdCustomer]);
        setCustomerSearch(
          `${createdCustomer.first_name} ${createdCustomer.last_name}`
        );
        customerId = createdCustomer.id;
      } else {
        const existingCustomer =
          customers.find((customer) => customer.id === customerId) ||
          customers.find(
            (customer) => String(customer.id) === String(customerId)
          );
        const shouldUpdateCustomer =
          !existingCustomer ||
          customerForm.firstName !== (existingCustomer.first_name || "") ||
          customerForm.lastName !== (existingCustomer.last_name || "") ||
          customerForm.email !== (existingCustomer.email || "") ||
          customerForm.phoneNumber !==
            formatPhoneNumber(existingCustomer.phone_number || "");

        if (shouldUpdateCustomer) {
          const updatedCustomer = await apiRequest(`/customers/${customerId}`, {
            method: "PUT",
            body: JSON.stringify(customerForm),
          });

          setCustomers((current) =>
            current.map((customer) =>
              customer.id === updatedCustomer.id ? updatedCustomer : customer
            )
          );
          setCustomerSearch(
            `${updatedCustomer.first_name} ${updatedCustomer.last_name}`
          );
        } else if (existingCustomer) {
          setCustomerSearch(
            `${existingCustomer.first_name} ${existingCustomer.last_name}`
          );
        }
      }

      const payload = {
        ...reservationForm,
        billingMode: "manual_total",
        motorhomeClassA:
          reservationForm.rvKind === "motor home"
            ? reservationForm.motorhomeClassA
            : false,
        motorhomeClassC:
          reservationForm.rvKind === "motor home"
            ? reservationForm.motorhomeClassC
            : false,
        motorhomeWithTow:
          reservationForm.rvKind === "motor home"
            ? reservationForm.motorhomeWithTow
            : false,
        customerId,
        status: reservationForm.status,
      };
      const created = await apiRequest(
        editingReservationId
          ? `/reservations/${editingReservationId}`
          : "/reservations",
        {
          method: editingReservationId ? "PUT" : "POST",
          body: JSON.stringify(payload),
        }
      );

      if (editingReservationId) {
        setCreatedReservation(created);
        setSuccessMessage(`Updated reservation #${created.id}.`);
        setReservationSuccessMessage(`Updated reservation #${created.id}.`);
        setAdminSaveNotice(`Reservation #${created.id} was saved.`);
      } else {
        setCreatedReservation(created);
        const creationMessage = `Created active reservation #${created.id}.`;
        const emailMessage = created.confirmationEmail?.message || "";

        setSuccessMessage(creationMessage);
        setReservationSuccessMessage(
          created.confirmationEmail?.sent && emailMessage
            ? `${creationMessage} ${emailMessage}`
            : creationMessage
        );
        setConfirmationCopyMessage(emailMessage);

        if (created.confirmationEmail?.sent) {
          setAdminSaveNotice(emailMessage);
        } else if (emailMessage) {
          setReservationErrorMessage(emailMessage);
        }
      }

      const lastUsedSegment = [...reservationForm.siteStays]
        .reverse()
        .find((segment) => segment.siteId);

      let rememberedSite = lastBookedSite;

      if (lastUsedSegment) {
        rememberedSite = {
          siteId: String(lastUsedSegment.siteId),
          siteSearch: lastUsedSegment.siteSearch,
        };

        setLastBookedSite(rememberedSite);
        writeLastBookedSite(rememberedSite);
      }

      await refreshReservationAndSiteData();
      if (isCreatingReservation) {
        setReservationCardPaymentAmount(
          (
            created.selectedPaymentMethod === "card"
              ? created.depositAmount
              : created.cardDepositAmount ?? getCardPrice(depositAmountNumber)
          ).toFixed(2)
        );
      }
      resetReservationForm(rememberedSite);
    } catch (error) {
      if (error.status === 409) {
        await handleReservationConflict(error, setReservationErrorMessage);
      } else {
        setReservationErrorMessage(error.message);
      }
    } finally {
      if (isSavingExistingReservation) {
        setIsSavingAdminEdit(false);
      }
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
    setActivePage("reservation");

    try {
      const reservation = await apiRequest(`/reservations/${reservationId}`);
      setEditingReservationId(reservation.id);
      setCustomerForm({
        firstName: reservation.first_name || "",
        lastName: reservation.last_name || "",
        email: reservation.email || "",
        phoneNumber: formatPhoneNumber(reservation.phone_number || ""),
      });
      setReservationForm({
        customerId: String(reservation.customer_id),
        bookedDate: reservation.booked_date,
        status: reservation.status || "active",
        reservationTerm: reservation.reservation_term || "standard",
        billingMode: "manual_total",
        discounts: reservation.requestedDiscounts || [],
        paymentMethod: reservation.selectedPaymentMethod || "bank",
        depositAmount:
          reservation.depositAmount !== null &&
          reservation.depositAmount !== undefined
            ? String(reservation.depositAmount)
            : "",
        totalPrice:
          reservation.totalPrice !== null &&
          reservation.totalPrice !== undefined
            ? String(reservation.totalPrice)
            : "",
        monthlyRentPrice:
          reservation.monthlyRentPrice !== null &&
          reservation.monthlyRentPrice !== undefined
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
        slideDriverSide: Boolean(reservation.slide_driver_side),
        slidePassengerSide: Boolean(reservation.slide_passenger_side),
        rigLengthFeet: String(reservation.rig_length_feet ?? ""),
        amountPaid: String(reservation.amountPaid ?? ""),
        notes: reservation.notes || "",
        siteStays: reservation.siteStays.map((segment) => ({
          siteId: String(segment.site_id),
          siteSearch: segment.site_number,
          arrivalDate: segment.arrival_date,
          leaveDate: isOpenEndedStay(segment.leave_date)
            ? ""
            : segment.leave_date,
        })),
      });
      setIsReservationTotalOverridden(true);
      setIsReservationDepositOverridden(true);
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
        : null;

    try {
      await navigator.clipboard.writeText(
        buildReservationConfirmationText(createdReservation, paymentContext)
      );
      setConfirmationCopyMessage(
        `Copied confirmation for reservation #${createdReservation.id}.`
      );
    } catch {
      setConfirmationCopyMessage(
        "Copy failed. You can still copy the confirmation text below."
      );
    }
  }

  async function sendReservationConfirmation(reservation) {
    if (!reservation?.email) {
      const message = "Add a customer email address before sending the confirmation.";
      setErrorMessage(message);

      if (createdReservation?.id === reservation?.id) {
        setConfirmationCopyMessage(message);
      }

      return;
    }

    setSendingConfirmationReservationId(reservation.id);
    setErrorMessage("");
    setSuccessMessage("");

    try {
      const result = await apiRequest(
        `/reservations/${reservation.id}/email-confirmation`,
        { method: "POST" }
      );
      const message = result.message || `Confirmation sent to ${reservation.email}.`;

      setSuccessMessage(message);
      setAdminSaveNotice(message);

      if (createdReservation?.id === reservation.id) {
        setConfirmationCopyMessage(message);
        setCreatedReservation((current) => ({
          ...current,
          confirmationEmail: {
            sent: true,
            recipient: reservation.email,
            message,
          },
        }));
      }
    } catch (error) {
      setErrorMessage(error.message);

      if (createdReservation?.id === reservation.id) {
        setConfirmationCopyMessage(error.message);
      }
    } finally {
      setSendingConfirmationReservationId(null);
    }
  }

  function openArrivalTextMessage(reservation, arrivalDate) {
    const phoneNumber = normalizePhoneForSms(reservation?.phone_number);

    if (!phoneNumber) {
      setErrorMessage(
        "Add a customer phone number before opening a text message."
      );
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

  async function createCardPaymentIntent(
    reservationId,
    amount,
    activateReservationOnPayment
  ) {
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

      return await apiRequest(
        `/reservations/${reservationId}/payment-intents`,
        {
          method: "POST",
          body: JSON.stringify({
            amount: amountNumber.toFixed(2),
            activateReservationOnPayment,
          }),
        }
      );
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

  function startEditingSite(site) {
    setActiveSiteEditorId(site.id);
    setSiteEditorForm(createSiteEditorForm(site));
    setSiteEditorErrorMessage("");
    setSiteEditorSuccessMessage("");
  }

  function cancelSiteEditing() {
    setActiveSiteEditorId(null);
    setSiteEditorForm(null);
    setSiteEditorErrorMessage("");
    setSiteEditorSuccessMessage("");
  }

  function updateSiteEditorField(field, value) {
    setSiteEditorForm((current) => {
      if (!current) {
        return current;
      }

      if (field === "isOnRiver") {
        return {
          ...current,
          isOnRiver: value,
          riverCategory: value ? current.riverCategory || "normal_river" : "",
        };
      }

      return {
        ...current,
        [field]: value,
      };
    });
  }

  async function saveSiteDetails() {
    if (!activeSiteEditorId || !siteEditorForm) {
      return;
    }

    setSiteEditorErrorMessage("");
    setSiteEditorSuccessMessage("");
    setErrorMessage("");
    setSuccessMessage("");

    try {
      const updatedSite = await apiRequest(`/sites/${activeSiteEditorId}`, {
        method: "PUT",
        body: JSON.stringify({
          siteNumber: siteEditorForm.siteNumber,
          sizeFeet: siteEditorForm.sizeFeet,
          isOnRiver: siteEditorForm.isOnRiver,
          riverCategory: siteEditorForm.isOnRiver
            ? siteEditorForm.riverCategory
            : "",
          isBigRig: siteEditorForm.isBigRig,
        }),
      });

      await refreshSites();
      setSiteEditorSuccessMessage(
        `Saved site ${updatedSite.site_number || updatedSite.siteNumber}.`
      );
      setSuccessMessage(
        `Saved site ${updatedSite.site_number || updatedSite.siteNumber}.`
      );
      setActiveSiteEditorId(null);
      setSiteEditorForm(null);
    } catch (error) {
      setSiteEditorErrorMessage(error.message);
    }
  }

  async function deleteSite(site) {
    const shouldDelete = window.confirm(`Delete site ${site.site_number}?`);

    if (!shouldDelete) {
      return;
    }

    setSiteEditorErrorMessage("");
    setSiteEditorSuccessMessage("");
    setErrorMessage("");
    setSuccessMessage("");

    try {
      const deletedSite = await apiRequest(`/sites/${site.id}`, {
        method: "DELETE",
      });

      setSites((current) => current.filter((entry) => entry.id !== site.id));
      setOpenSitePricing((current) => {
        const next = { ...current };
        delete next[site.id];
        return next;
      });

      if (activeSiteEditorId === site.id) {
        setActiveSiteEditorId(null);
        setSiteEditorForm(null);
      }

      setSiteEditorSuccessMessage(`Deleted site ${deletedSite.siteNumber}.`);
      setSuccessMessage(`Deleted site ${deletedSite.siteNumber}.`);
    } catch (error) {
      setSiteEditorErrorMessage(error.message);
    }
  }

  async function handleReservationCardPayment(reservation) {
    const result = await createCardPaymentIntent(
      reservation.id,
      reservationCardPaymentAmount,
      true
    );

    if (result) {
      setReservationCardPayment(result);
      setPaymentLinkSuccessMessage("Card form is ready.");
    }
  }

  async function generatePaymentLink(reservation, label = "Payment link") {
    setPaymentLinkErrorMessage("");
    setPaymentLinkSuccessMessage("");

    try {
      if (!reservation?.id || Number(reservation.remainingBalance || 0) <= 0) {
        throw new Error("This reservation does not have a remaining balance.");
      }

      const result = await apiRequest(
        `/reservations/${reservation.id}/payment-links`,
        {
          method: "POST",
          body: JSON.stringify({
            baseUrl: window.location.origin,
          }),
        }
      );

      setGeneratedPaymentLink({
        reservationId: reservation.id,
        amount: result.bankAmount,
        bankAmount: result.bankAmount,
        cardAmount: result.cardAmount,
        checkoutUrl: result.paymentUrl || result.checkoutUrl,
        label,
      });
      setPaymentLinkSuccessMessage(
        `${label} generated for reservation #${reservation.id}.`
      );
      return result;
    } catch (error) {
      setPaymentLinkErrorMessage(error.message);
      return null;
    }
  }

  function openPaymentLinkTextMessage(reservation) {
    if (
      generatedPaymentLink?.reservationId !== reservation?.id ||
      !generatedPaymentLink?.checkoutUrl
    ) {
      setPaymentLinkErrorMessage("Generate the payment link before texting it.");
      return;
    }

    const phoneNumber = normalizePhoneForSms(reservation.phone_number);

    if (!phoneNumber) {
      setPaymentLinkErrorMessage(
        "Add a customer phone number before opening the text message."
      );
      return;
    }

    const message = [
      "Riverpark RV Resort",
      "",
      `Hello ${reservation.first_name || "Guest"},`,
      "",
      "You can securely pay the remaining balance for your stay using the link below. Choose either bank account or credit card payment:",
      generatedPaymentLink.checkoutUrl,
      "",
      "Questions? Call (541) 295-1269.",
      "Reply STOP to unsubscribe or HELP for assistance.",
    ].join("\n");

    window.location.href = buildSmsComposeUrl(phoneNumber, message);
    setPaymentLinkSuccessMessage("Opened a text draft with the payment link.");
    setPaymentLinkErrorMessage("");
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
      const updatedReservation = await apiRequest(
        `/reservations/${reservation.id}/mark-paid`,
        {
          method: "POST",
          body: JSON.stringify({
            paymentSource: "office_card_reader",
          }),
        }
      );

      setReservations((current) =>
        current.map((entry) =>
          entry.id === updatedReservation.id ? updatedReservation : entry
        )
      );

      if (activeScheduleReservation?.id === updatedReservation.id) {
        setActiveScheduleReservation(updatedReservation);
      }

      if (scheduleCardPayment?.reservationId === updatedReservation.id) {
        setScheduleCardPayment(null);
      }

      setSuccessMessage(
        `Marked reservation #${updatedReservation.id} as fully paid.`
      );
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

      const updatedReservation = await apiRequest(
        `/reservations/${reservation.id}/record-payment`,
        {
          method: "POST",
          body: JSON.stringify({
            amount: amountNumber.toFixed(2),
            paymentSource: "office_card_reader",
          }),
        }
      );

      setReservations((current) =>
        current.map((entry) =>
          entry.id === updatedReservation.id ? updatedReservation : entry
        )
      );

      if (activeScheduleReservation?.id === updatedReservation.id) {
        setActiveScheduleReservation(updatedReservation);
      }

      if (scheduleCardPayment?.reservationId === updatedReservation.id) {
        setScheduleCardPayment(null);
      }

      setActiveSchedulePaymentAmount(
        Number(updatedReservation.cardRemainingBalance || 0) > 0
          ? Number(updatedReservation.cardRemainingBalance).toFixed(2)
          : ""
      );
      setSuccessMessage(
        `Recorded office payment for reservation #${updatedReservation.id}.`
      );
    } catch (error) {
      setPaymentLinkErrorMessage(error.message);
    }
  }

  async function recordCreatedReservationOfficePayment(reservation) {
    setErrorMessage("");
    setSuccessMessage("");
    setPaymentLinkErrorMessage("");
    setPaymentLinkSuccessMessage("");

    try {
      const amountNumber = Number(reservationCardPaymentAmount);

      if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
        throw new Error("Enter an office payment amount greater than zero.");
      }

      const updatedReservation = await apiRequest(
        `/reservations/${reservation.id}/record-payment`,
        {
          method: "POST",
          body: JSON.stringify({
            amount: amountNumber.toFixed(2),
            paymentSource: "office_card_reader",
          }),
        }
      );

      setReservations((current) =>
        current.map((entry) =>
          entry.id === updatedReservation.id ? updatedReservation : entry
        )
      );
      setCreatedReservation(updatedReservation);
      setReservationCardPayment(null);
      setReservationCardPaymentAmount(
        Number(updatedReservation.cardRemainingBalance || 0) > 0
          ? Number(updatedReservation.cardRemainingBalance).toFixed(2)
          : ""
      );
      setSuccessMessage(
        `Recorded office payment for reservation #${updatedReservation.id}.`
      );
      setPaymentLinkSuccessMessage(
        `Recorded office payment for reservation #${updatedReservation.id}.`
      );
    } catch (error) {
      setPaymentLinkErrorMessage(error.message);
    }
  }

  async function deleteOfficePaymentRecord(paymentEvent) {
    if (!activeScheduleReservation) {
      return;
    }

    const shouldDelete = window.confirm(
      `Delete office payment record for ${formatCurrency(paymentEvent.amount)}?`
    );

    if (!shouldDelete) {
      return;
    }

    setErrorMessage("");
    setSuccessMessage("");
    setPaymentLinkErrorMessage("");

    try {
      const updatedReservation = await apiRequest(
        `/reservation-payment-events/${paymentEvent.id}`,
        {
          method: "DELETE",
        }
      );

      setReservations((current) =>
        current.map((entry) =>
          entry.id === updatedReservation.id ? updatedReservation : entry
        )
      );

      if (activeScheduleReservation?.id === updatedReservation.id) {
        setActiveScheduleReservation(updatedReservation);
      }

      setActiveSchedulePaymentAmount(
        Number(updatedReservation.cardRemainingBalance || 0) > 0
          ? Number(updatedReservation.cardRemainingBalance).toFixed(2)
          : ""
      );
      setSuccessMessage(
        `Deleted office payment record from reservation #${updatedReservation.id}.`
      );
    } catch (error) {
      setPaymentLinkErrorMessage(error.message);
    }
  }

  async function finalizeCardPayment(reservationId) {
    await apiRequest("/stripe/sync", { method: "POST" });
    const refreshedReservation = await apiRequest(
      `/reservations/${reservationId}`
    );

    setReservations((current) =>
      current.map((entry) =>
        entry.id === refreshedReservation.id ? refreshedReservation : entry
      )
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
      [field]: value,
    }));
  }

  function updateScheduleDiscountQualification(discountQualified) {
    if (!activeScheduleReservation) {
      return;
    }

    const basePrice = discountQualified
      ? activeScheduleReservation.totals?.discountPrice
      : activeScheduleReservation.totals?.normalPrice;

    if (basePrice === null || basePrice === undefined) {
      setSchedulePaymentErrorMessage(
        discountQualified
          ? "Discount pricing is not configured for this stay."
          : "Standard pricing is not configured for this stay."
      );
      return;
    }

    const selectedPrice =
      activeScheduleReservation.selectedPaymentMethod === "card"
        ? getCardStayTotal(
            basePrice,
            activeScheduleReservation.totals?.chargeableNights
          )
        : basePrice;

    setSchedulePaymentForm((current) => ({
      ...current,
      discountQualified,
      totalPrice: String(selectedPrice),
    }));
    setSchedulePaymentErrorMessage("");
    setScheduleCardPayment(null);
    setGeneratedPaymentLink(null);
    setPaymentLinkSuccessMessage("");
  }

  async function saveSchedulePaymentInfo() {
    if (!activeScheduleReservation) {
      return;
    }

    setSchedulePaymentErrorMessage("");
    setSchedulePaymentSuccessMessage("");
    setErrorMessage("");
    setSuccessMessage("");
    setIsSavingAdminEdit(true);

    try {
      const updatedReservation = await apiRequest(
        `/reservations/${activeScheduleReservation.id}`,
        {
          method: "PUT",
          body: JSON.stringify({
            customerId: activeScheduleReservation.customer_id,
            bookedDate: activeScheduleReservation.booked_date,
            status: activeScheduleReservation.status || "active",
            reservationTerm:
              activeScheduleReservation.reservation_term || "standard",
            billingMode:
              activeScheduleReservation.billing_mode || "manual_total",
            depositAmount: schedulePaymentForm.depositAmount,
            totalPrice: schedulePaymentForm.totalPrice,
            monthlyRentPrice: activeScheduleReservation.monthlyRentPrice,
            electricMeterReading:
              activeScheduleReservation.electricMeterReading,
            rvKind: activeScheduleReservation.rv_kind,
            motorhomeClassA: Boolean(
              activeScheduleReservation.motorhome_class_a
            ),
            motorhomeClassC: Boolean(
              activeScheduleReservation.motorhome_class_c
            ),
            motorhomeWithTow: Boolean(
              activeScheduleReservation.motorhome_with_tow
            ),
            slideDriverSide: Boolean(
              activeScheduleReservation.slide_driver_side
            ),
            slidePassengerSide: Boolean(
              activeScheduleReservation.slide_passenger_side
            ),
            rigLengthFeet: activeScheduleReservation.rig_length_feet ?? "",
            amountPaid: schedulePaymentForm.amountPaid,
            notes: activeScheduleReservation.notes || "",
            paymentMethod:
              activeScheduleReservation.selectedPaymentMethod || "bank",
            discounts: schedulePaymentForm.discountQualified
              ? activeScheduleReservation.requestedDiscounts?.length
                ? activeScheduleReservation.requestedDiscounts
                : ["Admin confirmed discount"]
              : [],
            siteStays: (activeScheduleReservation.siteStays || []).map(
              (segment) => ({
                siteId: String(segment.site_id),
                arrivalDate: segment.arrival_date,
                leaveDate: isOpenEndedStay(segment.leave_date)
                  ? ""
                  : segment.leave_date,
              })
            ),
          }),
        }
      );

      setReservations((current) =>
        current.map((entry) =>
          entry.id === updatedReservation.id ? updatedReservation : entry
        )
      );
      setActiveScheduleReservation(updatedReservation);

      if (createdReservation?.id === updatedReservation.id) {
        setCreatedReservation(updatedReservation);
      }

      setGeneratedPaymentLink(null);

      setActiveSchedulePaymentAmount(
        Number(updatedReservation.cardRemainingBalance || 0) > 0
          ? Number(updatedReservation.cardRemainingBalance).toFixed(2)
          : ""
      );
      setSchedulePaymentSuccessMessage(
        `Saved payment info for reservation #${updatedReservation.id}.`
      );
      setSuccessMessage(
        `Saved payment info for reservation #${updatedReservation.id}.`
      );
      setAdminSaveNotice(
        `Payment information for reservation #${updatedReservation.id} was saved.`
      );
      setIsEditingSchedulePaymentInfo(false);
    } catch (error) {
      setSchedulePaymentErrorMessage(error.message);
    } finally {
      setIsSavingAdminEdit(false);
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
        method: "DELETE",
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

  function openStayExtension(reservation) {
    setStayExtensionError("");
    setStayExtensionForm({
      reservationId: reservation.id,
      days: "1",
    });
  }

  function closeStayExtension() {
    if (isSavingStayExtension) {
      return;
    }

    setStayExtensionForm(null);
    setStayExtensionError("");
  }

  async function saveStayExtension(event) {
    event.preventDefault();

    if (!stayExtensionReservation || !stayExtensionAvailability) {
      return;
    }

    const days = Number(stayExtensionForm.days);

    if (!Number.isInteger(days) || days < 1) {
      setStayExtensionError("Enter at least one whole day.");
      return;
    }

    if (
      stayExtensionAvailability.maximumDays !== null &&
      days > stayExtensionAvailability.maximumDays
    ) {
      setStayExtensionError(
        `Only ${stayExtensionAvailability.maximumDays} additional ${
          stayExtensionAvailability.maximumDays === 1 ? "day is" : "days are"
        } open on this site.`
      );
      return;
    }

    setStayExtensionError("");
    setIsSavingStayExtension(true);

    try {
      const updatedReservation = await apiRequest(
        `/reservations/${stayExtensionReservation.id}/extend-stay`,
        {
          method: "POST",
          body: JSON.stringify({ days }),
        }
      );

      setReservations((current) =>
        current.map((reservation) =>
          reservation.id === updatedReservation.id
            ? updatedReservation
            : reservation
        )
      );

      if (activeScheduleReservation?.id === updatedReservation.id) {
        setActiveScheduleReservation(updatedReservation);
      }

      if (createdReservation?.id === updatedReservation.id) {
        setCreatedReservation(updatedReservation);
      }

      setStayExtensionForm(null);
      setSuccessMessage(
        `Added ${days} ${days === 1 ? "day" : "days"} to reservation #${updatedReservation.id}.`
      );
      setAdminSaveNotice(
        `Reservation #${updatedReservation.id} was extended by ${days} ${
          days === 1 ? "day" : "days"
        }.`
      );
    } catch (error) {
      if (error.status === 409) {
        await refreshReservationAndSiteData();
      }
      setStayExtensionError(error.message);
    } finally {
      setIsSavingStayExtension(false);
    }
  }

  function buildReservationEditActions(reservationId) {
    const reservation = reservations.find((entry) => entry.id === reservationId);
    const canExtendStay = Boolean(
      getStayExtensionAvailability(reservation, reservations)
    );

    return [
      ...(canExtendStay
        ? [
            {
              label: "Add days to stay",
              placement: "card",
              onClick: () => openStayExtension(reservation),
            },
          ]
        : []),
      {
        label: "Edit customer information",
        onClick: () => openReservationEditor(reservationId, "customer"),
      },
      {
        label: "Edit dates/site",
        onClick: () => openReservationEditor(reservationId, "dates"),
      },
      {
        label: "Edit rig",
        onClick: () => openReservationEditor(reservationId, "rig"),
      },
      {
        label: "Edit notes",
        onClick: () => openReservationEditor(reservationId, "notes"),
      },
    ];
  }

  function updateReservationEditorCustomerField(field, value) {
    setReservationEditor((current) =>
      current
        ? {
            ...current,
            customer: {
              ...current.customer,
              [field]: value,
            },
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
              value === "motor home"
                ? current.reservation.motorhomeClassA
                : false,
            motorhomeClassC:
              value === "motor home"
                ? current.reservation.motorhomeClassC
                : false,
            motorhomeWithTow:
              value === "motor home"
                ? current.reservation.motorhomeWithTow
                : false,
          },
        };
      }

      return {
        ...current,
        reservation: {
          ...current.reservation,
          [field]: value,
        },
      };
    });
  }

  function updateReservationEditorSiteStay(index, field, value) {
    setReservationEditor((current) => {
      if (!current) {
        return current;
      }

      const nextSiteStays = current.reservation.siteStays.map(
        (stay, stayIndex) => {
          if (stayIndex !== index) {
            return stay;
          }

          if (field === "siteId") {
            return {
              ...stay,
              siteId: value,
            };
          }

          return { ...stay, [field]: value };
        }
      );

      return {
        ...current,
        reservation: {
          ...current.reservation,
          siteStays: nextSiteStays,
        },
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
              siteStays: [
                ...current.reservation.siteStays,
                createEmptySiteStay(),
              ],
            },
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
              siteStays: current.reservation.siteStays.filter(
                (_, stayIndex) => stayIndex !== index
              ),
            },
          }
        : current
    );
  }

  function openScheduleReservation(reservation, options = {}) {
    const { openPaymentEditor = false } = options;

    setActivePage("schedule");
    setActiveSchedulePaymentAmount(
      Number(reservation.cardRemainingBalance || 0) > 0
        ? Number(reservation.cardRemainingBalance).toFixed(2)
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

  async function openReservationEditor(
    reservationId,
    focusSection = "customer"
  ) {
    setErrorMessage("");
    setReservationEditorErrorMessage("");
    setReservationEditorSuccessMessage("");
    setReservationEditFocusSection(focusSection);
    setIsOpeningReservationEditor(true);

    try {
      const reservation = await apiRequest(`/reservations/${reservationId}`);
      setReservationEditor({
        id: reservation.id,
        focusSection,
        ...createReservationEditorState(reservation),
      });
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsOpeningReservationEditor(false);
    }
  }

  function closeReservationEditor() {
    setReservationEditor(null);
    setReservationEditorErrorMessage("");
    setReservationEditorSuccessMessage("");
    setReservationEditFocusSection("");
  }

  function openReservationNote(reservation) {
    if (!reservation?.notes?.trim()) {
      return;
    }

    setActiveReservationNote({
      reservationId: reservation.id,
      guestName: `${reservation.first_name || ""} ${
        reservation.last_name || ""
      }`.trim(),
      notes: reservation.notes.trim(),
    });
  }

  function closeReservationNote() {
    setActiveReservationNote(null);
  }

  async function saveReservationEditor() {
    if (!reservationEditor) {
      return;
    }

    setReservationEditorErrorMessage("");
    setReservationEditorSuccessMessage("");
    setErrorMessage("");
    setSuccessMessage("");
    setIsSavingAdminEdit(true);

    try {
      const customerPayload = {
        firstName: reservationEditor.customer.firstName,
        lastName: reservationEditor.customer.lastName,
        email: reservationEditor.customer.email,
        phoneNumber: reservationEditor.customer.phoneNumber,
      };
      const customerId = Number(reservationEditor.customer.id);
      const updatedCustomer = await apiRequest(`/customers/${customerId}`, {
        method: "PUT",
        body: JSON.stringify(customerPayload),
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
        slideDriverSide: reservationEditor.reservation.slideDriverSide,
        slidePassengerSide: reservationEditor.reservation.slidePassengerSide,
        rigLengthFeet: reservationEditor.reservation.rigLengthFeet,
        amountPaid: reservationEditor.reservation.amountPaid,
        notes: reservationEditor.reservation.notes,
        siteStays: reservationEditor.reservation.siteStays,
      };

      const updatedReservation = await apiRequest(
        `/reservations/${reservationEditor.id}`,
        {
          method: "PUT",
          body: JSON.stringify(reservationPayload),
        }
      );

      setReservations((current) =>
        current.map((entry) =>
          entry.id === updatedReservation.id ? updatedReservation : entry
        )
      );

      if (activeScheduleReservation?.id === updatedReservation.id) {
        setActiveScheduleReservation(updatedReservation);
      }

      if (createdReservation?.id === updatedReservation.id) {
        setCreatedReservation(updatedReservation);
      }

      setSuccessMessage(`Saved reservation #${updatedReservation.id}.`);
      setAdminSaveNotice(`Reservation #${updatedReservation.id} was saved.`);
      closeReservationEditor();
    } catch (error) {
      if (error.status === 409) {
        await handleReservationConflict(
          error,
          setReservationEditorErrorMessage
        );
      } else {
        setReservationEditorErrorMessage(error.message);
      }
    } finally {
      setIsSavingAdminEdit(false);
    }
  }

  function openReservationSection() {
    setActivePage("reservation");

    window.requestAnimationFrame(() => {
      reservationFormRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  }

  function applyDirectMatchToReservation(site) {
    setReservationForm((current) => ({
      ...current,
      rvKind: searchForm.rvKind,
      motorhomeClassA: searchForm.motorhomeClassA,
      motorhomeClassC: searchForm.motorhomeClassC,
      motorhomeWithTow: searchForm.motorhomeWithTow,
      slideDriverSide: searchForm.slideDriverSide,
      slidePassengerSide: searchForm.slidePassengerSide,
      rigLengthFeet: searchForm.rigLengthFeet,
      siteStays: [
        {
          siteId: String(site.id),
          siteSearch: site.siteNumber,
          arrivalDate: searchForm.arrivalDate,
          leaveDate: searchForm.leaveDate,
        },
      ],
    }));
    openReservationSection();
  }

  function applyPlanToReservation() {
    if (!switchPlan?.length) {
      return;
    }

    setReservationForm((current) => ({
      ...current,
      rvKind: searchForm.rvKind,
      motorhomeClassA: searchForm.motorhomeClassA,
      motorhomeClassC: searchForm.motorhomeClassC,
      motorhomeWithTow: searchForm.motorhomeWithTow,
      slideDriverSide: searchForm.slideDriverSide,
      slidePassengerSide: searchForm.slidePassengerSide,
      rigLengthFeet: searchForm.rigLengthFeet,
      siteStays: switchPlan.map((segment) => ({
        siteId: String(segment.siteId),
        siteSearch: segment.siteNumber,
        arrivalDate: segment.arrivalDate,
        leaveDate: segment.leaveDate,
      })),
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

  const publicPaymentToken =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("pay")
      : "";

  if (publicPaymentToken) {
    return <PublicPaymentPage token={publicPaymentToken} />;
  }

  if (
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("page") === "terms"
  ) {
    return <PublicTermsAndConditions />;
  }

  if (
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("page") === "privacy"
  ) {
    return <PublicPrivacyPolicy />;
  }

  if (activePage === "home") {
    return (
      <PublicHome
        searchForm={searchForm}
        onSearchChange={updateSearchField}
        onSearch={handleAvailabilitySearch}
        isCalendarOpen={isAvailabilityCalendarOpen}
        onToggleCalendar={() =>
          setIsAvailabilityCalendarOpen((current) => !current)
        }
        directMatches={directMatches}
        flexibleMatches={flexibleMatches}
        switchPlan={switchPlan}
        availabilityRestriction={availabilityRestriction}
        hasSearched={availabilityHasSearched}
        isSearching={isSearchingAvailability}
        errorMessage={errorMessage}
        onOpenGuest={() => {
          setActivePage("guest");
          window.scrollTo({ top: 0, behavior: "smooth" });
        }}
        onOpenAdmin={() => {
          setErrorMessage("");
          setActivePage("availability");
          window.scrollTo({ top: 0, behavior: "smooth" });
        }}
      />
    );
  }

  if (activePage === "guest") {
    return <GuestPortal onBackHome={() => setActivePage("home")} />;
  }

  if (!isUnlocked) {
    return (
      <Box className="passcode-shell">
        <Paper
          component="form"
          className="passcode-card"
          onSubmit={handleUnlock}
          elevation={0}>
          <Stack spacing={2.5}>
            <div>
              <Typography variant="h1">Admin Sign In</Typography>
              <Typography variant="body1" color="text.secondary" sx={{ mt: 1 }}>
                Sign in with your admin username and password.
              </Typography>
            </div>
            <TextField
              label="Username"
              value={adminLoginForm.username}
              onChange={(event) =>
                setAdminLoginForm((current) => ({
                  ...current,
                  username: event.target.value.toLowerCase(),
                }))
              }
              fullWidth
            />
            <TextField
              label="Password"
              type="password"
              value={adminLoginForm.password}
              onChange={(event) =>
                setAdminLoginForm((current) => ({
                  ...current,
                  password: event.target.value,
                }))
              }
              fullWidth
            />
            {adminLoginError ? (
              <Alert severity="error">{adminLoginError}</Alert>
            ) : null}
            {isCheckingAdminSession ? (
              <Alert severity="info">Checking admin session...</Alert>
            ) : null}
            <Button
              type="submit"
              variant="contained"
              size="large"
              disabled={isSigningInAdmin || isCheckingAdminSession}>
              {isSigningInAdmin ? "Signing in..." : "Sign in"}
            </Button>
            <Button
              type="button"
              variant="text"
              onClick={() => setActivePage("home")}>
              Back to resort home
            </Button>
          </Stack>
        </Paper>
      </Box>
    );
  }

  return (
    <Container className="page-shell admin-shell" maxWidth="xl">
      <Paper
        component="header"
        className={`app-header ${isAdminHeaderCompact ? "compact" : ""}`}
        elevation={0}>
        <Stack spacing={2.5} className="admin-header-stack">
          <div>
            <div className="admin-title-row">
              <Typography variant="h1">RV Park Reservations</Typography>
              <div className="admin-header-actions">
                <button
                  type="button"
                  className="admin-mobile-menu-button"
                  aria-label="Open admin navigation"
                  aria-expanded={isAdminMobileMenuOpen}
                  aria-controls="admin-mobile-menu"
                  onClick={() =>
                    setIsAdminMobileMenuOpen((current) => !current)
                  }>
                  <span />
                  <span />
                  <span />
                </button>
                <Button
                  type="button"
                  className={`admin-home-button booking-alert-button ${
                    bookingNotificationStatus === "enabled" ? "enabled" : ""
                  }`}
                  variant={
                    bookingNotificationStatus === "enabled"
                      ? "contained"
                      : "outlined"
                  }
                  onClick={toggleBookingNotifications}
                  disabled={
                    isUpdatingBookingNotifications ||
                    bookingNotificationStatus === "checking"
                  }>
                  {isUpdatingBookingNotifications
                    ? "Updating alerts..."
                    : bookingNotificationStatus === "enabled"
                      ? "Booking alerts on"
                      : "Enable booking alerts"}
                </Button>
                <Button
                  type="button"
                  className="admin-home-button"
                  variant="outlined"
                  onClick={() => setActivePage("home")}>
                  Resort home
                </Button>
                <Button
                  type="button"
                  className="admin-home-button"
                  variant="outlined"
                  onClick={async () => {
                    try {
                      await apiRequest("/admin/session", { method: "DELETE" });
                    } catch {
                      // Ignore logout transport errors and clear local state anyway.
                    }

                    setIsUnlocked(false);
                    setAdminLoginForm({ username: "", password: "" });
                    setAdminLoginError("");
                    setActivePage("home");
                  }}>
                  Sign out
                </Button>
              </div>
            </div>
            <Typography variant="body1" color="text.secondary" sx={{ mt: 1 }}>
              Switch between pages from the top navigation.
            </Typography>
          </div>
          <Tabs
            value={activePage}
            onChange={(_event, nextValue) => setActivePage(nextValue)}
            variant="scrollable"
            scrollButtons="auto"
            allowScrollButtonsMobile
            aria-label="Primary">
            {appPages.map((page) => (
              <Tab key={page.key} value={page.key} label={page.label} />
            ))}
          </Tabs>
          {isAdminMobileMenuOpen ? (
            <div className="admin-mobile-menu-panel" id="admin-mobile-menu">
              {appPages.map((page) => (
                <button
                  key={page.key}
                  type="button"
                  className={`admin-mobile-menu-item ${
                    activePage === page.key ? "active" : ""
                  }`}
                  onClick={() => setActivePage(page.key)}>
                  {page.label}
                </button>
              ))}
              <button
                type="button"
                className={`admin-mobile-menu-item add-notifications-menu-item ${
                  bookingNotificationStatus === "enabled" ? "enabled" : ""
                }`}
                disabled={
                  isUpdatingBookingNotifications ||
                  bookingNotificationStatus === "checking" ||
                  bookingNotificationStatus === "enabled"
                }
                onClick={async () => {
                  await toggleBookingNotifications();
                  setIsAdminMobileMenuOpen(false);
                }}>
                {isUpdatingBookingNotifications
                  ? "Adding notifications..."
                  : bookingNotificationStatus === "enabled"
                    ? "Notifications added ✓"
                    : "Add notifications"}
              </button>
            </div>
          ) : null}
        </Stack>
      </Paper>
      {bookingNotificationMessage ? (
        <Alert
          severity={
            bookingNotificationStatus === "enabled"
              ? "success"
              : bookingNotificationStatus === "blocked" ||
                  bookingNotificationStatus === "error"
                ? "error"
                : "info"
          }
          onClose={() => setBookingNotificationMessage("")}
          sx={{ mb: 2 }}>
          {bookingNotificationMessage}
        </Alert>
      ) : null}
      {errorMessage ? (
        <Alert severity="error" sx={{ mb: 2 }}>
          {errorMessage}
        </Alert>
      ) : null}
      {successMessage ? (
        <Alert severity="success" sx={{ mb: 2 }}>
          {successMessage}
        </Alert>
      ) : null}

      <main className="layout">
        {activePage === "availability" ? (
          <Paper component="section" className="card" elevation={0}>
            <div className="page-section-header">
              <h2>Availability Search</h2>
              <div className="section-actions">
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => clearSection("availability")}>
                  Clear section
                </button>
              </div>
            </div>
            <>
              <div className="section-heading">
                <p>
                  Find sites that fit the full stay or build a switch plan
                  across multiple sites.
                </p>
              </div>
              <form onSubmit={handleAvailabilitySearch}>
                {searchForm.searchMode === "exact" ? (
                  <div className="button-row">
                    <button
                      type="button"
                      className="ghost-button admin-calendar-toggle"
                      onClick={() =>
                        setIsAvailabilityCalendarOpen((current) => !current)
                      }>
                      {isAvailabilityCalendarOpen
                        ? "Hide calendar"
                        : "Show calendar"}
                    </button>
                  </div>
                ) : null}
                <StaySearchModeFields
                  searchForm={searchForm}
                  onChange={updateSearchField}
                  isCalendarOpen={isAvailabilityCalendarOpen}
                  publicLayout={false}
                />
                <RigSearchFields
                  searchForm={searchForm}
                  onChange={updateSearchField}
                />
                <div className="field-grid availability-options-row">
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={searchForm.riverfrontOnly}
                      onChange={(event) =>
                        updateSearchField(
                          "riverfrontOnly",
                          event.target.checked
                        )
                      }
                    />
                    Riverfront only
                  </label>
                </div>
                <button type="submit" className="primary-button">
                  {isSearchingAvailability
                    ? "Searching..."
                    : "Search availability"}
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
                        onClick={() =>
                          setShowAllDirectMatches((current) => !current)
                        }>
                        {showAllDirectMatches
                          ? "View less"
                          : `View more (${directMatches.length - 5})`}
                      </button>
                    ) : null}
                  </div>
                  {availabilityRestriction === "oversized_fifth_wheel" ? (
                    <Alert severity="warning" sx={{ mt: 2 }}>
                      No sites fit fifth wheels over 43 feet.
                    </Alert>
                  ) : searchForm.searchMode === "flexible" ? (
                    flexibleMatches.length ? (
                      <ul className="result-list flexible-result-list">
                        {flexibleMatches.map((site) => (
                          <li key={site.siteId}>
                            <div className="result-header">
                              <strong>Site {site.siteNumber}</strong>
                            </div>
                            <span>
                              {site.sizeFeet} ft • {getSiteTypeLabel(site)} • up
                              to {site.maxAvailableNights} open nights in the
                              selected range
                            </span>
                            <div className="flexible-window-list admin-flexible-window-list">
                              {site.openWindows.map((window, index) => (
                                <span key={`${site.siteId}-${index}`}>
                                  {formatDisplayDate(window.arrivalDate)} to{" "}
                                  {formatDisplayDate(window.leaveDate)} •{" "}
                                  {window.minStayNights ===
                                  window.maxStayNights
                                    ? `${window.minStayNights} days`
                                    : `${window.minStayNights}-${window.maxStayNights} days`}
                                </span>
                              ))}
                            </div>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="muted">
                        No sites currently match that flexible date window and
                        stay length.
                      </p>
                    )
                  ) : directMatches.length ? (
                    <ul className="result-list">
                      {(showAllDirectMatches
                        ? directMatches
                        : directMatches.slice(0, 5)
                      ).map((site) => (
                        <li key={site.id}>
                          <div className="result-header">
                            <strong>Site {site.siteNumber}</strong>
                            <button
                              type="button"
                              className="ghost-button"
                              onClick={() =>
                                applyDirectMatchToReservation(site)
                              }>
                              Use this plan
                            </button>
                          </div>
                          <span>
                            {site.sizeFeet} ft • {getSiteTypeLabel(site)} •{" "}
                            {formatPricingCategory(site.pricingCategory)} •{" "}
                            {site.numberOfNights} nights • Actually open for{" "}
                            {site.openEnded
                              ? "an open-ended stay"
                              : `${site.availableDays} day${
                                  site.availableDays === 1 ? "" : "s"
                                }`}
                            {site.availableUntil && !site.openEnded
                              ? ` (until ${formatDisplayDate(
                                  site.availableUntil
                                )})`
                              : ""}{" "}
                            • Normal {formatCurrency(site.normalPrice)} •
                            Discount {formatCurrency(site.discountPrice)}
                          </span>
                          <span className="availability-context-text">
                            {site.previousBookedUntil
                              ? `Last booked day: ${formatDisplayDate(
                                  site.previousBookedUntil
                                )}`
                              : "Last booked day: open before your arrival"}{" "}
                            •{" "}
                            {site.nextBookedFrom
                              ? `Next reservation starts ${formatDisplayDate(
                                  site.nextBookedFrom
                                )}`
                              : "Next reservation: none scheduled"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted">
                      No single site currently covers the full stay.
                    </p>
                  )}
                </div>

                {searchForm.searchMode === "flexible" ? null : (
                  <div className="result-panel">
                    <div className="result-header">
                      <h3>Switch plan</h3>
                      {switchPlan?.length ? (
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={applyPlanToReservation}>
                          Use this plan
                        </button>
                      ) : null}
                    </div>
                    {switchPlan?.length ? (
                      <>
                        <ol className="timeline-list">
                          {(showAllSwitchPlanSegments
                            ? switchPlan
                            : switchPlan.slice(0, 5)
                          ).map((segment, index) => (
                            <li key={`${segment.siteId}-${index}`}>
                              Site {segment.siteNumber}: {segment.arrivalDate} to{" "}
                              {segment.leaveDate} • {segment.numberOfNights}{" "}
                              nights •{" "}
                              {formatPricingCategory(segment.pricingCategory)} •
                              Normal {formatCurrency(segment.normalPrice)} •
                              Discount {formatCurrency(segment.discountPrice)}
                            </li>
                          ))}
                        </ol>
                        {switchPlan.length > 5 ? (
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() =>
                              setShowAllSwitchPlanSegments((current) => !current)
                            }>
                            {showAllSwitchPlanSegments
                              ? "View less"
                              : `View more (${switchPlan.length - 5})`}
                          </button>
                        ) : null}
                        <div className="pricing-summary">
                          <span>
                            Total normal:{" "}
                            {formatCurrency(switchPlanTotals?.normalPrice)}
                          </span>
                          <span>
                            Total discount:{" "}
                            {formatCurrency(switchPlanTotals?.discountPrice)}
                          </span>
                        </div>
                      </>
                    ) : (
                      <p className="muted">
                        No multi-site plan is available for that date range.
                      </p>
                    )}
                  </div>
                )}
              </div>
            </>
          </Paper>
        ) : null}

        {activePage === "reservation" ? (
          <Paper
            component="section"
            ref={reservationFormRef}
            className="card"
            elevation={0}>
            <div className="page-section-header">
              <h2>
                {editingReservationId
                  ? `Edit Reservation #${editingReservationId}`
                  : "Create Reservation"}
              </h2>
              <div className="section-actions">
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => clearSection("reservation")}>
                  Clear section
                </button>
              </div>
            </div>
            <div>
              <div className="section-heading">
                <p>
                  {editingReservationId && reservationEditFocusLabel
                    ? `Editing ${reservationEditFocusLabel} for reservation #${editingReservationId}.`
                    : "Create the customer and reservation together, or pick an existing customer."}
                </p>
                {isReservationPageLoading ? (
                  <p className="muted">Loading customers and sites...</p>
                ) : null}
              </div>
              <form onSubmit={handleReservationCreate}>
                <div className="field-grid">
                  <div
                    ref={reservationCustomerSectionRef}
                    className="reservation-form-anchor">
                    <span className="small-text">Customer information</span>
                  </div>
                  <label>
                    First name
                    <input
                      value={customerForm.firstName}
                      onChange={(event) =>
                        updateCustomerField("firstName", event.target.value)
                      }
                    />
                  </label>
                  <label>
                    Last name
                    <input
                      value={customerForm.lastName}
                      onChange={(event) =>
                        updateCustomerField("lastName", event.target.value)
                      }
                    />
                  </label>
                  <label>
                    Email
                    <input
                      type="email"
                      value={customerForm.email}
                      onChange={(event) =>
                        updateCustomerField("email", event.target.value)
                      }
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
                        updateCustomerField(
                          "phoneNumber",
                          formatPhoneNumber(event.target.value)
                        )
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
                          <article
                            key={customer.id}
                            className="timeline-entry-card">
                            <div className="result-header">
                              <h4>
                                #{customer.id} {customer.first_name}{" "}
                                {customer.last_name}
                              </h4>
                              <button
                                type="button"
                                className="ghost-button"
                                onClick={() => useExistingCustomer(customer)}>
                                Use customer
                              </button>
                            </div>
                            <p className="muted">
                              Email: {customer.email || "Not set"} • Phone:{" "}
                              {formatPhoneNumber(customer.phone_number || "") ||
                                "Not set"}
                            </p>
                          </article>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  <label>
                    Search customer name or phone
                    <input
                      placeholder="Type a name or phone number"
                      value={customerSearch}
                      onChange={(event) =>
                        setCustomerSearch(event.target.value)
                      }
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
                          (customer) =>
                            String(customer.id) === selectedCustomerId
                        );

                        if (selectedCustomer) {
                          useExistingCustomer(selectedCustomer);
                          return;
                        }

                        updateReservationField(
                          "customerId",
                          selectedCustomerId
                        );
                      }}>
                      <option value="">
                        Create a new customer from the fields above
                      </option>
                      {visibleCustomers.map((customer) => (
                        <option key={customer.id} value={customer.id}>
                          #{customer.id} {customer.first_name}{" "}
                          {customer.last_name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div
                    ref={reservationDatesSectionRef}
                    className="reservation-form-anchor">
                    <span className="small-text">Dates and site</span>
                  </div>
                  <label>
                    Booked date
                    <input
                      type="date"
                      value={reservationForm.bookedDate}
                      onChange={(event) =>
                        updateReservationField("bookedDate", event.target.value)
                      }
                    />
                  </label>
                  <label>
                    Booking status
                    <select
                      value={reservationForm.status}
                      onChange={(event) =>
                        updateReservationField("status", event.target.value)
                      }>
                      <option value="active">Active</option>
                      <option value="pending">Pending</option>
                      <option value="canceled">Canceled</option>
                    </select>
                  </label>
                  <label>
                    Reservation term
                    <select
                      value={reservationForm.reservationTerm}
                      onChange={(event) =>
                        updateReservationField(
                          "reservationTerm",
                          event.target.value
                        )
                      }>
                      <option value="standard">Standard</option>
                      <option value="yearly">Yearly</option>
                    </select>
                  </label>
                  <div className="public-discount-panel admin-price-choice-panel">
                    <span className="small-text">Discount</span>
                    <label className="checkbox-row compact-checkbox">
                      <input
                        type="checkbox"
                        checked={reservationForm.discounts.length > 0}
                        onChange={(event) =>
                          updateReservationPriceChoice(
                            "discounts",
                            event.target.checked ? ["Eligible discount"] : []
                          )
                        }
                      />
                      Guest qualifies for the discounted price
                    </label>
                  </div>
                  <div className="public-discount-panel admin-price-choice-panel">
                    <span className="small-text">Payment choice</span>
                    <label className="checkbox-row compact-checkbox">
                      <input
                        type="radio"
                        name="admin-booking-payment-method"
                        checked={reservationForm.paymentMethod === "bank"}
                        onChange={() => updateReservationPriceChoice("paymentMethod", "bank")}
                      />
                      Bank / cash / check
                    </label>
                    <label className="checkbox-row compact-checkbox">
                      <input
                        type="radio"
                        name="admin-booking-payment-method"
                        checked={reservationForm.paymentMethod === "card"}
                        onChange={() => updateReservationPriceChoice("paymentMethod", "card")}
                      />
                      Card
                    </label>
                  </div>
                  {needsManualReservationPricing ? (
                    <>
                      <label>
                        Manual total
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="0.00"
                          value={reservationForm.totalPrice}
                          onChange={(event) => {
                            setIsReservationTotalOverridden(true);
                            updateReservationField("totalPrice", event.target.value);
                          }}
                        />
                      </label>
                      <label>
                        Manual deposit
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="0.00"
                          value={reservationForm.depositAmount}
                          onChange={(event) => {
                            setIsReservationDepositOverridden(true);
                            updateReservationField("depositAmount", event.target.value);
                          }}
                          onWheel={(event) => event.currentTarget.blur()}
                        />
                      </label>
                    </>
                  ) : null}
                  <div
                    ref={reservationRigSectionRef}
                    className="reservation-form-anchor">
                    <span className="small-text">Rig details</span>
                  </div>
                  <label>
                    RV kind
                    <select
                      value={reservationForm.rvKind}
                      onChange={(event) =>
                        updateReservationField("rvKind", event.target.value)
                      }>
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
                            updateReservationField(
                              "motorhomeClassA",
                              event.target.checked
                            )
                          }
                        />
                        Class A
                      </label>
                      <label className="checkbox-row compact-checkbox">
                        <input
                          type="checkbox"
                          checked={reservationForm.motorhomeClassC}
                          onChange={(event) =>
                            updateReservationField(
                              "motorhomeClassC",
                              event.target.checked
                            )
                          }
                        />
                        Class C
                      </label>
                      <label className="checkbox-row compact-checkbox">
                        <input
                          type="checkbox"
                          checked={reservationForm.motorhomeWithTow}
                          onChange={(event) =>
                            updateReservationField(
                              "motorhomeWithTow",
                              event.target.checked
                            )
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
                        updateReservationField(
                          "rigLengthFeet",
                          event.target.value
                        )
                      }
                    />
                  </label>
                  <div
                    ref={reservationNotesSectionRef}
                    className="reservation-form-anchor">
                    <span className="small-text">Notes</span>
                  </div>
                  <label className="notes-field">
                    Notes
                    <textarea
                      rows="4"
                      value={reservationForm.notes}
                      onChange={(event) =>
                        updateReservationField("notes", event.target.value)
                      }
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

                {reservationPricingPreview.length ? (
                  <div className="pricing-preview-card">
                    <h3>Booking price</h3>
                    <p className="muted">
                      Every 7th night is free through 28 nights. Longer stays
                      need a price entered through payment info after booking.
                    </p>
                    <BookingPriceComparison
                      title={
                        hasRequestedReservationDiscount
                          ? "Discounted price per night"
                          : "Price per night"
                      }
                      bankPrice={selectedBaseReservationTotal}
                      cardPrice={selectedCardReservationTotal}
                      perNight
                      numberOfNights={reservationNightCount}
                    />
                    <BookingPriceComparison
                      title={
                        reservationNightCount > 7
                          ? "Two-night deposit due"
                          : "One-night deposit due"
                      }
                      bankPrice={selectedBankDepositAmount}
                      cardPrice={selectedCardDepositAmount}
                    />
                    <div className="pricing-summary">
                      <span>
                        Selected: {formatSelectedPaymentMethod(reservationForm.paymentMethod)}
                      </span>
                      <span>
                        Booking total: {formatCurrency(reservationForm.totalPrice || null)}
                      </span>
                      <span>
                        Deposit due: {formatCurrency(reservationForm.depositAmount || null)}
                      </span>
                      <span>
                        Remaining balance:{" "}
                        {formatCurrency(
                          effectiveTotalPreview !== null
                            ? effectiveTotalPreview -
                                (Number(reservationForm.amountPaid || 0) || 0)
                            : null
                        )}
                      </span>
                    </div>
                  </div>
                ) : null}

                <div className="button-row">
                  {reservationForm.reservationTerm !== "yearly" ? (
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={addSiteStay}>
                      Add site stay
                    </button>
                  ) : null}
                  {editingReservationId ? (
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={cancelEditingReservation}>
                      Cancel edit
                    </button>
                  ) : null}
                  <button
                    type="submit"
                    className="primary-button"
                    disabled={isSavingAdminEdit}>
                    {editingReservationId
                      ? isSavingAdminEdit
                        ? "Saving..."
                        : "Save reservation"
                      : "Create reservation"}
                  </button>
                </div>
                {reservationErrorMessage ? (
                  <div className="message error">{reservationErrorMessage}</div>
                ) : null}
                {reservationSuccessMessage ? (
                  <div className="message success">
                    {reservationSuccessMessage}
                  </div>
                ) : null}
                {paymentLinkErrorMessage ? (
                  <div className="message error">{paymentLinkErrorMessage}</div>
                ) : null}
                {paymentLinkSuccessMessage ? (
                  <div className="message success">
                    {paymentLinkSuccessMessage}
                  </div>
                ) : null}
                {createdReservation && !editingReservationId ? (
                  <div className="payment-panel">
                    <div className="result-header">
                      <h3>Collect deposit payment</h3>
                      <span className="balance-pill">
                        Card deposit{" "}
                        {formatCurrency(
                          createdReservation.cardDepositAmount ??
                            getCardPrice(createdReservation.depositAmount)
                        )}
                      </span>
                    </div>
                    <p className="muted">
                      Reservation #{createdReservation.id}. Card payments use
                      the card price. Office cash or check can stay at the
                      standard price.
                    </p>
                    <div className="payment-grid created-payment-grid">
                      <label className="payment-amount-field">
                        Payment amount
                        <input
                          type="number"
                          min="0.01"
                          step="0.01"
                          value={reservationCardPaymentAmount}
                          onChange={(event) => {
                            setReservationCardPaymentAmount(event.target.value);
                            setReservationCardPayment(null);
                            setPaymentLinkSuccessMessage("");
                          }}
                          onWheel={(event) => event.currentTarget.blur()}
                        />
                      </label>
                      <div className="created-payment-summary">
                        <div className="payment-summary-row">
                          <span>Standard deposit</span>
                          <strong>
                            {formatCurrency(createdReservation.depositAmount)}
                          </strong>
                        </div>
                        <div className="payment-summary-row">
                          <span>Card deposit</span>
                          <strong>
                            {formatCurrency(
                              createdReservation.cardDepositAmount ??
                                getCardPrice(createdReservation.depositAmount)
                            )}
                          </strong>
                        </div>
                        <div className="payment-summary-row">
                          <span>Status</span>
                          <strong>
                            {formatReservationStatus(createdReservation.status)}
                          </strong>
                        </div>
                        <div className="payment-summary-row">
                          <span>Amount paid</span>
                          <strong>
                            {formatCurrency(createdReservation.amountPaid)}
                          </strong>
                        </div>
                        <div className="payment-summary-row">
                          <span>Standard balance</span>
                          <strong>
                            {formatCurrency(
                              createdReservation.remainingBalance
                            )}
                          </strong>
                        </div>
                        <div className="payment-summary-row">
                          <span>Card balance</span>
                          <strong>
                            {formatCurrency(
                              createdReservation.cardRemainingBalance ??
                                getCardPrice(createdReservation.remainingBalance)
                            )}
                          </strong>
                        </div>
                      </div>
                    </div>
                    <div className="button-row created-payment-actions">
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() =>
                          recordCreatedReservationOfficePayment(
                            createdReservation
                          )
                        }>
                        Record office payment
                      </button>
                      <button
                        type="button"
                        className="primary-button"
                        onClick={() =>
                          handleReservationCardPayment(createdReservation)
                        }>
                        Pull up card info
                      </button>
                      <button
                        type="button"
                        className="primary-button"
                        onClick={() =>
                          generatePaymentLink(
                            createdReservation,
                            "Remaining-balance payment link"
                          )
                        }>
                        Generate payment link
                      </button>
                    </div>
                    {generatedPaymentLink?.reservationId ===
                    createdReservation.id ? (
                      <div className="generated-payment-link-card">
                        <div>
                          <span>Bank payment</span>
                          <strong>
                            {formatCurrency(generatedPaymentLink.bankAmount)}
                          </strong>
                        </div>
                        <div>
                          <span>Credit card payment</span>
                          <strong>
                            {formatCurrency(generatedPaymentLink.cardAmount)}
                          </strong>
                        </div>
                        <label>
                          Riverpark payment link
                          <input
                            readOnly
                            value={generatedPaymentLink.checkoutUrl}
                            onFocus={(event) => event.target.select()}
                          />
                        </label>
                        <div className="button-row">
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={copyPaymentLinkToClipboard}>
                            Copy link
                          </button>
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() =>
                              openPaymentLinkTextMessage(createdReservation)
                            }>
                            Text link
                          </button>
                          <a
                            className="ghost-button"
                            href={generatedPaymentLink.checkoutUrl}
                            target="_blank"
                            rel="noreferrer">
                            Open link
                          </a>
                        </div>
                      </div>
                    ) : null}
                    {hasReservationCardPayment ? (
                      <Elements stripe={getStripePromise()}>
                        <CardPaymentForm
                          amountLabel={formatCurrency(
                            reservationCardPayment.amount
                          )}
                          clientSecret={reservationCardPayment.clientSecret}
                          reservation={createdReservation}
                          onCancel={() => setReservationCardPayment(null)}
                          onSuccess={async () => {
                            const refreshedReservation =
                              await finalizeCardPayment(createdReservation.id);
                            setReservationCardPayment(null);
                            setPaymentLinkSuccessMessage(
                              `Deposit payment completed for reservation #${refreshedReservation.id}.`
                            );
                          }}
                        />
                      </Elements>
                    ) : null}
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
                          disabled={
                            sendingConfirmationReservationId ===
                            createdReservation.id
                          }
                          onClick={() =>
                            sendReservationConfirmation(createdReservation)
                          }>
                          {sendingConfirmationReservationId ===
                          createdReservation.id
                            ? "Sending..."
                            : createdReservation.confirmationEmail?.sent
                            ? "Resend confirmation email"
                            : "Send confirmation email"}
                        </button>
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={copyReservationConfirmation}>
                          Copy confirmation
                        </button>
                      </div>
                    </div>
                    <div className="pricing-summary">
                      <span>
                        Confirmation {buildConfirmationCode(createdReservation)}
                      </span>
                      <span>
                        Email: {createdReservation.email || "Not set"}
                      </span>
                      <span>
                        Phone:{" "}
                        {formatPhoneNumber(
                          createdReservation.phone_number || ""
                        ) || "Not set"}
                      </span>
                    </div>
                    {confirmationCopyMessage ? (
                      <div
                        className={`message ${
                          confirmationCopyMessage.startsWith("Copied") ||
                          confirmationCopyMessage.startsWith("Confirmation sent")
                            ? "success"
                            : "error"
                        }`}>
                        {confirmationCopyMessage}
                      </div>
                    ) : null}
                    <p className="muted">
                      Confirmation emails send automatically when a reservation
                      is created. You can resend or copy it as a backup.
                    </p>
                  </div>
                ) : null}
              </form>
            </div>
          </Paper>
        ) : null}

        {activePage === "schedule" ? (
          <Paper component="section" className="card" elevation={0}>
            <div className="page-section-header">
              <h2>Schedule</h2>
              <div className="section-actions">
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => clearSection("schedule")}>
                  Clear section
                </button>
              </div>
            </div>
            <>
              <div className="section-heading">
                <p>
                  See who is in a site today, then inspect a single site
                  timeline for any date window.
                </p>
              </div>
              <div className="button-row">
                <span className="muted">
                  {isSchedulePageLoading && !hasLoadedReservations
                    ? "Loading schedule..."
                    : `${currentOccupancy.length} current stays today`}
                </span>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={handleReservationRefresh}>
                  Refresh schedule
                </button>
              </div>
              <div className="timeline-controls schedule-search-controls">
                <label>
                  Search name or phone
                  <input
                    placeholder="Type a name or phone number"
                    value={customerBookingSearch}
                    onChange={(event) =>
                      setCustomerBookingSearch(event.target.value)
                    }
                  />
                </label>
                <label>
                  Arrival date
                  <input
                    type="date"
                    value={selectedArrivalDate}
                    onChange={(event) =>
                      setSelectedArrivalDate(event.target.value)
                    }
                  />
                </label>
              </div>
              {customerBookingSearchValue ? (
                <div className="timeline-card">
                  <div className="result-header">
                    <h3>Customer booking search</h3>
                    <span className="muted">
                      {isSchedulePageLoading && !hasLoadedReservations
                        ? "Loading..."
                        : `${customerScheduleResults.length} matches`}
                    </span>
                  </div>
                  {isSchedulePageLoading && !hasLoadedReservations ? (
                    <p className="muted">Loading customer bookings...</p>
                  ) : customerScheduleResults.length ? (
                    <div className="schedule-list">
                      {customerScheduleResults.map((reservation) => (
                        <article
                          key={reservation.id}
                          className="timeline-card history-reservation-card">
                          <div className="result-header">
                            <h3>
                              {reservation.first_name} {reservation.last_name}
                            </h3>
                            <div className="button-row schedule-card-actions">
                              <span
                                className={`status-badge ${getReservationStatusClass(
                                  reservation.status
                                )}`}>
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
                                    onClick: () =>
                                      openScheduleReservation(reservation),
                                  },
                                  {
                                    label: "Edit payment info",
                                    onClick: () =>
                                      openScheduleReservation(reservation, {
                                        openPaymentEditor: true,
                                      }),
                                  },
                                ].concat(
                                  buildReservationEditActions(reservation.id)
                                )}
                              />
                            </div>
                          </div>
                          <p className="muted">
                            Booked {formatDisplayDate(reservation.booked_date)}{" "}
                            •{" "}
                            {formatReservationTerm(
                              reservation.reservation_term
                            )}{" "}
                            • {reservation.rv_kind}
                            {formatMotorhomeDetails(reservation)}
                            {reservation.rig_length_feet
                              ? ` • ${reservation.rig_length_feet} ft rig`
                              : ""}
                            {` • Paid ${formatCurrency(
                              reservation.amountPaid
                            )} • Balance ${formatCurrency(
                              reservation.remainingBalance
                            )}`}
                          </p>
                          <ol className="timeline-list">
                            {reservation.siteStays.map((segment) => (
                              <li key={segment.id}>
                                <strong>Site {segment.site_number}</strong>:{" "}
                                {formatDisplayDate(segment.arrival_date)} to{" "}
                                {formatLeaveDate(segment.leave_date)}
                                {segment.numberOfNights
                                  ? ` • ${segment.numberOfNights} nights`
                                  : ""}
                              </li>
                            ))}
                          </ol>
                          {reservation.notes?.trim() ? (
                            <button
                              type="button"
                              className="notes-snippet-button"
                              onClick={() => openReservationNote(reservation)}>
                              Note:{" "}
                              {getReservationNotesSnippet(reservation.notes)}
                            </button>
                          ) : null}
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="muted">
                      No customer bookings match that search.
                    </p>
                  )}
                </div>
              ) : null}

              <div className="schedule-dropdown-grid">
                <div className="schedule-dropdown">
                  <button
                    type="button"
                    className="schedule-dropdown-trigger"
                    onClick={() =>
                      setIsWholeScheduleOpen((current) => !current)
                    }>
                    <span>Whole schedule</span>
                    <span className="muted">
                      {currentOccupancy.length} guests •{" "}
                      {isWholeScheduleOpen ? "Hide" : "Show"}
                    </span>
                  </button>
                  {isWholeScheduleOpen ? (
                    <div className="schedule-dropdown-panel">
                      {isSchedulePageLoading && !hasLoadedReservations ? (
                        <p className="muted">Loading current stays...</p>
                      ) : currentOccupancy.length ? (
                        <div className="schedule-list">
                          {currentOccupancy.map((reservation) => (
                            <article
                              key={reservation.id}
                              className="timeline-card schedule-summary-card">
                              <div className="result-header">
                                <h3>
                                  {reservation.first_name}{" "}
                                  {reservation.last_name}
                                </h3>
                                <div className="button-row schedule-card-actions">
                                  <CardActionMenu
                                    menuId={`whole-schedule-${reservation.id}`}
                                    openMenuId={openCardActionMenuId}
                                    onToggle={toggleCardActionMenu}
                                    onClose={closeCardActionMenu}
                                    actions={[
                                      ...(Number(
                                        reservation.remainingBalance || 0
                                      ) > 0
                                        ? [
                                            {
                                              label: "Add payment",
                                              onClick: () =>
                                                openScheduleReservation(
                                                  reservation
                                                ),
                                            },
                                          ]
                                        : []),
                                      {
                                        label: "View booking",
                                        onClick: () =>
                                          openScheduleReservation(reservation),
                                      },
                                      {
                                        label: "Edit payment info",
                                        onClick: () =>
                                          openScheduleReservation(reservation, {
                                            openPaymentEditor: true,
                                          }),
                                      },
                                    ].concat(
                                      buildReservationEditActions(
                                        reservation.id
                                      )
                                    )}
                                  />
                                </div>
                              </div>
                              <p className="muted">
                                {reservation.activeSiteStays.map(
                                  (segment, index) => (
                                    <span key={segment.id}>
                                      {index > 0 ? ", " : ""}
                                      <strong>
                                        Site {segment.site_number}
                                      </strong>
                                    </span>
                                  )
                                )}{" "}
                                • Booked{" "}
                                {formatDisplayDate(reservation.booked_date)} •{" "}
                                {reservation.rv_kind}
                                {formatMotorhomeDetails(reservation)}
                                {reservation.rig_length_feet
                                  ? ` • ${reservation.rig_length_feet} ft rig`
                                  : ""}
                                {` • Paid ${formatCurrency(
                                  reservation.amountPaid
                                )} • Balance ${formatCurrency(
                                  reservation.remainingBalance
                                )}`}
                              </p>
                              {reservation.notes?.trim() ? (
                                <button
                                  type="button"
                                  className="notes-snippet-button"
                                  onClick={() =>
                                    openReservationNote(reservation)
                                  }>
                                  Note:{" "}
                                  {getReservationNotesSnippet(
                                    reservation.notes
                                  )}
                                </button>
                              ) : null}
                            </article>
                          ))}
                        </div>
                      ) : (
                        <p className="muted">
                          No guests are currently in a site today.
                        </p>
                      )}
                    </div>
                  ) : null}
                </div>

                <div className="schedule-dropdown">
                  <button
                    type="button"
                    className="schedule-dropdown-trigger"
                    onClick={() =>
                      setIsArrivalsTodayOpen((current) => !current)
                    }>
                    <span>
                      {selectedArrivalDate === today
                        ? "Who's coming in today"
                        : `Who's coming in ${formatDisplayDate(
                            selectedArrivalDate
                          )}`}
                    </span>
                    <span className="muted">
                      {isSchedulePageLoading && !hasLoadedReservations
                        ? "Loading arrivals"
                        : `${arrivalsOnSelectedDate.length} arrivals`}{" "}
                      •{" "}
                      {isArrivalsTodayOpen ? "Hide" : "Show"}
                    </span>
                  </button>
                  {isArrivalsTodayOpen ? (
                    <div className="schedule-dropdown-panel">
                      {isSchedulePageLoading && !hasLoadedReservations ? (
                        <p className="muted">Loading arrivals...</p>
                      ) : arrivalsOnSelectedDate.length ? (
                        <div className="schedule-list">
                          {arrivalsOnSelectedDate.map((reservation) => (
                            <article
                              key={reservation.id}
                              className="timeline-card schedule-summary-card">
                              <div className="result-header">
                                <h3>
                                  {reservation.first_name}{" "}
                                  {reservation.last_name}
                                </h3>
                                <div className="button-row schedule-card-actions">
                                  <CardActionMenu
                                    menuId={`arrivals-${reservation.id}`}
                                    openMenuId={openCardActionMenuId}
                                    onToggle={toggleCardActionMenu}
                                    onClose={closeCardActionMenu}
                                    actions={[
                                      ...(Number(
                                        reservation.remainingBalance || 0
                                      ) > 0
                                        ? [
                                            {
                                              label: "Add payment",
                                              onClick: () =>
                                                openScheduleReservation(
                                                  reservation
                                                ),
                                            },
                                            {
                                              label: "Mark paid",
                                              onClick: () =>
                                                markReservationPaid(
                                                  reservation
                                                ),
                                            },
                                          ]
                                        : []),
                                      {
                                        label: "Open text",
                                        onClick: () =>
                                          openArrivalTextMessage(
                                            reservation,
                                            selectedArrivalDate
                                          ),
                                      },
                                      {
                                        label: "View booking",
                                        onClick: () =>
                                          openScheduleReservation(reservation),
                                      },
                                      {
                                        label: "Edit payment info",
                                        onClick: () =>
                                          openScheduleReservation(reservation, {
                                            openPaymentEditor: true,
                                          }),
                                      },
                                    ].concat(
                                      buildReservationEditActions(
                                        reservation.id
                                      )
                                    )}
                                  />
                                </div>
                              </div>
                              <p className="muted">
                                {reservation.arrivingSiteStays.map(
                                  (segment, index) => (
                                    <span key={segment.id}>
                                      {index > 0 ? ", " : ""}
                                      <strong>
                                        Site {segment.site_number}
                                      </strong>
                                    </span>
                                  )
                                )}{" "}
                                • Arriving{" "}
                                {formatDisplayDate(selectedArrivalDate)} •{" "}
                                Departing{" "}
                                {reservation.arrivingSiteStays[0]?.leave_date
                                  ? formatLeaveDate(
                                      reservation.arrivingSiteStays[0]
                                        .leave_date
                                    )
                                  : "Not set"}{" "}
                                •{" "}
                                {reservation.rv_kind}
                                {formatMotorhomeDetails(reservation)}
                                {reservation.rig_length_feet
                                  ? ` • ${reservation.rig_length_feet} ft rig`
                                  : ""}
                                {` • Paid ${formatCurrency(
                                  reservation.amountPaid
                                )} • Balance ${formatCurrency(
                                  reservation.remainingBalance
                                )}`}
                              </p>
                              {reservation.notes?.trim() ? (
                                <button
                                  type="button"
                                  className="notes-snippet-button"
                                  onClick={() =>
                                    openReservationNote(reservation)
                                  }>
                                  Note:{" "}
                                  {getReservationNotesSnippet(
                                    reservation.notes
                                  )}
                                </button>
                              ) : null}
                            </article>
                          ))}
                        </div>
                      ) : (
                        <p className="muted">
                          No guests are arriving{" "}
                          {selectedArrivalDate === today
                            ? "today"
                            : formatDisplayDate(selectedArrivalDate)}
                          .
                        </p>
                      )}
                    </div>
                  ) : null}
                </div>

                <div className="schedule-dropdown site-moves-dropdown">
                  <button
                    type="button"
                    className="schedule-dropdown-trigger"
                    onClick={() => setIsSiteMovesOpen((current) => !current)}>
                    <span>
                      {selectedArrivalDate === today
                        ? "People moving sites today"
                        : `People moving sites on ${formatDisplayDate(
                            selectedArrivalDate
                          )}`}
                    </span>
                    <span className="muted">
                      {isSchedulePageLoading && !hasLoadedReservations
                        ? "Loading site moves"
                        : `${siteMovesOnSelectedDate.length} site ${
                            siteMovesOnSelectedDate.length === 1
                              ? "move"
                              : "moves"
                          }`} {" "}
                      • {isSiteMovesOpen ? "Hide" : "Show"}
                    </span>
                  </button>
                  {isSiteMovesOpen ? (
                    <div className="schedule-dropdown-panel">
                      {isSchedulePageLoading && !hasLoadedReservations ? (
                        <p className="muted">Loading site moves...</p>
                      ) : siteMovesOnSelectedDate.length ? (
                        <div className="schedule-list">
                          {siteMovesOnSelectedDate.map((reservation) => (
                            <article
                              key={reservation.id}
                              className="timeline-card schedule-summary-card site-move-card">
                              <div className="result-header">
                                <h3>
                                  {reservation.first_name}{" "}
                                  {reservation.last_name}
                                </h3>
                                <div className="button-row schedule-card-actions">
                                  <CardActionMenu
                                    menuId={`site-move-${reservation.id}`}
                                    openMenuId={openCardActionMenuId}
                                    onToggle={toggleCardActionMenu}
                                    onClose={closeCardActionMenu}
                                    actions={[
                                      ...(Number(
                                        reservation.remainingBalance || 0
                                      ) > 0
                                        ? [
                                            {
                                              label: "Add payment",
                                              onClick: () =>
                                                openScheduleReservation(
                                                  reservation
                                                ),
                                            },
                                          ]
                                        : []),
                                      {
                                        label: "View booking",
                                        onClick: () =>
                                          openScheduleReservation(reservation),
                                      },
                                      {
                                        label: "Edit payment info",
                                        onClick: () =>
                                          openScheduleReservation(reservation, {
                                            openPaymentEditor: true,
                                          }),
                                      },
                                    ].concat(
                                      buildReservationEditActions(
                                        reservation.id
                                      )
                                    )}
                                  />
                                </div>
                              </div>
                              <p className="site-move-route">
                                <strong>
                                  Site{" "}
                                  {
                                    reservation.departingSiteStays[0]
                                      ?.site_number
                                  }
                                </strong>
                                <span aria-hidden="true">→</span>
                                <strong>
                                  Site{" "}
                                  {
                                    reservation.arrivingSiteStays[0]
                                      ?.site_number
                                  }
                                </strong>
                              </p>
                              <p className="muted">
                                Moving {formatDisplayDate(selectedArrivalDate)} •{" "}
                                {reservation.rv_kind}
                                {formatMotorhomeDetails(reservation)}
                                {reservation.rig_length_feet
                                  ? ` • ${reservation.rig_length_feet} ft rig`
                                  : ""}
                                {` • Paid ${formatCurrency(
                                  reservation.amountPaid
                                )} • Balance ${formatCurrency(
                                  reservation.remainingBalance
                                )}`}
                              </p>
                              {reservation.notes?.trim() ? (
                                <button
                                  type="button"
                                  className="notes-snippet-button"
                                  onClick={() =>
                                    openReservationNote(reservation)
                                  }>
                                  Note:{" "}
                                  {getReservationNotesSnippet(
                                    reservation.notes
                                  )}
                                </button>
                              ) : null}
                            </article>
                          ))}
                        </div>
                      ) : (
                        <p className="muted">
                          No guests are moving sites{" "}
                          {selectedArrivalDate === today
                            ? "today"
                            : formatDisplayDate(selectedArrivalDate)}
                          .
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
                    onChange={(event) =>
                      setTimelineSiteSearch(event.target.value)
                    }
                  />
                </label>
                <label>
                  Site
                  <select
                    value={timelineSiteId}
                    onChange={(event) => setTimelineSiteId(event.target.value)}
                    disabled={!timelineSiteOptions.length}>
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
                isLoading={isSchedulePageLoading && !hasLoadedReservations}
              />

              <div className="timeline-card">
                <h3>
                  {selectedTimelineSite
                    ? `Site ${selectedTimelineSite.site_number} booking details`
                    : "Site booking details"}
                </h3>
                <p className="muted">
                  {formatDisplayDate(selectedTimelineDate)}
                </p>
                {isSchedulePageLoading && !hasLoadedReservations ? (
                  <p className="muted">Loading site booking details...</p>
                ) : selectedDateReservations.length ? (
                  <div className="schedule-list">
                    {selectedDateReservations.map((entry, index) => (
                      <article
                        key={`${entry.reservationId}-${entry.segment.id}-${index}`}
                        className="timeline-entry-card">
                        <div className="result-header">
                          <h4>{entry.customerName}</h4>
                          <div className="button-row schedule-card-actions">
                            <CardActionMenu
                              menuId={`timeline-${entry.reservationId}-${entry.segment.id}`}
                              openMenuId={openCardActionMenuId}
                              onToggle={toggleCardActionMenu}
                              onClose={closeCardActionMenu}
                              actions={[
                                {
                                  label: "View booking",
                                  onClick: () =>
                                    openScheduleReservation(entry.reservation),
                                },
                                {
                                  label: "Edit payment info",
                                  onClick: () =>
                                    openScheduleReservation(entry.reservation, {
                                      openPaymentEditor: true,
                                    }),
                                },
                              ].concat(
                                buildReservationEditActions(entry.reservationId)
                              )}
                            />
                          </div>
                        </div>
                        <p className="muted">
                          {formatDisplayDate(entry.segment.arrival_date)} to{" "}
                          {formatLeaveDate(entry.segment.leave_date)} •{" "}
                          {entry.rvKind}
                          {entry.rigLengthFeet
                            ? ` • ${entry.rigLengthFeet} ft rig`
                            : ""}
                        </p>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="muted">
                    No booking is assigned to this site on the selected date.
                  </p>
                )}
              </div>
            </>
          </Paper>
        ) : null}

        {activePage === "history" ? (
          <Paper component="section" className="card" elevation={0}>
            <div className="page-section-header">
              <h2>Reservation History</h2>
              <div className="section-actions">
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => clearSection("history")}>
                  Clear section
                </button>
              </div>
            </div>
            <>
              <div className="section-heading">
                <p>
                  Browse reservations by booked date, then open a day to review
                  and edit bookings.
                </p>
                {isHistoryPageLoading ? (
                  <p className="muted">Loading booking history...</p>
                ) : null}
              </div>

              <BookingHistoryCalendar
                monthCursor={historyMonthCursor}
                selectedDate={selectedHistoryDate}
                reservationsByDate={reservationsByHistoryDate}
                onChangeMonth={changeHistoryMonth}
                onSelectDate={(dateString) => {
                  setSelectedHistoryDate(dateString);
                  setHistoryMonthCursor(startOfMonth(dateString));
                }}
              />

              <div className="timeline-card">
                <h3>History for {formatDisplayDate(selectedHistoryDate)}</h3>
                {isHistoryPageLoading && !hasLoadedReservations ? (
                  <p className="muted">Loading reservations for this day...</p>
                ) : selectedHistoryReservations.length ? (
                  <div className="schedule-list">
                    {selectedHistoryReservations.map((reservation) => (
                      <article
                        key={reservation.id}
                        className="timeline-card history-reservation-card">
                        <div className="result-header">
                          <h3>
                            {reservation.first_name} {reservation.last_name}
                          </h3>
                          <div className="button-row schedule-card-actions">
                            <span
                              className={`status-badge ${getReservationStatusClass(
                                reservation.status
                              )}`}>
                              {formatReservationStatus(reservation.status)}
                            </span>
                            <CardActionMenu
                              menuId={`history-${reservation.id}`}
                              openMenuId={openCardActionMenuId}
                              onToggle={toggleCardActionMenu}
                              onClose={closeCardActionMenu}
                              actions={[
                                {
                                  label:
                                    sendingConfirmationReservationId ===
                                    reservation.id
                                      ? "Sending..."
                                      : "Send confirmation email",
                                  disabled:
                                    sendingConfirmationReservationId ===
                                    reservation.id,
                                  onClick: () =>
                                    sendReservationConfirmation(reservation),
                                },
                                {
                                  label: "View booking",
                                  onClick: () =>
                                    openScheduleReservation(reservation),
                                },
                                {
                                  label: "Edit payment info",
                                  onClick: () =>
                                    openScheduleReservation(reservation, {
                                      openPaymentEditor: true,
                                    }),
                                },
                              ].concat(
                                buildReservationEditActions(reservation.id)
                              )}
                            />
                          </div>
                        </div>
                        <p className="muted">
                          {reservation.rv_kind}
                          {formatMotorhomeDetails(reservation)}
                          {reservation.rig_length_feet
                            ? ` • ${reservation.rig_length_feet} ft rig`
                            : ""}{" "}
                          •{" "}
                          {formatReservationTerm(reservation.reservation_term)}{" "}
                          • Amount paid {formatCurrency(reservation.amountPaid)}
                        </p>
                        <div className="pricing-summary">
                          <span>
                            Payment: {formatSelectedPaymentMethod(
                              reservation.selectedPaymentMethod
                            )}
                          </span>
                          <span>
                            Discounts: {reservation.requestedDiscounts?.length
                              ? reservation.requestedDiscounts.join(", ")
                              : "None requested"}
                          </span>
                          <span>
                            Deposit amount:{" "}
                            {formatCurrency(reservation.depositAmount)}
                          </span>
                          <span>
                            Booking total:{" "}
                            {formatCurrency(reservation.totalPrice)}
                          </span>
                          <span>
                            Remaining balance:{" "}
                            {formatCurrency(reservation.remainingBalance)}
                          </span>
                        </div>
                        <ol className="timeline-list">
                          {reservation.siteStays.map((segment) => (
                            <li key={segment.id}>
                              Site {segment.site_number}:{" "}
                              {formatDisplayDate(segment.arrival_date)} to{" "}
                              {formatLeaveDate(segment.leave_date)}
                              {segment.numberOfNights
                                ? ` • ${segment.numberOfNights} nights`
                                : ""}
                            </li>
                          ))}
                        </ol>
                        {reservation.notes?.trim() ? (
                          <button
                            type="button"
                            className="notes-snippet-button"
                            onClick={() => openReservationNote(reservation)}>
                            Note:{" "}
                            {getReservationNotesSnippet(reservation.notes)}
                          </button>
                        ) : null}
                        {reservation.status === "canceled" &&
                        reservation.canceled_at ? (
                          <p className="muted">
                            Canceled{" "}
                            {new Date(reservation.canceled_at).toLocaleString()}
                          </p>
                        ) : null}
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="muted">
                    No reservation activity on this day.
                  </p>
                )}
              </div>
            </>
          </Paper>
        ) : null}

        {activePage === "yearly" ? (
          <Paper component="section" className="card" elevation={0}>
            <div className="page-section-header">
              <h2>Yearly Bookings</h2>
              <div className="section-actions">
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => clearSection("yearly")}>
                  Clear section
                </button>
              </div>
            </div>
            <>
              <div className="section-heading">
                <p>
                  Manage open-ended yearly guests with quick booking, edit, and
                  cancel actions.
                </p>
                {isYearlyPageLoading ? (
                  <p className="muted">Loading yearly bookings...</p>
                ) : null}
              </div>
              {isYearlyPageLoading && !hasLoadedReservations ? (
                <p className="muted">Loading yearly bookings...</p>
              ) : yearlyReservations.length ? (
                <div className="schedule-list">
                  {yearlyReservations.map((reservation) => (
                    <article
                      key={reservation.id}
                      className="timeline-card history-reservation-card">
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
                                onClick: () =>
                                  openScheduleReservation(reservation),
                              },
                              {
                                label: "Edit payment info",
                                onClick: () =>
                                  openScheduleReservation(reservation, {
                                    openPaymentEditor: true,
                                  }),
                              },
                              ...buildReservationEditActions(reservation.id),
                              {
                                label: "Cancel",
                                onClick: () =>
                                  cancelReservation(reservation.id),
                                danger: true,
                              },
                            ]}
                          />
                        </div>
                      </div>
                      <p className="muted">
                        Site{" "}
                        {reservation.siteStays[0]?.site_number || "Not set"} •
                        Starts{" "}
                        {reservation.siteStays[0]?.arrival_date
                          ? formatDisplayDate(
                              reservation.siteStays[0].arrival_date
                            )
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
                          {formatPhoneNumber(reservation.phone_number || "") ||
                            "Not set"}
                        </span>
                        <span>
                          Booking total: {formatCurrency(reservation.totalPrice)}
                        </span>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="muted">No active yearly bookings.</p>
              )}
            </>
          </Paper>
        ) : null}

        {activePage === "messages" ? (
          <Paper component="section" className="card" elevation={0}>
            <div className="page-section-header">
              <h2>Text Messages</h2>
              <div className="section-actions">
                <button
                  type="button"
                  className="ghost-button"
                  disabled={isLoadingTextMessages}
                  onClick={loadTextMessageHistory}>
                  {isLoadingTextMessages ? "Refreshing..." : "Refresh messages"}
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => clearSection("messages")}>
                  Clear draft
                </button>
              </div>
            </div>

            {isTextMessagingConfigured === false ? (
              <Alert severity="warning" sx={{ mb: 2 }}>
                Twilio still needs: {missingTextMessageConfig.join(", ")}.
                Add these as private server environment variables before
                sending.
              </Alert>
            ) : null}
            {textMessageError ? (
              <Alert severity="error" sx={{ mb: 2 }}>
                {textMessageError}
              </Alert>
            ) : null}
            {textMessageSuccess ? (
              <Alert severity="success" sx={{ mb: 2 }}>
                {textMessageSuccess}
              </Alert>
            ) : null}

            <div className="admin-text-message-layout">
              <form className="admin-text-composer" onSubmit={sendTextMessage}>
                <div className="section-heading">
                  <p>
                    Send a reservation message or a park-wide operational
                    update to a guest.
                  </p>
                </div>
                <label>
                  Guest mobile number
                  <input
                    type="tel"
                    inputMode="tel"
                    list="text-message-customer-phones"
                    placeholder="(541) 555-1234"
                    value={textMessageForm.to}
                    onChange={(event) =>
                      setTextMessageForm((current) => ({
                        ...current,
                        to: formatPhoneNumber(event.target.value),
                      }))
                    }
                  />
                </label>
                <datalist id="text-message-customer-phones">
                  {customers
                    .filter((customer) => customer.phone_number)
                    .map((customer) => (
                      <option
                        key={customer.id}
                        value={formatPhoneNumber(customer.phone_number)}>
                        {customer.first_name} {customer.last_name}
                      </option>
                    ))}
                </datalist>
                <label>
                  Message
                  <textarea
                    rows="10"
                    maxLength="1500"
                    placeholder="Type the message to send..."
                    value={textMessageForm.body}
                    onChange={(event) =>
                      setTextMessageForm((current) => ({
                        ...current,
                        body: event.target.value,
                      }))
                    }
                  />
                </label>
                <div className="admin-text-message-meta">
                  <span>{textMessageForm.body.length} / 1,500 characters</span>
                  <span>
                    STOP and HELP instructions are added automatically.
                  </span>
                </div>
                <button
                  type="submit"
                  className="primary-button"
                  disabled={
                    isSendingTextMessage ||
                    !textMessageForm.to.trim() ||
                    !textMessageForm.body.trim() ||
                    isTextMessagingConfigured === false
                  }>
                  {isSendingTextMessage ? "Sending..." : "Send text message"}
                </button>
              </form>

              <section className="admin-text-history" aria-label="Recent text messages">
                <div className="admin-text-history-heading">
                  <div>
                    <span className="eyebrow">Twilio history</span>
                    <h3>Recent messages</h3>
                  </div>
                  <span>{textMessages.length} shown</span>
                </div>
                {isLoadingTextMessages && !textMessages.length ? (
                  <p className="muted">Loading text messages...</p>
                ) : textMessages.length ? (
                  <div className="admin-text-history-list">
                    {textMessages.map((message) => {
                      const isOutbound = String(message.direction || "").startsWith(
                        "outbound"
                      );
                      const guestNumber = isOutbound ? message.to : message.from;

                      return (
                        <article
                          key={message.sid}
                          className={`admin-text-history-item ${
                            isOutbound ? "outbound" : "inbound"
                          }`}>
                          <div className="admin-text-history-meta">
                            <strong>{isOutbound ? "Sent" : "Received"}</strong>
                            <span>{formatPhoneNumber(guestNumber)}</span>
                            <span>{formatTextMessageTimestamp(message.dateSent)}</span>
                          </div>
                          <p>{message.body}</p>
                          <div className="admin-text-history-footer">
                            <span>Status: {message.status || "unknown"}</span>
                            <button
                              type="button"
                              className="text-button"
                              onClick={() => {
                                setTextMessageForm({
                                  to: formatPhoneNumber(guestNumber),
                                  body: "",
                                });
                                window.requestAnimationFrame(() =>
                                  document
                                    .querySelector(".admin-text-composer textarea")
                                    ?.focus()
                                );
                              }}>
                              Message this guest
                            </button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <p className="muted">No text messages to show yet.</p>
                )}
              </section>
            </div>
          </Paper>
        ) : null}

        {activePage === "sites" ? (
          <Paper component="section" className="card" elevation={0}>
            <div className="page-section-header">
              <h2>RV Sites</h2>
              <div className="section-actions">
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => clearSection("sites")}>
                  Clear section
                </button>
              </div>
            </div>
            <>
              <div className="section-heading">
                <p>Current site inventory with size and riverfront details.</p>
                {isSitesPageLoading ? (
                  <p className="muted">Loading sites...</p>
                ) : null}
              </div>
              {siteEditorErrorMessage ? (
                <div className="message error">{siteEditorErrorMessage}</div>
              ) : null}
              {siteEditorSuccessMessage ? (
                <div className="message success">
                  {siteEditorSuccessMessage}
                </div>
              ) : null}
              <div className="site-filter-bar">
                <label>
                  Site lookup
                  <input
                    placeholder="Type a site number or letter"
                    value={siteFilters.siteLookup}
                    onChange={(event) =>
                      updateSiteFilter("siteLookup", event.target.value)
                    }
                  />
                </label>
                <label>
                  Site types
                  <div className="type-dropdown">
                    <button
                      type="button"
                      className="type-dropdown-trigger"
                      onClick={() => setIsTypeMenuOpen((current) => !current)}>
                      {siteFilters.types.length === siteTypeOptions.length
                        ? "All site types"
                        : `${siteFilters.types.length} selected`}
                    </button>
                    {isTypeMenuOpen ? (
                      <div className="type-dropdown-menu">
                        {siteTypeOptions.map((option) => (
                          <label
                            key={option.value}
                            className="type-dropdown-option">
                            <input
                              type="checkbox"
                              checked={siteFilters.types.includes(option.value)}
                              onChange={() =>
                                toggleSiteTypeFilter(option.value)
                              }
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
                    onChange={(event) =>
                      updateSiteFilter("minSizeFeet", event.target.value)
                    }
                  />
                </label>
                <label>
                  Max size
                  <input
                    type="number"
                    min="1"
                    placeholder="Any"
                    value={siteFilters.maxSizeFeet}
                    onChange={(event) =>
                      updateSiteFilter("maxSizeFeet", event.target.value)
                    }
                  />
                </label>
              </div>
              <div className="site-grid">
                {visibleSites.map((site) => (
                  <article
                    key={site.id}
                    className={`site-tile ${site.is_on_river ? "river" : ""} ${
                      openSitePricing[site.id] || activeSiteEditorId === site.id
                        ? "expanded"
                        : ""
                    }`}>
                    <h3>Site {site.site_number}</h3>
                    <p>{site.size_feet} feet</p>
                    <p>{getSiteTypeLabel(site)}</p>
                    <p>
                      River category:{" "}
                      {formatPricingCategory(site.river_category)}
                    </p>
                    <p>Big rig: {site.is_big_rig ? "Yes" : "No"}</p>
                    <p>
                      Pricing category:{" "}
                      {formatPricingCategory(site.pricing_category)}
                    </p>
                    <div className="button-row site-tile-actions">
                      <CardActionMenu
                        menuId={`site-${site.id}`}
                        openMenuId={openCardActionMenuId}
                        onToggle={toggleCardActionMenu}
                        onClose={closeCardActionMenu}
                        actions={[
                          {
                            label: openSitePricing[site.id]
                              ? "Hide prices"
                              : "Prices",
                            onClick: () => toggleSitePricing(site.id),
                          },
                          {
                            label:
                              activeSiteEditorId === site.id
                                ? "Cancel edit"
                                : "Edit site",
                            onClick: () =>
                              activeSiteEditorId === site.id
                                ? cancelSiteEditing()
                                : startEditingSite(site),
                          },
                          {
                            label: "Delete site",
                            danger: true,
                            onClick: () => deleteSite(site),
                          },
                        ]}
                      />
                    </div>
                    {activeSiteEditorId === site.id && siteEditorForm ? (
                      <div className="site-editor-card">
                        <div className="field-grid compact-grid">
                          <label>
                            Site number
                            <input
                              value={siteEditorForm.siteNumber}
                              onChange={(event) =>
                                updateSiteEditorField(
                                  "siteNumber",
                                  event.target.value
                                )
                              }
                            />
                          </label>
                          <label>
                            Size (feet)
                            <input
                              type="number"
                              min="1"
                              value={siteEditorForm.sizeFeet}
                              onChange={(event) =>
                                updateSiteEditorField(
                                  "sizeFeet",
                                  event.target.value
                                )
                              }
                              onWheel={(event) => event.currentTarget.blur()}
                            />
                          </label>
                          <label className="checkbox-row compact-checkbox">
                            <input
                              type="checkbox"
                              checked={siteEditorForm.isOnRiver}
                              onChange={(event) =>
                                updateSiteEditorField(
                                  "isOnRiver",
                                  event.target.checked
                                )
                              }
                            />
                            Riverfront
                          </label>
                          <label className="checkbox-row compact-checkbox">
                            <input
                              type="checkbox"
                              checked={siteEditorForm.isBigRig}
                              onChange={(event) =>
                                updateSiteEditorField(
                                  "isBigRig",
                                  event.target.checked
                                )
                              }
                            />
                            Big rig
                          </label>
                          {siteEditorForm.isOnRiver ? (
                            <label>
                              River category
                              <select
                                value={siteEditorForm.riverCategory}
                                onChange={(event) =>
                                  updateSiteEditorField(
                                    "riverCategory",
                                    event.target.value
                                  )
                                }>
                                {riverCategoryOptions.map((option) => (
                                  <option
                                    key={option.value}
                                    value={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                            </label>
                          ) : null}
                        </div>
                        <div className="button-row">
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={cancelSiteEditing}>
                            Cancel
                          </button>
                          <button
                            type="button"
                            className="primary-button"
                            onClick={saveSiteDetails}>
                            Save site
                          </button>
                        </div>
                      </div>
                    ) : null}
                    {openSitePricing[site.id] ? (
                      <>
                        <div className="day-chip-row">
                          {site.pricing_rules.map((rule) => (
                            <button
                              key={rule.numberOfDays}
                              type="button"
                              className={`day-chip ${
                                openSitePricing[site.id].includes(
                                  rule.numberOfDays
                                )
                                  ? "active"
                                  : ""
                              }`}
                              onClick={() =>
                                toggleSitePricingDay(site.id, rule.numberOfDays)
                              }>
                              {rule.numberOfDays} day
                              {rule.numberOfDays === 1 ? "" : "s"}
                            </button>
                          ))}
                        </div>
                        <div className="pricing-table">
                          {openSitePricing[site.id].length ? (
                            site.pricing_rules
                              .filter((rule) =>
                                openSitePricing[site.id].includes(
                                  rule.numberOfDays
                                )
                              )
                              .map((rule) => (
                                <div
                                  key={rule.numberOfDays}
                                  className="pricing-row">
                                  <span>{rule.numberOfDays} nights</span>
                                  <span>
                                    Normal {formatCurrency(rule.normalPrice)}
                                  </span>
                                  <span>
                                    Discount{" "}
                                    {formatCurrency(rule.discountPrice)}
                                  </span>
                                </div>
                              ))
                          ) : (
                            <p className="muted">
                              Select one or more day counts to view pricing.
                            </p>
                          )}
                        </div>
                      </>
                    ) : null}
                    <span>{site.is_on_river ? "Riverfront" : "Standard"}</span>
                  </article>
                ))}
              </div>
              {isSitesPageLoading && !hasLoadedSites ? (
                <p className="muted">Loading sites...</p>
              ) : !visibleSites.length ? (
                <p className="muted">No sites match the current filters.</p>
              ) : null}
            </>
          </Paper>
        ) : null}

        {isOpeningReservationEditor || isSavingAdminEdit ? (
          <div
            className="admin-operation-overlay"
            role="status"
            aria-live="polite"
            aria-label={
              isOpeningReservationEditor ? "Loading editor" : "Saving changes"
            }>
            <span className="loading-spinner" aria-hidden="true" />
            <strong>
              {isOpeningReservationEditor ? "Loading editor..." : "Saving changes..."}
            </strong>
          </div>
        ) : null}

        {adminSaveNotice ? (
          <div className="admin-save-notice" role="status" aria-live="polite">
            {adminSaveNotice}
          </div>
        ) : null}

        {adminConflictNotice ? (
          <div
            className="admin-conflict-notice"
            role="alert"
            aria-live="assertive">
            <strong>Site availability changed</strong>
            <span>{adminConflictNotice}</span>
            <button
              type="button"
              aria-label="Dismiss conflict notice"
              onClick={() => setAdminConflictNotice("")}>
              ×
            </button>
          </div>
        ) : null}

        {reservationEditor ? (
          <div
            className="modal-backdrop"
            role="presentation"
            onClick={closeReservationEditor}>
            <div
              className="modal-card"
              role="dialog"
              aria-modal="true"
              aria-labelledby="reservation-editor-modal-title"
              onClick={(event) => event.stopPropagation()}>
              <div className="result-header">
                <div>
                  <h3 id="reservation-editor-modal-title">
                    Edit {reservationEditFocusLabel || "reservation"}
                  </h3>
                  <p className="muted">
                    Reservation #{reservationEditor.id} •{" "}
                    {reservationEditor.customer.firstName}{" "}
                    {reservationEditor.customer.lastName}
                  </p>
                </div>
                <div className="button-row schedule-card-actions">
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={closeReservationEditor}>
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
                        updateReservationEditorCustomerField(
                          "firstName",
                          event.target.value
                        )
                      }
                    />
                  </label>
                  <label>
                    Last name
                    <input
                      value={reservationEditor.customer.lastName}
                      onChange={(event) =>
                        updateReservationEditorCustomerField(
                          "lastName",
                          event.target.value
                        )
                      }
                    />
                  </label>
                  <label>
                    Email
                    <input
                      type="email"
                      value={reservationEditor.customer.email}
                      onChange={(event) =>
                        updateReservationEditorCustomerField(
                          "email",
                          event.target.value
                        )
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
                        updateReservationEditorField(
                          "rvKind",
                          event.target.value
                        )
                      }>
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
                        updateReservationEditorField(
                          "rigLengthFeet",
                          event.target.value
                        )
                      }
                    />
                  </label>
                  {reservationEditor.reservation.rvKind === "motor home" ? (
                    <div className="motorhome-options notes-field">
                      <span className="small-text">Motor home details</span>
                      <label className="checkbox-row compact-checkbox">
                        <input
                          type="checkbox"
                          checked={
                            reservationEditor.reservation.motorhomeClassA
                          }
                          onChange={(event) =>
                            updateReservationEditorField(
                              "motorhomeClassA",
                              event.target.checked
                            )
                          }
                        />
                        Class A
                      </label>
                      <label className="checkbox-row compact-checkbox">
                        <input
                          type="checkbox"
                          checked={
                            reservationEditor.reservation.motorhomeClassC
                          }
                          onChange={(event) =>
                            updateReservationEditorField(
                              "motorhomeClassC",
                              event.target.checked
                            )
                          }
                        />
                        Class C
                      </label>
                      <label className="checkbox-row compact-checkbox">
                        <input
                          type="checkbox"
                          checked={
                            reservationEditor.reservation.motorhomeWithTow
                          }
                          onChange={(event) =>
                            updateReservationEditorField(
                              "motorhomeWithTow",
                              event.target.checked
                            )
                          }
                        />
                        With tow
                      </label>
                    </div>
                  ) : null}
                  <SlideSideFields
                    slideDriverSide={
                      reservationEditor.reservation.slideDriverSide
                    }
                    slidePassengerSide={
                      reservationEditor.reservation.slidePassengerSide
                    }
                    onChange={updateReservationEditorField}
                    className="notes-field"
                  />
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
                          updateReservationEditorField(
                            "bookedDate",
                            event.target.value
                          )
                        }
                      />
                    </label>
                    <label>
                      Booking status
                      <select
                        value={reservationEditor.reservation.status}
                        onChange={(event) =>
                          updateReservationEditorField(
                            "status",
                            event.target.value
                          )
                        }>
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
                          updateReservationEditorField(
                            "reservationTerm",
                            event.target.value
                          )
                        }>
                        <option value="standard">Standard</option>
                        <option value="yearly">Yearly</option>
                      </select>
                    </label>
                  </div>
                  <div className="segment-list">
                    {reservationEditor.reservation.siteStays.map(
                      (segment, index) => (
                        <SiteStayFields
                          key={`${reservationEditor.id}-${index}`}
                          segment={segment}
                          index={index}
                          sites={sites}
                          bookedRangesBySite={bookedRangesBySite}
                          reservationTerm={
                            reservationEditor.reservation.reservationTerm
                          }
                          onChange={updateReservationEditorSiteStay}
                          onRemove={removeReservationEditorSiteStay}
                          canRemove={
                            reservationEditor.reservation.reservationTerm !==
                              "yearly" &&
                            reservationEditor.reservation.siteStays.length > 1
                          }
                        />
                      )
                    )}
                    {reservationEditor.reservation.reservationTerm !==
                    "yearly" ? (
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={addReservationEditorSiteStay}>
                        Add stay segment
                      </button>
                    ) : null}
                  </div>
                </>
              ) : null}
              <div className="button-row">
                <button
                  type="button"
                  className="ghost-button"
                  onClick={closeReservationEditor}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={isSavingAdminEdit}
                  onClick={saveReservationEditor}>
                  {isSavingAdminEdit ? "Saving..." : "Save changes"}
                </button>
              </div>
              {reservationEditorErrorMessage ? (
                <div className="message error">
                  {reservationEditorErrorMessage}
                </div>
              ) : null}
              {reservationEditorSuccessMessage ? (
                <div className="message success">
                  {reservationEditorSuccessMessage}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {activeReservationNote ? (
          <div
            className="modal-backdrop"
            role="presentation"
            onClick={closeReservationNote}>
            <div
              className="modal-card note-modal-card"
              role="dialog"
              aria-modal="true"
              aria-labelledby="reservation-note-modal-title"
              onClick={(event) => event.stopPropagation()}>
              <div className="result-header">
                <div>
                  <h3 id="reservation-note-modal-title">Reservation note</h3>
                  <p className="muted">
                    {activeReservationNote.guestName ||
                      `Reservation #${activeReservationNote.reservationId}`}
                  </p>
                </div>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={closeReservationNote}>
                  Close
                </button>
              </div>
              <div className="note-modal-body">
                {activeReservationNote.notes}
              </div>
            </div>
          </div>
        ) : null}

        {stayExtensionForm && stayExtensionReservation && stayExtensionAvailability ? (
          <div
            className="modal-backdrop"
            role="presentation"
            onClick={closeStayExtension}>
            <form
              className="modal-card note-modal-card"
              role="dialog"
              aria-modal="true"
              aria-labelledby="stay-extension-modal-title"
              onSubmit={saveStayExtension}
              onClick={(event) => event.stopPropagation()}>
              <div className="result-header">
                <div>
                  <h3 id="stay-extension-modal-title">Add days to stay</h3>
                  <p className="muted">
                    {stayExtensionReservation.first_name}{" "}
                    {stayExtensionReservation.last_name} • Site{" "}
                    {stayExtensionAvailability.finalStay.site_number}
                  </p>
                </div>
                <button
                  type="button"
                  className="ghost-button"
                  disabled={isSavingStayExtension}
                  onClick={closeStayExtension}>
                  Close
                </button>
              </div>
              <p>
                Current departure:{" "}
                <strong>
                  {formatDisplayDate(
                    stayExtensionAvailability.finalStay.leave_date
                  )}
                </strong>
              </p>
              <label>
                Days to add
                <input
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max={stayExtensionAvailability.maximumDays ?? undefined}
                  step="1"
                  value={stayExtensionForm.days}
                  onChange={(event) => {
                    setStayExtensionError("");
                    setStayExtensionForm((current) => ({
                      ...current,
                      days: event.target.value,
                    }));
                  }}
                  onWheel={(event) => event.currentTarget.blur()}
                />
              </label>
              {Number(stayExtensionForm.days) > 0 ? (
                <p className="muted">
                  New departure:{" "}
                  {formatDisplayDate(
                    addDays(
                      stayExtensionAvailability.finalStay.leave_date,
                      Number(stayExtensionForm.days)
                    )
                  )}
                </p>
              ) : null}
              {stayExtensionError ? (
                <div className="message error">{stayExtensionError}</div>
              ) : null}
              <div className="button-row">
                <button
                  type="button"
                  className="ghost-button"
                  disabled={isSavingStayExtension}
                  onClick={closeStayExtension}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="primary-button"
                  disabled={
                    isSavingStayExtension ||
                    stayExtensionAvailability.maximumDays === 0
                  }>
                  {isSavingStayExtension ? "Adding days..." : "Add days to stay"}
                </button>
              </div>
              <p className="muted stay-extension-availability">
                {stayExtensionAvailability.maximumDays === null
                  ? `Site ${stayExtensionAvailability.finalStay.site_number} has no later booking scheduled, so it is open beyond this stay.`
                  : stayExtensionAvailability.maximumDays === 0
                    ? `Site ${stayExtensionAvailability.finalStay.site_number} has another guest arriving on the current departure date, so no days can be added.`
                    : `Site ${stayExtensionAvailability.finalStay.site_number} is open for ${stayExtensionAvailability.maximumDays} more ${stayExtensionAvailability.maximumDays === 1 ? "day" : "days"}, until ${formatDisplayDate(stayExtensionAvailability.nextStay.arrival_date)}.`}
              </p>
            </form>
          </div>
        ) : null}

        {activeScheduleReservation ? (
          <div
            className="modal-backdrop"
            role="presentation"
            onClick={() => setActiveScheduleReservation(null)}>
            <div
              className="modal-card"
              role="dialog"
              aria-modal="true"
              aria-labelledby="today-schedule-modal-title"
              onClick={(event) => event.stopPropagation()}>
              <div className="result-header">
                <h3 id="today-schedule-modal-title">
                  {activeScheduleReservation.first_name}{" "}
                  {activeScheduleReservation.last_name}
                </h3>
                <div className="button-row schedule-card-actions">
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() =>
                      setIsEditingSchedulePaymentInfo((current) => !current)
                    }>
                    {isEditingSchedulePaymentInfo
                      ? "Hide payment info"
                      : "Edit payment info"}
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => setActiveScheduleReservation(null)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => setActiveScheduleReservation(null)}>
                    Close
                  </button>
                </div>
              </div>
              <p className="muted">
                Booked{" "}
                {formatDisplayDate(activeScheduleReservation.booked_date)} •{" "}
                {formatReservationTerm(
                  activeScheduleReservation.reservation_term
                )}{" "}
                • {activeScheduleReservation.rv_kind}
                {formatMotorhomeDetails(activeScheduleReservation)}
                {activeScheduleReservation.rig_length_feet
                  ? ` • ${activeScheduleReservation.rig_length_feet} ft rig`
                  : ""}
              </p>
              <div className="pricing-summary">
                <span>
                  Email: {activeScheduleReservation.email || "Not set"}
                </span>
                <span>
                  Phone:{" "}
                  {formatPhoneNumber(
                    activeScheduleReservation.phone_number || ""
                  ) || "Not set"}
                </span>
                <span>
                  Rig size:{" "}
                  {activeScheduleReservation.rig_length_feet
                    ? `${activeScheduleReservation.rig_length_feet} ft`
                    : "Not set"}
                </span>
              </div>
              <div className="pricing-summary">
                <span>
                  Payment choice: {formatSelectedPaymentMethod(
                    activeScheduleReservation.selectedPaymentMethod
                  )}
                </span>
                <span>
                  Discounted price:{" "}
                  {activeScheduleReservation.requestedDiscounts?.length
                    ? "Qualified"
                    : "Not qualified"}
                </span>
                <span>
                  Deposit amount:{" "}
                  {formatCurrency(activeScheduleReservation.depositAmount)}
                </span>
                <span>
                  Booking total:{" "}
                  {formatCurrency(
                    activeScheduleReservation.effectiveTotalPrice ??
                      activeScheduleReservation.totalPrice
                  )}
                </span>
                <span>
                  Remaining balance:{" "}
                  {formatCurrency(activeScheduleReservation.remainingBalance)}
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
                    <strong>Site {segment.site_number}</strong>: arrival{" "}
                    {formatDisplayDate(segment.arrival_date)} • leave{" "}
                    {formatLeaveDate(segment.leave_date)}
                    {segment.numberOfNights
                      ? ` • ${segment.numberOfNights} nights`
                      : " • Yearly stay"}
                  </li>
                ))}
              </ol>
              <div className="pricing-summary">
                <span>
                  Deposit amount:{" "}
                  {formatCurrency(activeScheduleReservation.depositAmount)}
                </span>
                <span>
                  Booking total:{" "}
                  {formatCurrency(
                    activeScheduleReservation.effectiveTotalPrice ??
                      activeScheduleReservation.totalPrice
                  )}
                </span>
                <span>
                  Amount paid:{" "}
                  {formatCurrency(activeScheduleReservation.amountPaid)}
                </span>
                <span>
                  Remaining balance:{" "}
                  {formatCurrency(activeScheduleReservation.remainingBalance)}
                </span>
              </div>
              {activeScheduleReservation.paymentEvents?.length ? (
                <div className="timeline-card payment-history-card">
                  <h3>Payment history</h3>
                  <ul className="timeline-list">
                    {activeScheduleReservation.paymentEvents.map(
                      (paymentEvent) => (
                        <li
                          key={paymentEvent.id}
                          className="payment-history-item">
                          <span>
                            {formatPaymentSource(paymentEvent.paymentSource)} •{" "}
                            {formatCurrency(paymentEvent.amount)} •{" "}
                            {new Date(paymentEvent.recordedAt).toLocaleString()}
                            {paymentEvent.note ? ` • ${paymentEvent.note}` : ""}
                          </span>
                          {paymentEvent.paymentSource ===
                          "office_card_reader" ? (
                            <button
                              type="button"
                              className="ghost-button danger-button payment-history-delete"
                              onClick={() =>
                                deleteOfficePaymentRecord(paymentEvent)
                              }>
                              Delete
                            </button>
                          ) : null}
                        </li>
                      )
                    )}
                  </ul>
                </div>
              ) : null}
              {isEditingSchedulePaymentInfo ? (
                <div className="payment-panel">
                  <div className="result-header">
                    <h3>Edit payment info</h3>
                    <span className="balance-pill">
                      Balance{" "}
                      {formatCurrency(
                        activeScheduleReservation.remainingBalance
                      )}
                    </span>
                  </div>
                  <div className="payment-edit-sections">
                    <div className="timeline-card payment-edit-card">
                      <div className="result-header">
                        <h4>Reservation amounts</h4>
                        <span className="muted">
                          Save these only when you want to change the booking
                          totals.
                        </span>
                      </div>
                      <label className="checkbox-row compact-checkbox payment-discount-checkbox">
                        <input
                          type="checkbox"
                          checked={schedulePaymentForm.discountQualified}
                          onChange={(event) =>
                            updateScheduleDiscountQualification(
                              event.target.checked
                            )
                          }
                        />
                        <span>
                          <strong>Guest qualifies for the discounted price</strong>
                          <small>
                            Saving will update the booking total and remaining
                            balance using this stay’s discount pricing.
                          </small>
                        </span>
                      </label>
                      <div className="pricing-summary payment-discount-preview">
                        <span>
                          Standard stay price:{" "}
                          {formatCurrency(
                            activeScheduleReservation.totals?.normalPrice
                          )}
                        </span>
                        <span>
                          Discounted stay price:{" "}
                          {formatCurrency(
                            activeScheduleReservation.totals?.discountPrice
                          )}
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
                              updateSchedulePaymentField(
                                "depositAmount",
                                event.target.value
                              )
                            }
                            onWheel={(event) => event.currentTarget.blur()}
                          />
                        </label>
                        <label>
                          Booking total
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={schedulePaymentForm.totalPrice}
                            onChange={(event) =>
                              updateSchedulePaymentField(
                                "totalPrice",
                                event.target.value
                              )
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
                              updateSchedulePaymentField(
                                "amountPaid",
                                event.target.value
                              )
                            }
                            onWheel={(event) => event.currentTarget.blur()}
                          />
                        </label>
                      </div>
                    </div>
                    <div className="timeline-card payment-edit-card office-payment-card">
                      <div className="result-header">
                        <h4>Record office payment</h4>
                        <span className="muted">
                          This uses only the office payment amount below.
                        </span>
                      </div>
                      <div className="field-grid">
                        <label>
                          Office payment amount
                          <input
                            type="number"
                            min="0.01"
                            step="0.01"
                            value={activeSchedulePaymentAmount}
                            onChange={(event) =>
                              setActiveSchedulePaymentAmount(event.target.value)
                            }
                            onWheel={(event) => event.currentTarget.blur()}
                          />
                        </label>
                      </div>
                      <div className="button-row">
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() =>
                            recordOfficePayment(activeScheduleReservation)
                          }>
                          Record office payment
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="button-row">
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => {
                        setSchedulePaymentForm(
                          createSchedulePaymentForm(activeScheduleReservation)
                        );
                        setSchedulePaymentErrorMessage("");
                        setSchedulePaymentSuccessMessage("");
                        setIsEditingSchedulePaymentInfo(false);
                      }}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="primary-button"
                      disabled={isSavingAdminEdit}
                      onClick={saveSchedulePaymentInfo}>
                      {isSavingAdminEdit ? "Saving..." : "Save payment info"}
                    </button>
                  </div>
                  {schedulePaymentErrorMessage ? (
                    <div className="message error">
                      {schedulePaymentErrorMessage}
                    </div>
                  ) : null}
                  {schedulePaymentSuccessMessage ? (
                    <div className="message success">
                      {schedulePaymentSuccessMessage}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {activeScheduleReservation.status !== "canceled" ? (
                <div className="payment-panel">
                  <div className="result-header">
                    <h3>Collect card payment</h3>
                    <span className="balance-pill">
                      Card balance{" "}
                      {formatCurrency(
                        activeScheduleReservation.cardRemainingBalance ??
                          getCardPrice(activeScheduleReservation.remainingBalance)
                      )}
                    </span>
                  </div>
                  <div className="payment-grid">
                    <label>
                      Card payment amount
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={activeSchedulePaymentAmount}
                        onChange={(event) => {
                          setActiveSchedulePaymentAmount(event.target.value);
                          setScheduleCardPayment(null);
                          setPaymentLinkSuccessMessage("");
                        }}
                        onWheel={(event) => event.currentTarget.blur()}
                      />
                    </label>
                    <div className="pricing-summary">
                      <span>
                        Standard balance:{" "}
                        {formatCurrency(
                          activeScheduleReservation.remainingBalance
                        )}
                      </span>
                      <span>
                        Card balance:{" "}
                        {formatCurrency(
                          activeScheduleReservation.cardRemainingBalance ??
                            getCardPrice(
                              activeScheduleReservation.remainingBalance
                            )
                        )}
                      </span>
                      <span>
                        Amount paid:{" "}
                        {formatCurrency(activeScheduleReservation.amountPaid)}
                      </span>
                      <span>
                        Status:{" "}
                        {formatReservationStatus(
                          activeScheduleReservation.status
                        )}
                      </span>
                      <span>
                        Office payment: use this amount box, then record it
                        below.
                      </span>
                      <span>
                        Remaining standard balance:{" "}
                        {formatCurrency(
                          activeScheduleReservation.remainingBalance
                        )}
                      </span>
                    </div>
                  </div>
                  <div className="button-row">
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() =>
                        recordOfficePayment(activeScheduleReservation)
                      }>
                      Record office payment
                    </button>
                    {Number(activeScheduleReservation.remainingBalance || 0) >
                    0 ? (
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() =>
                          markReservationPaid(activeScheduleReservation)
                        }>
                        Mark fully paid
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() =>
                        handleSchedulePaymentLink(activeScheduleReservation)
                      }>
                      Pull up card info
                    </button>
                    <button
                      type="button"
                      className="primary-button"
                      disabled={
                        Number(activeScheduleReservation.remainingBalance || 0) <=
                        0
                      }
                      onClick={() =>
                        generatePaymentLink(
                          activeScheduleReservation,
                          "Remaining-balance payment link"
                        )
                      }>
                      Generate payment link
                    </button>
                  </div>
                  {paymentLinkErrorMessage ? (
                    <div className="message error">
                      {paymentLinkErrorMessage}
                    </div>
                  ) : null}
                  {paymentLinkSuccessMessage ? (
                    <div className="message success">
                      {paymentLinkSuccessMessage}
                    </div>
                  ) : null}
                  {generatedPaymentLink?.reservationId ===
                  activeScheduleReservation.id ? (
                    <div className="generated-payment-link-card">
                      <div>
                        <span>Bank payment</span>
                        <strong>
                          {formatCurrency(generatedPaymentLink.bankAmount)}
                        </strong>
                      </div>
                      <div>
                        <span>Credit card payment</span>
                        <strong>
                          {formatCurrency(generatedPaymentLink.cardAmount)}
                        </strong>
                      </div>
                      <label>
                        Riverpark payment link
                        <input
                          readOnly
                          value={generatedPaymentLink.checkoutUrl}
                          onFocus={(event) => event.target.select()}
                        />
                      </label>
                      <div className="button-row">
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={copyPaymentLinkToClipboard}>
                          Copy link
                        </button>
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() =>
                            openPaymentLinkTextMessage(
                              activeScheduleReservation
                            )
                          }>
                          Text link
                        </button>
                        <a
                          className="ghost-button"
                          href={generatedPaymentLink.checkoutUrl}
                          target="_blank"
                          rel="noreferrer">
                          Open link
                        </a>
                      </div>
                    </div>
                  ) : null}
                  {hasScheduleCardPayment ? (
                    <Elements stripe={getStripePromise()}>
                      <CardPaymentForm
                        amountLabel={formatCurrency(scheduleCardPayment.amount)}
                        clientSecret={scheduleCardPayment.clientSecret}
                        reservation={activeScheduleReservation}
                        onCancel={() => setScheduleCardPayment(null)}
                        onSuccess={async () => {
                          const refreshedReservation =
                            await finalizeCardPayment(
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
                <p className="muted">
                  Notes: {activeScheduleReservation.notes}
                </p>
              ) : null}
              <div className="button-row booking-delete-row">
                <button
                  type="button"
                  className="ghost-button danger-button booking-delete-icon-button"
                  aria-label="Delete reservation"
                  onClick={() => deleteReservation(activeScheduleReservation)}>
                  🗑
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </main>
    </Container>
  );
}
