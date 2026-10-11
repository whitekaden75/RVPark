export const adminPrimaryPages = [
  { key: "overview", label: "Overview" },
  { key: "checkin", label: "Check In" },
  { key: "messages", label: "Messages" },
];

export function sameBookingGuest(primary,source) {
  if(Number(primary.customer_id)===Number(source.customer_id)) return true;
  const name=r=>`${r.first_name || ''} ${r.last_name || ''}`.trim().toLowerCase();
  const email=r=>String(r.email || '').trim().toLowerCase();
  const phone=r=>String(r.phone_number || '').replace(/\D/g,'').replace(/^1(?=\d{10}$)/,'');
  return Boolean(name(primary) && name(primary)===name(source) &&
    (email(primary) && email(primary)===email(source) || phone(primary) && phone(primary)===phone(source)));
}

export const adminPageGroups = [
  {
    label: "Reservations",
    pages: [
      { key: "availability", label: "Availability" },
      { key: "reservation", label: "New reservation" },
      { key: "schedule", label: "Schedule" },
      { key: "history", label: "History" },
    ],
  },
  {
    label: "Finance & Setup",
    pages: [
      { key: "monthly", label: "Monthly" },
      { key: "yearly", label: "Yearly" },
      { key: "bookkeeping", label: "Bookkeeping" },
      { key: "sites", label: "Sites" },
    ],
  },
];

export const adminPages = [
  ...adminPrimaryPages,
  ...adminPageGroups.flatMap((group) => group.pages),
];

const siteCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

// A search narrows choices without removing the controlled select's current value.
export function getSiteOptions(sites, search = "", selectedId = "") {
  const query = search.trim().toLowerCase();
  return sites
    .filter((site) => String(site.id) === String(selectedId) ||
      String(site.site_number).toLowerCase().includes(query))
    .sort((left, right) => siteCollator.compare(left.site_number, right.site_number));
}

export function updateStayField(stay, field, value) {
  if (field === "arrivalDate") {
    return {
      ...stay,
      arrivalDate: value,
      leaveDate: !value || (stay.leaveDate && stay.leaveDate <= value) ? "" : stay.leaveDate,
    };
  }
  return field === "siteId"
    ? { ...stay, siteId: value, siteSearch: "" }
    : { ...stay, [field]: value };
}

export function getAfterHoursCashFollowUps(reservations, today) {
  return reservations.filter(reservation => ['pending','active'].includes(reservation.status) &&
    !reservation.merged_into_reservation_id && !reservation.after_hours_cash_received &&
    /^AFTER-HOURS DRIVE-UP\b/m.test(String(reservation.notes || '')) &&
    reservation.siteStays?.some(stay => stay.arrival_date <= today))
    .map(reservation => {
      const stays=[...reservation.siteStays].sort((a,b)=>a.arrival_date.localeCompare(b.arrival_date));
      const quote=String(reservation.notes).match(/Expected envelope amount:\s*\$([\d,]+\.\d{2})(?:\.|\s|$)/);
      const expected=quote ? Number(quote[1].replaceAll(',','')) : null;
      return {reservation,arrivalDate:stays[0].arrival_date,
        siteNumbers:[...new Set(stays.map(stay=>stay.site_number))],
        expectedAmount:Number.isFinite(expected) && expected>0 ? expected : null};
    }).sort((a,b)=>a.arrivalDate.localeCompare(b.arrivalDate) || Number(a.reservation.id)-Number(b.reservation.id));
}

export function getPaymentFollowUps(reservations, today) {
  const rows = [];
  for (const reservation of reservations) {
    if (reservation.balanceWaiver?.active) continue;
    if (!reservation.after_hours_cash_received && /^AFTER-HOURS DRIVE-UP\b/m.test(String(reservation.notes || ''))) continue;
    if (reservation.status !== "active") continue;
    if (reservation.monthly_classification || reservation.reservation_term === "yearly" ||
        (reservation.effectiveBillingMode || reservation.billing_mode) === "monthly") continue;

    const stays = (reservation.siteStays || [])
      .filter((stay) => stay.leave_date !== "9999-12-31")
      .sort((left, right) => left.arrival_date.localeCompare(right.arrival_date));
    const visits = [];
    for (const stay of stays) {
      if (!visits.length || visits.at(-1).at(-1).leave_date !== stay.arrival_date) visits.push([]);
      visits.at(-1).push(stay);
    }
    // Include the rest of an ongoing trip across planned site moves, but exclude
    // a separate future return visit when checking what still needs payment.
    const startedVisits = visits.filter((visit) => visit[0].arrival_date <= today);
    if (!startedVisits.length) continue;
    const startedStays = startedVisits.flat();

    const hasNightProgress = reservation.paidStayNights != null && reservation.unpaidStayNights != null;
    const startedNights = startedStays.reduce((total, stay) => total +
      Math.max(0, (Date.parse(stay.leave_date) - Date.parse(stay.arrival_date)) / 86400000), 0);
    const unpaidNights = hasNightProgress
      ? Math.max(0, Math.min(Number(reservation.unpaidStayNights), startedNights - Number(reservation.paidStayNights)))
      : null;
    const hasBalance = Number(reservation.bankRemainingBalance ?? reservation.remainingBalance ?? 0) > 0 ||
      Number(reservation.cardRemainingBalance ?? 0) > 0;
    if (hasNightProgress ? !(unpaidNights > 0) : !hasBalance) continue;

    const visit = startedVisits.at(-1);
    rows.push({
      reservation,
      arrivalDate: visit[0].arrival_date,
      leaveDate: visit.at(-1).leave_date,
      siteNumbers: [...new Set(visit.map((stay) => stay.site_number))],
      departed: visit.at(-1).leave_date <= today,
      unpaidNights,
    });
  }
  return rows.sort((left, right) => Number(right.departed) - Number(left.departed) ||
    left.arrivalDate.localeCompare(right.arrivalDate) || Number(left.reservation.id) - Number(right.reservation.id));
}

export function getAdminOverview(reservations, sites, today) {
  const active = reservations.filter((reservation) => reservation.status === "active");
  const reservedSiteIds = new Set();
  const arrivals = [], departures = [], moves = [];

  for (const reservation of active) {
    const stays = reservation.siteStays || [];
    const arriving = stays.filter((stay) => stay.arrival_date === today);
    const leaving = stays.filter((stay) => stay.leave_date === today);
    for (const stay of stays) {
      if (stay.arrival_date <= today && stay.leave_date > today) {
        reservedSiteIds.add(String(stay.site_id));
      }
    }
    const entry = { reservation, arriving, leaving };
    if (arriving.length && leaving.length) moves.push(entry);
    else if (arriving.length) arrivals.push(entry);
    else if (leaving.length) departures.push(entry);
  }

  const order = (left, right) => siteCollator.compare(
    (left.arriving[0] || left.leaving[0])?.site_number || "",
    (right.arriving[0] || right.leaving[0])?.site_number || ""
  );
  return {
    reservedSites: sites.filter((site) => reservedSiteIds.has(String(site.id))).length,
    totalSites: sites.length,
    arrivals: arrivals.sort(order),
    departures: departures.sort(order),
    moves: moves.sort(order),
    pending: reservations.filter((reservation) => reservation.status === "pending"),
    paymentFollowUps: getPaymentFollowUps(reservations, today),
    cashFollowUps: getAfterHoursCashFollowUps(reservations, today),
  };
}
