import test from 'node:test';
import assert from 'node:assert/strict';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { deleteBookkeepingDocument } from './bookkeeping-document-deletion.js';

function fixture(overrides = {}) {
  const state = { document: { id: '12', storage_key: 'bookkeeping/sample.pdf', processing_status: 'queued', metadata: {}, ...overrides }, transactions: [], lineItems: [], extractions: [], bills: [], matches: [] };
  const calls = [], sent = [];
  let released = 0, snapshot, storageError, dbError, failStage, missing = false;
  const result = rows => ({ rows: structuredClone(rows), rowCount: rows.length });
  const client = { release() { released++; }, async query(sql, params = []) {
    calls.push({ sql, params });
    if (sql === 'BEGIN') { snapshot = structuredClone(state); return result([]); }
    if (sql === 'ROLLBACK') { Object.assign(state, snapshot); return result([]); }
    if (dbError && sql.startsWith(failStage)) throw dbError;
    if (sql.startsWith('SELECT id,storage_key')) { assert.match(sql, /FOR UPDATE/); return result(missing || !state.document ? [] : [state.document]); }
    if (sql.startsWith('SELECT id,status FROM bookkeeping_transactions')) {
      assert.match(sql, /WHERE document_id=\$1 ORDER BY id FOR UPDATE/); assert.doesNotMatch(sql, /LIMIT|status\s*=/);
      return result(state.transactions.filter(row => row.document_id === params[0]));
    }
    if (sql.startsWith('SELECT id FROM bookkeeping_bills')) {
      assert.match(sql, /document_id=\$1 OR paid_transaction_id=ANY/); assert.doesNotMatch(sql, /status/);
      return result(state.bills.filter(row => row.document_id === params[0] || params[1].includes(row.paid_transaction_id)));
    }
    if (sql.startsWith('SELECT id FROM bookkeeping_consolidations')) {
      assert.match(sql, /duplicate_transaction_id=ANY/); assert.match(sql, /keeper_transaction_id=ANY/);
      return result(state.matches.filter(row => params[0].includes(row.duplicate_transaction_id) || params[0].includes(row.keeper_transaction_id)));
    }
    if (sql.startsWith('DELETE FROM bookkeeping_line_items')) {
      assert.match(sql, /WHERE transaction_id=ANY/);
      state.lineItems = state.lineItems.filter(row => !params[0].includes(row.transaction_id)); return result([]);
    }
    if (sql.startsWith('DELETE FROM bookkeeping_transactions')) {
      assert.match(sql, /WHERE document_id=\$1 AND status='void'/);
      const deleted = state.transactions.filter(row => row.document_id === params[0] && row.status === 'void');
      state.transactions = state.transactions.filter(row => !deleted.includes(row)); return result(deleted);
    }
    if (sql.startsWith('DELETE FROM bookkeeping_extractions')) {
      assert.match(sql, /WHERE document_id=\$1/);
      state.extractions = state.extractions.filter(row => row.document_id !== params[0]); return result([]);
    }
    if (sql.startsWith('DELETE FROM bookkeeping_documents')) {
      assert.deepEqual(params, ['12']);
      const row = state.document; state.document = null; return result(row ? [row] : []);
    }
    return result([]);
  } };
  const args = { pool: { connect: async () => client }, bucket: 'sample-bucket', documentId: '12', storage: { async send(command) {
    assert.ok(command instanceof DeleteObjectCommand); sent.push(command.input);
    calls.push({ sql: 'STORAGE DELETE' });
    assert.equal(state.document, null); // All database constraints are checked before removing storage.
    if (storageError) throw storageError;
  } } };
  return { state, calls, sent, get released() { return released; }, async remove(extra) { return deleteBookkeepingDocument({ ...args, ...extra }); }, failStorage() { storageError = new Error('Private provider credential details'); }, failDatabase(code, stage = 'DELETE FROM bookkeeping_documents') { dbError = Object.assign(new Error('Database write failed'), { code }); failStage = stage; }, setMissing() { missing = true; } };
}

function excludedImport(f) {
  f.state.transactions.push({ id: '1', document_id: '12', status: 'void' }, { id: '2', document_id: '12', status: 'void' });
  f.state.lineItems.push({ id: '10', transaction_id: '1' }, { id: '11', transaction_id: '2' });
  f.state.extractions.push({ id: '20', document_id: '12' });
  f.state.document.metadata.transaction_reset_history = [{ id: 'previous-reset' }];
}

test('unused and processed empty uploads can be deleted after locking and database checks', async () => {
  for (const status of ['uploaded', 'queued', 'failed', 'needs_review', 'approved']) {
    const f = fixture({ processing_status: status }); await f.remove();
    assert.equal(f.state.document, null); assert.equal(f.released, 1);
    assert.deepEqual(f.sent, [{ Bucket: 'sample-bucket', Key: 'bookkeeping/sample.pdf' }]);
    const documentLock = f.calls.findIndex(({ sql }) => sql.startsWith('SELECT id,storage_key'));
    const entryLock = f.calls.findIndex(({ sql }) => sql.startsWith('SELECT id,status'));
    const storage = f.calls.findIndex(({ sql }) => sql === 'STORAGE DELETE');
    assert.ok(documentLock < entryLock && entryLock < storage); assert.equal(f.calls.at(-1).sql, 'COMMIT');
    assert.equal(f.calls.some(({ sql }) => /DELETE FROM bookkeeping_(transactions|bills)/.test(sql)), false);
  }
});

test('a confirmed reset import deletes only its excluded entries, line items, AI results and original', async () => {
  const f = fixture(); excludedImport(f);
  const otherTransaction = { id: '3', document_id: '13', status: 'void' }, manual = { id: '4', document_id: null, status: 'approved' };
  f.state.transactions.push(otherTransaction, manual);
  const otherLine = { id: '12', transaction_id: '3' }, otherExtraction = { id: '21', document_id: '13' };
  f.state.lineItems.push(otherLine); f.state.extractions.push(otherExtraction);
  await f.remove({ confirmedExcludedCount: 2 });
  assert.equal(f.state.document, null);
  assert.deepEqual(f.state.transactions, [otherTransaction, manual]);
  assert.deepEqual(f.state.lineItems, [otherLine]); assert.deepEqual(f.state.extractions, [otherExtraction]);
  assert.equal(f.sent.length, 1); assert.equal(f.calls.at(-1).sql, 'COMMIT'); assert.equal(f.released, 1);
});

test('waiting AI jobs, processing and any active entries are protected before any deletion', async () => {
  for (const kind of ['queued', 'processing', 'pending', 'approved', 'mixed']) {
    const f = fixture();
    if (kind === 'queued') f.state.document.metadata.ai_queued = true;
    else if (kind === 'processing') f.state.document.processing_status = 'processing';
    else {
      f.state.transactions.push({ id: '1', document_id: '12', status: kind === 'mixed' ? 'pending' : kind });
      if (kind === 'mixed') f.state.transactions.push({ id: '2', document_id: '12', status: 'void' });
    }
    const before = structuredClone(f.state);
    await assert.rejects(f.remove(), error => error.statusCode === 409, kind);
    assert.deepEqual(f.state, before); assert.equal(f.sent.length, 0); assert.equal(f.released, 1);
    assert.equal(f.calls.some(({ sql }) => sql.startsWith('DELETE FROM')), false);
  }
});

test('changed excluded counts require fresh confirmation and old delete requests cannot purge history', async () => {
  for (const count of [undefined, 0, 1, 3, -1, '2', 2.5]) {
    const f = fixture(); excludedImport(f); const before = structuredClone(f.state);
    await assert.rejects(f.remove({ confirmedExcludedCount: count }), error => error.statusCode === 409 && /count changed/.test(error.message));
    assert.deepEqual(f.state, before); assert.equal(f.sent.length, 0);
  }
});

test('bill references and both sides of consolidation links block deletion even for excluded records', async () => {
  for (const dependency of ['document bill', 'paid bill', 'void bill', 'duplicate', 'keeper']) {
    const f = fixture(); excludedImport(f);
    if (dependency === 'document bill') f.state.bills.push({ id: '8', document_id: '12', status: 'unpaid' });
    if (dependency.endsWith('bill') && dependency !== 'document bill') f.state.bills.push({ id: '9', document_id: '13', paid_transaction_id: '1', status: dependency.split(' ')[0] });
    if (dependency === 'duplicate') f.state.matches.push({ duplicate_transaction_id: '1', keeper_transaction_id: '3' });
    if (dependency === 'keeper') f.state.matches.push({ duplicate_transaction_id: '3', keeper_transaction_id: '1' });
    const before = structuredClone(f.state);
    await assert.rejects(f.remove({ confirmedExcludedCount: 2 }), error => error.statusCode === 409, dependency);
    assert.deepEqual(f.state, before); assert.equal(f.sent.length, 0);
  }
});

test('storage failure restores the file, excluded entries, line items and old extraction results for retry', async () => {
  const f = fixture(); excludedImport(f); const before = structuredClone(f.state); f.failStorage();
  await assert.rejects(f.remove({ confirmedExcludedCount: 2 }), error => {
    assert.equal(error.statusCode, 502); assert.match(error.message, /remains in Documents/);
    assert.doesNotMatch(error.message, /Private provider/); return true;
  });
  assert.deepEqual(f.state, before); assert.equal(f.calls.at(-1).sql, 'ROLLBACK'); assert.equal(f.released, 1);
});

test('invalid IDs, missing files and storage setup errors do not delete data', async () => {
  const invalid = fixture(); await assert.rejects(invalid.remove({ documentId: '12 OR 1=1' }), error => error.statusCode === 400);
  assert.equal(invalid.calls.length, 0);
  const missing = fixture(); missing.setMissing(); await assert.rejects(missing.remove(), error => error.statusCode === 404);
  assert.equal(missing.sent.length, 0); assert.equal(missing.released, 1);
  const storage = fixture(); await assert.rejects(storage.remove({ storage: null }), error => error.statusCode === 503);
  assert.equal(storage.calls.length, 0);
});

test('constraint errors or competing updates roll back all database removals before touching storage', async () => {
  for (const code of ['55P03', '40P01', '23503', 'XX000']) {
    const f = fixture(); excludedImport(f); const before = structuredClone(f.state); f.failDatabase(code);
    await assert.rejects(f.remove({ confirmedExcludedCount: 2 }), error => code === 'XX000' ? error.code === code : error.statusCode === 409);
    assert.deepEqual(f.state, before); assert.equal(f.sent.length, 0);
    assert.equal(f.calls.at(-1).sql, 'ROLLBACK'); assert.equal(f.released, 1);
  }
});
