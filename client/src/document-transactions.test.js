import test from 'node:test';
import assert from 'node:assert/strict';
import { documentExtractionMessage, documentTransactionSummary } from './document-transactions.js';

test('file totals separate currencies and transaction types and exclude reset history', () => {
  const result = documentTransactionSummary([
    { status: 'pending', total: '10.01', currency: 'USD', transaction_type: 'expense' },
    { status: 'approved', total: '20.02', currency: 'usd', transaction_type: 'expense' },
    { status: 'approved', total: '40.01', currency: 'USD', transaction_type: 'income' },
    { status: 'pending', total: '50.02', currency: 'CAD', transaction_type: 'expense' },
    { status: 'approved', total: '-5.03', currency: 'CAD', transaction_type: 'expense' },
    { status: 'pending', total: '900.99', currency: 'USD', transaction_type: 'transfer' },
    { status: 'void', total: '1000', currency: 'USD', transaction_type: 'expense' }
  ]);
  assert.equal(result.activeCount, 6); assert.equal(result.pendingCount, 3); assert.equal(result.approvedCount, 3); assert.equal(result.excludedCount, 1);
  assert.deepEqual(result.totals, [
    { currency: 'USD', type: 'expense', count: 2, amount: 30.03 },
    { currency: 'USD', type: 'income', count: 1, amount: 40.01 },
    { currency: 'CAD', type: 'expense', count: 2, amount: 44.99 },
    { currency: 'USD', type: 'transfer', count: 1, amount: 900.99 }
  ]);
});

test('counts include files larger than the main ledger cap and preserve zero amounts', () => {
  const result = documentTransactionSummary(Array.from({ length: 650 }, (_, id) => ({ id, status: id % 2 ? 'pending' : 'approved', total: id ? '1.01' : '0', transaction_type: 'expense' })));
  assert.equal(result.activeCount, 650); assert.equal(result.pendingCount, 325); assert.equal(result.approvedCount, 325);
  assert.equal(result.totals[0].count, 650); assert.equal(result.totals[0].amount, 655.49);
});

test('queued, processing, failed, empty and reset files give useful guidance without claiming completeness', () => {
  const empty = documentTransactionSummary([]), history = documentTransactionSummary([{ status: 'void', total: '100' }]);
  assert.match(documentExtractionMessage({ processing_status: 'queued', metadata: {} }, empty), /Use Queue AI/);
  assert.match(documentExtractionMessage({ processing_status: 'queued', metadata: { ai_queued: true } }, empty), /waiting in the AI queue/);
  assert.match(documentExtractionMessage({ processing_status: 'processing' }, empty), /AI is reading/);
  assert.match(documentExtractionMessage({ processing_status: 'failed', error_message: 'Download failed' }, empty), /Download failed/);
  assert.match(documentExtractionMessage({ processing_status: 'needs_review' }, empty), /saved no transactions/);
  assert.match(documentExtractionMessage({ processing_status: 'approved' }, history), /excluded history/);
  assert.match(documentExtractionMessage({ processing_status: 'queued' }, history), /fresh set/);
  assert.equal(documentExtractionMessage({ processing_status: 'needs_review' }, { activeCount: 2 }), '');
  assert.deepEqual(empty, { activeCount: 0, pendingCount: 0, approvedCount: 0, excludedCount: 0, totals: [] });
});
