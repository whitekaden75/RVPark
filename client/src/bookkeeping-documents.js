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
  if (!['uploaded', 'queued', 'failed', 'rejected', 'needs_review', 'approved'].includes(document.processing_status) || document.metadata?.ai_queued) return 'Cancel any waiting AI job or wait for processing to finish before deleting this file.';
  if (Number(document.transaction_count) > 0) return 'Reset or exclude all active transactions before deleting this file.';
  if (document.has_bill_links) return 'Remove bill links before deleting this file and its excluded entries.';
  if (document.has_consolidation_links) return 'Undo consolidation/match links in Reconcile before deleting this file and its excluded entries.';
  return '';
}
