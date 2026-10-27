import test from 'node:test';
import assert from 'node:assert/strict';
import { auditBookkeeping, reconciliationSnapshot, registerBookkeepingAuditRoutes, statementAudit } from './bookkeeping-audit.js';
import { buildFinanceReport } from './bookkeeping-finance.js';

const tx = (id, overrides = {}) => ({ id, document_id: id, document_type: 'receipt', source_filename: `${id}.pdf`, status: 'approved', transaction_date: '2026-10-06', vendor: 'Chevron', total: '40.00', currency: 'USD', transaction_type: 'expense', ...overrides });
const bank = (id, overrides = {}) => tx(id, { document_type: 'bank_statement', payment_account: 'Checking 1234', ...overrides });
function apply(rows, report, links = []) {
  const updated = rows.map(row => ({ ...row }));
  for (const action of report.cleanup) {
    const duplicate = updated.find(row => row.id === action.duplicateId);
    links.push({ id: links.length + 1, duplicate_transaction_id: duplicate.id, keeper_transaction_id: action.keeperId, previous_status: duplicate.status });
    duplicate.status = 'void';
  }
  return { rows: updated, links };
}

test('all-history scan collapses overlapping statements and a receipt into one approved expense', () => {
  const rows = [bank(1), bank(2), tx(3)];
  const report = auditBookkeeping(rows);
  assert.equal(report.scannedCount, 3);
  assert.equal(report.cleanup.length, 2);
  assert.deepEqual(report.cleanup.map(row => [row.duplicateId, row.keeperId]), [[2, 3], [1, 3]]);
  assert.equal(report.matched.length, 1);
  assert.equal(report.duplicates[0].canAutoConsolidate, true);
  assert.deepEqual(report.totals, [{ currency: 'USD', type: 'expense', statementTotal: 40, receiptTotal: 40, difference: 0 }]);
  const saved = apply(rows, report);
  const next = auditBookkeeping(saved.rows, saved.links);
  assert.equal(next.cleanup.length, 0);
  assert.equal(next.matched[0].status, 'connected');
  assert.equal(next.unmatchedReceipts.length, 0);
  assert.equal(next.unmatchedStatement.length, 0);
  assert.equal(buildFinanceReport({ transactions: saved.rows }).summary.totalExpenses, 40);
  assert.equal(rows[0].status, 'approved', 'A scan must not mutate input records');
});

test('approved records win over pending receipts and a paid bill is never excluded', () => {
  for (const bills of [[], [{ paid_transaction_id: 1 }]]) {
    const report = auditBookkeeping([bank(1), tx(2, { status: 'pending' })], [], bills);
    assert.deepEqual(report.cleanup.map(row => [row.duplicateId, row.keeperId]), [[2, 1]]);
  }
  const report = auditBookkeeping([bank(1), tx(2)], [], [{ paid_transaction_id: 1 }, { paid_transaction_id: 2 }]);
  assert.equal(report.cleanup.length, 0);
  assert.equal(report.possibleMatches.length, 1);
});

test('ambiguity is checked in both directions, independent of input order', () => {
  for (const rows of [[bank(1), bank(2, { payment_account: 'Card 5678' }), tx(3, { payment_account: null })], [bank(1), tx(2), tx(3)]]) {
    for (const input of [rows, [...rows].reverse()]) {
      const report = auditBookkeeping(input);
      assert.equal(report.cleanup.length, 0);
      assert.equal(report.matched.length, 0);
      assert.equal(report.unmatchedReceipts.length, rows.filter(row => row.document_type === 'receipt').length);
      assert.ok(report.possibleMatches.length);
    }
  }
});

test('same merchant purchases repeated in a statement are preserved and flagged', () => {
  const report = auditBookkeeping([bank(1, { document_id: 10 }), bank(2, { document_id: 10 }), bank(3, { document_id: 20 }), tx(4)]);
  assert.equal(report.cleanup.length, 0);
  assert.equal(report.duplicates.length, 2);
  assert.ok(report.duplicates.every(row => !row.canAutoConsolidate));
});

test('unknown accounts and different statement types cannot be automatically deduplicated', () => {
  for (const rows of [[bank(1, { payment_account: null }), bank(2, { payment_account: null })], [bank(1), bank(2, { document_type: 'credit_card_statement' })]]) {
    const report = auditBookkeeping(rows);
    assert.equal(report.cleanup.length, 0);
    assert.equal(report.duplicates.length, 1);
  }
});

test('different accounts, amounts, currencies and types never become clear receipt matches', () => {
  for (const overrides of [{ payment_account: 'Visa 5678' }, { total: '41.01' }, { currency: 'CAD' }, { transaction_type: 'refund' }, { transaction_date: '2026-10-10' }, { vendor: 'Different merchant' }]) {
    const report = auditBookkeeping([bank(1), tx(2, overrides)]);
    assert.equal(report.cleanup.length, 0);
    assert.equal(report.unmatchedReceipts.length, 1);
  }
  const mismatch = auditBookkeeping([bank(1), tx(2, { total: '41.01' })]);
  assert.equal(mismatch.possibleMatches[0].amountDifference, -1.01);
  assert.match(mismatch.possibleMatches[0].details.reason, /amounts differ/);
});

test('posting delays, normalized merchants, date objects, manual entries and non-USD amounts work', () => {
  const report = auditBookkeeping([bank(1, { vendor: 'The Chevron, Inc.', currency: 'cad', transaction_date: new Date('2026-10-09') }), tx(2, { document_id: null, currency: 'CAD' })]);
  assert.equal(report.cleanup.length, 1);
  assert.equal(report.totals[0].currency, 'CAD');
  assert.equal(report.totals[0].difference, 0);
});

test('unlinked void entries stay excluded, confirmed connections and Stripe links remain connected', () => {
  const rows = [bank(1, { status: 'void' }), tx(2), tx(3, { status: 'void' }), bank(4, { status: 'void' })];
  const report = auditBookkeeping(rows, [{ duplicate_transaction_id: 1, keeper_transaction_id: 2 }, { duplicate_transaction_id: 4, stripe_activity_id: 'txn_1' }]);
  assert.equal(report.matched.length, 1);
  assert.equal(report.matched[0].status, 'connected');
  assert.equal(report.unmatchedReceipts.length, 0);
  assert.equal(report.connectedStripe.length, 1);
  assert.equal(report.cleanup.length, 0);
});

test('new overlapping imports connect to a previously consolidated group without losing evidence', () => {
  const rows = [bank(1, { status: 'void' }), tx(2), bank(3)];
  const links = [{ duplicate_transaction_id: 1, keeper_transaction_id: 2 }];
  const report = auditBookkeeping(rows, links);
  assert.deepEqual(report.cleanup.map(row => [row.duplicateId, row.keeperId]), [[3, 2]]);
  const saved = apply(rows, report, [...links]);
  const next = auditBookkeeping(saved.rows, saved.links);
  assert.equal(next.cleanup.length, 0);
  assert.equal(next.matched.length, 1);
});

test('transfers, zero or missing factual data remain review items', () => {
  for (const overrides of [{ transaction_type: 'transfer' }, { total: 0 }, { total: null }, { total: -40 }, { transaction_date: null }, { vendor: null }]) {
    const report = auditBookkeeping([bank(1, overrides), tx(2, overrides)]);
    assert.equal(report.cleanup.length, 0);
    assert.equal(report.unmatchedReceipts.length, 1);
  }
  assert.equal(auditBookkeeping([tx(1, { document_type: 'other' })]).otherTransactions.length, 1);
});

test('the all-history scan includes records beyond transaction list and date-period limits', () => {
  const rows = Array.from({ length: 5100 }, (_, i) => tx(i + 1, { transaction_date: '2020-01-01', total: i + 1 }));
  const report = auditBookkeeping([...rows, bank(6000, { transaction_date: '2020-01-01', total: 5100 })]);
  assert.equal(report.scannedCount, 5101);
  assert.equal(report.cleanup.length, 1);
  assert.equal(report.cleanup[0].keeperId, 5100);
});

function fixture(rows = [bank(1), tx(2)]) {
  let records = structuredClone(rows), links = [];
  const calls = [], notifications = [], routes = new Map();
  const client = { release() { calls.push('RELEASE'); }, async query(sql, values) {
    calls.push(sql);
    if (sql.startsWith('SELECT t.*')) return { rows: structuredClone(records) };
    if (sql.startsWith('SELECT * FROM bookkeeping_consolidations')) return { rows: structuredClone(links) };
    if (sql.startsWith('SELECT id,paid_transaction_id')) return { rows: [] };
    if (sql.startsWith('INSERT INTO bookkeeping_consolidations')) links.push({ id: links.length + 1, duplicate_transaction_id: values[0], keeper_transaction_id: values[1], previous_status: values[2] });
    if (sql.startsWith('UPDATE bookkeeping_transactions')) records.find(row => row.id === values[0]).status = 'void';
    return { rows: [] };
  } };
  const app = Object.fromEntries(['get', 'post', 'patch', 'delete'].map(method => [method, (url, fn) => routes.set(`${method} ${url}`, fn)]));
  registerBookkeepingAuditRoutes(app, { pool: { connect: async () => client }, notify: event => notifications.push(event) });
  const response = () => ({ statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } });
  return { client, calls, notifications, routes, response, rows: () => records, links: () => links };
}

test('cleanup runs atomically, rechecks the snapshot, persists audit links and notifies after commit', async () => {
  const f = fixture(), scan = f.response();
  await f.routes.get('get /api/bookkeeping/reconciliation')({}, scan);
  assert.ok(f.calls.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
  const res = f.response();
  await f.routes.get('post /api/bookkeeping/reconciliation/cleanup')({ body: { snapshot: scan.body.snapshot }, adminUser: { id: 7 } }, res);
  assert.equal(res.body.consolidatedCount, 1);
  assert.equal(res.body.report.cleanup.length, 0);
  assert.equal(res.body.report.matched[0].status, 'connected');
  assert.ok(f.calls.find(sql => sql.startsWith('LOCK TABLE')));
  assert.equal(f.links()[0].previous_status, 'approved');
  assert.equal(f.calls.at(-2), 'COMMIT');
  assert.equal(f.calls.at(-1), 'RELEASE');
  assert.equal(f.notifications.length, 1);
});

test('stale or replayed cleanup is rejected before writes and the transaction is released', async () => {
  const f = fixture(), snapshot = reconciliationSnapshot(f.rows(), [], []);
  f.rows()[0].total = '50.00';
  const res = f.response();
  await f.routes.get('post /api/bookkeeping/reconciliation/cleanup')({ body: { snapshot }, adminUser: { id: 7 } }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(f.links().length, 0);
  assert.equal(f.notifications.length, 0);
  assert.equal(f.calls.at(-2), 'ROLLBACK');
  assert.equal(f.calls.at(-1), 'RELEASE');
});

test('write failures roll back, release the client and do not send success notifications', async () => {
  const f = fixture(), snapshot = reconciliationSnapshot(f.rows(), [], []), original = f.client.query;
  f.client.query = async (sql, values) => {
    if (sql.startsWith('INSERT INTO')) throw new Error('Simulated write failure');
    return original(sql, values);
  };
  const res = f.response();
  await f.routes.get('post /api/bookkeeping/reconciliation/cleanup')({ body: { snapshot }, adminUser: { id: 7 } }, res);
  assert.equal(res.statusCode, 500);
  assert.equal(f.calls.at(-2), 'ROLLBACK');
  assert.equal(f.calls.at(-1), 'RELEASE');
  assert.equal(f.notifications.length, 0);
});


test('a protected pending keeper cannot remove an approved transaction from financial totals', () => {
  const rows = [bank(1), tx(2, { status: 'pending' }), tx(3, { status: 'void' })];
  const report = auditBookkeeping(rows, [{ duplicate_transaction_id: 3, keeper_transaction_id: 2 }]);
  assert.equal(report.cleanup.length, 0);
  assert.equal(report.possibleMatches.length, 1);
});

test('statement views retain confirmed connections and use global receipt competition', () => {
  const rows = [bank(1, { status: 'void' }), tx(2), bank(3, { payment_account: 'Visa 5678' })];
  const global = auditBookkeeping(rows, [{ duplicate_transaction_id: 1, keeper_transaction_id: 2 }]);
  const scoped = statementAudit(global, '1', [rows[0]]);
  assert.equal(scoped.scope, 'statement');
  assert.equal(scoped.matched.length, 1);
  assert.equal(scoped.matched[0].status, 'connected');
  assert.equal(scoped.unmatchedReceipts.length, 0);
  assert.equal(scoped.cleanup.length, 0);
  const competing = [bank(1), bank(2, { payment_account: 'Visa 5678' }), tx(3, { payment_account: null })];
  const ambiguous = statementAudit(auditBookkeeping(competing), '1', [competing[0]]);
  assert.equal(ambiguous.matched.length, 0);
  assert.equal(ambiguous.possibleMatches.length, 1);
});


test('a newly extracted repeated purchase in an already linked source document stays ambiguous', () => {
  const rows = [bank(1, { status: 'void', document_id: 10 }), bank(2, { status: 'void', document_id: 20 }), tx(3), bank(4, { document_id: 20 })];
  const links = [{ duplicate_transaction_id: 1, keeper_transaction_id: 3 }, { duplicate_transaction_id: 2, keeper_transaction_id: 3 }];
  const report = auditBookkeeping(rows, links);
  assert.equal(report.cleanup.length, 0);
  assert.equal(report.duplicates[0].canAutoConsolidate, false);
  const scoped = statementAudit(report, 20, [rows[1], rows[3]]);
  assert.equal(scoped.matched[0].statementTransaction.id, 2);
});
