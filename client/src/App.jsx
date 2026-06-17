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
  amountPaid: "",
  notes: "",
  siteStays: [{ siteId: "", arrivalDate: "", leaveDate: "" }]
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

function SiteStayFields({ segment, index, sites, onChange, onRemove, canRemove }) {
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
          Site
          <select
            value={segment.siteId}
            onChange={(event) => onChange(index, "siteId", event.target.value)}
          >
            <option value="">Select a site</option>
            {sites.map((site) => (
              <option key={site.id} value={site.id}>
                Site {site.site_number} • {site.size_feet} ft •{" "}
                {formatPricingCategory(site.pricing_category)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Arrival
          <input
            type="date"
            value={segment.arrivalDate}
            onChange={(event) => onChange(index, "arrivalDate", event.target.value)}
          />
        </label>
        <label>
          Leave
          <input
            type="date"
            value={segment.leaveDate}
            onChange={(event) => onChange(index, "leaveDate", event.target.value)}
          />
        </label>
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
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");

  useEffect(() => {
    async function loadInitialData() {
      try {
        const [siteData, customerData] = await Promise.all([
          apiRequest("/sites"),
          apiRequest("/customers")
        ]);

        setSites(ensureArray(siteData, "Sites"));
        setCustomers(ensureArray(customerData, "Customers"));
      } catch (error) {
        setErrorMessage(error.message);
      }
    }

    loadInitialData();
  }, []);

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
      siteStays: [...current.siteStays, { siteId: "", arrivalDate: "", leaveDate: "" }]
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

  async function handleCustomerCreate(event) {
    event.preventDefault();
    setErrorMessage("");
    setSuccessMessage("");

    try {
      const createdCustomer = await apiRequest("/customers", {
        method: "POST",
        body: JSON.stringify(customerForm)
      });

      setCustomers((current) => [...current, createdCustomer]);
      setReservationForm((current) => ({
        ...current,
        customerId: String(createdCustomer.id)
      }));
      setCustomerForm(emptyCustomer);
      setSuccessMessage(`Created customer #${createdCustomer.id}.`);
    } catch (error) {
      setErrorMessage(error.message);
    }
  }

  async function handleReservationCreate(event) {
    event.preventDefault();
    setErrorMessage("");
    setSuccessMessage("");

    try {
      const created = await apiRequest("/reservations", {
        method: "POST",
        body: JSON.stringify({
          ...reservationForm,
          customerId: Number(reservationForm.customerId)
        })
      });

      setCreatedReservation(created);
      setSuccessMessage(`Created reservation #${created.id}.`);
      setReservationForm(emptyReservation);
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
        arrivalDate: segment.arrivalDate,
        leaveDate: segment.leaveDate
      }))
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

        <section className="card two-column">
          <div>
            <div className="section-heading">
              <h2>Create Customer</h2>
              <p>Save guest details first, then attach the customer to a reservation.</p>
            </div>
            <form onSubmit={handleCustomerCreate}>
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
              </div>
              <button type="submit" className="primary-button">
                Create customer
              </button>
            </form>
          </div>

          <div>
            <div className="section-heading">
              <h2>Create Reservation</h2>
              <p>One reservation can contain one or more contiguous site stays.</p>
            </div>
            <form onSubmit={handleReservationCreate}>
              <div className="field-grid">
                <label>
                  Customer
                  <select
                    value={reservationForm.customerId}
                    onChange={(event) => updateReservationField("customerId", event.target.value)}
                  >
                    <option value="">Select a customer</option>
                    {customers.map((customer) => (
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
                <button type="submit" className="primary-button">
                  Create reservation
                </button>
              </div>
            </form>
          </div>
        </section>

        <section className="card">
          <div className="section-heading">
            <h2>Reservation Timeline</h2>
            <p>The reservation response returns the saved site segments in order.</p>
          </div>
          {createdReservation ? (
            <div className="timeline-card">
              <h3>Reservation #{createdReservation.id}</h3>
              <ol className="timeline-list">
                {createdReservation.siteStays.map((segment) => (
                  <li key={segment.id}>
                    Site {segment.site_number}: {segment.arrival_date} to {segment.leave_date} •{" "}
                    {segment.numberOfNights} nights •{" "}
                    {formatPricingCategory(segment.pricingCategory)} • Normal{" "}
                    {formatCurrency(segment.normalPrice)} • Discount{" "}
                    {formatCurrency(segment.discountPrice)}
                  </li>
                ))}
              </ol>
              <div className="pricing-summary">
                <span>Total normal: {formatCurrency(createdReservation.totals?.normalPrice)}</span>
                <span>
                  Total discount: {formatCurrency(createdReservation.totals?.discountPrice)}
                </span>
                <span>Amount paid: {formatCurrency(createdReservation.amountPaid)}</span>
                <span>
                  Remaining normal: {formatCurrency(createdReservation.remainingNormalPrice)}
                </span>
                <span>
                  Remaining discount: {formatCurrency(createdReservation.remainingDiscountPrice)}
                </span>
              </div>
            </div>
          ) : (
            <p className="muted">Create a reservation to see its saved timeline here.</p>
          )}
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
