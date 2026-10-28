import test from 'node:test';
import assert from 'node:assert/strict';
import { registerBookkeepingRoutes } from './bookkeeping.js';

function setup({ missing = false, failedRead = false, processing = false } = {}) {
  const calls = [], source = { id: '12', original_filename: 'Statement.pdf', processing_status: processing ? 'processing' : 'needs_review', metadata: {} };
  const records = Array.from({ length: 650 }, (_, i) => ({ id: i + 1, document_id: i === 649 ? '13' : '12', transaction_date: i === 0 ? '2024-01-01' : '2026-10-01', status: i % 3 === 0 ? 'void' : i % 3 === 1 ? 'pending' : 'approved', total: '1.00' }));
  let released = 0;
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('SELECT id,original_filename')) return { rows: missing ? [] : [source], rowCount: missing ? 0 : 1 };
    if (sql.includes('WHERE t.document_id=$1 ORDER BY')) {
      assert.deepEqual(params, ['12']); assert.doesNotMatch(sql, /LIMIT|status\s*=|transaction_date\s*[<>]/);
      if (failedRead) throw new Error('Database unavailable');
      const rows = processing ? [] : records.filter(row => row.document_id === params[0]);
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('AS transaction_count')) {
      assert.match(sql, /counts.document_id=d.id/); assert.match(sql, /t.status<>'void'/);
      return { rows: [{ ...source, transaction_count: records.filter(row => row.document_id === source.id && row.status !== 'void').length }] };
    }
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release() { released++; } }) };
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'patch', 'delete'].map(method => [method, (path, ...handlers) => routes.set(`${method} ${path}`, handlers.at(-1))]));
  registerBookkeepingRoutes(app, { pool });
  return { calls, records, get released() { return released; }, async get(id = '12', list = false) {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await routes.get(`get /api/bookkeeping/documents${list ? '' : '/:id/transactions'}`)({ params: { id }, query: { limit: 1, from: '2026-10-01', status: 'pending' } }, res);
    return res;
  } };
}

test('file view returns every saved transaction from just that file, across all dates/statuses and row caps', async () => {
  const f = setup(), res = await f.get();
  assert.equal(res.statusCode, 200); assert.equal(res.body.document.id, '12');
  assert.equal(res.body.transactions.length, 649);
  assert.equal(res.body.transactions[0].transaction_date, '2024-01-01');
  assert.deepEqual(new Set(res.body.transactions.map(row => row.status)), new Set(['void', 'pending', 'approved']));
  assert.ok(res.body.transactions.every(row => row.document_id === '12'));
  assert.equal(f.calls[0].sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(f.calls.at(-1).sql, 'COMMIT'); assert.equal(f.released, 1);
  assert.ok(f.calls.every(({ sql }) => !/UPDATE|INSERT|DELETE/.test(sql)));
});

test('document list counts match the active entries in the full file view', async () => {
  const f = setup(), list = await f.get('12', true), full = await f.get();
  assert.equal(list.body.documents[0].transaction_count, full.body.transactions.filter(row => row.status !== 'void').length);
});

test('an unfinished extraction returns the processing state with an empty list', async () => {
  const f = setup({ processing: true }), res = await f.get();
  assert.equal(res.statusCode, 200); assert.equal(res.body.document.processing_status, 'processing');
  assert.deepEqual(res.body.transactions, []); assert.equal(f.released, 1);
});

test('invalid IDs, missing files and failed reads return errors without leaking database clients', async () => {
  const invalid = setup(); assert.equal((await invalid.get('12 OR 1=1')).statusCode, 400); assert.equal(invalid.calls.length, 0);
  const missing = setup({ missing: true }); assert.equal((await missing.get()).statusCode, 404);
  assert.equal(missing.calls.at(-1).sql, 'ROLLBACK'); assert.equal(missing.released, 1);
  const failed = setup({ failedRead: true }); assert.equal((await failed.get()).statusCode, 500);
  assert.equal(failed.calls.at(-1).sql, 'ROLLBACK'); assert.equal(failed.released, 1);
});
