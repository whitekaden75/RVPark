function stripeVerificationUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password &&
        (url.hostname === "stripe.com" || url.hostname.endsWith(".stripe.com"))) {
      return url.href;
    }
  } catch {}
  return null;
}

export function registerCheckoutReturnRoutes(app, { pool, stripe }) {
  app.get("/api/guest/checkout-returns/:sessionId", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const sessionId = String(req.params.sessionId || "");
    if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId) || sessionId.length > 255) {
      return res.status(400).json({ message: "A valid checkout session is required." });
    }
    if (!stripe) {
      return res.status(503).json({ message: "Payment status is temporarily unavailable. Please try again." });
    }

    try {
      // The unguessable Checkout Session ID is the return-page credential.
      // Only expose status and the next step for checkouts recorded by this app.
      const result = await pool.query(`
        SELECT 1 FROM stripe_payment_records WHERE stripe_checkout_session_id = $1
        UNION ALL
        SELECT 1 FROM public_booking_checkouts WHERE stripe_checkout_session_id = $1
        LIMIT 1
      `, [sessionId]);
      if (!result.rows.length) {
        return res.status(404).json({ message: "Payment checkout not found. Please contact Riverpark RV Resort." });
      }

      const session = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: ["payment_intent"]
      });
      if (session.mode !== "payment") {
        return res.status(400).json({ message: "This checkout is not a payment." });
      }
      const paymentIntent = typeof session.payment_intent === "string"
        ? await stripe.paymentIntents.retrieve(session.payment_intent)
        : session.payment_intent;
      const status = paymentIntent?.status || (session.payment_status === "paid"
        ? "succeeded" : session.status === "expired" ? "canceled" : "incomplete");
      const verificationUrl = status === "requires_action" &&
        paymentIntent?.next_action?.type === "verify_with_microdeposits"
        ? stripeVerificationUrl(paymentIntent.next_action.verify_with_microdeposits?.hosted_verification_url)
        : null;

      return res.json({ status, verificationUrl });
    } catch (error) {
      return res.status(error.code === "resource_missing" ? 404 : 502).json({
        message: "We couldn't check your payment. Please try again or call Riverpark RV Resort."
      });
    }
  });
}
