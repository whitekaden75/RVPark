// Shared booking and check-in calculations. Keep all price types on the same nightly rules.

export function toPriceNumber(value) {
  return value === null || value === undefined ? null : Number(value);
}

export function roundCurrency(value) {
  return value === null || value === undefined
    ? null
    : Math.round(Number(value) * 100) / 100;
}

export function getCardPrice(value) {
  const amount = toPriceNumber(value);

  if (amount === null) {
    return null;
  }

  if (amount <= 0) {
    return 0;
  }

  const amountWithCardPricing = amount * 1.03;
  return roundCurrency(Math.ceil(amountWithCardPricing - 0.99) + 0.99);
}

export function getCardStayTotal(value, chargeableNights) {
  const amount = toPriceNumber(value);
  const nights = Number(chargeableNights);

  if (amount === null || !Number.isFinite(nights) || nights <= 0) {
    return getCardPrice(value);
  }

  const nightlyBasePrice = roundCurrency(amount / nights);
  const nightlyCardPrice = getCardPrice(nightlyBasePrice);

  return nightlyCardPrice === null
    ? null
    : roundCurrency(nightlyCardPrice * nights);
}

export function normalizeReservationPaymentMethod(value) {
  return value === "card" ? "card" : "bank";
}

export function normalizeRequestedDiscounts(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.map((discount) => String(discount || "").trim()).filter(Boolean))];
}

export function toMeterNumber(value) {
  return value === null || value === undefined || value === "" ? null : Number(value);
}

export function calculateUtilityPrice(electricMeterReading) {
  const meter = toMeterNumber(electricMeterReading);

  if (meter === null) {
    return null;
  }

  return meter * 0.17 - 75;
}

export function getEffectiveReservationTotal(
  billingMode,
  totals,
  totalPrice,
  monthlyRentPrice,
  utilityPrice,
  useDiscountPrice = false
) {
  if (billingMode === "manual_total") {
    return toPriceNumber(totalPrice);
  }

  if (billingMode === "monthly") {
    const rent = toPriceNumber(monthlyRentPrice);

    if (rent === null || utilityPrice === null) {
      return null;
    }

    return rent + utilityPrice;
  }

  if (
    useDiscountPrice &&
    totals.discountPrice !== null &&
    totals.discountPrice !== undefined
  ) {
    return totals.discountPrice;
  }

  if (totals.normalPrice !== null && totals.normalPrice !== undefined) {
    return totals.normalPrice;
  }

  if (totals.discountPrice !== null && totals.discountPrice !== undefined) {
    return totals.discountPrice;
  }

  return toPriceNumber(totalPrice);
}

export function getPricingCategory(site) {
  if (site.river_category === "prime_river") {
    return "prime_river";
  }

  if (site.river_category === "normal_river") {
    return "normal_river";
  }

  return site.is_big_rig ? "off_river_big_rig" : "off_river_small_rig";
}

export function calculateChargeableNights(numberOfNights) {
  if (!Number.isFinite(numberOfNights) || numberOfNights <= 0 || numberOfNights > 28) {
    return null;
  }

  return numberOfNights - Math.floor(numberOfNights / 7);
}

export function buildPricingRuleLookup(pricingRules) {
  const lookup = new Map();

  for (const rule of pricingRules) {
    if (Number(rule.number_of_days) !== 1) {
      continue;
    }

    lookup.set(rule.site_category, {
      numberOfDays: rule.number_of_days,
      normalPrice: toPriceNumber(rule.normal_price),
      discountPrice: toPriceNumber(rule.discount_price)
    });
  }

  return lookup;
}

export function getPaymentEventPriceType(paymentEvent) {
  const match = String(paymentEvent?.note || "").match(
    /price type:\s*(bank|card)/i
  );

  return match?.[1]?.toLowerCase() || "";
}

export function findClosestPaidNightCount(amount, nightlyPrices, startIndex = 0) {
  const targetAmount = Math.max(Number(amount) || 0, 0);
  let closestCount = 0;
  let closestDifference = targetAmount;
  let accumulatedAmount = 0;

  for (let index = startIndex; index < nightlyPrices.length; index += 1) {
    accumulatedAmount = roundCurrency(
      accumulatedAmount + Number(nightlyPrices[index] || 0)
    );
    const difference = Math.abs(targetAmount - accumulatedAmount);

    if (difference < closestDifference) {
      closestCount = index - startIndex + 1;
      closestDifference = difference;
    }
  }

  return { count: closestCount, difference: closestDifference };
}

export function calculatePaidChargeableNights({
  amountPaid,
  paymentEvents,
  bankNightlyPrices,
  cardNightlyPrices,
  totalChargeableNights
}) {
  let unallocatedPaidAmount = Math.max(Number(amountPaid) || 0, 0);
  let paidNights = 0;
  let partialPaymentCredit = 0;

  const allocateAmountToNights = (amount, preferredPriceType = "") => {
    partialPaymentCredit = roundCurrency(
      partialPaymentCredit + Math.max(Number(amount) || 0, 0)
    );
    let priceType = preferredPriceType;

    if (!priceType) {
      const bankMatch = findClosestPaidNightCount(
        partialPaymentCredit,
        bankNightlyPrices,
        paidNights
      );
      const cardMatch = findClosestPaidNightCount(
        partialPaymentCredit,
        cardNightlyPrices,
        paidNights
      );
      priceType = cardMatch.difference < bankMatch.difference ? "card" : "bank";
    }

    const nightlyPrices =
      priceType === "card" ? cardNightlyPrices : bankNightlyPrices;

    while (paidNights < totalChargeableNights) {
      const nextNightPrice = Number(nightlyPrices[paidNights]);

      if (!Number.isFinite(nextNightPrice) || nextNightPrice <= 0) break;
      if (partialPaymentCredit + 0.001 < nextNightPrice) break;

      partialPaymentCredit = roundCurrency(
        partialPaymentCredit - nextNightPrice
      );
      paidNights += 1;
    }
  };

  for (const paymentEvent of paymentEvents || []) {
    if (unallocatedPaidAmount <= 0) break;

    const eventAmount = Math.min(
      Math.max(Number(paymentEvent.amount) || 0, 0),
      unallocatedPaidAmount
    );

    if (eventAmount <= 0) continue;

    allocateAmountToNights(
      eventAmount,
      getPaymentEventPriceType(paymentEvent)
    );
    unallocatedPaidAmount -= eventAmount;
  }

  if (unallocatedPaidAmount > 0) {
    allocateAmountToNights(unallocatedPaidAmount);
  }

  return {
    paidNights: Math.min(
      Math.max(paidNights, 0),
      Math.max(Number(totalChargeableNights) || 0, 0)
    ),
    partialPaymentCredit: roundCurrency(Math.max(partialPaymentCredit, 0))
  };
}

export function buildBillingSummary(reservationRow, totals, paymentEvents = []) {
  const utilityPrice = calculateUtilityPrice(reservationRow.electric_meter_reading);
  const selectedPaymentMethod = normalizeReservationPaymentMethod(
    reservationRow.payment_method
  );
  const useDiscountPrice =
    normalizeRequestedDiscounts(reservationRow.requested_discounts).length > 0;
  const selectedDailyTotal = useDiscountPrice
    ? totals?.discountPrice ?? totals?.normalPrice
    : totals?.normalPrice ?? totals?.discountPrice;
  const selectedCardDailyTotal = useDiscountPrice
    ? totals?.discountCardPrice ?? totals?.normalCardPrice
    : totals?.normalCardPrice ?? totals?.discountCardPrice;
  const usesDiscountNightlyPrices = useDiscountPrice
    ? totals?.discountPrice !== null && totals?.discountPrice !== undefined
    : (totals?.normalPrice === null || totals?.normalPrice === undefined) &&
      totals?.discountPrice !== null && totals?.discountPrice !== undefined;
  const selectedBankNightlyPrices = usesDiscountNightlyPrices
    ? totals?.discountNightlyPrices || []
    : totals?.normalNightlyPrices || [];
  const selectedCardNightlyPrices = usesDiscountNightlyPrices
    ? totals?.discountCardNightlyPrices || []
    : totals?.normalCardNightlyPrices || [];
  const effectiveBillingMode =
    reservationRow.billing_mode === "manual_total" &&
    reservationRow.reservation_term !== "yearly" &&
    selectedDailyTotal !== null &&
    selectedDailyTotal !== undefined
      ? "standard"
      : reservationRow.billing_mode;
  const baseEffectiveTotalPrice = getEffectiveReservationTotal(
    effectiveBillingMode,
    totals,
    reservationRow.total_price,
    reservationRow.monthly_rent_price,
    utilityPrice,
    useDiscountPrice
  );
  const amountPaid = toPriceNumber(reservationRow.amount_paid) ?? 0;
  const depositNights = Number(totals?.numberOfNights) > 7 ? 2 : 1;
  const totalChargeableNights = Number(totals?.chargeableNights);
  const usesDailyNightBilling =
    effectiveBillingMode === "standard" &&
    baseEffectiveTotalPrice !== null &&
    baseEffectiveTotalPrice !== undefined &&
    Number.isFinite(totalChargeableNights) &&
    totalChargeableNights > 0;
  const cardTotalPrice = usesDailyNightBilling
    ? roundCurrency(selectedCardDailyTotal)
    : getCardStayTotal(baseEffectiveTotalPrice, totals?.chargeableNights);
  const calculatedPaymentProgress = usesDailyNightBilling
    ? calculatePaidChargeableNights({
        amountPaid,
        paymentEvents,
        bankNightlyPrices: selectedBankNightlyPrices,
        cardNightlyPrices: selectedCardNightlyPrices,
        totalChargeableNights
      })
    : null;
  const normalStayPriceIsFullyPaid =
    usesDailyNightBilling &&
    Number.isFinite(Number(selectedDailyTotal)) &&
    amountPaid + 0.001 >= Number(selectedDailyTotal);
  const paymentProgress = normalStayPriceIsFullyPaid
    ? {
        paidNights: totalChargeableNights,
        partialPaymentCredit: 0
      }
    : calculatedPaymentProgress;
  const paidChargeableNights = paymentProgress?.paidNights ?? null;
  const partialPaymentCredit = paymentProgress?.partialPaymentCredit ?? 0;
  const unpaidChargeableNights = usesDailyNightBilling
    ? Math.max(totalChargeableNights - paidChargeableNights, 0)
    : null;
  const totalStayNights = usesDailyNightBilling
    ? Number(totals?.numberOfNights)
    : null;
  const paidStayNights = usesDailyNightBilling
    ? Math.min(
        Number(
          totals?.coveredStayNightsByPaidNightCount?.[paidChargeableNights] ??
            paidChargeableNights
        ),
        totalStayNights
      )
    : null;
  const unpaidStayNights = usesDailyNightBilling
    ? Math.max(totalStayNights - paidStayNights, 0)
    : null;
  const bankDailyPrice = usesDailyNightBilling
    ? selectedBankNightlyPrices[paidChargeableNights] ?? 0
    : null;
  const cardDailyPrice = usesDailyNightBilling
    ? selectedCardNightlyPrices[paidChargeableNights] ?? 0
    : null;
  const storedDepositAmount = toPriceNumber(reservationRow.deposit_amount) ?? 0;
  const depositWasWaived = storedDepositAmount <= 0;
  const requiredDepositAmount = usesDailyNightBilling && !depositWasWaived
    ? roundCurrency(
        selectedBankNightlyPrices
          .slice(0, Math.min(depositNights, totalChargeableNights))
          .reduce((total, price) => total + Number(price || 0), 0)
      )
    : storedDepositAmount;
  const requiredCardDepositAmount = usesDailyNightBilling && !depositWasWaived
    ? roundCurrency(
        selectedCardNightlyPrices
          .slice(0, Math.min(depositNights, totalChargeableNights))
          .reduce((total, price) => total + Number(price || 0), 0)
      )
    : selectedPaymentMethod === "card"
      ? storedDepositAmount
      : getCardStayTotal(storedDepositAmount, depositNights) ?? 0;
  const effectiveTotalPrice =
    usesDailyNightBilling && selectedPaymentMethod === "card"
      ? cardTotalPrice
      : baseEffectiveTotalPrice;
  let remainingBalance =
    effectiveTotalPrice !== null && effectiveTotalPrice !== undefined
      ? roundCurrency(Math.max(effectiveTotalPrice - amountPaid, 0))
      : null;
  let bankRemainingBalance = null;

  if (usesDailyNightBilling) {
    bankRemainingBalance = roundCurrency(
      Math.max(
        selectedBankNightlyPrices
          .slice(paidChargeableNights)
          .reduce((total, price) => total + Number(price), 0) -
          partialPaymentCredit,
        0
      )
    );
    remainingBalance =
      selectedPaymentMethod === "card"
        ? roundCurrency(
            Math.max(
              selectedCardNightlyPrices
                .slice(paidChargeableNights)
                .reduce((total, price) => total + Number(price), 0) -
                partialPaymentCredit,
              0
            )
          )
        : bankRemainingBalance;
  } else if (
    baseEffectiveTotalPrice !== null &&
    baseEffectiveTotalPrice !== undefined
  ) {
    bankRemainingBalance = roundCurrency(
      Math.max(Number(baseEffectiveTotalPrice) - amountPaid, 0)
    );
  }
  let cardRemainingBalance = null;

  if (usesDailyNightBilling) {
    cardRemainingBalance = roundCurrency(
      Math.max(
        selectedCardNightlyPrices
          .slice(paidChargeableNights)
          .reduce((total, price) => total + Number(price), 0) -
          partialPaymentCredit,
        0
      )
    );
  } else if (remainingBalance === 0) {
    cardRemainingBalance = 0;
  } else if (selectedPaymentMethod === "card") {
    cardRemainingBalance = remainingBalance;
  } else if (
    remainingBalance !== null &&
    baseEffectiveTotalPrice !== null &&
    baseEffectiveTotalPrice !== undefined &&
    Number(baseEffectiveTotalPrice) > 0 &&
    Number(totals?.chargeableNights) > 0
  ) {
    const bankDailyPrice =
      Number(baseEffectiveTotalPrice) / Number(totals.chargeableNights);
    const unpaidDayEquivalents = Number(remainingBalance) / bankDailyPrice;
    const cardDailyPrice = getCardPrice(bankDailyPrice);
    cardRemainingBalance = roundCurrency(
      Number(cardDailyPrice || 0) * unpaidDayEquivalents
    );
  } else {
    cardRemainingBalance = getCardPrice(remainingBalance);
  }

  if (
    Number(bankRemainingBalance) <= 0 &&
    Number(cardRemainingBalance) > 0 &&
    Number(baseEffectiveTotalPrice) > 0 &&
    Number(cardTotalPrice) > 0
  ) {
    bankRemainingBalance = roundCurrency(
      Number(cardRemainingBalance) *
        (Number(baseEffectiveTotalPrice) / Number(cardTotalPrice))
    );
  }

  const cardPaymentOptions = usesDailyNightBilling
    ? Array.from({ length: unpaidStayNights }, (_, index) => {
        const nights = index + 1;
        const targetStayNights = paidStayNights + nights;
        let targetChargeableNights = paidChargeableNights;

        while (
          targetChargeableNights < totalChargeableNights &&
          Number(
            totals?.coveredStayNightsByPaidNightCount?.[
              targetChargeableNights
            ] ?? 0
          ) < targetStayNights
        ) {
          targetChargeableNights += 1;
        }

        const amount = roundCurrency(
          Math.max(
            selectedCardNightlyPrices
              .slice(paidChargeableNights, targetChargeableNights)
              .reduce((total, price) => total + Number(price || 0), 0) -
              partialPaymentCredit,
            0
          )
        );

        return {
          nights,
          amount: Math.min(amount, Number(cardRemainingBalance || 0))
        };
      })
    : [];

  return {
    depositAmount: toPriceNumber(reservationRow.deposit_amount) ?? 0,
    requiredDepositAmount,
    cardDepositAmount: requiredCardDepositAmount,
    requiredCardDepositAmount,
    totalPrice: toPriceNumber(reservationRow.total_price),
    monthlyRentPrice: toPriceNumber(reservationRow.monthly_rent_price),
    electricMeterReading: toMeterNumber(reservationRow.electric_meter_reading),
    monthlyBillingDay: reservationRow.monthly_billing_day || null,
    monthlySummerRate: toPriceNumber(reservationRow.monthly_summer_rate),
    monthlyWinterRate: toPriceNumber(reservationRow.monthly_winter_rate),
    utilityPrice,
    amountPaid,
    effectiveBillingMode,
    bankTotalPrice: baseEffectiveTotalPrice,
    bankDailyPrice,
    cardDailyPrice,
    totalChargeableNights: usesDailyNightBilling
      ? totalChargeableNights
      : null,
    paidChargeableNights,
    partialPaymentCredit,
    unpaidChargeableNights,
    totalStayNights,
    paidStayNights,
    unpaidStayNights,
    effectiveTotalPrice,
    cardTotalPrice,
    remainingBalance,
    bankRemainingBalance,
    cardRemainingBalance,
    cardPaymentOptions,
    selectedPaymentMethod,
    requestedDiscounts: normalizeRequestedDiscounts(
      reservationRow.requested_discounts
    )
  };
}

export function getPricingForSiteAndNights(
  site,
  numberOfNights,
  pricingLookup,
  pricingCategoryOverride = null
) {
  const pricingCategory = pricingCategoryOverride || getPricingCategory(site);
  const baseRule = pricingLookup.get(pricingCategory) || null;
  const chargeableNights = calculateChargeableNights(numberOfNights);

  return {
    pricingCategory,
    numberOfNights,
    pricingConfigured: Boolean(baseRule && chargeableNights !== null),
    normalDailyPrice: baseRule?.normalPrice ?? null,
    discountDailyPrice: baseRule?.discountPrice ?? null,
    normalPrice:
      baseRule?.normalPrice !== null &&
      baseRule?.normalPrice !== undefined &&
      chargeableNights !== null
        ? roundCurrency(baseRule.normalPrice * chargeableNights)
        : null,
    discountPrice:
      baseRule?.discountPrice !== null &&
      baseRule?.discountPrice !== undefined &&
      chargeableNights !== null
        ? roundCurrency(baseRule.discountPrice * chargeableNights)
        : null
  };
}

export function sumReservationTotals(siteStays) {
  let normalPrice = 0;
  let discountPrice = 0;
  let normalCardPrice = 0;
  let discountCardPrice = 0;
  let chargeableNights = 0;
  let numberOfNights = 0;
  let consecutiveNight = 0;
  let previousLeaveDate = "";
  const normalNightlyPrices = [];
  const discountNightlyPrices = [];
  const normalCardNightlyPrices = [];
  const discountCardNightlyPrices = [];
  const coveredStayNightsByPaidNightCount = [0];

  for (const segment of siteStays) {
    const segmentNights = Number(segment.numberOfNights);

    if (
      !Number.isFinite(segmentNights) ||
      segmentNights <= 0 ||
      numberOfNights + segmentNights > 28
    ) {
      return {
        normalPrice: null,
        discountPrice: null,
        normalCardPrice: null,
        discountCardPrice: null,
        normalNightlyPrices: [],
        discountNightlyPrices: [],
        normalCardNightlyPrices: [],
        discountCardNightlyPrices: [],
        coveredStayNightsByPaidNightCount: [],
        chargeableNights: null,
        numberOfNights: null
      };
    }

    if (previousLeaveDate && segment.arrival_date !== previousLeaveDate) {
      consecutiveNight = 0;
    }

    for (let nightIndex = 0; nightIndex < segmentNights; nightIndex += 1) {
      consecutiveNight += 1;
      numberOfNights += 1;

      if (consecutiveNight % 7 === 0) {
        coveredStayNightsByPaidNightCount[chargeableNights] = numberOfNights;
        continue;
      }

      chargeableNights += 1;
      coveredStayNightsByPaidNightCount[chargeableNights] = numberOfNights;
      normalPrice =
        normalPrice !== null &&
        segment.normalDailyPrice !== null &&
        segment.normalDailyPrice !== undefined
          ? normalPrice + Number(segment.normalDailyPrice)
          : null;
      discountPrice =
        discountPrice !== null &&
        segment.discountDailyPrice !== null &&
        segment.discountDailyPrice !== undefined
          ? discountPrice + Number(segment.discountDailyPrice)
          : null;
      normalCardPrice =
        normalCardPrice !== null &&
        segment.normalDailyPrice !== null &&
        segment.normalDailyPrice !== undefined
          ? normalCardPrice + Number(segment.normalCardDailyPrice ?? getCardPrice(segment.normalDailyPrice))
          : null;
      discountCardPrice =
        discountCardPrice !== null &&
        segment.discountDailyPrice !== null &&
        segment.discountDailyPrice !== undefined
          ? discountCardPrice + Number(segment.discountCardDailyPrice ?? getCardPrice(segment.discountDailyPrice))
          : null;

      if (segment.normalDailyPrice !== null && segment.normalDailyPrice !== undefined) {
        normalNightlyPrices.push(roundCurrency(segment.normalDailyPrice));
        normalCardNightlyPrices.push(segment.normalCardDailyPrice ?? getCardPrice(segment.normalDailyPrice));
      }

      if (segment.discountDailyPrice !== null && segment.discountDailyPrice !== undefined) {
        discountNightlyPrices.push(roundCurrency(segment.discountDailyPrice));
        discountCardNightlyPrices.push(segment.discountCardDailyPrice ?? getCardPrice(segment.discountDailyPrice));
      }
    }

    previousLeaveDate = segment.leave_date;
  }

  return {
    normalPrice: normalPrice === null ? null : roundCurrency(normalPrice),
    discountPrice:
      discountPrice === null ? null : roundCurrency(discountPrice),
    normalCardPrice:
      normalCardPrice === null ? null : roundCurrency(normalCardPrice),
    discountCardPrice:
      discountCardPrice === null ? null : roundCurrency(discountCardPrice),
    normalNightlyPrices,
    discountNightlyPrices,
    normalCardNightlyPrices,
    discountCardNightlyPrices,
    coveredStayNightsByPaidNightCount,
    chargeableNights,
    numberOfNights
  };
}
