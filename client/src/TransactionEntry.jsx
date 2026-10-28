import { useRef, useState } from 'react';
import { Alert, Button, CircularProgress } from '@mui/material';

export function entryDraft(type = 'expense', account = '') {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return { transaction_date: date, transaction_type: type === 'all' ? 'expense' : type, vendor: '', total: '', category: '', description: '', payment_account: account, document_id: '' };
}

export function TransactionEntryFields({ draft, setDraft, categories, documents = [], fixedDocument, disabled = false }) {
  const set = (key, value) => setDraft(current => ({ ...current, [key]: value }));
  const statements = documents.filter(doc => ['bank_statement','credit_card_statement'].includes(doc.document_type) && ['needs_review','approved'].includes(doc.processing_status) && !doc.metadata?.ai_queued);
  return <fieldset className="fin-entry-fields" disabled={disabled}><div className="fin-form-grid">
    <label className="fin-span-2">Vendor / customer<input required value={draft.vendor} onChange={event => set('vendor', event.target.value)}/></label>
    <label>Transaction date<input required type="date" value={draft.transaction_date} onChange={event => set('transaction_date', event.target.value)}/></label>
    <label>Type<select value={draft.transaction_type} onChange={event => set('transaction_type', event.target.value)}>{['expense','income','refund','transfer','adjustment'].map(type => <option key={type}>{type}</option>)}</select></label>
    <label>Amount (USD)<input required type="number" min=".01" step=".01" value={draft.total} onChange={event => set('total', event.target.value)}/></label>
    <label>Category<select value={draft.category} onChange={event => set('category', event.target.value)}><option value="">Uncategorized</option>{categories.map(row => <option key={row.id} value={row.name}>{row.name}</option>)}</select></label>
    <label className="fin-span-2">Description<input value={draft.description} onChange={event => set('description', event.target.value)}/></label>
    <label className="fin-span-2">Bank or credit-card account (optional)<input maxLength={200} value={draft.payment_account} placeholder="e.g. Business checking ending 1234 or Visa ending 5678" onChange={event => set('payment_account', event.target.value)}/></label>
    {fixedDocument ? <p className="fin-muted fin-small fin-span-2">Statement: <strong className="fin-document-filename">{fixedDocument.original_filename}</strong></p> : <label className="fin-span-2">Bank or credit-card statement (optional)<select value={draft.document_id} onChange={event => set('document_id', event.target.value)}><option value="">No statement — standalone entry</option>{statements.map(doc => <option key={doc.id} value={doc.id}>{doc.original_filename}</option>)}</select></label>}
    <p className="fin-muted fin-small fin-span-2">{fixedDocument || draft.document_id ? 'Added to this statement as Needs review. Review and approve it with the other entries.' : 'Standalone entries are approved immediately.'} Use an account nickname or last four digits. Do not re-enter payments already imported from Stripe or recorded on a reservation. Credit-card payments are transfers.</p>
  </div></fieldset>;
}

export function StatementEntryEditor({ document, transactionType, account, categories, apiRequest, onSaved, onClose, onBusyChange }) {
  const [draft, setDraft] = useState(() => ({ ...entryDraft(transactionType, account), document_id: document.id }));
  const [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const root = useRef(null), inFlight = useRef(false);
  async function save() {
    if (inFlight.current) return;
    for (const field of root.current.querySelectorAll('input,select')) if (!field.reportValidity()) return;
    inFlight.current = true; setSaving(true); setError(''); onBusyChange?.(true);
    try {
      const result = await apiRequest('/bookkeeping/entries', { method: 'POST', body: JSON.stringify(draft) });
      onSaved(result.transaction); onClose();
    } catch (err) { setError(err.message); }
    finally { inFlight.current = false; setSaving(false); onBusyChange?.(false); }
  }
  return <div ref={root} className="fin-inline-review fin-new-statement-entry" role="region" aria-label="Add transaction to statement">
    <div className="fin-section-title"><h3>Add transaction</h3><Button type="button" disabled={saving} onClick={onClose}>Cancel</Button></div>
    {error ? <Alert severity="error">{error}</Alert> : null}
    <TransactionEntryFields draft={draft} setDraft={setDraft} categories={categories} fixedDocument={document} disabled={saving}/>
    <Button type="button" variant="contained" disabled={saving} onClick={save} startIcon={saving ? <CircularProgress size={16} color="inherit"/> : undefined}>{saving ? 'Adding…' : 'Add to statement'}</Button>
  </div>;
}
