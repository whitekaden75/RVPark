import test from 'node:test';
import assert from 'node:assert/strict';
import { documentResetPreview, registerDocumentEntryResetRoutes } from './bookkeeping-document-reset.js';

function fixture() {
  const state = {
    documents: [{ id: '12', original_filename: 'bank-statement.pdf', document_type: 'bank_statement', processing_status: 'needs_review', processed_at: '2026-10-01', metadata: { note: 'Business account' } }],
    transactions: [
      { id: '1', document_id: '12', transaction_date: '2024-01-01', vendor: 'Old purchase', total: '10.01', currency: 'USD', transaction_type: 'expense', status: 'approved' },
      { id: '2', document_id: '12', transaction_date: '2026-10-01', vendor: 'New purchase', total: '20.02', currency: 'USD', transaction_type: 'expense', status: 'pending' },
      { id: '3', document_id: '12', transaction_date: '2026-10-02', vendor: 'Foreign purchase', total: '30.03', currency: 'CAD', transaction_type: 'expense', status: 'pending' },
      { id: '4', document_id: '12', total: '99.99', status: 'void' },
      { id: '5', document_id: '13', total: '45', status: 'approved' },
      { id: '6', document_id: null, total: '55', status: 'approved' }
    ], matches: [], bills: []
  };
  const queries = [], events = [];
  let backup, advisory = true, failUpdate = false, released = 0;
  const result = rows => ({ rows: structuredClone(rows), rowCount: rows.length });
  const client = { release() { released++; }, async query(sql, params = []) {
    queries.push({ sql, params });
    if (sql.startsWith('BEGIN')) { backup = structuredClone(state); return result([]); }
    if (sql === 'ROLLBACK') { if (backup) Object.assign(state, backup); return result([]); }
    if (sql === 'COMMIT' || sql.startsWith('SET LOCAL') || sql.startsWith('LOCK TABLE')) return result([]);
    if (sql.includes('pg_try_advisory_xact_lock')) return result([{ locked: advisory }]);
    if (sql.includes('count(t.id)')) return result(state.documents.map(doc => ({ ...doc, entry_count: state.transactions.filter(row => row.document_id === doc.id && row.status !== 'void').length })).filter(doc => doc.entry_count));
    if (sql.startsWith('SELECT id,original_filename')) return result(state.documents.filter(doc => doc.id === String(params[0])));
    if (sql.startsWith('SELECT t.*,t.transaction_date::text')) {
      assert.match(sql, /WHERE t.document_id=\$1 ORDER BY t.id/);
      assert.doesNotMatch(sql, /LIMIT|transaction_date\s*[<>]=/);
      return result(state.transactions.filter(row => row.document_id === String(params[0])));
    }
    if (sql.includes('FROM bookkeeping_consolidations')) return result(state.matches.filter(row => params[0].includes(row.duplicate_transaction_id) || params[0].includes(row.keeper_transaction_id)));
    if (sql.includes('FROM bookkeeping_bills')) return result(state.bills.filter(row => row.status === 'paid' && params[0].includes(row.paid_transaction_id)));
    if (sql.startsWith('UPDATE bookkeeping_transactions')) {
      assert.match(sql, /WHERE document_id=\$1 AND status<>'void'/);
      const affected = state.transactions.filter(row => row.document_id === String(params[0]) && row.status !== 'void');
      affected.forEach(row => { row.status = 'void'; }); return result(affected);
    }
    if (sql.startsWith('UPDATE bookkeeping_documents')) {
      if (failUpdate) throw new Error('Database write failed');
      assert.match(sql, /processing_status='queued',processed_at=NULL,error_message=NULL/);
      assert.match(sql, /'ai_queued',false/);
      const doc = state.documents.find(row => row.id === String(params[0]));
      doc.processing_status = 'queued'; doc.processed_at = null; doc.error_message = null;
      doc.metadata.ai_queued = false;
      doc.metadata.transaction_reset_history = [...(doc.metadata.transaction_reset_history || []), ...JSON.parse(params[1])];
      return result([doc]);
    }
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const pool = { query: client.query, connect: async () => client };
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'patch', 'delete'].map(method => [method, (path, ...handlers) => routes.set(`${method} ${path}`, handlers.at(-1))]));
  registerDocumentEntryResetRoutes(app, { pool, notify: event => events.push(event) });
  return { state, client, queries, events, setBusy() { advisory = false; }, failWrite() { failUpdate = true; }, get released() { return released; }, async request(method, path, body, id = '12') {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
    await routes.get(`${method} ${path}`)({ params: { id }, body, adminUser: { id: 7 } }, res);
    return res;
  } };
}
const previewPath = '/api/bookkeeping/documents/:id/reset-preview';
const resetPath = '/api/bookkeeping/documents/:id/reset-entries';
const confirmation = preview => ({ snapshot: preview.snapshot, confirmDocumentId: preview.document.id });

test('preview includes every date and active status, with separate currency/type totals', async () => {
  const f = fixture();
  const res = await f.request('get', previewPath);
  assert.equal(res.statusCode, 200); assert.equal(res.body.canReset, true);
  assert.deepEqual(res.body.entries.map(row => row.id), ['1', '2', '3']);
  assert.deepEqual(res.body.totals.map(({ currency, count, amount }) => ({ currency, count, amount })), [
    { currency: 'USD', count: 2, amount: 30.03 }, { currency: 'CAD', count: 1, amount: 30.03 }
  ]);
  assert.equal(f.released, 1); assert.equal(f.queries[0].sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const sources = await f.request('get', '/api/bookkeeping/document-entry-resets/sources');
  assert.equal(sources.body.documents[0].entry_count, 3);
  assert.doesNotMatch(f.queries.at(-1).sql, /LIMIT/);
});

test('confirmed reset only excludes one file, preserves history and makes the original ready for requeue', async () => {
  const f = fixture(), before = structuredClone(f.state);
  const preview = await documentResetPreview(f.client, '12');
  const res = await f.request('post', resetPath, confirmation(preview));
  assert.equal(res.statusCode, 200); assert.equal(res.body.removedCount, 3); assert.equal(res.body.readyToQueue, true);
  assert.deepEqual(f.state.transactions.map(row => row.status), ['void', 'void', 'void', 'void', 'approved', 'approved']);
  assert.deepEqual(f.state.transactions.slice(4), before.transactions.slice(4));
  assert.equal(f.state.transactions.length, before.transactions.length);
  const doc = f.state.documents[0];
  assert.equal(doc.original_filename, before.documents[0].original_filename);
  assert.equal(doc.processing_status, 'queued'); assert.equal(doc.metadata.ai_queued, false);
  assert.equal(doc.metadata.note, 'Business account'); assert.equal(doc.processed_at, null);
  const history = doc.metadata.transaction_reset_history[0];
  assert.equal(history.adminUserId, 7); assert.ok(history.resetAt); assert.ok(history.id);
  assert.deepEqual(history.entries, [{ id: '1', previousStatus: 'approved' }, { id: '2', previousStatus: 'pending' }, { id: '3', previousStatus: 'pending' }]);
  assert.deepEqual(f.events, [{ reason: 'bookkeeping_changed' }]);
  assert.equal(f.queries.some(({ sql }) => /DELETE|INSERT INTO bookkeeping_transactions/.test(sql)), false);
  assert.ok(f.queries.some(({ sql }) => sql.startsWith('LOCK TABLE')));
  const repeated = await f.request('post', resetPath, confirmation(preview));
  assert.equal(repeated.statusCode, 409); assert.equal(f.events.length, 1);
});

test('changed review and wrong-file confirmation cannot mutate records', async () => {
  for (const change of ['status', 'amount', 'notes', 'document', 'new entry', 'wrong file']) {
    const f = fixture(), preview = await documentResetPreview(f.client, '12');
    const body = confirmation(preview);
    if (change === 'status') f.state.transactions[0].status = 'pending';
    if (change === 'amount') f.state.transactions[0].total = '500';
    if (change === 'notes') f.state.transactions[0].notes = 'Edited after review';
    if (change === 'document') f.state.documents[0].metadata.note = 'Changed';
    if (change === 'new entry') f.state.transactions.push({ id: '7', document_id: '12', status: 'pending', total: '1' });
    if (change === 'wrong file') body.confirmDocumentId = '13';
    const before = structuredClone(f.state);
    const res = await f.request('post', resetPath, body);
    assert.equal(res.statusCode, change === 'wrong file' ? 400 : 409, change);
    assert.deepEqual(f.state, before); assert.deepEqual(f.events, []);
  }
});

test('consolidations involving even void entries and paid bills block an entire reset', async () => {
  for (const dependency of ['duplicate', 'keeper', 'paid bill']) {
    const f = fixture();
    if (dependency === 'paid bill') f.state.bills.push({ id: '9', status: 'paid', vendor: 'Utilities', paid_transaction_id: '1' });
    else f.state.matches.push({ id: '8', duplicate_transaction_id: dependency === 'duplicate' ? '4' : '5', keeper_transaction_id: dependency === 'keeper' ? '1' : '5' });
    const preview = await documentResetPreview(f.client, '12');
    assert.equal(preview.canReset, false); assert.ok(preview.blockers.length);
    const before = structuredClone(f.state);
    const res = await f.request('post', resetPath, confirmation(preview));
    assert.equal(res.statusCode, 409); assert.deepEqual(f.state, before); assert.deepEqual(f.events, []);
  }
});

test('processing and queued AI jobs cannot race a reset', async () => {
  for (const reason of ['active worker', 'processing file', 'queued file']) {
    const f = fixture();
    if (reason === 'active worker') f.setBusy();
    if (reason === 'processing file') f.state.documents[0].processing_status = 'processing';
    if (reason === 'queued file') f.state.documents[0].metadata.ai_queued = true;
    const preview = await documentResetPreview(f.client, '12'), before = structuredClone(f.state);
    const res = await f.request('post', resetPath, confirmation(preview));
    assert.equal(res.statusCode, 409, reason); assert.deepEqual(f.state, before); assert.deepEqual(f.events, []);
  }
});

test('failure after excluding entries rolls back all changes and emits no update', async () => {
  const f = fixture(), preview = await documentResetPreview(f.client, '12'), before = structuredClone(f.state);
  f.failWrite();
  const res = await f.request('post', resetPath, confirmation(preview));
  assert.equal(res.statusCode, 500); assert.deepEqual(f.state, before); assert.deepEqual(f.events, []);
  assert.equal(f.queries.at(-1).sql, 'ROLLBACK'); assert.equal(f.released, 1);
});

test('missing files, empty sources and invalid IDs cannot be reset', async () => {
  const f = fixture();
  assert.equal((await f.request('get', previewPath, undefined, '99')).statusCode, 404);
  assert.equal((await f.request('get', previewPath, undefined, '../12')).statusCode, 400);
  assert.equal((await f.request('post', resetPath, {})).statusCode, 400);
  f.state.transactions.filter(row => row.document_id === '12').forEach(row => { row.status = 'void'; });
  const preview = await documentResetPreview(f.client, '12');
  assert.equal(preview.canReset, false); assert.equal(preview.count, 0);
  assert.equal((await f.request('post', resetPath, confirmation(preview))).statusCode, 409);
});
