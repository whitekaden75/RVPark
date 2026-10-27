export const transactionSourceOptions = [
  ['all', 'All sources'],
  ['stripe', 'Stripe'],
  ['office', 'Office payments'],
  ['document', 'All documents & manual'],
  ['receipt', 'Receipts'],
  ['invoice', 'Invoices'],
  ['statements', 'Bank & credit-card statements'],
  ['bank_statement', 'Bank statements'],
  ['credit_card_statement', 'Credit-card statements'],
  ['tax_document', 'Tax documents'],
  ['other', 'Other documents'],
  ['manual', 'Manual entries'],
];

const sourceLabels = {
  stripe: 'Stripe', office: 'Office payment', receipt: 'Receipt', invoice: 'Invoice',
  bank_statement: 'Bank statement', credit_card_statement: 'Credit-card statement',
  tax_document: 'Tax document', other: 'Other document', manual: 'Manual entry',
};

export function transactionSource(entry) {
  if (entry.source !== 'document') return entry.source;
  if (entry.documentId == null) return 'manual';
  return Object.hasOwn(sourceLabels, entry.documentType) &&
    !['stripe', 'office', 'manual'].includes(entry.documentType) ? entry.documentType : 'other';
}

export function transactionSourceLabel(entry) {
  return sourceLabels[transactionSource(entry)] || 'Other source';
}

export function matchesTransactionSource(entry, filter) {
  if (filter === 'all') return true;
  if (filter === 'document') return entry.source === 'document';
  const source = transactionSource(entry);
  if (filter === 'statements') return ['bank_statement', 'credit_card_statement'].includes(source);
  return source === filter;
}
