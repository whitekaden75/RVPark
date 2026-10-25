import { useEffect, useState } from "react";
import "./saved-payment-methods.css";

export const storageConsentText = "I authorize Riverpark RV Resort to securely save my payment method with Stripe for future reservation payments, including monthly rent and utilities. Each future charge requires my separate approval. I can request removal by calling or texting 541-295-1269.";

const attemptKey = (id) => `rvpark-saved-payment-attempt-${id}`;
function readAttempt(id) {
  try {
    const value = JSON.parse(window.localStorage.getItem(attemptKey(id)) || "null");
    return value?.requestId && value?.methodId && value?.guestApproved === true ? value : null;
  } catch { return null; }
}

export function SavePaymentConsent({ checked, onChange, disabled = false }) {
  return <label className="checkbox-row saved-payment-consent">
    <input type="checkbox" checked={checked === true} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
    <span><strong>Save my payment method for later (optional).</strong> {storageConsentText}</span>
  </label>;
}

export function PaymentMethodSetupPage({ token, request }) {
  const [details, setDetails] = useState(null);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get("session_id");
  const path = `/guest/payment-method-setups/${encodeURIComponent(token)}`;
  useEffect(() => {
    let canceled = false;
    request(`${path}${sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ""}`)
      .then((result) => { if (!canceled) setDetails(result); })
      .catch((err) => { if (!canceled) setError(err.message); });
    return () => { canceled = true; };
  }, [token, sessionId, request]);
  async function save() {
    setBusy(true); setError("");
    try {
      const result = await request(`${path}/checkouts`, { method: "POST",
        body: JSON.stringify({ storageAccepted: accepted, baseUrl: window.location.origin }) });
      window.location.assign(result.checkoutUrl);
    } catch (err) { setError(err.message); setBusy(false); }
  }
  return <main className="public-payment-page"><section className="public-payment-card">
    <a className="public-terms-brand" href="/">Riverpark RV Resort</a>
    <p className="eyebrow">Secure card storage</p><h1>Save a card for your stay</h1>
    {error ? <div className="message error" role="alert">{error}</div> : null}
    {!details && !error ? <p>Loading reservation…</p> : null}
    {details?.saved ? <div className="message success" role="status">Your card was securely saved. No payment was collected.</div> : details ? <>
      <p>Reservation #{details.reservationId}. Add a card for future reservation payments, monthly rent, or utilities. No payment is collected now. Each future charge requires your separate approval.</p>
      {params.get("save_status") === "cancel" ? <p>Card setup was canceled. You can try again below.</p> : null}
      {sessionId ? <p>Card setup has not been confirmed yet. Refresh this page to check again.</p> : null}
      <SavePaymentConsent checked={accepted} onChange={setAccepted} disabled={busy} />
      <p className="muted">Stripe securely stores your card. The office sees only its brand, last four digits, and expiration date.</p>
      <button className="primary-button" type="button" disabled={!accepted || busy || Boolean(sessionId)} onClick={save}>
        {busy ? "Opening Stripe…" : "Continue to secure card setup"}
      </button>
    </> : null}
  </section></main>;
}

export function SavedPaymentMethodsPanel({ reservation, request, amount = "", onPayment }) {
  const [restoredAttempt] = useState(() => readAttempt(reservation.id));
  const [open, setOpen] = useState(false);
  const [methods, setMethods] = useState(null);
  const [selected, setSelected] = useState(restoredAttempt?.methodId || "");
  const [chargeAmount, setChargeAmount] = useState(restoredAttempt?.amount || String(amount || ""));
  const [description, setDescription] = useState(restoredAttempt?.description || "Reservation payment");
  const [approved, setApproved] = useState(restoredAttempt?.guestApproved === true);
  const [approvalNote, setApprovalNote] = useState(restoredAttempt?.approvalNote || "");
  const [setupUrl, setSetupUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState(restoredAttempt ? "A previous payment request is saved. Check this request before starting another charge." : "");
  const [attempt, setAttempt] = useState(restoredAttempt);
  const [result, setResult] = useState(null);
  const path = `/reservations/${reservation.id}`;
  const currency = (value) => Number(value || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
  async function load() {
    const rows = await request(`${path}/saved-payment-methods`);
    setMethods(rows);
    setSelected((current) => rows.some((row) => String(row.id) === current) ? current : String(rows[0]?.id || ""));
  }
  useEffect(() => {
    if (!open) return;
    let canceled = false;
    request(`${path}/saved-payment-methods`).then((rows) => {
      if (canceled) return;
      setMethods(rows); setSelected((current) => rows.some((row) => String(row.id) === current) ? current : String(rows[0]?.id || ""));
    }).catch((err) => { if (!canceled) setError(err.message); });
    return () => { canceled = true; };
  }, [open, reservation.id, request]);
  useEffect(() => { if (!attempt) { setChargeAmount(String(amount || "")); setApproved(false); } }, [amount]);
  async function act(action) {
    setBusy(true); setError(""); setMessage("");
    try { await action(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function charge() {
    const draft = attempt || { methodId: selected, requestId: crypto.randomUUID(), amount: chargeAmount,
      description, guestApproved: approved, approvalNote };
    if (!/^\d+(\.\d{1,2})?$/.test(String(draft.amount)) || Number(draft.amount) <= 0 || Number(draft.amount) > 999999.99) {
      setError("Enter a positive amount with at most two decimal places."); return;
    }
    await act(async () => {
      window.localStorage.setItem(attemptKey(reservation.id), JSON.stringify(draft));
      setAttempt(draft);
      let response;
      try {
        response = await request(`${path}/saved-payment-methods/${draft.methodId}/charges`, {
          method: "POST", body: JSON.stringify(draft)
        });
      } catch (err) {
        // These responses reject before creating/confirming an intent. Network
        // failures and server errors keep the request for safe recovery.
        if ([400, 404].includes(err.status)) {
          window.localStorage.removeItem(attemptKey(reservation.id)); setAttempt(null); setApproved(false);
        }
        throw err;
      }
      setResult(response); setMessage(response.message);
      await onPayment?.();
    });
  }
  const method = methods?.find((row) => String(row.id) === selected);
  return <details className="saved-payment-panel timeline-card" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Saved payment methods <span className="muted">· reservations &amp; monthly payments</span></summary>
    {open ? <div className="saved-payment-content">
      <p>Save a guest’s card securely, then collect individually approved reservation, rent, or utility payments.</p>
      {error ? <div className="message error" role="alert">{error}{attempt ? " Retry this same request to check it safely before starting another charge." : ""}</div> : null}
      {message ? <div className="message" role="status">{message}</div> : null}
      <div className="button-row">
        {attempt && (!result || result.status === "processing") ? <button type="button" className="primary-button" disabled={busy} onClick={charge}>{busy ? "Checking payment…" : "Retry / check previous payment"}</button> : null}
        <button type="button" className="ghost-button" disabled={busy} onClick={() => act(async () => {
          const link = await request(`${path}/payment-method-setup-links`, { method: "POST", body: JSON.stringify({ baseUrl: window.location.origin }) });
          setSetupUrl(link.setupUrl);
        })}>Create secure card-save link</button>
        <button type="button" className="ghost-button" disabled={busy} onClick={() => act(load)}>Refresh saved methods</button>
      </div>
      {setupUrl ? <div className="saved-payment-link"><label>Guest card-save link (valid for 7 days)
        <input readOnly value={setupUrl} onFocus={(event) => event.target.select()} />
      </label><div className="button-row">
        <button className="ghost-button" type="button" onClick={() => act(async () => { await navigator.clipboard.writeText(setupUrl); setMessage("Card-save link copied."); })}>Copy link</button>
        <a className="ghost-button" href={setupUrl} target="_blank" rel="noreferrer">Open for guest</a>
      </div><p className="muted">The guest checks the authorization box and enters their card in Stripe. This link collects no payment.</p></div> : null}
      {methods === null ? <p>Loading saved methods…</p> : !methods.length ? <p className="muted">No payment method is saved. Create a card-save link above; the guest can add one without making a payment.</p> : <>
        <label>Payment method<select value={selected} disabled={busy || Boolean(attempt)} onChange={(event) => { setSelected(event.target.value); setApproved(false); }}>
          {methods.map((row) => <option key={row.id} value={row.id}>{row.brand || row.type} ending {row.last4}{row.exp_month ? ` · expires ${row.exp_month}/${row.exp_year}` : ""}</option>)}
        </select></label>
        {method ? <p className="muted small-text">Saving authorized {new Date(method.consent_at).toLocaleString()}. Available across this guest’s reservations.</p> : null}
        <div className="saved-payment-fields">
          <label>Exact {method?.type === "us_bank_account" ? "bank" : "card"} amount to charge<input type="number" min="0.01" step="0.01" value={chargeAmount} disabled={busy || Boolean(attempt)} onChange={(event) => { setChargeAmount(event.target.value); setApproved(false); }} /></label>
          <label>Payment description<input value={description} maxLength={200} disabled={busy || Boolean(attempt)} placeholder="October rent and utilities" onChange={(event) => { setDescription(event.target.value); setApproved(false); }} /></label>
        </div>
        <label>Guest approval record<input value={approvalNote} maxLength={1000} disabled={busy || Boolean(attempt)} placeholder="Who approved, when, and how (for example, signed authorization)" onChange={(event) => { setApprovalNote(event.target.value); setApproved(false); }} /></label>
        <label className="checkbox-row saved-payment-consent"><input type="checkbox" checked={approved} disabled={busy || Boolean(attempt)} onChange={(event) => setApproved(event.target.checked)} /><span>The guest separately approved this exact {currency(chargeAmount)} charge for {description || "this payment"}. Storage consent alone does not authorize it.</span></label>
        <p className="muted small-text">Enter the full amount approved by the guest, including the agreed card price. Payments are initiated here by staff; monthly autopay is not enabled.</p>
        <div className="button-row">
          {!attempt ? <button type="button" className="primary-button" disabled={busy || !selected || !approved || !approvalNote.trim() || !description.trim() || Number(chargeAmount) <= 0} onClick={charge}>{busy ? "Checking payment…" : `Charge ${currency(chargeAmount)} to saved method`}</button> : null}
          {result && result.status !== "processing" ? <button type="button" className="ghost-button" onClick={() => { window.localStorage.removeItem(attemptKey(reservation.id)); setAttempt(null); setResult(null); setApproved(false); setApprovalNote(""); setMessage(""); }}>Start another payment</button> : null}
          <button type="button" className="ghost-button danger-button" disabled={busy || Boolean(attempt)} onClick={() => act(async () => {
            await request(`${path}/saved-payment-methods/${selected}`, { method: "DELETE" }); await load(); setMessage("Payment method removed for this guest.");
          })}>Remove saved method</button>
        </div>
      </>}
    </div> : null}
  </details>;
}
