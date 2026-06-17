import { useEffect, useState } from "react";

const apiBaseUrl = (
  import.meta.env.VITE_API_BASE_URL || "https://rvpark-production.up.railway.app/api"
).replace(/\/+$/, "");
const appPasscode = import.meta.env.VITE_APP_PASSCODE || "rvpark2026";
const unlockStorageKey = "rvpark-unlocked";

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

const emptyReservation = {
  customerId: "",
  bookedDate: "",
  rvKind: "camper",
  rigLengthFeet: "",
  amountPaid: "",
  notes: "",
  siteStays: [{ siteId: "", siteSearch: "", arrivalDate: "", leaveDate: "" }]
};

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
  if (!arrivalDate || !leaveDate) {
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

  if (!isJson) {
    throw new Error(
      `Expected JSON from ${apiBaseUrl}${path}. Check that VITE_API_BASE_URL points to your backend /api URL.`
    );
  }

  return data;
}

function BookingSiteCalendar({ segment, bookedRanges, onSelectRange }) {
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
          {segment.leaveDate
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

export default function App() {
  const [isUnlocked, setIsUnlocked] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }

    return window.sessionStorage.getItem(unlockStorageKey) === "true";
  });
  const [passcodeInput, setPasscodeInput] = useState("");
  const [passcodeError, setPasscodeError] = useState("");
  const [sites, setSites] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [reservations, setReservations] = useState([]);
  const [timelineSiteId, setTimelineSiteId] = useState("");
  const [selectedTimelineDate, setSelectedTimelineDate] = useState(formatDateInput(new Date()));
  const [timelineMonthCursor, setTimelineMonthCursor] = useState(() =>
    startOfMonth(formatDateInput(new Date()))
  );
  const [customerSearch, setCustomerSearch] = useState("");
  const [scheduleNameSearch, setScheduleNameSearch] = useState("");
  const [isTypeMenuOpen, setIsTypeMenuOpen] = useState(false);
  const [siteFilters, setSiteFilters] = useState(emptySiteFilters);
  const [openSitePricing, setOpenSitePricing] = useState({});
  const [searchForm, setSearchForm] = useState(emptySearch);
  const [customerForm, setCustomerForm] = useState(emptyCustomer);
  const [reservationForm, setReservationForm] = useState(emptyReservation);
  const [directMatches, setDirectMatches] = useState([]);
  const [switchPlan, setSwitchPlan] = useState(null);
  const [switchPlanTotals, setSwitchPlanTotals] = useState(null);
  const [createdReservation, setCreatedReservation] = useState(null);
  const [editingReservationId, setEditingReservationId] = useState(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [reservationErrorMessage, setReservationErrorMessage] = useState("");
  const [reservationSuccessMessage, setReservationSuccessMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");

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
    if (!timelineSiteId && sites.length > 0) {
      setTimelineSiteId(String(sites[0].id));
    }
  }, [sites, timelineSiteId]);

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
  const visibleCustomers = customers.filter((customer) => {
    const searchValue = customerSearch.trim().toLowerCase();

    if (!searchValue) {
      return true;
    }

    const fullName = `${customer.first_name} ${customer.last_name}`.toLowerCase();
    return fullName.includes(searchValue);
  });
  const scheduleReservations = [...reservations].sort((left, right) => {
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
    .filter(Boolean)
    .filter((reservation) => {
      const searchValue = scheduleNameSearch.trim().toLowerCase();

      if (!searchValue) {
        return true;
      }

      return `${reservation.first_name} ${reservation.last_name}`
        .toLowerCase()
        .includes(searchValue);
    });
  const timelineStartDate = formatDateInput(timelineMonthCursor);
  const timelineEndDate = formatDateInput(startOfNextMonth(timelineMonthCursor));
  const selectedTimelineSite = sites.find((site) => String(site.id) === timelineSiteId) || null;
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
          customerName: `${reservation.first_name} ${reservation.last_name}`,
          rvKind: reservation.rv_kind,
          rigLengthFeet: reservation.rig_length_feet,
          segment
        }))
    )
    .filter((entry) => {
      const searchValue = scheduleNameSearch.trim().toLowerCase();
      return searchValue ? entry.customerName.toLowerCase().includes(searchValue) : true;
    })
    .sort((left, right) => left.segment.arrival_date.localeCompare(right.segment.arrival_date));
  const selectedDateReservations = selectedSiteTimeline.filter((entry) =>
    isDateWithinRange(selectedTimelineDate, entry.segment.arrival_date, entry.segment.leave_date)
  );

  async function refreshReservations() {
    const reservationData = await apiRequest("/reservations");
    setReservations(ensureArray(reservationData, "Reservations"));
  }

  function resetReservationForm() {
    setReservationForm(emptyReservation);
    setCustomerSearch("");
    setCustomerForm(emptyCustomer);
    setEditingReservationId(null);
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

  function updateReservationField(field, value) {
    setReservationForm((current) => ({ ...current, [field]: value }));
  }

  function updateSiteStay(index, field, value) {
    setReservationForm((current) => ({
      ...current,
      siteStays: current.siteStays.map((stay, stayIndex) =>
        stayIndex === index ? { ...stay, [field]: value } : stay
      )
    }));
  }

  function addSiteStay() {
    setReservationForm((current) => ({
      ...current,
      siteStays: [
        ...current.siteStays,
        { siteId: "", siteSearch: "", arrivalDate: "", leaveDate: "" }
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

    try {
      let customerId = reservationForm.customerId
        ? Number(reservationForm.customerId)
        : null;

      if (!customerId) {
        const createdCustomer = await apiRequest("/customers", {
          method: "POST",
          body: JSON.stringify(customerForm)
        });

        setCustomers((current) => [...current, createdCustomer]);
        setCustomerSearch(`${createdCustomer.first_name} ${createdCustomer.last_name}`);
        customerId = createdCustomer.id;
      }

      const payload = {
        ...reservationForm,
        customerId
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
        setSuccessMessage(`Created reservation #${created.id}.`);
        setReservationSuccessMessage(`Created reservation #${created.id}.`);
      }

      await refreshReservations();
      resetReservationForm();
    } catch (error) {
      setReservationErrorMessage(error.message);
    }
  }

  async function startEditingReservation(reservationId) {
    setErrorMessage("");

    try {
      const reservation = await apiRequest(`/reservations/${reservationId}`);
      setEditingReservationId(reservation.id);
      setCustomerForm({
        firstName: reservation.first_name || "",
        lastName: reservation.last_name || "",
        email: reservation.email || "",
        phoneNumber: reservation.phone_number || ""
      });
      setReservationForm({
        customerId: String(reservation.customer_id),
        bookedDate: reservation.booked_date,
        rvKind: reservation.rv_kind,
        rigLengthFeet: String(reservation.rig_length_feet ?? ""),
        amountPaid: String(reservation.amountPaid ?? ""),
        notes: reservation.notes || "",
        siteStays: reservation.siteStays.map((segment) => ({
          siteId: String(segment.site_id),
          siteSearch: segment.site_number,
          arrivalDate: segment.arrival_date,
          leaveDate: segment.leave_date
        }))
      });
      setCustomerSearch(`${reservation.first_name} ${reservation.last_name}`);
      setCreatedReservation(reservation);
    } catch (error) {
      setErrorMessage(error.message);
    }
  }

  function cancelEditingReservation() {
    resetReservationForm();
  }

  async function handleReservationRefresh() {
    setErrorMessage("");

    try {
      await refreshReservations();
    } catch (error) {
      setErrorMessage(error.message);
    }
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
  }

  function changeTimelineMonth(offset) {
    setTimelineMonthCursor((current) => {
      const next = new Date(current);
      next.setUTCMonth(next.getUTCMonth() + offset);
      return new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth(), 1));
    });
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
          <div className="section-heading">
            <h2>Availability Search</h2>
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
              <h3>Direct matches</h3>
              {directMatches.length ? (
                <ul className="result-list">
                  {directMatches.map((site) => (
                    <li key={site.id}>
                      <strong>Site {site.siteNumber}</strong> • {site.sizeFeet} ft •{" "}
                      {getSiteTypeLabel(site)} • {formatPricingCategory(site.pricingCategory)} •{" "}
                      {site.numberOfNights} nights • Normal {formatCurrency(site.normalPrice)} •
                      Discount {formatCurrency(site.discountPrice)}
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
                    {switchPlan.map((segment, index) => (
                      <li key={`${segment.siteId}-${index}`}>
                        Site {segment.siteNumber}: {segment.arrivalDate} to {segment.leaveDate} •{" "}
                        {segment.numberOfNights} nights •{" "}
                        {formatPricingCategory(segment.pricingCategory)} • Normal{" "}
                        {formatCurrency(segment.normalPrice)} • Discount{" "}
                        {formatCurrency(segment.discountPrice)}
                      </li>
                    ))}
                  </ol>
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
        </section>

        <section className="card">
          <div>
            <div className="section-heading">
              <h2>{editingReservationId ? `Edit Reservation #${editingReservationId}` : "Create Reservation"}</h2>
              <p>Create the customer and reservation together, or pick an existing customer.</p>
            </div>
            <form onSubmit={handleReservationCreate}>
              <div className="field-grid">
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
                    value={customerForm.phoneNumber}
                    onChange={(event) => updateCustomerField("phoneNumber", event.target.value)}
                  />
                </label>
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
                    onChange={(event) => updateReservationField("customerId", event.target.value)}
                  >
                    <option value="">Create a new customer from the fields above</option>
                    {visibleCustomers.map((customer) => (
                      <option key={customer.id} value={customer.id}>
                        #{customer.id} {customer.first_name} {customer.last_name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Booked date
                  <input
                    type="date"
                    value={reservationForm.bookedDate}
                    onChange={(event) => updateReservationField("bookedDate", event.target.value)}
                  />
                </label>
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
                <label>
                  Amount paid
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    value={reservationForm.amountPaid}
                    onChange={(event) => updateReservationField("amountPaid", event.target.value)}
                  />
                </label>
                <label className="notes-field">
                  Notes
                  <textarea
                    rows="4"
                    value={reservationForm.notes}
                    onChange={(event) => updateReservationField("notes", event.target.value)}
                  />
                </label>
              </div>

              <div className="segment-list">
                {reservationForm.siteStays.map((segment, index) => (
                  <SiteStayFields
                    key={index}
                    segment={segment}
                    index={index}
                    sites={sites}
                    bookedRangesBySite={bookedRangesBySite}
                    onChange={updateSiteStay}
                    onRemove={removeSiteStay}
                    canRemove={reservationForm.siteStays.length > 1}
                  />
                ))}
              </div>

              {reservationPricingPreview.length ? (
                <div className="pricing-preview-card">
                  <h3>Pricing Preview</h3>
                  <ul className="result-list">
                    {reservationPricingPreview.map((segment) => (
                      <li key={segment.index}>
                        Site {segment.siteNumber} • {segment.numberOfNights} nights •{" "}
                        {formatPricingCategory(segment.pricingCategory)} • Normal{" "}
                        {formatCurrency(segment.normalPrice)} • Discount{" "}
                        {formatCurrency(segment.discountPrice)}
                      </li>
                    ))}
                  </ul>
                  <div className="pricing-summary">
                    <span>Total normal: {formatCurrency(reservationPricingTotals.normalPrice)}</span>
                    <span>
                      Total discount: {formatCurrency(reservationPricingTotals.discountPrice)}
                    </span>
                    <span>
                      Remaining normal:{" "}
                      {formatCurrency(
                        reservationPricingTotals.normalPrice !== null
                          ? Math.max(
                              reservationPricingTotals.normalPrice -
                                (Number(reservationForm.amountPaid || 0) || 0),
                              0
                            )
                          : null
                      )}
                    </span>
                    <span>
                      Remaining discount:{" "}
                      {formatCurrency(
                        reservationPricingTotals.discountPrice !== null
                          ? Math.max(
                              reservationPricingTotals.discountPrice -
                                (Number(reservationForm.amountPaid || 0) || 0),
                              0
                            )
                          : null
                      )}
                    </span>
                  </div>
                </div>
              ) : null}

              <div className="button-row">
                <button type="button" className="ghost-button" onClick={addSiteStay}>
                  Add site stay
                </button>
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
            </form>
          </div>
        </section>

        <section className="card">
          <div className="section-heading">
            <h2>Schedule</h2>
            <p>See who is in a site today, then inspect a single site timeline for any date window.</p>
          </div>
          <div className="button-row">
            <span className="muted">{currentOccupancy.length} current stays today</span>
            <button type="button" className="ghost-button" onClick={handleReservationRefresh}>
              Refresh schedule
            </button>
          </div>
          <div className="timeline-controls">
            <label>
              Search name
              <input
                placeholder="Type a customer name"
                value={scheduleNameSearch}
                onChange={(event) => setScheduleNameSearch(event.target.value)}
              />
            </label>
          </div>
          {currentOccupancy.length ? (
            <div className="schedule-list">
              {currentOccupancy.map((reservation) => (
                <article key={reservation.id} className="timeline-card">
                  <div className="result-header">
                    <h3>
                      Reservation #{reservation.id} • {reservation.first_name} {reservation.last_name}
                    </h3>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => startEditingReservation(reservation.id)}
                    >
                      Edit
                    </button>
                  </div>
                  <p className="muted">
                    Booked {formatDisplayDate(reservation.booked_date)} • {reservation.rv_kind}
                    {reservation.rig_length_feet ? ` • ${reservation.rig_length_feet} ft rig` : ""}
                  </p>
                  <ol className="timeline-list">
                    {reservation.activeSiteStays.map((segment) => (
                      <li key={segment.id}>
                        Site {segment.site_number}: {formatDisplayDate(
                          segment.arrival_date
                        )} to {formatDisplayDate(segment.leave_date)} •{" "}
                        {segment.numberOfNights} nights •{" "}
                        {formatPricingCategory(segment.pricingCategory)} • Normal{" "}
                        {formatCurrency(segment.normalPrice)} • Discount{" "}
                        {formatCurrency(segment.discountPrice)}
                      </li>
                    ))}
                  </ol>
                  <div className="pricing-summary">
                    <span>Total normal: {formatCurrency(reservation.totals?.normalPrice)}</span>
                    <span>
                      Total discount: {formatCurrency(reservation.totals?.discountPrice)}
                    </span>
                    <span>Amount paid: {formatCurrency(reservation.amountPaid)}</span>
                    <span>
                      Remaining normal: {formatCurrency(reservation.remainingNormalPrice)}
                    </span>
                    <span>
                      Remaining discount: {formatCurrency(reservation.remainingDiscountPrice)}
                    </span>
                  </div>
                  {reservation.notes ? <p className="muted">Notes: {reservation.notes}</p> : null}
                </article>
              ))}
            </div>
          ) : (
            <p className="muted">No guests are currently in a site today.</p>
          )}

          <div className="timeline-controls">
            <label>
              Site
              <select
                value={timelineSiteId}
                onChange={(event) => setTimelineSiteId(event.target.value)}
              >
                {sites.map((site) => (
                  <option key={site.id} value={site.id}>
                    Site {site.site_number}
                  </option>
                ))}
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
                        {entry.customerName} • Reservation #{entry.reservationId}
                      </h4>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => startEditingReservation(entry.reservationId)}
                      >
                        Edit
                      </button>
                    </div>
                    <p className="muted">
                      {formatDisplayDate(entry.segment.arrival_date)} to{" "}
                      {formatDisplayDate(entry.segment.leave_date)} • {entry.rvKind}
                      {entry.rigLengthFeet ? ` • ${entry.rigLengthFeet} ft rig` : ""}
                    </p>
                  </article>
                ))}
              </div>
            ) : (
              <p className="muted">No booking is assigned to this site on the selected date.</p>
            )}
          </div>
        </section>

        <section className="card">
          <div className="section-heading">
            <h2>RV Sites</h2>
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
        </section>
      </main>
    </div>
  );
}
