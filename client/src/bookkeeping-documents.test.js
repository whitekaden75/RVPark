import test from 'node:test';
import assert from 'node:assert/strict';
import { documentDisplayStatus, matchesDocumentStatus, documentDeleteBlocker } from './bookkeeping-documents.js';

test('Ready for AI matches the badge and excludes waiting, processing, failed and processed files', () => {
  const documents = [
    { id: 1, processing_status: 'queued', metadata: {} },
    { id: 2, processing_status: 'queued', metadata: { ai_queued: false } },
    { id: 3, processing_status: 'uploaded', metadata: null },
    { id: 4, processing_status: 'queued', metadata: { ai_queued: true } },
    { id: 5, processing_status: 'processing', metadata: {} },
    { id: 6, processing_status: 'failed', metadata: {} },
    { id: 7, processing_status: 'needs_review' },
    { id: 8, processing_status: 'approved' }
  ];
  assert.deepEqual(documents.filter(doc => matchesDocumentStatus(doc, 'ready_for_ai')).map(doc => doc.id), [1, 2, 3]);
  assert.deepEqual(documents.filter(doc => matchesDocumentStatus(doc, 'queued')).map(doc => doc.id), [4]);
  assert.equal(documents.filter(doc => matchesDocumentStatus(doc, 'all')).length, 8);
  assert.equal(documentDisplayStatus(documents[2]), 'ready_for_ai');
  assert.deepEqual(documents.filter(doc => matchesDocumentStatus(doc, 'failed')).map(doc => doc.id), [6]);
});

test('unused ready and failed uploads can be deleted while financial history and AI jobs are protected', () => {
  const ready = { processing_status: 'queued', metadata: {}, transaction_count: 0 };
  assert.equal(documentDeleteBlocker(ready), '');
  assert.equal(documentDeleteBlocker({ ...ready, processing_status: 'failed' }), '');
  for (const history of [
    { has_transaction_history: true }, { transaction_count: '2' }, { has_extraction_history: true },
    { has_bill_links: true }, { metadata: { transaction_reset_history: [{ id: 'reset' }] } }
  ]) assert.match(documentDeleteBlocker({ ...ready, ...history }), /bookkeeping history/);
  for (const state of [
    { processing_status: 'queued', metadata: { ai_queued: true } }, { processing_status: 'processing' },
    { processing_status: 'needs_review' }, { processing_status: 'approved' }
  ]) assert.ok(documentDeleteBlocker(state));
});
