import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel } from '@mui/material';

const money = (amount, currency) => {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(amount); }
  catch { return `${currency} ${Number(amount).toFixed(2)}`; }
};

export default function DocumentEntryResetDialog({ initialDocumentId, apiRequest, onClose, onReset }) {
  const [documents, setDocuments] = useState([]), [documentId, setDocumentId] = useState(String(initialDocumentId || ''));
  const [preview, setPreview] = useState(null), [confirmed, setConfirmed] = useState(false);
  const [loadingSources, setLoadingSources] = useState(true), [loading, setLoading] = useState(false), [saving, setSaving] = useState(false);
  const [sourceError, setSourceError] = useState(''), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  const savingRef = useRef(false);

  useEffect(() => {
    let current = true;
    setLoadingSources(true); setSourceError('');
    apiRequest('/bookkeeping/document-entry-resets/sources')
      .then(data => { if (current) setDocuments(data.documents || []); })
      .catch(err => { if (current) setSourceError(err.message); })
      .finally(() => { if (current) setLoadingSources(false); });
    return () => { current = false; };
  }, [apiRequest, revision]);

  useEffect(() => {
    let current = true;
    setPreview(null); setConfirmed(false); setError(''); setLoading(Boolean(documentId));
    if (documentId) apiRequest(`/bookkeeping/documents/${documentId}/reset-preview`)
      .then(data => { if (current) setPreview(data); })
      .catch(err => { if (current) setError(err.message); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [apiRequest, documentId, revision]);

  async function reset() {
    if (savingRef.current || !confirmed || !preview?.canReset || String(preview.document.id) !== documentId) return;
    savingRef.current = true; setSaving(true); setError('');
    let result;
    try {
      result = await apiRequest(`/bookkeeping/documents/${documentId}/reset-entries`, {
        method: 'POST', body: JSON.stringify({ snapshot: preview.snapshot, confirmDocumentId: documentId })
      });
    } catch (err) {
      setError(err.message); setConfirmed(false); setPreview(null);
      savingRef.current = false; setSaving(false); return;
    }
    onReset(result);
  }

  return <Dialog open onClose={() => { if (!savingRef.current) onClose(); }} fullWidth maxWidth="md" aria-labelledby="document-reset-title">
    <DialogTitle id="document-reset-title">Start over from one file</DialogTitle>
    <DialogContent className="fin-modal-content finance-dialog">
      <p>Remove the selected file’s imported entries from Transactions and reports, across all dates. The original file and historical records are preserved. You can then queue the file again in Documents for a fresh import.</p>
      {sourceError ? <Alert severity="error">{sourceError}</Alert> : null}
      <label className="fin-modal-select">Source file
        <select aria-label="Source file to reset" value={documentId} disabled={saving || loadingSources} onChange={event => { setDocumentId(event.target.value); setPreview(null); setConfirmed(false); }}>
          <option value="">{loadingSources ? 'Loading files…' : 'Choose a file…'}</option>
          {documentId && !documents.some(doc => String(doc.id) === documentId) ? <option value={documentId}>{preview?.document.original_filename || `File #${documentId}`}</option> : null}
          {documents.map(doc => <option key={doc.id} value={doc.id}>{doc.original_filename} · #{doc.id} · {doc.entry_count} entries</option>)}
        </select>
      </label>
      {!loadingSources && !sourceError && !documents.length && !documentId ? <p>No files have active imported entries to reset.</p> : null}
      {loading ? <p role="status"><CircularProgress size={16} sx={{ mr: 1, verticalAlign: 'middle' }}/> Reviewing all entries…</p> : null}
      {error ? <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert> : null}
      {preview ? <>
        <h3 className="fin-reset-filename">{preview.document.original_filename} · File #{preview.document.id}</h3>
        <Alert severity="warning">{preview.count} active entries will be removed, including any approved entries. Other files, manual entries, Stripe and office payments are unaffected.</Alert>
        <p>{preview.totals.map(row => `${row.count} ${row.type}: ${money(row.amount, row.currency)}`).join(' · ')}</p>
        {preview.blockers.map(message => <Alert key={message} severity="error" sx={{ mb: 1 }}>{message}</Alert>)}
        {preview.entries.length ? <div className="fin-reset-entries" tabIndex={0} role="region" aria-label="All entries to remove">
          <table><thead><tr><th>Date</th><th>Entry</th><th>Status</th><th>Type</th><th>Amount</th></tr></thead><tbody>
            {preview.entries.map(entry => <tr key={entry.id}><td>{entry.transaction_date || 'No date'}</td><td>#{entry.id} · {entry.vendor || 'Unknown vendor'}<small>{entry.description}</small></td><td>{entry.status}</td><td>{entry.transaction_type}</td><td>{money(entry.total, entry.currency)}</td></tr>)}
          </tbody></table>
        </div> : null}
        {preview.canReset ? <FormControlLabel className="fin-reset-confirm" control={<Checkbox checked={confirmed} disabled={saving} onChange={event => setConfirmed(event.target.checked)}/>} label={`Remove all ${preview.count} entries from file #${preview.document.id} and make this file ready for AI again.`}/> : null}
      </> : null}
    </DialogContent>
    <DialogActions sx={{ flexWrap: 'wrap' }}>
      <Button disabled={saving} onClick={onClose}>Cancel</Button>
      <Button disabled={saving || loading || loadingSources} onClick={() => { setPreview(null); setConfirmed(false); setRevision(value => value + 1); }}>Refresh review</Button>
      <Button color="error" variant="contained" disabled={saving || loading || !confirmed || !preview?.canReset} onClick={reset} startIcon={saving ? <CircularProgress size={16} color="inherit"/> : undefined}>{saving ? 'Resetting…' : `Remove ${preview?.count || ''} entries & reset file`}</Button>
    </DialogActions>
  </Dialog>;
}
