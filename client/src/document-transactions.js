export function documentTransactionSummary(transactions) {
  const active = transactions.filter(row => row.status !== 'void');
  const totals = new Map();
  for (const row of active) {
    const currency = (row.currency || 'USD').toUpperCase(), type = row.transaction_type || 'adjustment';
    const key = `${currency}:${type}`;
    const total = totals.get(key) || { currency, type, count: 0, cents: 0 };
    total.count++;
    total.cents += Math.round(Number(row.total || 0) * 100);
    totals.set(key, total);
  }
  return {
    activeCount: active.length,
    pendingCount: active.filter(row => row.status === 'pending').length,
    approvedCount: active.filter(row => row.status === 'approved').length,
    excludedCount: transactions.length - active.length,
    totals: [...totals.values()].map(({ cents, ...row }) => ({ ...row, amount: cents / 100 }))
  };
}

export function documentExtractionMessage(document, summary) {
  if (document.processing_status === 'processing') return 'AI is reading this file. This list updates automatically when processing finishes.';
  if (document.metadata?.ai_queued) return 'This file is waiting in the AI queue. This list updates automatically when processing finishes.';
  if (document.processing_status === 'failed') return `Processing failed: ${document.error_message || 'Return to Documents to retry this file.'}`;
  if (summary.activeCount) return '';
  if (['uploaded', 'queued'].includes(document.processing_status)) return 'Use Queue AI in Documents to extract a fresh set of transactions from this file.';
  if (summary.excludedCount) return 'This file has no active transactions. Turn on excluded history to see its previous entries.';
  return 'Processing saved no transactions for this file. Check the original document before deciding whether to reset and retry it.';
}
