export function manualChargePayload(form, requestId) {
  const description = form.description.trim();
  const quantity = Number(form.quantity);
  if (!description || description.length > 200) throw new Error('Enter a description of 200 characters or fewer.');
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000) throw new Error('Enter a whole number of nights or items between 1 and 10,000.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(String(form.unitAmount)) || Number(form.unitAmount) <= 0 || quantity * Number(form.unitAmount) > 99999999.99) {
    throw new Error('Enter a positive rate with up to two decimal places.');
  }
  return { description, quantity, unitAmount: form.unitAmount, serviceDate: form.serviceDate,
    replaceAutomaticBalance: form.replaceAutomaticBalance, requestId };
}

export const manualChargeStorageKey = id => `rvpark-manual-charge-${id}`;

export async function saveManualCharge({ reservationId, payload, request, storage }) {
  const key = manualChargeStorageKey(reservationId);
  // Preserve the exact request before sending, so a lost response can be retried
  // after refresh without adding a second charge.
  storage.setItem(key, JSON.stringify(payload));
  try {
    const updated = await request(`/reservations/${reservationId}/manual-charges`, {
      method: 'POST', body: JSON.stringify(payload),
    });
    storage.removeItem(key);
    return updated;
  } catch (error) {
    if ([400, 401, 403, 404, 409].includes(error.status)) storage.removeItem(key);
    throw error;
  }
}
