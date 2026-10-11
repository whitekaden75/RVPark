import { useState } from "react";
import { getAdminOverview } from "./admin-ui.js";

function OverviewIcon({ name, ...props }) {
  const paths = {
    sites: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M3 10h18M9 10v10M15 10v10" /></>,
    arrival: <><path d="M14 4h5v16h-5M3 12h12m-4-4 4 4-4 4" /></>,
    departure: <><path d="M10 4H5v16h5M10 12h11m-4-4 4 4-4 4" /></>,
    pending: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  };
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name] || paths.arrow}</svg>;
}

export default function AdminOverview({ reservations, sites, today, isLoading, onNavigate, onOpenReservation, onRefresh }) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const [paymentFilter, setPaymentFilter] = useState("all");
  const [paymentSearch, setPaymentSearch] = useState("");
  const overview = getAdminOverview(reservations, sites, today);
  const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const followUps = overview.paymentFollowUps.filter((entry) => {
    if (paymentFilter === "yesterday" && entry.arrivalDate !== yesterday) return false;
    if (paymentFilter === "departed" && !entry.departed) return false;
    const query = paymentSearch.trim().toLowerCase();
    return `${entry.reservation.first_name} ${entry.reservation.last_name} ${entry.reservation.id} ${entry.siteNumbers.join(" ")}`.toLowerCase().includes(query);
  });
  const shortDate = (date) => new Date(`${date}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const dateLabel = new Date(`${today}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const metrics = [
    { name: "Sites booked tonight", value: overview.reservedSites, note: `${overview.totalSites} sites in the park · active reservations`, icon: "sites", page: "schedule" },
    { name: "Arrivals today", value: overview.arrivals.length, note: "Guests starting a visit", icon: "arrival", page: "checkin" },
    { name: "Departures today", value: overview.departures.length, note: "Guests finishing a visit", icon: "departure", page: "schedule" },
    { name: "Pending reservations", value: overview.pending.length, note: "Bookings awaiting approval", icon: "pending", page: "schedule" },
  ];

  async function refresh() {
    setIsRefreshing(true);
    setRefreshError("");
    try { await onRefresh(); }
    catch (error) { setRefreshError(error.message); }
    finally { setIsRefreshing(false); }
  }

  function renderGuest(entry, type) {
    const { reservation, arriving, leaving } = entry;
    const stays = type === "departure" ? leaving : arriving;
    return <button key={reservation.id} type="button" className="overview-guest" onClick={() => onOpenReservation(reservation)}>
      <span className="overview-guest-avatar">{(reservation.first_name || "G").slice(0, 1)}{(reservation.last_name || "").slice(0, 1)}</span>
      <span className="overview-guest-copy"><strong>{reservation.first_name} {reservation.last_name}</strong><small>
        {type === "move" ? `Site ${leaving.map((stay) => stay.site_number).join(", ")} → ${arriving.map((stay) => stay.site_number).join(", ")}` : `Site ${stays.map((stay) => stay.site_number).join(", ")}`} · Reservation #{reservation.id}
      </small></span>
      <OverviewIcon name="arrow" />
    </button>;
  }

  return <section className="admin-overview" aria-labelledby="overview-title" aria-busy={isLoading}>
    <div className="overview-heading">
      <div><p className="admin-eyebrow">Your park at a glance</p><h2 id="overview-title">Today at Riverpark</h2><p className="overview-date">{dateLabel} · Pacific Time</p></div>
      <div className="button-row"><button type="button" className="ghost-button" onClick={refresh} disabled={isRefreshing || isLoading}>{isRefreshing ? "Refreshing…" : "Refresh"}</button><button type="button" className="primary-button overview-new-reservation" onClick={() => onNavigate("reservation")}><OverviewIcon name="plus" /> New reservation</button></div>
    </div>
    {refreshError ? <div className="message error" role="alert">{refreshError}</div> : null}
    <div className="overview-metrics">
      {metrics.map((metric) => <button key={metric.name} type="button" className={`overview-metric overview-metric-${metric.icon}`} onClick={() => onNavigate(metric.page)}>
        <span className="overview-metric-top"><span>{metric.name}</span><OverviewIcon name={metric.icon} /></span>
        <strong>{isLoading ? "—" : metric.value}</strong><small>{metric.note}</small>
      </button>)}
    </div>
    <section className="overview-payment-followup" aria-labelledby="payment-followup-title">
      <div className="overview-panel-heading">
        <div><p className="admin-eyebrow">Office follow-up</p><h3 id="payment-followup-title">Payment follow-up <span className="overview-followup-count">{isLoading ? "—" : overview.paymentFollowUps.length}</span></h3><p className="overview-followup-description">Guests who have arrived and still need to finish paying. Departed guests stay here until their balance is settled.</p></div>
        <label className="overview-followup-search"><span className="sr-only">Search payment follow-up</span><input type="search" placeholder="Guest, site or reservation #" value={paymentSearch} onChange={(event) => setPaymentSearch(event.target.value)} /></label>
      </div>
      <div className="overview-followup-filters" aria-label="Payment follow-up filters">{[
        ["all", "All unpaid stays"], ["yesterday", "Arrived yesterday"], ["departed", "Departed unpaid"],
      ].map(([key, label]) => <button key={key} type="button" aria-pressed={paymentFilter === key} onClick={() => setPaymentFilter(key)}>{label}</button>)}</div>
      {isLoading ? <p className="overview-empty">Checking payment progress…</p> : followUps.length ? <div className="overview-followup-list">{followUps.map((entry) => <div key={entry.reservation.id} className="overview-followup-row">
        <div className="overview-followup-guest"><span className="overview-guest-avatar">{(entry.reservation.first_name || "G").slice(0, 1)}{(entry.reservation.last_name || "").slice(0, 1)}</span><span><strong>{entry.reservation.first_name} {entry.reservation.last_name}</strong><small>Site {entry.siteNumbers.join(" → ")} · Reservation #{entry.reservation.id}</small></span></div>
        <div className="overview-followup-stay"><strong>{entry.departed ? `Departed ${shortDate(entry.leaveDate)}` : entry.arrivalDate === yesterday ? "Arrived yesterday" : entry.arrivalDate === today ? "Arriving today" : `Arrived ${shortDate(entry.arrivalDate)}`}</strong><small>{entry.cashEnvelope ? "Verify cash envelope" : entry.departed ? "Balance needs office follow-up" : `Departure ${shortDate(entry.leaveDate)}`}</small></div>
        <span className="overview-followup-progress">{entry.unpaidNights == null ? "Balance still due" : `${entry.unpaidNights} ${entry.unpaidNights === 1 ? "night" : "nights"} left to pay`}</span>
        <button type="button" className="ghost-button" aria-label={`Review payment for ${entry.reservation.first_name} ${entry.reservation.last_name}`} onClick={() => onOpenReservation(entry.reservation)}>Review payment <OverviewIcon name="arrow" /></button>
      </div>)}</div> : <p className="overview-empty">{overview.paymentFollowUps.length ? "No unpaid stays match these filters." : "No outstanding payments for guests who have arrived."}</p>}
    </section>
    <div className="overview-workspace">
      <div className="overview-day-board">
        <div className="overview-panel-heading"><div><p className="admin-eyebrow">Daily handoff</p><h3>Coming & going</h3></div><button type="button" className="overview-text-action" onClick={() => onNavigate("schedule")}>View schedule <OverviewIcon name="arrow" /></button></div>
        <div className="overview-day-columns">{[
          { label: "Arrivals", entries: overview.arrivals, type: "arrival", empty: "No arrivals scheduled today." },
          { label: "Departures", entries: overview.departures, type: "departure", empty: "No departures scheduled today." },
          { label: "Site moves", entries: overview.moves, type: "move", empty: "No site moves scheduled today." },
        ].map((column) => <div key={column.type} className="overview-day-column"><h4>{column.label}<span>{isLoading ? "—" : column.entries.length}</span></h4>{isLoading ? <p className="overview-empty">Loading the schedule…</p> : column.entries.length ? column.entries.map((entry) => renderGuest(entry, column.type)) : <p className="overview-empty">{column.empty}</p>}</div>)}</div>
      </div>
      <aside className="overview-shortcuts" aria-label="Office shortcuts"><p className="admin-eyebrow">Office shortcuts</p><h3>What’s next?</h3>{[
        { title: "Find an open site", detail: "Search dates and match the guest’s rig.", page: "availability" },
        { title: "Check in a guest", detail: "Arrival details, signature and payment.", page: "checkin" },
        { title: "Open messages", detail: "Guest conversations and arrival texts.", page: "messages" },
        { title: "Review the books", detail: "Transactions, documents and reports.", page: "bookkeeping" },
      ].map((item) => <button key={item.page} type="button" onClick={() => onNavigate(item.page)}><span><strong>{item.title}</strong><small>{item.detail}</small></span><OverviewIcon name="arrow" /></button>)}</aside>
    </div>
  </section>;
}
