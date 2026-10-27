import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesTransactionSource, transactionSourceLabel } from './bookkeeping-sources.js';

test('source filtering separates otherwise identical receipts, invoices, and statement purchases', () => {
  const base = { source: 'document', vendor: 'Same merchant', amount: 40, status: 'pending' };
  const entries = [
    { ...base, id: 1, documentId: 101, documentType: 'receipt' },
    { ...base, id: 2, documentId: 102, documentType: 'invoice' },
    { ...base, id: 3, documentId: 1, documentType: 'bank_statement', status: 'approved' },
    { ...base, id: 4, documentId: 2, documentType: 'credit_card_statement' },
    { ...base, id: 5, documentId: null },
    { ...base, id: 6, documentId: 3, documentType: null },
    { ...base, id: 7, source: 'stripe' },
    { ...base, id: 8, source: 'office' },
  ];
  const ids = filter => entries.filter(row => matchesTransactionSource(row, filter)).map(row => row.id);
  assert.deepEqual(ids('bank_statement'), [3]);
  assert.deepEqual(ids('credit_card_statement'), [4]);
  assert.deepEqual(ids('statements'), [3, 4]);
  assert.deepEqual(ids('receipt'), [1]);
  assert.deepEqual(ids('invoice'), [2]);
  assert.deepEqual(ids('manual'), [5]);
  assert.deepEqual(ids('other'), [6]);
  assert.deepEqual(ids('document'), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(ids('all'), entries.map(row => row.id));
  assert.equal(transactionSourceLabel(entries[2]), 'Bank statement');
  assert.equal(transactionSourceLabel(entries[5]), 'Other document');
});
