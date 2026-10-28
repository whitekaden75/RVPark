export const documentStatusOptions = [
  ['ready_for_ai', 'Ready for AI'], ['queued', 'Queued for AI'], ['processing', 'Processing'],
  ['needs_review', 'Needs review'], ['approved', 'Approved'], ['failed', 'Failed']
];

export function documentDisplayStatus(document) {
  if (['uploaded', 'queued'].includes(document.processing_status) && !document.metadata?.ai_queued) return 'ready_for_ai';
  return document.processing_status;
}

export function matchesDocumentStatus(document, filter) {
  return filter === 'all' || documentDisplayStatus(document) === filter;
}

export function documentDeleteBlocker(document) {
  if (!['uploaded', 'queued', 'failed'].includes(document.processing_status) || document.metadata?.ai_queued) return 'Cancel any waiting AI job first. Processing and processed files cannot be deleted.';
  if (document.has_transaction_history || Number(document.transaction_count) > 0 || document.has_extraction_history || document.has_bill_links || document.metadata?.transaction_reset_history?.length) return 'This file has bookkeeping history or linked bills. Keep its original for your records; use Reset entries to start over.';
  return '';
}
