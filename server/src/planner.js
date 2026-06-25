function toDate(value) {
  return new Date(`${value}T00:00:00Z`);
}

export const openEndedStayDate = "9999-12-31";

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function nightsBetween(arrivalDate, leaveDate) {
  const start = toDate(arrivalDate);
  const end = toDate(leaveDate);
  return Math.round((end - start) / 86400000);
}

function uniqueSortedDates(values) {
  return [...new Set(values)].sort();
}

function subtractBusyIntervals(requestStart, requestEnd, busyIntervals) {
  const free = [];
  let cursor = requestStart;

  for (const interval of busyIntervals) {
    if (interval.leave_date <= cursor) {
      continue;
    }

    if (interval.arrival_date > cursor) {
      free.push({ start: cursor, end: interval.arrival_date });
    }

    if (interval.leave_date > cursor) {
      cursor = interval.leave_date;
    }

    if (cursor >= requestEnd) {
      break;
    }
  }

  if (cursor < requestEnd) {
    free.push({ start: cursor, end: requestEnd });
  }

  return free.filter((segment) => segment.start < segment.end);
}

export function buildAvailabilityMap(sites, conflictingStays, arrivalDate, leaveDate) {
  const bySite = new Map();

  for (const site of sites) {
    bySite.set(site.id, []);
  }

  for (const stay of conflictingStays) {
    if (bySite.has(stay.site_id)) {
      bySite.get(stay.site_id).push(stay);
    }
  }

  const availability = sites.map((site) => {
    const busyIntervals = (bySite.get(site.id) || []).sort((a, b) =>
      a.arrival_date.localeCompare(b.arrival_date)
    );

    return {
      ...site,
      freeIntervals: subtractBusyIntervals(arrivalDate, leaveDate, busyIntervals)
    };
  });

  return availability;
}

export function buildSiteSwitchPlan(availability, arrivalDate, leaveDate) {
  const intervals = [];

  for (const site of availability) {
    for (const interval of site.freeIntervals) {
      intervals.push({
        siteId: site.id,
        siteNumber: site.site_number,
        sizeFeet: site.size_feet,
        isOnRiver: site.is_on_river,
        start: interval.start,
        end: interval.end
      });
    }
  }

  intervals.sort((a, b) => {
    if (a.start === b.start) {
      return a.end.localeCompare(b.end);
    }

    return a.start.localeCompare(b.start);
  });

  const plan = [];
  let cursor = arrivalDate;

  while (cursor < leaveDate) {
    let best = null;

    for (const interval of intervals) {
      if (interval.start <= cursor && interval.end > cursor) {
        if (!best || interval.end > best.end) {
          best = interval;
        }
      }
    }

    if (!best) {
      return null;
    }

    plan.push({
      siteId: best.siteId,
      siteNumber: best.siteNumber,
      sizeFeet: best.sizeFeet,
      isOnRiver: best.isOnRiver,
      arrivalDate: cursor,
      leaveDate: best.end
    });

    cursor = best.end;
  }

  const merged = [];

  for (const segment of plan) {
    const previous = merged.at(-1);

    if (previous && previous.siteId === segment.siteId && previous.leaveDate === segment.arrivalDate) {
      previous.leaveDate = segment.leaveDate;
    } else {
      merged.push({ ...segment });
    }
  }

  return merged;
}

export function getDirectMatches(availability, arrivalDate, leaveDate) {
  return availability.filter((site) =>
    site.freeIntervals.some(
      (interval) => interval.start <= arrivalDate && interval.end >= leaveDate
    )
  );
}

export function buildAvailabilityLeadTimes(sites, futureStays, arrivalDate) {
  const staysBySite = new Map();

  for (const site of sites) {
    staysBySite.set(site.id, []);
  }

  for (const stay of futureStays) {
    if (staysBySite.has(stay.site_id)) {
      staysBySite.get(stay.site_id).push(stay);
    }
  }

  const leadTimes = new Map();

  for (const site of sites) {
    const siteStays = (staysBySite.get(site.id) || []).sort((left, right) =>
      left.arrival_date.localeCompare(right.arrival_date)
    );
    const blockingStay = siteStays.find(
      (stay) => stay.arrival_date <= arrivalDate && stay.leave_date > arrivalDate
    );

    if (blockingStay) {
      leadTimes.set(site.id, {
        availableDays: 0,
        availableUntil: arrivalDate,
        openEnded: false
      });
      continue;
    }

    const nextStay = siteStays.find((stay) => stay.arrival_date > arrivalDate);

    if (!nextStay) {
      leadTimes.set(site.id, {
        availableDays: null,
        availableUntil: null,
        openEnded: true
      });
      continue;
    }

    leadTimes.set(site.id, {
      availableDays: nightsBetween(arrivalDate, nextStay.arrival_date),
      availableUntil: nextStay.arrival_date,
      openEnded: false
    });
  }

  return leadTimes;
}

export function validateReservationSegments(siteStays, reservationTerm = "standard") {
  if (!Array.isArray(siteStays) || siteStays.length === 0) {
    return "At least one site stay is required.";
  }

  const sorted = [...siteStays].sort((a, b) => a.arrivalDate.localeCompare(b.arrivalDate));

  if (reservationTerm === "yearly" && sorted.length !== 1) {
    return "Yearly bookings can only have one stay segment.";
  }

  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index];

    if (!current.siteId || !current.arrivalDate || (reservationTerm !== "yearly" && !current.leaveDate)) {
      return "Each site stay needs a site, arrival date, and leave date.";
    }

    if (reservationTerm !== "yearly" && current.arrivalDate >= current.leaveDate) {
      return "Each site stay must have an arrival date before the leave date.";
    }

    if (reservationTerm !== "yearly" && index > 0) {
      const previous = sorted[index - 1];

      if (previous.leaveDate > current.arrivalDate) {
        return "Site stays cannot overlap each other.";
      }
    }
  }

  return null;
}

export function normalizeSegments(siteStays, reservationTerm = "standard") {
  return [...siteStays]
    .sort((a, b) => a.arrivalDate.localeCompare(b.arrivalDate))
    .map((segment) => ({
      siteId: Number(segment.siteId),
      arrivalDate: formatDate(toDate(segment.arrivalDate)),
      leaveDate:
        reservationTerm === "yearly"
          ? openEndedStayDate
          : formatDate(toDate(segment.leaveDate))
    }));
}
