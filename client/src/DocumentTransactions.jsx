import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Checkbox, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel } from '@mui/material';
import { documentExtractionMessage, documentTransactionSummary } from './document-transactions.js';

const title = value => String(value || '').replaceAll('_', ' ').replace(/^./, value => value.toUpperCase());
const money = (amount, currency = 'USD') => {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(amount || 0)); }
  catch { return `${currency} ${Number(amount || 0).toFixed(2)}`; }
};

export default function DocumentTransactions({ documentId, apiRequest, renderOriginal, renderEditor, renderCreator, onEdited, onApproved, onBusyChange, busy = false }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0), [showExcluded, setShowExcluded] = useState(false);
  const [typeFilter, setTypeFilter] = useState('all');
  const [approval, setApproval] = useState(null), [approving, setApproving] = useState(false);
  const [approvalError, setApprovalError] = useState(''), [notice, setNotice] = useState('');
  const [expandedId, setExpandedId] = useState(null), [adding, setAdding] = useState(false);
  const approvalBusy = useRef(false);
  const expandedRef = useRef(null), reviewButtons = useRef(new Map()); expandedRef.current = adding ? 'new' : expandedId;
  const tableRef = useRef(null), returnFocus = useRef(null), scrollParents = useRef([]);
  const saving = approving || busy;
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
    const update = () => { if (document.visibilityState !== 'hidden' && expandedRef.current == null) load(); };
    const timer = setInterval(update, 15000);
    window.addEventListener('rvpark-bookkeeping-changed', update);
    window.addEventListener('focus', update);
    return () => { current = false; clearInterval(timer); window.removeEventListener('rvpark-bookkeeping-changed', update); window.removeEventListener('focus', update); };
  }, [apiRequest, documentId, revision]);

  const summary = useMemo(() => documentTransactionSummary(data?.transactions || []), [data]);
  const entries = (data?.transactions || []).filter(row => (showExcluded || row.status !== 'void') && (typeFilter === 'all' || (row.transaction_type || 'adjustment') === typeFilter));
  const pending = entries.filter(row => row.status === 'pending');
  const preview = data?.approvalPreviews?.[typeFilter];
  const canApprove = pending.length > 0 && preview?.count === pending.length && preview?.snapshot && !loading && !error && !saving && !adding && expandedId == null && data?.document.processing_status !== 'processing' && !data?.document.metadata?.ai_queued;
  const canAdd = renderCreator && data && ['bank_statement','credit_card_statement'].includes(data.document.document_type) && ['needs_review','approved'].includes(data.document.processing_status) && !data.document.metadata?.ai_queued && !loading && !error && !saving && expandedId == null && !adding;
  const accounts = [...new Set((data?.transactions || []).filter(row => row.status !== 'void').map(row => row.payment_account?.trim()).filter(Boolean))];
  const processingMessage = data ? documentExtractionMessage(data.document, summary) : '';

  function closeEditor() {
    if (saving) return;
    setExpandedId(null);
  }

  function openEditor(id) {
    returnFocus.current = id; scrollParents.current = [];
    for (let element = tableRef.current; element; element = element.parentElement) {
      if (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth) scrollParents.current.push({ element, top: element.scrollTop, left: element.scrollLeft });
    }
    setExpandedId(id);
  }

  useLayoutEffect(() => {
    if (expandedId == null && returnFocus.current != null) {
      for (const { element, top, left } of scrollParents.current) if (element.isConnected) { element.scrollTop = top; element.scrollLeft = left; }
      reviewButtons.current.get(returnFocus.current)?.focus({ preventScroll: true });
      returnFocus.current = null;
    }
  }, [expandedId]);

  function edited(transaction) {
    if (transaction) setData(current => ({ ...current, transactions: current.transactions.map(row => String(row.id) === String(transaction.id) ? transaction : row) }));
    setNotice(transaction?.status === 'approved' ? 'Transaction saved and approved.' : 'Transaction changes saved.');
    setLoading(true); setRevision(value => value + 1); onEdited?.(transaction);
  }

  useEffect(() => {
    if (expandedId != null && data && !entries.some(row => String(row.id) === expandedId && row.status !== 'void')) setExpandedId(null);
  }, [data, expandedId, typeFilter, showExcluded]);

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
    <div className="fin-section-title"><div><h3>Transactions from this document</h3><p className="fin-document-filename">{data?.document.original_filename || `File #${documentId}`}</p></div><div className="fin-actions">{renderCreator && data && ['bank_statement','credit_card_statement'].includes(data.document.document_type) ? <Button type="button" variant="outlined" disabled={!canAdd} onClick={() => {setNotice('');setAdding(true);}}>Add transaction</Button> : null}<Button type="button" disabled={loading || saving || expandedId != null || adding} onClick={() => setRevision(value => value + 1)}>Refresh transactions</Button></div></div>
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
        <button type="button" disabled={saving || expandedId != null || adding} aria-pressed={typeFilter === 'all'} onClick={() => setTypeFilter('all')}><span>All types</span><strong>{summary.activeCount} active entries</strong></button>
        {summary.totals.map(row => <button type="button" disabled={saving || expandedId != null || adding} key={`${row.currency}:${row.type}`} aria-label={`Show ${row.type} transactions (${row.currency} total)`} aria-pressed={typeFilter === row.type} onClick={() => setTypeFilter(row.type)}><span>{title(row.type)} · {row.currency} · {row.count} entries</span><strong>{money(row.amount, row.currency)}</strong></button>)}
      </div>
      <p className="fin-muted">Totals include approved entries and entries awaiting review. Excluded history is omitted. AI can miss transactions, so check against the original.</p>
    </> : null}
    <div className="fin-document-transactions-layout">
      <div className="fin-document-transactions-list">
        {adding && data ? renderCreator(data.document,typeFilter,accounts.length === 1 ? accounts[0] : '',{onSaved: transaction => {setData(current => ({...current,transactions:[...current.transactions.filter(row => String(row.id) !== String(transaction.id)),transaction]}));setTypeFilter(transaction.transaction_type);setNotice('Transaction added to this statement. Review and approve it when ready.');setLoading(true);setRevision(value => value + 1);onEdited?.(transaction);},onClose: () => setAdding(false)}) : null}
        {summary.excludedCount ? <FormControlLabel className="fin-document-history" control={<Checkbox checked={showExcluded} disabled={saving || expandedId != null || adding} onChange={event => setShowExcluded(event.target.checked)}/>} label={`Show excluded history (${summary.excludedCount})`}/> : null}
        {data ? <p className="fin-document-filter-count" role="status">Showing {entries.length} {typeFilter === 'all' ? 'transactions' : `${typeFilter} transactions`}{showExcluded ? ', including excluded history' : ', active only'}.</p> : null}
        {data ? <div className="fin-document-approval"><Button variant="contained" disabled={!canApprove} onClick={reviewApproval}>Approve all pending ({pending.length})</Button><span>{expandedId != null || adding ? 'Save or close the editor to change filters or approve a group.' : typeFilter === 'all' ? 'All types in this document' : `${title(typeFilter)} only in this document`}</span></div> : null}
        {entries.length ? <div ref={tableRef} className="fin-document-table" role="region" tabIndex={0} aria-label="Transactions tied to this document"><table><thead><tr><th>Date</th><th>Transaction</th><th>Status</th><th>Amount</th><th><span className="fin-muted">Review</span></th></tr></thead><tbody>{entries.map(entry => <Fragment key={entry.id}><tr className={entry.status === 'void' ? 'fin-document-excluded' : ''}>
          <td>{entry.transaction_date || 'No date'}</td><td><strong>#{entry.id} · {entry.vendor || 'Unknown vendor'}</strong><small>{entry.description}</small><small>{title(entry.transaction_type)} · {entry.category || 'Uncategorized'}</small>{entry.payment_account ? <small>{entry.payment_account}</small> : null}</td><td>{entry.status === 'void' ? 'Excluded' : entry.status === 'pending' ? 'Needs review' : title(entry.status)}</td><td>{money(entry.total, entry.currency || 'USD')}</td><td>{entry.status !== 'void' ? <Button size="small" ref={button => { if (button) reviewButtons.current.set(String(entry.id), button); else reviewButtons.current.delete(String(entry.id)); }} disabled={saving || adding || (expandedId != null && expandedId !== String(entry.id))} onClick={() => { if (expandedId === String(entry.id)) closeEditor(); else openEditor(String(entry.id)); }} aria-expanded={expandedId === String(entry.id)} aria-controls={`document-editor-${entry.id}`} aria-label={expandedId === String(entry.id) ? `Close transaction ${entry.id}` : `Review transaction ${entry.id}`}>{expandedId === String(entry.id) ? 'Close' : 'Review'}</Button> : 'History'}</td>
        </tr>{expandedId === String(entry.id) && entry.status !== 'void' ? <tr><td colSpan={5} className="fin-document-editor-cell"><div id={`document-editor-${entry.id}`} role="region" aria-label={`Edit transaction ${entry.id}`}>{renderEditor(entry, { onSaved: edited, onClose: closeEditor })}</div></td></tr> : null}</Fragment>)}</tbody></table></div> : data ? <p className="fin-muted">{typeFilter !== 'all' ? `No ${typeFilter} transactions match this view. Select All types to see the full list.` : showExcluded ? 'No transactions are tied to this file yet.' : 'No active transactions are tied to this file yet.'}</p> : null}
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
