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

test('files with only excluded entries and extraction/reset history can be deleted', () => {
  const ready = { processing_status: 'queued', metadata: {}, transaction_count: 0 };
  for (const status of ['uploaded', 'queued', 'failed', 'needs_review', 'approved']) {
    assert.equal(documentDeleteBlocker({ ...ready, processing_status: status }), '');
    assert.equal(documentDeleteBlocker({ ...ready, processing_status: status, has_transaction_history: true, excluded_transaction_count: 5, has_extraction_history: true, metadata: { transaction_reset_history: [{ id: 'reset' }] } }), '');
  }
});

test('active entries, bill links, matches and AI jobs must be resolved before deletion', () => {
  const ready = { processing_status: 'queued', metadata: {}, transaction_count: 0 };
  assert.match(documentDeleteBlocker({ ...ready, transaction_count: '2' }), /active transactions/);
  assert.match(documentDeleteBlocker({ ...ready, has_bill_links: true }), /bill links/);
  assert.match(documentDeleteBlocker({ ...ready, has_consolidation_links: true }), /consolidation/);
  for (const state of [{ processing_status: 'queued', metadata: { ai_queued: true } }, { processing_status: 'processing' }]) assert.ok(documentDeleteBlocker(state));
});
