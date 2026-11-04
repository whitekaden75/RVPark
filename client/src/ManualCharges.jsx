import { useRef, useState } from 'react';
import { manualChargePayload, manualChargeStorageKey, saveManualCharge } from './manual-charges.js';

const money = value => Number(value || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
function restore(id) {
  try { return JSON.parse(window.localStorage.getItem(manualChargeStorageKey(id)) || 'null'); }
  catch { return null; }
}

export default function ManualCharges({ reservation, request, onSaved, onRefresh, onGenerateLink, disabled = false }) {
  const [pending, setPending] = useState(() => restore(reservation.id));
  const [form, setForm] = useState(() => restore(reservation.id) || {
    description: '', quantity: '1', unitAmount: '', serviceDate: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const inFlight = useRef(false);
  const entries = reservation.manualCharges || [];
  const activeEntries = entries.filter(entry => !entry.voidedAt);
  const replacing = reservation.manualChargePricingMode === 'replace';
  const total = Math.round(Number(form.quantity || 0) * Number(form.unitAmount || 0) * 100) / 100;
  const bankBalance = Number(reservation.bankRemainingBalance || 0);
  const cardBalance = Number(reservation.cardRemainingBalance || 0);
  const update = (field, value) => { setForm(current => ({ ...current, [field]: value })); setNotice(''); };

  async function mutate(path, body, success) {
    if (inFlight.current || disabled) return;
    inFlight.current = true; setBusy(true); setError(''); setNotice('');
    try {
      let updated;
      if (path === 'manual-charges') {
        const payload = pending || manualChargePayload(form, crypto.randomUUID());
        setPending(payload);
        updated = await saveManualCharge({ reservationId: reservation.id, payload, request, storage: window.localStorage });
        setPending(null);
        setForm(current => ({ ...current, description: '', serviceDate: '' }));
      } else {
        updated = await request(`/reservations/${reservation.id}/${path}`, { method: 'POST', body: JSON.stringify(body) });
      }
      onSaved(updated); setNotice(success);
      try { await onRefresh(); } catch { setNotice(`${success} Refresh the list to see all changes.`); }
    } catch (error) {
      if ([400, 401, 403, 404, 409].includes(error.status)) setPending(null);
      setError(error.message);
    } finally { inFlight.current = false; setBusy(false); }
  }

  return <section className="timeline-card payment-edit-card manual-charges-card" aria-label="Manual reservation charges">
    <div className="result-header"><h4>Manual charges</h4><strong>{money(reservation.manualChargeTotal)} in charges</strong></div>
    <p>Enter the exact amount this guest should owe. Saving replaces the current unpaid balance, including any earlier manual amount. Previously collected payments stay on record. No payment is collected when saving.</p>
    {replacing ? <p className="manual-charge-mode"><strong>Manual balance is active.</strong> Payments received after the last replacement reduce this balance.</p> : null}
    <fieldset disabled={busy || disabled || Boolean(pending)} className="manual-charge-fields">
      <label>Description<input value={form.description} maxLength={200} placeholder="For example: December visit — three nights" onChange={event => update('description', event.target.value)} /></label>
      <div className="field-grid compact-grid">
        <label>Nights / quantity<input type="number" min="1" max="10000" step="1" value={form.quantity} onChange={event => update('quantity', event.target.value)} /></label>
        <label>Amount / rate ($)<input type="number" min="0.01" step="0.01" value={form.unitAmount} onChange={event => update('unitAmount', event.target.value)} /></label>
        <label>Visit date <span className="optional-label">optional</span><input type="date" value={form.serviceDate} onChange={event => update('serviceDate', event.target.value)} /></label>
      </div>

    </fieldset>
    <div className="manual-charge-preview"><strong>New balance due: {money(Number.isFinite(total) ? total : 0)}</strong><span>The entered total is the same for cash, check, bank, and card. No automatic discounts or card markup are added.</span>
      <span>Replaces the current {money(bankBalance)} balance. To cover two three-night visits at once, enter 6 nights and your nightly rate.</span>
    </div>
    <button type="button" className="primary-button" disabled={busy || disabled} onClick={() => mutate('manual-charges', null, 'Balance replaced. Collect this exact amount using the payment controls below.')}>
      {busy ? 'Saving…' : pending ? 'Retry saving this charge' : `Replace balance with ${money(Number.isFinite(total) ? total : 0)}`}
    </button>
    {pending && !busy ? <p className="muted">Retry this same charge to confirm whether it saved before entering another one.</p> : null}
    {entries.length ? <ul className="timeline-list manual-charge-list">{entries.map(entry => <li key={entry.id} className={entry.voidedAt ? 'manual-charge-voided' : ''}>
      <div><strong>{entry.description} · {money(entry.amount)}{entry.replacedByChargeId ? ' · Replaced' : entry.voidedAt ? ' · Voided' : ''}</strong><span>{entry.quantity} × {money(entry.unitAmount)}{entry.serviceDate ? ` · Visit: ${entry.serviceDate}` : ''} · Added {new Date(entry.createdAt).toLocaleDateString()}</span></div>
      {!entry.voidedAt ? <div className="button-row">
        <button type="button" className="ghost-button" disabled={busy || disabled || Boolean(pending) || Math.max(bankBalance, cardBalance) <= 0 || reservation.balanceWaiver?.active} onClick={() => onGenerateLink(reservation, 'Manual charge payment link', {
          customAmount: Math.min(entry.amount, bankBalance), customCardAmount: Math.min(entry.amount, cardBalance), description: entry.description,
        })}>Payment link</button>
        <button type="button" className="ghost-button danger-button" disabled={busy || disabled || Boolean(pending)} onClick={() => {
          if (window.confirm(`Void “${entry.description}” (${money(entry.amount)})? This removes the charge from the balance and keeps its history. Payments are not refunded.`)) mutate(`manual-charges/${entry.id}/void`, {}, 'Charge voided. Payment history was preserved.');
        }}>Void charge</button>
      </div> : null}
    </li>)}</ul> : null}
    {replacing && !activeEntries.length ? <button type="button" className="ghost-button" disabled={busy || disabled || Boolean(pending)} onClick={() => {
      if (window.confirm('Restore automatic pricing? The reservation’s calculated balance will apply again.')) mutate('manual-charges/restore-automatic', {}, 'Automatic pricing restored.');
    }}>Restore automatic pricing</button> : null}
    {disabled ? <p className="muted">Save or reset your pricing edits before changing manual charges.</p> : null}
    {error ? <div className="message error" role="alert">{error}</div> : null}
    {notice ? <div className="message success" role="status">{notice}</div> : null}
  </section>;
}
