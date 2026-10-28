import test from 'node:test';
import assert from 'node:assert/strict';
import { approveDocumentTransactions, documentApprovalPreviews } from './bookkeeping-document-approval.js';
import { registerBookkeepingRoutes } from './bookkeeping.js';

function fixture() {
  const entry = (id, type, status = 'pending', documentId = '12') => ({ id: String(id), document_id: documentId, transaction_type: type, status, transaction_date: '2026-07-06', vendor: 'Sample vendor', total: '10.01', currency: 'USD' });
  const state = { document: { id: '12', original_filename: 'Statement.pdf', processing_status: 'needs_review', metadata: {} }, rows: [
    entry(1, 'income'), entry(2, 'expense'), entry(3, 'expense'), entry(4, 'transfer'),
    entry(5, 'expense', 'approved'), entry(6, 'expense', 'void'), entry(7, 'expense', 'pending', '13'), entry(8, 'expense', 'pending', null)
  ] };
  const calls = []; let backup, released = 0, failDocumentWrite = false, mismatch = false;
  const result = rows => ({ rows: structuredClone(rows), rowCount: rows.length });
  const query = async (sql, values = []) => {
    calls.push({ sql, values });
    if (sql === 'BEGIN') { backup = structuredClone(state); return result([]); }
    if (sql === 'ROLLBACK') { Object.assign(state, backup); return result([]); }
    if (sql.startsWith('SELECT id,original_filename')) { assert.match(sql, /FOR UPDATE/); return result(state.document ? [state.document] : []); }
    if (sql.startsWith('SELECT t.*')) {
      assert.match(sql, /WHERE t.document_id=\$1 ORDER BY t.id FOR UPDATE/);
      assert.doesNotMatch(sql, /LIMIT|transaction_date\s*[<>]/);
      return result(state.rows.filter(row => row.document_id === values[0]));
    }
    if (sql.startsWith('UPDATE bookkeeping_transactions')) {
      assert.match(sql, /document_id=\$1 AND status='pending' AND id=ANY/);
      assert.match(sql, /approved_by_admin_user_id=\$2,approved_at=NOW\(\)/);
      assert.match(sql, /COALESCE\(transaction_type,'adjustment'\)=\$4/);
      const [documentId, actor, ids, type] = values;
      const rows = state.rows.filter(row => row.document_id === documentId && row.status === 'pending' && ids.includes(row.id) && (type === 'all' || row.transaction_type === type));
      rows.forEach(row => { row.status = 'approved'; row.approved_by_admin_user_id = actor; row.approved_at = '2026-10-27T21:00:00Z'; });
      return result(mismatch ? rows.slice(1) : rows);
    }
    if (sql.startsWith('UPDATE bookkeeping_documents')) {
      if (failDocumentWrite) throw new Error('Database write failed');
      assert.match(sql, /status='pending'/);
      state.document.processing_status = state.rows.some(row => row.document_id === values[0] && row.status === 'pending') ? 'needs_review' : 'approved';
    }
    return result([]);
  };
  const args = { pool: { connect: async () => ({ query, release() { released++; } }) }, documentId: '12', adminUserId: 19 };
  const previews = () => documentApprovalPreviews(state.document, state.rows.filter(row => row.document_id === '12'));
  return { state, calls, entry, previews, pool: args.pool, get released() { return released; }, failWrite() { failDocumentWrite = true; }, mismatch() { mismatch = true; }, approve(type = 'expense', snapshot = previews()[type]?.snapshot, extra = {}) { return approveDocumentTransactions({ ...args, transactionType: type, snapshot, ...extra }); } };
}

test('filtered approval changes only pending entries of one document/type and records admin/time', async () => {
  const f = fixture(), before = structuredClone(f.state);
  assert.equal(f.previews().expense.count, 2);
  const result = await f.approve();
  assert.equal(result.approvedCount, 2); assert.equal(result.transactionType, 'expense');
  assert.deepEqual(f.state.rows.map(row => row.status), ['pending', 'approved', 'approved', 'pending', 'approved', 'void', 'pending', 'pending']);
  for (const index of [0, 3, 4, 5, 6, 7]) assert.deepEqual(f.state.rows[index], before.rows[index]);
  for (const index of [1, 2]) { assert.equal(f.state.rows[index].approved_by_admin_user_id, 19); assert.ok(f.state.rows[index].approved_at); assert.equal(f.state.rows[index].total, before.rows[index].total); }
  assert.equal(f.state.document.processing_status, 'needs_review'); assert.equal(f.calls.at(-1).sql, 'COMMIT'); assert.equal(f.released, 1);
});

test('all types approves the remaining file and completes document review without restoring excluded history', async () => {
  const f = fixture(); await f.approve();
  const result = await f.approve('all');
  assert.equal(result.approvedCount, 2); assert.equal(f.state.document.processing_status, 'approved');
  assert.equal(f.state.rows[5].status, 'void'); assert.equal(f.state.rows[6].status, 'pending');
});

test('file approval is not limited by the main ledger row cap', async () => {
  const f = fixture(); f.state.rows = Array.from({ length: 650 }, (_, index) => f.entry(index + 1, 'expense'));
  assert.equal((await f.approve()).approvedCount, 650);
  assert.ok(f.state.rows.every(row => row.status === 'approved'));
});

test('edited amounts, notes, type, status, file state and new entries require a refreshed approval', async () => {
  for (const change of ['amount', 'notes', 'type', 'status', 'filename', 'new entry']) {
    const f = fixture(), snapshot = f.previews().expense.snapshot;
    if (change === 'amount') f.state.rows[1].total = '999';
    if (change === 'notes') f.state.rows[1].notes = 'Edited after review';
    if (change === 'type') f.state.rows[1].transaction_type = 'income';
    if (change === 'status') f.state.rows[1].status = 'void';
    if (change === 'filename') f.state.document.original_filename = 'Changed.pdf';
    if (change === 'new entry') f.state.rows.push(f.entry(9, 'expense'));
    const before = structuredClone(f.state);
    await assert.rejects(f.approve('expense', snapshot), error => error.statusCode === 409, change);
    assert.deepEqual(f.state, before); assert.equal(f.calls.some(({ sql }) => sql.startsWith('UPDATE')), false);
  }
});

test('a malformed entry prevents partial approval and identifies entries requiring review', async () => {
  for (const change of [{ vendor: '  ' }, { transaction_date: null }, { transaction_date: '2026-02-30' }, { total: '-1' }, { total: 'NaN' }, { total: null }, { currency: 'bad' }]) {
    const f = fixture(); Object.assign(f.state.rows[1], change); const before = structuredClone(f.state);
    await assert.rejects(f.approve(), error => error.statusCode === 422 && /#2/.test(error.message));
    assert.deepEqual(f.state, before); assert.equal(f.calls.some(({ sql }) => sql.startsWith('UPDATE')), false);
  }
});

test('zero amounts and multiple currencies can be approved without changing amounts or transfer classification', async () => {
  const f = fixture(); f.state.rows[1].total = '0.00'; f.state.rows[2].currency = 'CAD';
  await f.approve(); await f.approve('transfer');
  assert.equal(f.state.rows[1].total, '0.00'); assert.equal(f.state.rows[2].currency, 'CAD');
  assert.equal(f.state.rows[3].transaction_type, 'transfer'); assert.equal(f.state.rows[3].status, 'approved');
});

test('queued/processing files and replayed or wrong-type confirmations cannot approve records', async () => {
  for (const processing of [false, true]) {
    const f = fixture(), snapshot = f.previews().expense.snapshot;
    if (processing) f.state.document.processing_status = 'processing'; else f.state.document.metadata.ai_queued = true;
    await assert.rejects(f.approve('expense', snapshot), error => error.statusCode === 409);
    assert.equal(f.state.rows[1].status, 'pending');
  }
  const f = fixture(), snapshot = f.previews().expense.snapshot;
  await assert.rejects(f.approve('income', snapshot), error => error.statusCode === 409);
  await f.approve('expense', snapshot);
  await assert.rejects(f.approve('expense', snapshot), error => error.statusCode === 409);
});

test('later write failures and update-count mismatches roll back every approval', async () => {
  for (const mismatch of [false, true]) {
    const f = fixture(), before = structuredClone(f.state);
    if (mismatch) f.mismatch(); else f.failWrite();
    await assert.rejects(f.approve()); assert.deepEqual(f.state, before);
    assert.equal(f.calls.at(-1).sql, 'ROLLBACK'); assert.equal(f.released, 1);
  }
});

test('preview hashing ignores query order but binds the document, type and pending content', () => {
  const f = fixture(), initial = f.previews(); f.state.rows.reverse();
  assert.deepEqual(f.previews(), initial);
  assert.notEqual(initial.all.snapshot, initial.expense.snapshot);
  f.state.rows.find(row => row.id === '7').total = '600'; // another document is irrelevant
  assert.deepEqual(f.previews(), initial);
});

test('invalid scopes, missing files and empty pending filters do not mutate records', async () => {
  const invalid = fixture(); await assert.rejects(invalid.approve('stripe', 'a'.repeat(64)), error => error.statusCode === 400); assert.equal(invalid.calls.length, 0);
  await assert.rejects(invalid.approve('expense', 'bad'), error => error.statusCode === 400);
  const missing = fixture(), snapshot = missing.previews().expense.snapshot; missing.state.document = null;
  await assert.rejects(missing.approve('expense', snapshot), error => error.statusCode === 404); assert.equal(missing.released, 1);
  const empty = fixture(); await assert.rejects(empty.approve('refund'), error => error.statusCode === 409);
});


test('the route notifies after commit and never reports success after a failed write', async () => {
  for (const fails of [false, true]) {
    const f = fixture(), events = [], routes = new Map(), before = structuredClone(f.state);
    const app = Object.fromEntries(['get', 'post', 'patch', 'delete'].map(method => [method, (path, ...handlers) => routes.set(`${method} ${path}`, handlers.at(-1))]));
    registerBookkeepingRoutes(app, { pool: f.pool, notify: event => { assert.equal(f.calls.at(-1).sql, 'COMMIT'); events.push(event); } });
    if (fails) f.failWrite();
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await routes.get('post /api/bookkeeping/documents/:id/approve-transactions')({ params: { id: '12' }, body: { transactionType: 'expense', snapshot: f.previews().expense.snapshot }, adminUser: { id: 19 } }, res);
    assert.equal(res.statusCode, fails ? 500 : 200);
    assert.equal(events.length, fails ? 0 : 1);
    if (fails) assert.deepEqual(f.state, before); else assert.equal(res.body.approvedCount, 2);
  }
});
