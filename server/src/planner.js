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
    bySite.set(String(site.id), []);
  }

  for (const stay of conflictingStays) {
    const siteId = String(stay.site_id);

    if (bySite.has(siteId)) {
      bySite.get(siteId).push(stay);
    }
  }

  const availability = sites.map((site) => {
    const busyIntervals = (bySite.get(String(site.id)) || []).sort((a, b) =>
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

function intervalsOverlap(left, right) {
  return left.arrivalDate < right.leaveDate && left.leaveDate > right.arrivalDate;
}

function siteCategory(site) {
  if (site.riverCategory === "prime_river") {
    return "prime_river";
  }

  if (site.riverCategory === "normal_river") {
    return "normal_river";
  }

  return site.isBigRig ? "off_river_big_rig" : "off_river_small_rig";
}

function jobFitsSite(job, site) {
  if (Number(site.sizeFeet) < Number(job.minimumSiteSize || 1)) {
    return false;
  }

  if (job.excludeSite23 && String(site.siteNumber) === "23") {
    return false;
  }

  if (
    job.slideDriverSide &&
    Number(job.rigLengthFeet) > 25 &&
    String(site.siteNumber) === "23"
  ) {
    return false;
  }

  if (job.riverfrontOnly && !site.isOnRiver) {
    return false;
  }

  return true;
}

function siteChoiceScore(job, site) {
  const originalSite = job.originalSite;
  let score = Math.max(Number(site.sizeFeet) - Number(job.minimumSiteSize || 1), 0);

  if (!originalSite) {
    return score;
  }

  if (siteCategory(site) !== siteCategory(originalSite)) {
    score += 500;
  }

  if (originalSite.isOnRiver && !site.isOnRiver) {
    score += 2500;
  }

  return score;
}

function countChangedAssignments(jobsById, assignments) {
  let count = 0;

  for (const [jobId, siteId] of assignments.entries()) {
    const job = jobsById.get(jobId);

    if (job && !job.isNewRequest && Number(siteId) !== Number(job.originalSiteId)) {
      count += 1;
    }
  }

  return count;
}

export function buildReservationRearrangementPlans({
  sites,
  stays,
  fixedHolds = [],
  request,
  maxMoves = 4,
  maxPlans = 5,
  maxSearchNodes = 20000,
  maxAssignmentsPerTarget = 4
}) {
  const normalizedSites = sites.map((site) => ({
    id: Number(site.id),
    siteNumber: String(site.siteNumber),
    sizeFeet: Number(site.sizeFeet),
    isOnRiver: Boolean(site.isOnRiver),
    riverCategory: site.riverCategory || "",
    isBigRig: Boolean(site.isBigRig)
  }));
  const sitesById = new Map(normalizedSites.map((site) => [site.id, site]));
  const normalizedStays = stays.map((stay) => ({
    ...stay,
    id: String(stay.id),
    originalSiteId: Number(stay.originalSiteId),
    arrivalDate: String(stay.arrivalDate),
    leaveDate: String(stay.leaveDate),
    rigLengthFeet: Number(stay.rigLengthFeet || 0),
    minimumSiteSize: Math.max(1, Number(stay.minimumSiteSize || 1)),
    slideDriverSide: Boolean(stay.slideDriverSide),
    excludeSite23: false,
    riverfrontOnly: false,
    movable: Boolean(stay.movable),
    isNewRequest: false,
    originalSite: sitesById.get(Number(stay.originalSiteId)) || null
  }));
  const newJob = {
    id: "new-request",
    originalSiteId: null,
    arrivalDate: String(request.arrivalDate),
    leaveDate: String(request.leaveDate),
    rigLengthFeet: Number(request.rigLengthFeet || 0),
    minimumSiteSize: Math.max(1, Number(request.minimumSiteSize || 1)),
    slideDriverSide: Boolean(request.slideDriverSide),
    excludeSite23: Boolean(request.excludeSite23),
    riverfrontOnly: Boolean(request.riverfrontOnly),
    movable: true,
    isNewRequest: true,
    originalSite: null
  };
  const allJobs = [...normalizedStays, newJob];
  const jobsById = new Map(allJobs.map((job) => [job.id, job]));
  const initialAssignments = new Map(
    normalizedStays.map((stay) => [stay.id, stay.originalSiteId])
  );
  const holdsBySite = new Map();

  for (const hold of fixedHolds) {
    const siteId = Number(hold.siteId);

    if (!holdsBySite.has(siteId)) {
      holdsBySite.set(siteId, []);
    }

    holdsBySite.get(siteId).push({
      arrivalDate: String(hold.arrivalDate),
      leaveDate: String(hold.leaveDate)
    });
  }

  let visitedNodes = 0;

  function conflictsFor(job, siteId, assignments) {
    const conflicts = [];

    for (const hold of holdsBySite.get(Number(siteId)) || []) {
      if (intervalsOverlap(job, hold)) {
        return { fixedConflict: true, jobs: [] };
      }
    }

    for (const [otherJobId, assignedSiteId] of assignments.entries()) {
      if (otherJobId === job.id || Number(assignedSiteId) !== Number(siteId)) {
        continue;
      }

      const otherJob = jobsById.get(otherJobId);

      if (otherJob && intervalsOverlap(job, otherJob)) {
        if (!otherJob.movable) {
          return { fixedConflict: true, jobs: [] };
        }

        conflicts.push(otherJob);
      }
    }

    return { fixedConflict: false, jobs: conflicts };
  }

  function candidateSitesFor(job, excludedSiteId) {
    return normalizedSites
      .filter(
        (site) =>
          site.id !== Number(excludedSiteId) && jobFitsSite(job, site)
      )
      .sort((left, right) => {
        const scoreDifference =
          siteChoiceScore(job, left) - siteChoiceScore(job, right);

        if (scoreDifference !== 0) {
          return scoreDifference;
        }

        return left.siteNumber.localeCompare(right.siteNumber, undefined, {
          numeric: true
        });
      });
  }

  function tryPlace(job, siteId, assignments, visiting, solutionLimit) {
    visitedNodes += 1;

    if (visitedNodes > maxSearchNodes) {
      return [];
    }

    const site = sitesById.get(Number(siteId));

    if (!site || !jobFitsSite(job, site) || visiting.has(job.id)) {
      return [];
    }

    const nextVisiting = new Set(visiting);
    nextVisiting.add(job.id);
    const conflictResult = conflictsFor(job, site.id, assignments);

    if (conflictResult.fixedConflict) {
      return [];
    }

    function relocateConflict(index, workingAssignments) {
      if (index >= conflictResult.jobs.length) {
        const completedAssignments = new Map(workingAssignments);
        completedAssignments.set(job.id, site.id);

        if (
          countChangedAssignments(jobsById, completedAssignments) > maxMoves
        ) {
          return [];
        }

        return [completedAssignments];
      }

      const conflict = conflictResult.jobs[index];

      if (nextVisiting.has(conflict.id)) {
        return [];
      }

      if (Number(workingAssignments.get(conflict.id)) !== Number(site.id)) {
        return relocateConflict(index + 1, workingAssignments);
      }

      const currentlyAssignedSite = workingAssignments.get(conflict.id);
      const results = [];

      for (const alternativeSite of candidateSitesFor(
        conflict,
        currentlyAssignedSite
      )) {
        const movedOptions = tryPlace(
          conflict,
          alternativeSite.id,
          new Map(workingAssignments),
          nextVisiting,
          solutionLimit - results.length
        );

        for (const movedAssignments of movedOptions) {
          const completedOptions = relocateConflict(
            index + 1,
            movedAssignments
          );

          results.push(...completedOptions);

          if (results.length >= solutionLimit) {
            return results.slice(0, solutionLimit);
          }
        }

        if (visitedNodes > maxSearchNodes) {
          break;
        }
      }

      return results;
    }

    return relocateConflict(0, new Map(assignments));
  }

  const plans = [];

  for (const targetSite of candidateSitesFor(newJob, null)) {
    const assignmentOptions = tryPlace(
      newJob,
      targetSite.id,
      new Map(initialAssignments),
      new Set(),
      maxAssignmentsPerTarget
    );

    if (!assignmentOptions.length) {
      continue;
    }

    for (const assignments of assignmentOptions) {

    const moves = normalizedStays
      .filter(
        (stay) =>
          Number(assignments.get(stay.id)) !== Number(stay.originalSiteId)
      )
      .map((stay) => {
        const fromSite = sitesById.get(stay.originalSiteId);
        const toSite = sitesById.get(Number(assignments.get(stay.id)));
        const warnings = [];

        if (fromSite?.isOnRiver && !toSite?.isOnRiver) {
          warnings.push("Moves from a riverfront site to a non-riverfront site");
        }

        if (fromSite && toSite && siteCategory(fromSite) !== siteCategory(toSite)) {
          warnings.push("Changes the site pricing category");
        }

        return {
          stayId: stay.id,
          reservationId: stay.reservationId,
          guestName: stay.guestName,
          arrivalDate: stay.arrivalDate,
          leaveDate: stay.leaveDate,
          rigLengthFeet: stay.rigLengthFeet,
          fromSiteId: fromSite?.id,
          fromSiteNumber: fromSite?.siteNumber,
          toSiteId: toSite?.id,
          toSiteNumber: toSite?.siteNumber,
          warnings
        };
      });
    const changedCategoryCount = moves.filter((move) =>
      move.warnings.includes("Changes the site pricing category")
    ).length;
    const riverDowngradeCount = moves.filter((move) =>
      move.warnings.includes(
        "Moves from a riverfront site to a non-riverfront site"
      )
    ).length;
    const sizeWaste = moves.reduce((sum, move) => {
      const movedStay = jobsById.get(String(move.stayId));
      const destination = sitesById.get(Number(move.toSiteId));
      return (
        sum +
        Math.max(
          Number(destination?.sizeFeet || 0) -
            Number(movedStay?.minimumSiteSize || 0),
          0
        )
      );
    }, 0);

    plans.push({
      targetSiteId: targetSite.id,
      targetSiteNumber: targetSite.siteNumber,
      targetSiteSizeFeet: targetSite.sizeFeet,
      moves,
      moveCount: moves.length,
      affectedReservationCount: new Set(
        moves.map((move) => move.reservationId)
      ).size,
      warningCount: moves.reduce(
        (sum, move) => sum + move.warnings.length,
        0
      ),
      score:
        moves.length * 10000 +
        riverDowngradeCount * 2500 +
        changedCategoryCount * 500 +
        sizeWaste +
        Math.max(targetSite.sizeFeet - newJob.minimumSiteSize, 0)
    });
    }
  }

  const uniquePlans = new Map();

  for (const plan of plans) {
    const signature = `${plan.targetSiteId}:${plan.moves
      .map((move) => `${move.stayId}->${move.toSiteId}`)
      .sort()
      .join("|")}`;

    if (!uniquePlans.has(signature)) {
      uniquePlans.set(signature, plan);
    }
  }

  const sortedPlans = [...uniquePlans.values()].sort(
    (left, right) => left.score - right.score
  );
  const firstPlanByTarget = [];
  const alternatePlansForTargets = [];
  const seenTargetSiteIds = new Set();

  for (const plan of sortedPlans) {
    if (seenTargetSiteIds.has(plan.targetSiteId)) {
      alternatePlansForTargets.push(plan);
    } else {
      seenTargetSiteIds.add(plan.targetSiteId);
      firstPlanByTarget.push(plan);
    }
  }

  return [...firstPlanByTarget, ...alternatePlansForTargets]
    .slice(0, maxPlans)
    .map(({ score: _score, ...plan }) => plan);
}

export function buildAvailabilityLeadTimes(sites, futureStays, arrivalDate) {
  const staysBySite = new Map();

  for (const site of sites) {
    staysBySite.set(String(site.id), []);
  }

  for (const stay of futureStays) {
    const siteId = String(stay.site_id);

    if (staysBySite.has(siteId)) {
      staysBySite.get(siteId).push(stay);
    }
  }

  const leadTimes = new Map();

  for (const site of sites) {
    const siteStays = (staysBySite.get(String(site.id)) || []).sort((left, right) =>
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

export function buildAvailabilityBookingContext(sites, siteStays, arrivalDate, leaveDate) {
  const staysBySite = new Map();

  for (const site of sites) {
    staysBySite.set(String(site.id), []);
  }

  for (const stay of siteStays) {
    const siteId = String(stay.site_id);

    if (staysBySite.has(siteId)) {
      staysBySite.get(siteId).push(stay);
    }
  }

  const bookingContext = new Map();

  for (const site of sites) {
    const sortedStays = (staysBySite.get(String(site.id)) || []).sort((left, right) =>
      left.arrival_date.localeCompare(right.arrival_date)
    );
    const previousStay = [...sortedStays]
      .reverse()
      .find((stay) => stay.leave_date <= arrivalDate);
    const nextStay = sortedStays.find((stay) => stay.arrival_date >= leaveDate);

    bookingContext.set(site.id, {
      previousBookedUntil: previousStay?.leave_date || null,
      nextBookedFrom: nextStay?.arrival_date || null
    });
  }

  return bookingContext;
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
