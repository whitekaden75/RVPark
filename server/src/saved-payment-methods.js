export const storageConsentVersion = "2026-10-24";
export const storageConsentText = "I authorize Riverpark RV Resort to securely save my payment method with Stripe for future reservation payments, including monthly rent and utilities. Each future charge requires my separate approval. I can request removal by calling or texting 541-295-1269.";

const objectId = (value) => typeof value === "string" ? value : value?.id;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export function validateSavedCharge(body) {
  const amount = String(body?.amount ?? "");
  if (!/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0 || Number(amount) > 999999.99) {
    throw fail("Enter a positive payment amount with at most two decimal places.");
  }
  if (body?.guestApproved !== true || !String(body?.approvalNote || "").trim()) {
    throw fail("Record the guest’s separate approval for this exact charge.");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body?.requestId || "")) {
    throw fail("A payment request ID is required. Refresh and try again.");
  }
  const description = String(body.description || "").trim().slice(0, 200);
  if (!description) throw fail("Describe the rent, utilities, or reservation payment being collected.");
  return { amountCents: Math.round(Number(amount) * 100), description,
    approvalNote: String(body.approvalNote).trim().slice(0, 1000), requestId: body.requestId.toLowerCase() };
}

export function createSavedPaymentMethods({ pool, stripe, getReservation, signToken, readToken,
  secret, allowedOrigins, syncPayments, notify }) {
  function baseUrl(value) {
    const url = String(value || "").trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(url) || (allowedOrigins.length && !allowedOrigins.includes(url))) {
      throw fail("That payment return URL is not allowed.");
    }
    return url;
  }
  async function reservationFor(id) {
    const reservation = await getReservation(pool, Number(id));
    if (!reservation || reservation.status === "canceled") throw fail("This reservation is unavailable.", 404);
    return reservation;
  }
  async function customerFor(reservation) {
    // Serialize creation so concurrent payment links share the same Stripe customer.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query("SELECT stripe_customer_id FROM customers WHERE id=$1 FOR UPDATE", [reservation.customer_id]);
      let id = result.rows[0]?.stripe_customer_id;
      if (!id) {
        const customer = await stripe.customers.create({
          name: `${reservation.first_name || ""} ${reservation.last_name || ""}`.trim(),
          email: reservation.email || undefined,
          metadata: { riverpark_customer_id: String(reservation.customer_id) }
        }, { idempotencyKey: `riverpark-customer-${reservation.customer_id}` });
        id = customer.id;
        await client.query("UPDATE customers SET stripe_customer_id=$2 WHERE id=$1", [reservation.customer_id, id]);
      }
      await client.query("COMMIT");
      return id;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  async function saveMethod(client, { reservation, method, stripeCustomerId, consentAt,
    consentVersion = storageConsentVersion, consentText = storageConsentText, source }) {
    if (!consentAt || !method || objectId(method.customer) !== stripeCustomerId ||
        !["card", "us_bank_account"].includes(method.type)) return false;
    const details = method.card || method.us_bank_account;
    await client.query(`INSERT INTO reservation_saved_payment_methods
      (customer_id,reservation_id,stripe_customer_id,stripe_payment_method_id,payment_method_type,
       brand,last4,exp_month,exp_year,consent_at,consent_version,consent_text,source)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (customer_id,stripe_payment_method_id) DO NOTHING`,
    [reservation.customer_id, reservation.id, stripeCustomerId, method.id, method.type,
      details?.brand || details?.bank_name || null, details?.last4 || null,
      details?.exp_month || null, details?.exp_year || null, consentAt, consentVersion, consentText, source]);
    return true;
  }
  async function rememberSession(session, reservation, stripeCustomerId, client = pool, consent = {}) {
    await client.query(`INSERT INTO payment_method_save_sessions
      (stripe_checkout_session_id,reservation_id,customer_id,stripe_customer_id,consent_version,consent_text,consent_at)
      VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz,NOW())) ON CONFLICT DO NOTHING`,
    [session.id, reservation.id, reservation.customer_id, stripeCustomerId,
      consent.version || storageConsentVersion, consent.text || storageConsentText, consent.at || null]);
  }
  async function completeSession(client, session) {
    const result = await client.query(`SELECT * FROM payment_method_save_sessions
      WHERE stripe_checkout_session_id=$1 AND completed_at IS NULL FOR UPDATE`, [session.id]);
    if (!result.rowCount || session.status !== "complete") return null;
    const record = result.rows[0];
    if (objectId(session.customer) !== record.stripe_customer_id) throw fail("Saved payment customer mismatch.");
    const intentId = objectId(session.mode === "setup" ? session.setup_intent : session.payment_intent);
    if (!intentId) return null;
    const intent = session.mode === "setup"
      ? await stripe.setupIntents.retrieve(intentId, { expand: ["payment_method"] })
      : await stripe.paymentIntents.retrieve(intentId, { expand: ["payment_method"] });
    if (intent.status !== "succeeded") return null;
    const reservation = await getReservation(client, record.reservation_id);
    if (!reservation || String(reservation.customer_id) !== String(record.customer_id)) return null;
    const saved = await saveMethod(client, { reservation, method: intent.payment_method, stripeCustomerId: record.stripe_customer_id,
      consentAt: record.consent_at, consentVersion: record.consent_version, consentText: record.consent_text,
      source: session.mode === "setup" ? "guest_setup" : "guest_payment_link" });
    if (!saved) throw fail("Stripe has not confirmed a reusable payment method for this guest.");
    await client.query("UPDATE payment_method_save_sessions SET completed_at=NOW() WHERE stripe_checkout_session_id=$1", [session.id]);
    return reservation.id;
  }
  async function refreshSessions(reservation) {
    const result = await pool.query(`SELECT stripe_checkout_session_id FROM payment_method_save_sessions
      WHERE customer_id=$1 AND completed_at IS NULL AND created_at > NOW() - INTERVAL '30 days'
      ORDER BY created_at DESC LIMIT 10`, [reservation.customer_id]);
    for (const row of result.rows) {
      const session = await stripe.checkout.sessions.retrieve(row.stripe_checkout_session_id);
      const client = await pool.connect();
      try { await client.query("BEGIN"); await completeSession(client, session); await client.query("COMMIT"); }
      catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
  }
  function registerRoutes(app) {
    const route = (handler) => async (req, res) => {
      if (!stripe) return res.status(503).json({ message: "Stripe payments are not configured." });
      try { await handler(req, res); }
      catch (error) { res.status(error.status || 500).json({ message: error.message }); }
    };
    app.post("/api/reservations/:id/payment-method-setup-links", route(async (req, res) => {
      if (!secret) throw fail("Payment method links require GUEST_AUTH_SECRET.", 503);
      const reservation = await reservationFor(req.params.id);
      const origin = baseUrl(req.body.baseUrl);
      const token = signToken({ type: "guest_payment_method_setup", reservationId: reservation.id,
        customerId: reservation.customer_id, expiresAt: Date.now() + 7 * 86400000 }, secret);
      res.json({ setupUrl: `${origin}/?save_payment=${encodeURIComponent(token)}` });
    }));
    async function setupReservation(token) {
      const payload = readToken(token, secret, "guest_payment_method_setup");
      if (!payload?.reservationId) throw fail("This payment method link is invalid or expired. Ask the office for a new link.", 401);
      const reservation = await reservationFor(payload.reservationId);
      if (String(reservation.customer_id) !== String(payload.customerId)) throw fail("This payment method link is no longer valid.", 401);
      return reservation;
    }
    app.get("/api/guest/payment-method-setups/:token", route(async (req, res) => {
      const reservation = await setupReservation(req.params.token);
      let saved = false;
      if (req.query.session_id) {
        const result = await pool.query(`SELECT completed_at FROM payment_method_save_sessions
          WHERE stripe_checkout_session_id=$1 AND reservation_id=$2 AND customer_id=$3`,
        [req.query.session_id, reservation.id, reservation.customer_id]);
        if (result.rowCount) {
          await refreshSessions(reservation);
          const completed = await pool.query("SELECT completed_at FROM payment_method_save_sessions WHERE stripe_checkout_session_id=$1", [req.query.session_id]);
          saved = Boolean(completed.rows[0]?.completed_at);
        }
      }
      res.json({ reservationId: reservation.id, consentText: storageConsentText, saved });
    }));
    app.post("/api/guest/payment-method-setups/:token/checkouts", route(async (req, res) => {
      const reservation = await setupReservation(req.params.token);
      if (req.body.storageAccepted !== true) throw fail("Check the authorization box to save a payment method.");
      const origin = baseUrl(req.body.baseUrl);
      const customer = await customerFor(reservation);
      const returnUrl = `${origin}/?save_payment=${encodeURIComponent(req.params.token)}`;
      const session = await stripe.checkout.sessions.create({ mode: "setup", customer,
        payment_method_types: ["card"], currency: "usd",
        success_url: `${returnUrl}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${returnUrl}&save_status=cancel`,
        custom_text: { submit: { message: storageConsentText } },
        setup_intent_data: { usage: "off_session", metadata: { reservation_id: String(reservation.id) } }
      });
      await rememberSession(session, reservation, customer);
      res.json({ checkoutUrl: session.url });
    }));
    app.get("/api/reservations/:id/saved-payment-methods", route(async (req, res) => {
      const reservation = await reservationFor(req.params.id);
      await refreshSessions(reservation);
      const result = await pool.query(`SELECT id,payment_method_type AS type,brand,last4,exp_month,exp_year,consent_at
        FROM reservation_saved_payment_methods WHERE customer_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC`, [reservation.customer_id]);
      res.json(result.rows);
    }));
    app.delete("/api/reservations/:id/saved-payment-methods/:methodId", route(async (req, res) => {
      const reservation = await reservationFor(req.params.id);
      const result = await pool.query(`SELECT * FROM reservation_saved_payment_methods
        WHERE id=$1 AND customer_id=$2`, [req.params.methodId, reservation.customer_id]);
      const method = result.rows[0];
      if (!method) throw fail("Saved payment method not found.", 404);
      // Revoke first so a failed detach can never leave a method available to charge.
      await pool.query("UPDATE reservation_saved_payment_methods SET revoked_at=COALESCE(revoked_at,NOW()) WHERE id=$1", [method.id]);
      const current = await stripe.paymentMethods.retrieve(method.stripe_payment_method_id);
      if (objectId(current.customer) === method.stripe_customer_id) await stripe.paymentMethods.detach(current.id);
      res.json({ removed: true });
    }));
    app.post("/api/reservations/:id/saved-payment-methods/:methodId/charges", route(async (req, res) => {
      const charge = validateSavedCharge(req.body);
      const reservation = await reservationFor(req.params.id);
      const client = await pool.connect();
      let intent;
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [charge.requestId]);
        const previous = (await client.query("SELECT * FROM saved_payment_charge_requests WHERE request_id=$1", [charge.requestId])).rows[0];
        if (previous && (String(previous.reservation_id) !== String(reservation.id) || String(previous.saved_payment_method_id) !== String(req.params.methodId) ||
            previous.amount_cents !== charge.amountCents || previous.description !== charge.description || previous.approval_note !== charge.approvalNote)) {
          throw fail("This payment request has already been used for a different charge.", 409);
        }
        if (previous?.stripe_payment_intent_id) {
          intent = await stripe.paymentIntents.retrieve(previous.stripe_payment_intent_id);
        } else {
          const methods = await client.query(`SELECT * FROM reservation_saved_payment_methods
            WHERE id=$1 AND customer_id=$2 AND revoked_at IS NULL FOR UPDATE`, [req.params.methodId, reservation.customer_id]);
          const method = methods.rows[0];
          if (!method) throw fail("Saved payment method is unavailable. Refresh the list.", 404);
          const current = await stripe.paymentMethods.retrieve(method.stripe_payment_method_id);
          if (objectId(current.customer) !== method.stripe_customer_id) throw fail("This payment method was removed. Ask the guest to save it again.");
          await client.query(`INSERT INTO saved_payment_charge_requests
            (request_id,reservation_id,saved_payment_method_id,amount_cents,description,approval_note,approved_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
          [charge.requestId,reservation.id,method.id,charge.amountCents,charge.description,charge.approvalNote,String(req.adminUser.id)]);
          intent = await stripe.paymentIntents.create({ amount: charge.amountCents, currency: "usd",
            customer: method.stripe_customer_id, payment_method: method.stripe_payment_method_id,
            payment_method_types: [method.payment_method_type], receipt_email: reservation.email || undefined,
            description: charge.description, metadata: { reservation_id: String(reservation.id),
              payment_price_type: method.payment_method_type === "card" ? "card" : "bank",
              saved_payment_request_id: charge.requestId }
          }, { idempotencyKey: `saved-payment-create-${charge.requestId}` });
          await client.query(`INSERT INTO stripe_payment_records
            (reservation_id,stripe_payment_intent_id,amount_cents,currency,payment_status,
             activate_reservation_on_payment,stripe_customer_email,stripe_payment_method_type)
            VALUES ($1,$2,$3,'usd','unpaid',$4,$5,$6)`,
          [reservation.id,intent.id,charge.amountCents,reservation.status === "pending",reservation.email || null,method.payment_method_type]);
          await client.query("UPDATE saved_payment_charge_requests SET stripe_payment_intent_id=$2 WHERE request_id=$1", [charge.requestId,intent.id]);
        }
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
      // Persist the payment record before confirming, so even an immediate webhook
      // or a lost browser response can be reconciled without a second charge.
      if (intent.status === "requires_confirmation") {
        try {
          intent = await stripe.paymentIntents.confirm(intent.id, { off_session: true },
            { idempotencyKey: `saved-payment-confirm-${charge.requestId}` });
        } catch (error) {
          if (!error.payment_intent) throw error;
          intent = error.payment_intent;
        }
      }
      if (["requires_action", "requires_payment_method"].includes(intent.status)) {
        try { intent = await stripe.paymentIntents.cancel(intent.id); }
        catch (error) {
          if (error.code !== "payment_intent_unexpected_state") throw error;
          intent = await stripe.paymentIntents.retrieve(intent.id);
        }
      }
      const settlement = await syncPayments({ reservationId: reservation.id });
      notify({ reason: "saved_payment_charge", reservationId: reservation.id });
      res.json({ status: intent.status, paymentIntentId: intent.id,
        message: intent.status === "succeeded" ? (settlement?.errorCount
          ? "Stripe confirmed payment. The reservation record is still syncing; refresh payment history."
          : "Payment collected and recorded.")
          : intent.status === "processing" ? "Payment submitted. The balance updates after Stripe confirms it."
            : "This payment needs a new payment method or guest authentication. Send the guest a payment link; no payment has been recorded." });
    }));
  }
  return { registerRoutes, customerFor, rememberSession, completeSession, saveMethod };
}
