import { useEffect, useRef, useState } from "react";
import { monthlyPaymentPayload, monthlyPaymentStorageKey, monthLabel, paymentTenderLabel,
  prepareMonthlyPaymentText, saveMonthlyOfficePayment } from "./monthly-payments.js";

const money = value => Number(value || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
function restorePayment(id) {
  try { return JSON.parse(window.localStorage.getItem(monthlyPaymentStorageKey(id)) || "null"); }
  catch { return null; }
}

export default function MonthlyPaymentsPanel({ reservation, amount, today, request, onPayment, onPreviewText }) {
  const [pending, setPending] = useState(() => restorePayment(reservation.id));
  const [open, setOpen] = useState(() => Boolean(restorePayment(reservation.id)));
  const [form, setForm] = useState(() => restorePayment(reservation.id) || {
    amount, tenderType: "cash", checkNumber: "", paymentDate: today, paymentMonth: today.slice(0, 7), note: ""
  });
  const [busy, setBusy] = useState(false);
  const [textBusy, setTextBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [lastPayment, setLastPayment] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const inFlight = useRef(false);
  const textInFlight = useRef(false);
  const name = `${reservation.first_name || ""} ${reservation.last_name || ""}`.trim();

  useEffect(() => {
    if (!historyOpen) return;
    let cancelled = false;
    setHistoryLoading(true);
    setHistoryError("");
    request(`/reservations/${reservation.id}/monthly-payments`).then(result => {
      if (!cancelled) setHistory(result.payments);
    }).catch(error => { if (!cancelled) setHistoryError(error.message); })
      .finally(() => { if (!cancelled) setHistoryLoading(false); });
    return () => { cancelled = true; };
  }, [reservation.id, reservation.amountPaid, request, historyOpen, refresh]);

  function update(field, value) { setForm(current => ({ ...current, [field]: value })); }

  async function recordPayment(event) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError(""); setNotice("");
    try {
      const payload = pending || { ...monthlyPaymentPayload(form, today), requestId: crypto.randomUUID() };
      setPending(payload);
      const result = await saveMonthlyOfficePayment({ reservationId: reservation.id, payload,
        request, storage: window.localStorage });
      setPending(null); setOpen(false); setLastPayment(result.payment);
      setNotice(`${money(result.payment.amount)} recorded as ${result.payment.tenderType} for ${monthLabel(result.payment.paymentMonth)}.`);
      onPayment(result.reservation);
      setRefresh(value => value + 1);
    } catch (error) {
      if ([400, 401, 403, 409].includes(error.status)) {
        setPending(null);
        try { window.localStorage.removeItem(monthlyPaymentStorageKey(reservation.id)); } catch {}
      }
      setError(error.message);
    } finally { inFlight.current = false; setBusy(false); }
  }

  async function previewText(payment = null) {
    if (textInFlight.current) return;
    textInFlight.current = true;
    setTextBusy(true); setError("");
    try {
      const draft = await prepareMonthlyPaymentText({ reservation, amount, payment,
        paymentMonth: form.paymentMonth, request, baseUrl: window.location.origin });
      onPreviewText(draft);
    } catch (error) { setError(error.message); }
    finally { textInFlight.current = false; setTextBusy(false); }
  }

  return <section className="monthly-office-payments" aria-label={`Cash, checks and payment history for ${name}`}>
    <div className="monthly-payment-heading"><h4>Cash &amp; check payments</h4>
      <div className="button-row">
        <button type="button" className="primary-button" disabled={busy} aria-expanded={open}
          onClick={() => { if (!open && !pending) setForm(current => ({ ...current, amount, paymentDate: today })); setOpen(value => !value); }}>
          {open ? "Close payment form" : "Record cash or check"}
        </button>
        <button type="button" className="ghost-button" disabled={textBusy || busy || !reservation.phone_number} onClick={() => previewText()}>
          {textBusy ? "Preparing text…" : "Send text…"}
        </button>
      </div>
      <p className="muted small-text">Review the message before pressing Send. Payment and meter entries are saved separately.</p>
    </div>
    {error ? <p className="message error" role="alert">{error}</p> : null}
    {notice ? <div className="message success" role="status">{notice}</div> : null}
    {lastPayment ? <button type="button" className="ghost-button" disabled={textBusy || !reservation.phone_number} onClick={() => previewText(lastPayment)}>Text payment receipt…</button> : null}
    {open ? <form onSubmit={recordPayment} className="monthly-office-payment-form">
      <fieldset disabled={busy || Boolean(pending)} className="monthly-settings-grid">
        <label>Payment method<select value={form.tenderType} onChange={event => update("tenderType", event.target.value)}><option value="cash">Cash</option><option value="check">Check</option></select></label>
        <label>Amount received ($)<input type="number" inputMode="decimal" min="0.01" max="99999999.99" step="0.01" required value={form.amount} onChange={event => update("amount", event.target.value)} /></label>
        <label>Payment received date<input type="date" required max={today} value={form.paymentDate} onChange={event => update("paymentDate", event.target.value)} /></label>
        <label>Month covered<input type="month" required value={form.paymentMonth} onChange={event => update("paymentMonth", event.target.value)} /></label>
        {form.tenderType === "check" ? <label>Check number<input required maxLength={50} value={form.checkNumber} onChange={event => update("checkNumber", event.target.value)} /></label> : null}
        <label className="monthly-payment-note">Note (optional)<input maxLength={500} placeholder="Rent, electricity, or partial payment" value={form.note} onChange={event => update("note", event.target.value)} /></label>
      </fieldset>
      {pending && !busy ? <p className="muted small-text">Retry this same payment to confirm whether it was saved before recording another one.</p> : null}
      <button type="submit" className="primary-button" disabled={busy}>{busy ? "Saving payment…" : pending ? "Retry saving this payment" : `Record ${money(form.amount)} ${form.tenderType} payment`}</button>
    </form> : null}
    <details className="monthly-payment-history" onToggle={event => setHistoryOpen(event.currentTarget.open)}>
      <summary>Payment history ({reservation.paymentEvents?.length || 0})</summary>
      <button type="button" className="ghost-button" disabled={historyLoading} onClick={() => setRefresh(value => value + 1)}>Refresh payments</button>
      {historyError ? <p className="message error" role="alert">{historyError}</p> : null}
      {historyLoading ? <p className="muted">Loading payments…</p> : history.length ? <ol className="monthly-payment-history-list">{history.map(payment => <li key={payment.id}>
        <div><strong>{money(payment.amount)}</strong><span className="status-badge active">{paymentTenderLabel(payment)}</span></div>
        <p>Received {payment.paymentDate}{payment.paymentMonth ? ` · For ${monthLabel(payment.paymentMonth)}` : ""}</p>
        {payment.note ? <p className="muted small-text">{payment.note.replace(/\.?\s*Price type: (bank|card)/i, "").replace(/\.?\s*Tender: (cash|check|card)/i, "")}</p> : null}
        <button type="button" className="ghost-button" disabled={textBusy || !reservation.phone_number} onClick={() => previewText(payment)}>Text receipt…</button>
      </li>)}</ol> : <p className="muted">No payments recorded yet.</p>}
    </details>
  </section>;
}
