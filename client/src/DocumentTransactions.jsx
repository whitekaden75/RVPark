import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Checkbox, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel } from '@mui/material';
import { documentExtractionMessage, documentTransactionSummary } from './document-transactions.js';

const title = value => String(value || '').replaceAll('_', ' ').replace(/^./, value => value.toUpperCase());
const money = (amount, currency = 'USD') => {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(amount || 0)); }
  catch { return `${currency} ${Number(amount || 0).toFixed(2)}`; }
};

export default function DocumentTransactions({ documentId, apiRequest, renderOriginal, onReview, onApproved, onBusyChange }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0), [showExcluded, setShowExcluded] = useState(false);
  const [typeFilter, setTypeFilter] = useState('all');
  const [approval, setApproval] = useState(null), [approving, setApproving] = useState(false);
  const [approvalError, setApprovalError] = useState(''), [notice, setNotice] = useState('');
  const approvalBusy = useRef(false);
  useEffect(() => {
    let current = true, inFlight = false;
    async function load() {
      if (inFlight || approvalBusy.current) return;
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
  const entries = (data?.transactions || []).filter(row => (showExcluded || row.status !== 'void') && (typeFilter === 'all' || (row.transaction_type || 'adjustment') === typeFilter));
  const pending = entries.filter(row => row.status === 'pending');
  const preview = data?.approvalPreviews?.[typeFilter];
  const canApprove = pending.length > 0 && preview?.count === pending.length && preview?.snapshot && !loading && !error && !approving && data?.document.processing_status !== 'processing' && !data?.document.metadata?.ai_queued;
  const processingMessage = data ? documentExtractionMessage(data.document, summary) : '';

  function reviewApproval() {
    if (!canApprove) return;
    setApprovalError(''); setNotice('');
    setApproval({ type: typeFilter, count: pending.length, snapshot: preview.snapshot,
      filename: data.document.original_filename, totals: documentTransactionSummary(pending).totals });
  }

  async function approve() {
    if (!approval || approvalBusy.current) return;
    const reviewed = approval;
    approvalBusy.current = true; setApproving(true); onBusyChange?.(true);
    try {
      const result = await apiRequest(`/bookkeeping/documents/${documentId}/approve-transactions`, {
        method: 'POST', body: JSON.stringify({ transactionType: reviewed.type, snapshot: reviewed.snapshot })
      });
      setApproval(null); setNotice(`Approved ${result.approvedCount} ${reviewed.type === 'all' ? 'pending' : reviewed.type} transactions.`);
      onApproved?.(result);
    } catch (err) { setApproval(null); setApprovalError(err.message); }
    finally {
      approvalBusy.current = false; setApproving(false); onBusyChange?.(false);
      setLoading(true); setRevision(value => value + 1);
    }
  }

  return <>
    <div className="fin-section-title"><div><h3>Transactions from this document</h3><p className="fin-document-filename">{data?.document.original_filename || `File #${documentId}`}</p></div><Button disabled={loading || approving} onClick={() => setRevision(value => value + 1)}>Refresh transactions</Button></div>
    {loading ? <p role="status"><CircularProgress size={16} sx={{ mr: 1, verticalAlign: 'middle' }}/>{data ? 'Refreshing transactions…' : 'Loading all transactions…'}</p> : null}
    {error ? <Alert severity="error" sx={{ my: 2 }}>{error}{data ? ' The last loaded results are shown below; refresh to check for changes.' : ''}</Alert> : null}
    {approvalError ? <Alert severity="error" sx={{ my: 2 }}>{approvalError}</Alert> : null}
    {notice ? <Alert severity="success" sx={{ my: 2 }}>{notice}</Alert> : null}
    {data ? <>
      <div className="fin-document-counts" aria-label="Document transaction counts">
        <span><strong>{summary.activeCount}</strong> active transactions</span><span><strong>{summary.pendingCount}</strong> need review</span><span><strong>{summary.approvedCount}</strong> approved</span><span><strong>{summary.excludedCount}</strong> excluded</span>
      </div>
      {processingMessage ? <Alert severity={data.document.processing_status === 'failed' ? 'warning' : 'info'} sx={{ my: 2 }}>{processingMessage}</Alert> : null}
      <p>All dates are included. Compare the list and totals with the original document to check for missing or repeated transactions.</p>
      <p>Select a total below to show only that transaction type.</p>
      <div className="fin-document-totals" role="group" aria-label="Filter document transactions by type">
        <button type="button" disabled={approving} aria-pressed={typeFilter === 'all'} onClick={() => setTypeFilter('all')}><span>All types</span><strong>{summary.activeCount} active entries</strong></button>
        {summary.totals.map(row => <button type="button" disabled={approving} key={`${row.currency}:${row.type}`} aria-label={`Show ${row.type} transactions (${row.currency} total)`} aria-pressed={typeFilter === row.type} onClick={() => setTypeFilter(row.type)}><span>{title(row.type)} · {row.currency} · {row.count} entries</span><strong>{money(row.amount, row.currency)}</strong></button>)}
      </div>
      <p className="fin-muted">Totals include approved entries and entries awaiting review. Excluded history is omitted. AI can miss transactions, so check against the original.</p>
    </> : null}
    <div className="fin-document-transactions-layout">
      <div className="fin-document-transactions-list">
        {summary.excludedCount ? <FormControlLabel className="fin-document-history" control={<Checkbox checked={showExcluded} disabled={approving} onChange={event => setShowExcluded(event.target.checked)}/>} label={`Show excluded history (${summary.excludedCount})`}/> : null}
        {data ? <p className="fin-document-filter-count" role="status">Showing {entries.length} {typeFilter === 'all' ? 'transactions' : `${typeFilter} transactions`}{showExcluded ? ', including excluded history' : ', active only'}.</p> : null}
        {data ? <div className="fin-document-approval"><Button variant="contained" disabled={!canApprove} onClick={reviewApproval}>Approve all pending ({pending.length})</Button><span>{typeFilter === 'all' ? 'All types in this document' : `${title(typeFilter)} only in this document`}</span></div> : null}
        {entries.length ? <div className="fin-document-table" role="region" tabIndex={0} aria-label="Transactions tied to this document"><table><thead><tr><th>Date</th><th>Transaction</th><th>Status</th><th>Amount</th><th><span className="fin-muted">Review</span></th></tr></thead><tbody>{entries.map(entry => <tr key={entry.id} className={entry.status === 'void' ? 'fin-document-excluded' : ''}>
          <td>{entry.transaction_date || 'No date'}</td><td><strong>#{entry.id} · {entry.vendor || 'Unknown vendor'}</strong><small>{entry.description}</small><small>{title(entry.transaction_type)} · {entry.category || 'Uncategorized'}</small></td><td>{entry.status === 'void' ? 'Excluded' : entry.status === 'pending' ? 'Needs review' : title(entry.status)}</td><td>{money(entry.total, entry.currency || 'USD')}</td><td>{entry.status !== 'void' ? <Button size="small" disabled={approving} onClick={() => onReview(entry)} aria-label={`Review transaction ${entry.id}`}>Review</Button> : 'History'}</td>
        </tr>)}</tbody></table></div> : data ? <p className="fin-muted">{typeFilter !== 'all' ? `No ${typeFilter} transactions match this view. Select All types to see the full list.` : showExcluded ? 'No transactions are tied to this file yet.' : 'No active transactions are tied to this file yet.'}</p> : null}
      </div>
      {data ? renderOriginal(data.document) : null}
    </div>
    <Dialog open={Boolean(approval)} onClose={() => { if (!approvalBusy.current) setApproval(null); }} fullWidth maxWidth="sm" aria-labelledby="document-approve-title">
      <DialogTitle id="document-approve-title">Approve {approval?.count} {approval?.type === 'all' ? '' : approval?.type} transactions?</DialogTitle>
      <DialogContent className="fin-modal-content finance-dialog"><p className="fin-document-filename"><strong>{approval?.filename}</strong></p><p>Only the pending entries in this confirmation will be marked approved in your books.</p>{approval?.totals.map(row => <p key={`${row.currency}:${row.type}`}>{title(row.type)} · {row.currency} · {row.count} entries · <strong>{money(row.amount, row.currency)}</strong></p>)}</DialogContent>
      <DialogActions><Button disabled={approving} onClick={() => setApproval(null)}>Cancel</Button><Button variant="contained" disabled={approving} onClick={approve} startIcon={approving ? <CircularProgress size={16} color="inherit"/> : undefined}>{approving ? 'Approving…' : `Approve ${approval?.count || ''} transactions`}</Button></DialogActions>
    </Dialog>
  </>;
}
