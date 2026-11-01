export function getCheckoutReturnSessionId(search) {
  const params = new URLSearchParams(search);
  const isReturn = (params.has("pay") && params.get("pay_status") === "success") ||
    params.get("guest_payment") === "return" ||
    (params.has("checkout_token") && params.get("booking_checkout") === "return");
  return isReturn ? params.get("session_id") || "" : "";
}

export async function checkCheckoutReturn({ sessionId, request, isCancelled, redirect, onReady }) {
  const result = await request(`/guest/checkout-returns/${encodeURIComponent(sessionId)}`);
  if (isCancelled()) return null;
  if (result.status === "requires_action" && result.verificationUrl) {
    redirect(result.verificationUrl);
  } else if (["succeeded", "processing"].includes(result.status)) {
    onReady(sessionId);
  }
  return result;
}
