import test from 'node:test';
import assert from 'node:assert/strict';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { deleteUnprocessedDocument } from './bookkeeping-document-deletion.js';

function fixture(overrides = {}) {
  const state = { document: { id: '12', storage_key: 'bookkeeping/sample.pdf', processing_status: 'queued', metadata: {}, ...overrides }, transactions: [], extractions: [], bills: [] };
  const calls = [], sent = [];
  let released = 0, snapshot, storageError, dbError, missing = false;
  const result = rows => ({ rows, rowCount: rows.length });
  const client = { release() { released++; }, async query(sql, params) {
    calls.push({ sql, params });
    if (sql === 'BEGIN') { snapshot = structuredClone(state); return result([]); }
    if (sql === 'ROLLBACK') { Object.assign(state, snapshot); return result([]); }
    if (sql.includes('FOR UPDATE')) return result(missing || !state.document ? [] : [state.document]);
    if (sql.startsWith('SELECT id FROM bookkeeping_transactions')) {
      assert.doesNotMatch(sql, /status|void/); return result(state.transactions);
    }
    if (sql.startsWith('SELECT id FROM bookkeeping_extractions')) return result(state.extractions);
    if (sql.startsWith('SELECT id FROM bookkeeping_bills')) { assert.doesNotMatch(sql, /status/); return result(state.bills); }
    if (sql.startsWith('DELETE FROM bookkeeping_documents')) {
      assert.deepEqual(params, ['12']); assert.equal(sent.length, 1);
      if (dbError) throw dbError;
      const row = state.document; state.document = null; return result([row]);
    }
    return result([]);
  } };
  const args = { pool: { connect: async () => client }, bucket: 'sample-bucket', documentId: '12', storage: { async send(command) {
    assert.ok(command instanceof DeleteObjectCommand); sent.push(command.input);
    calls.push({ sql: 'STORAGE DELETE' });
    if (storageError) throw storageError;
  } } };
  return { state, calls, sent, get released() { return released; }, args, async remove(extra) { return deleteUnprocessedDocument({ ...args, ...extra }); }, failStorage() { storageError = new Error('Private provider credential details'); }, failDatabase(code) { dbError = Object.assign(new Error('Database write failed'), { code }); }, setMissing() { missing = true; } };
}

test('deleting one unused ready upload locks it, removes its storage object, commits and releases', async () => {
  for (const status of ['uploaded', 'queued', 'failed']) {
    const f = fixture({ processing_status: status }); await f.remove();
    assert.equal(f.state.document, null); assert.equal(f.released, 1);
    assert.deepEqual(f.sent, [{ Bucket: 'sample-bucket', Key: 'bookkeeping/sample.pdf' }]);
    const lock = f.calls.findIndex(({ sql }) => sql.includes('FOR UPDATE'));
    const firstReference = f.calls.findIndex(({ sql }) => sql.includes('FROM bookkeeping_transactions'));
    const storage = f.calls.findIndex(({ sql }) => sql === 'STORAGE DELETE');
    assert.ok(lock < firstReference && firstReference < storage);
    assert.equal(f.calls.at(-1).sql, 'COMMIT');
    assert.equal(f.calls.some(({ sql }) => /DELETE FROM bookkeeping_(transactions|bills|extractions)/.test(sql)), false);
  }
});

test('waiting AI jobs and claimed/processed files are rejected before deleting anything', async () => {
  for (const document of [
    { metadata: { ai_queued: true } }, { processing_status: 'processing' },
    { processing_status: 'needs_review' }, { processing_status: 'approved' }
  ]) {
    const f = fixture(document);
    await assert.rejects(f.remove(), error => error.statusCode === 409);
    assert.ok(f.state.document); assert.equal(f.sent.length, 0); assert.equal(f.released, 1);
    assert.equal(f.calls.at(-1).sql, 'ROLLBACK');
  }
});

test('all transaction history, empty extractions, reset audits and bills protect original files', async () => {
  for (const dependency of ['approved', 'pending', 'void', 'extraction', 'paid bill', 'void bill', 'reset']) {
    const f = fixture();
    if (['approved', 'pending', 'void'].includes(dependency)) f.state.transactions.push({ id: 8, status: dependency });
    if (dependency === 'extraction') f.state.extractions.push({ id: 9, extracted_json: { transactions: [] } });
    if (dependency.endsWith('bill')) f.state.bills.push({ id: 10, status: dependency.split(' ')[0] });
    if (dependency === 'reset') f.state.document.metadata.transaction_reset_history = [{ id: 'previous-reset' }];
    await assert.rejects(f.remove(), error => error.statusCode === 409, dependency);
    assert.ok(f.state.document); assert.equal(f.sent.length, 0); assert.equal(f.released, 1);
  }
});

test('storage failures leave a retryable library entry and return no provider secrets', async () => {
  const f = fixture(); f.failStorage();
  await assert.rejects(f.remove(), error => {
    assert.equal(error.statusCode, 502); assert.match(error.message, /remains in Documents/);
    assert.doesNotMatch(error.message, /Private provider/); return true;
  });
  assert.ok(f.state.document); assert.equal(f.calls.some(({ sql }) => sql.startsWith('DELETE FROM')), false);
  assert.equal(f.calls.at(-1).sql, 'ROLLBACK'); assert.equal(f.released, 1);
});

test('invalid IDs, missing files and storage setup errors do not delete data', async () => {
  const invalid = fixture(); await assert.rejects(invalid.remove({ documentId: '12 OR 1=1' }), error => error.statusCode === 400);
  assert.equal(invalid.calls.length, 0);
  const missing = fixture(); missing.setMissing(); await assert.rejects(missing.remove(), error => error.statusCode === 404);
  assert.equal(missing.sent.length, 0); assert.equal(missing.released, 1);
  const storage = fixture(); await assert.rejects(storage.remove({ storage: null }), error => error.statusCode === 503);
  assert.equal(storage.calls.length, 0);
});

test('database errors roll back, release the lock, and explain linked records or competing updates', async () => {
  for (const code of ['55P03', '40P01', '23503', 'XX000']) {
    const f = fixture(); f.failDatabase(code);
    await assert.rejects(f.remove(), error => code === 'XX000' ? error.code === code : error.statusCode === 409);
    assert.ok(f.state.document); assert.equal(f.calls.at(-1).sql, 'ROLLBACK'); assert.equal(f.released, 1);
  }
});
