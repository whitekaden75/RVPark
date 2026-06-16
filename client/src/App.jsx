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
  notes: "",
  siteStays: [{ siteId: "", arrivalDate: "", leaveDate: "" }]
};

const rvKinds = ["camper", "van", "5th wheel", "motor home", "trailer"];
const siteNumberCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base"
});

const emptySiteFilters = {
  type: "all",
  minSizeFeet: "",
  maxSizeFeet: ""
};

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
                Site {site.site_number} • {site.size_feet} ft {site.is_on_river ? "• River" : ""}
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
  const [siteFilters, setSiteFilters] = useState(emptySiteFilters);
  const [searchForm, setSearchForm] = useState(emptySearch);
  const [customerForm, setCustomerForm] = useState(emptyCustomer);
  const [reservationForm, setReservationForm] = useState(emptyReservation);
  const [directMatches, setDirectMatches] = useState([]);
  const [switchPlan, setSwitchPlan] = useState(null);
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
      if (siteFilters.type === "riverfront" && !site.is_on_river) {
        return false;
      }

      if (siteFilters.type === "standard" && site.is_on_river) {
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
                      Site {site.siteNumber} • {site.sizeFeet} ft •{" "}
                      {site.isOnRiver ? "Riverfront" : "Standard"}
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
                <ol className="timeline-list">
                  {switchPlan.map((segment, index) => (
                    <li key={`${segment.siteId}-${index}`}>
                      Site {segment.siteNumber}: {segment.arrivalDate} to {segment.leaveDate}
                    </li>
                  ))}
                </ol>
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
                    Site {segment.site_number}: {segment.arrival_date} to {segment.leave_date}
                  </li>
                ))}
              </ol>
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
              Type
              <select
                value={siteFilters.type}
                onChange={(event) => updateSiteFilter("type", event.target.value)}
              >
                <option value="all">All sites</option>
                <option value="riverfront">Riverfront only</option>
                <option value="standard">Standard only</option>
              </select>
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
              <article key={site.id} className={`site-tile ${site.is_on_river ? "river" : ""}`}>
                <h3>Site {site.site_number}</h3>
                <p>{site.size_feet} feet</p>
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
