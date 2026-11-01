const money = value => Number(value).toLocaleString("en-US", { style: "currency", currency: "USD" });
export const monthlyPaymentStorageKey = id => `rvpark-monthly-office-payment-${id}`;

export function monthLabel(month) {
  return /^\d{4}-\d{2}$/.test(month || "")
    ? new Date(`${month}-01T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
    : "";
}

export function paymentTenderLabel(payment) {
  const type = payment.tenderType || String(payment.note || "").match(/\bTender:\s*(cash|check|card)\b/i)?.[1]?.toLowerCase();
  if (type === "cash") return "Cash";
  if (type === "check") {
    const number = payment.checkNumber || String(payment.note || "").match(/Check number:\s*(.*?)\. Tender:/)?.[1];
    return number ? `Check #${number}` : "Check";
  }
  return payment.paymentSource === "office_card_reader" ? "Office card payment" : "Online payment";
}

export function monthlyPaymentPayload(form, today) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(String(form.amount)) || !Number.isFinite(Number(form.amount)) || Number(form.amount) <= 0) {
    throw new Error("Enter the amount received, greater than zero, with up to two decimal places.");
  }
  if (!["cash", "check"].includes(form.tenderType)) throw new Error("Choose cash or check.");
  const checkNumber = String(form.checkNumber || "").trim();
  if (form.tenderType === "check" && !checkNumber) throw new Error("Enter the check number.");
  if (!form.paymentDate || form.paymentDate > today) throw new Error("Choose a payment date that is today or earlier.");
  if (!/^\d{4}-\d{2}$/.test(form.paymentMonth || "")) throw new Error("Choose the month this payment covers.");
  return { amount: Number(form.amount).toFixed(2), tenderType: form.tenderType,
    checkNumber: form.tenderType === "check" ? checkNumber : "",
    paymentDate: form.paymentDate, paymentMonth: form.paymentMonth, note: (form.note || "").trim() };
}

export async function saveMonthlyOfficePayment({ reservationId, payload, request, storage }) {
  const key = monthlyPaymentStorageKey(reservationId);
  // Persist the same request before sending so a lost response/reload can be retried safely.
  storage.setItem(key, JSON.stringify(payload));
  const result = await request(`/reservations/${reservationId}/monthly-office-payments`, {
    method: "POST", body: JSON.stringify(payload)
  });
  try { storage.removeItem(key); } catch {}
  return result;
}

export async function prepareMonthlyPaymentText({ reservation, amount, paymentMonth, payment, request, baseUrl }) {
  if (!String(reservation.phone_number || "").trim()) throw new Error("Add a mobile number to this booking before texting.");
  let body;
  if (payment) {
    body = ["Riverpark RV Resort", `Hi ${reservation.first_name || "there"}, we received ${money(payment.amount)} by ${paymentTenderLabel(payment).toLowerCase()}${
      payment.paymentMonth ? ` for ${monthLabel(payment.paymentMonth)}` : ""
    }.`, `Payment date: ${payment.paymentDate}. Thank you!`].join("\n");
  } else {
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) throw new Error("Enter the monthly payment amount before preparing a text.");
    const link = await request(`/reservations/${reservation.id}/payment-links`, {
      method: "POST", body: JSON.stringify({ customAmount: Number(amount).toFixed(2),
        description: `Monthly charges for ${monthLabel(paymentMonth)}`, baseUrl })
    });
    if (!link?.paymentUrl) throw new Error("The payment link could not be prepared. Please try again.");
    body = ["Riverpark RV Resort", `Hi ${reservation.first_name || "there"}, your monthly payment request for ${monthLabel(paymentMonth)} is ready.`,
      `Bank/cash amount: ${money(amount)}. Card price is shown at checkout.`, `View and pay: ${link.paymentUrl}`].join("\n");
  }
  // This returns a draft only. The existing message composer owns the explicit Send action.
  return { to: reservation.phone_number, body };
}
