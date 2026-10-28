import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Checkbox, CircularProgress, FormControlLabel } from '@mui/material';
import { documentExtractionMessage, documentTransactionSummary } from './document-transactions.js';

const title = value => String(value || '').replaceAll('_', ' ').replace(/^./, value => value.toUpperCase());
const money = (amount, currency = 'USD') => {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(amount || 0)); }
  catch { return `${currency} ${Number(amount || 0).toFixed(2)}`; }
};

export default function DocumentTransactions({ documentId, apiRequest, renderOriginal, onReview }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0), [showExcluded, setShowExcluded] = useState(false);
  useEffect(() => {
    let current = true, inFlight = false;
    async function load() {
      if (inFlight) return;
      inFlight = true; setLoading(true);
      try {
        const result = await apiRequest(`/bookkeeping/documents/${documentId}/transactions`);
        if (current) { setData(result); setError(''); }
      } catch (err) { if (current) setError(err.message); }
      finally { inFlight = false; if (current) setLoading(false); }
    }
    load();
    const update = () => { if (document.visibilityState !== 'hidden') load(); };
    const timer = setInterval(update, 15000);
    window.addEventListener('rvpark-bookkeeping-changed', update);
    window.addEventListener('focus', update);
    return () => { current = false; clearInterval(timer); window.removeEventListener('rvpark-bookkeeping-changed', update); window.removeEventListener('focus', update); };
  }, [apiRequest, documentId, revision]);

  const summary = useMemo(() => documentTransactionSummary(data?.transactions || []), [data]);
  const entries = (data?.transactions || []).filter(row => showExcluded || row.status !== 'void');
  const processingMessage = data ? documentExtractionMessage(data.document, summary) : '';
  return <>
    <div className="fin-section-title"><div><h3>Transactions from this document</h3><p className="fin-document-filename">{data?.document.original_filename || `File #${documentId}`}</p></div><Button disabled={loading} onClick={() => setRevision(value => value + 1)}>Refresh transactions</Button></div>
    {loading ? <p role="status"><CircularProgress size={16} sx={{ mr: 1, verticalAlign: 'middle' }}/>{data ? 'Refreshing transactions…' : 'Loading all transactions…'}</p> : null}
    {error ? <Alert severity="error" sx={{ my: 2 }}>{error}{data ? ' The last loaded results are shown below; refresh to check for changes.' : ''}</Alert> : null}
    {data ? <>
      <div className="fin-document-counts" aria-label="Document transaction counts">
        <span><strong>{summary.activeCount}</strong> active transactions</span><span><strong>{summary.pendingCount}</strong> need review</span><span><strong>{summary.approvedCount}</strong> approved</span><span><strong>{summary.excludedCount}</strong> excluded</span>
      </div>
      {processingMessage ? <Alert severity={data.document.processing_status === 'failed' ? 'warning' : 'info'} sx={{ my: 2 }}>{processingMessage}</Alert> : null}
      <p>All dates are included. Compare the list and totals with the original document to check for missing or repeated transactions.</p>
      {summary.totals.length ? <div className="fin-document-totals" aria-label="Active transaction totals">{summary.totals.map(row => <div key={`${row.currency}:${row.type}`}><span>{title(row.type)} · {row.currency} · {row.count} entries</span><strong>{money(row.amount, row.currency)}</strong></div>)}</div> : null}
      <p className="fin-muted">Totals include approved entries and entries awaiting review. Excluded history is omitted. AI can miss transactions, so check against the original.</p>
    </> : null}
    <div className="fin-document-transactions-layout">
      <div className="fin-document-transactions-list">
        {summary.excludedCount ? <FormControlLabel className="fin-document-history" control={<Checkbox checked={showExcluded} onChange={event => setShowExcluded(event.target.checked)}/>} label={`Show excluded history (${summary.excludedCount})`}/> : null}
        {entries.length ? <div className="fin-document-table" role="region" tabIndex={0} aria-label="Transactions tied to this document"><table><thead><tr><th>Date</th><th>Transaction</th><th>Status</th><th>Amount</th><th><span className="fin-muted">Review</span></th></tr></thead><tbody>{entries.map(entry => <tr key={entry.id} className={entry.status === 'void' ? 'fin-document-excluded' : ''}>
          <td>{entry.transaction_date || 'No date'}</td><td><strong>#{entry.id} · {entry.vendor || 'Unknown vendor'}</strong><small>{entry.description}</small><small>{title(entry.transaction_type)} · {entry.category || 'Uncategorized'}</small></td><td>{entry.status === 'void' ? 'Excluded' : entry.status === 'pending' ? 'Needs review' : title(entry.status)}</td><td>{money(entry.total, entry.currency || 'USD')}</td><td>{entry.status !== 'void' ? <Button size="small" onClick={() => onReview(entry)} aria-label={`Review transaction ${entry.id}`}>Review</Button> : 'History'}</td>
        </tr>)}</tbody></table></div> : data ? <p className="fin-muted">{showExcluded ? 'No transactions are tied to this file yet.' : 'No active transactions are tied to this file yet.'}</p> : null}
      </div>
      {data ? renderOriginal(data.document) : null}
    </div>
  </>;
}
