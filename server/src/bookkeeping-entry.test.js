import test from 'node:test';
import assert from 'node:assert/strict';
import { createBookkeepingEntry } from './bookkeeping-entry.js';
import { buildFinanceReport, registerFinanceRoutes } from './bookkeeping-finance.js';

const body = { transaction_date: '2026-10-01', transaction_type: 'expense', vendor: ' Missing purchase ', total: '12.34', payment_account: ' Business checking ending 1234 ' };
function fixture(overrides = {}) {
  const document = { id: '12', document_type: 'bank_statement', processing_status: 'approved', metadata: {}, ...overrides };
  const state = { document, transactions: [] }, calls = [];
  let backup, released = 0, failUpdate = false;
  const client = { release() { released++; }, async query(sql, params = []) {
    calls.push({ sql, params });
    if (sql === 'BEGIN') backup = structuredClone(state);
    if (sql === 'ROLLBACK') Object.assign(state, backup);
    if (sql.startsWith('SELECT id,document_type')) {
      assert.match(sql, /FOR UPDATE/);
      return { rows: params[0] === document.id ? [state.document] : [] };
    }
    if (sql.startsWith('INSERT INTO bookkeeping_transactions')) {
      const [admin, date, vendor, description, total, category, account, type, status, notes, documentId, approvedBy, approved] = params;
      const transaction = { id: 99, uploaded_by_admin_user_id: admin, transaction_date: date, vendor, description, total, category, payment_account: account, transaction_type: type, status, notes, document_id: documentId, currency: 'USD', approved_by_admin_user_id: approvedBy, approved_at: approved ? '2026-10-27T20:00:00Z' : null };
      state.transactions.push(transaction); return { rows: [transaction] };
    }
    if (sql.startsWith('UPDATE bookkeeping_documents')) {
      if (failUpdate) throw new Error('Statement update failed');
      assert.equal(params[0], document.id); assert.match(sql, /processing_status='needs_review'/);
      state.document.processing_status = 'needs_review';
    }
    return { rows: [] };
  } };
  return { state, calls, get released() { return released; }, failWrite() { failUpdate = true; }, create: changes => createBookkeepingEntry({ pool: { connect: async () => client }, adminUserId: 7, body: { ...body, ...changes } }) };
}

test('standalone entry preserves its named account and existing immediate approval behavior', async () => {
  const f = fixture(); const row = await f.create();
  assert.equal(row.document_id, null); assert.equal(row.status, 'approved');
  assert.equal(row.payment_account, 'Business checking ending 1234'); assert.equal(row.vendor, 'Missing purchase');
  assert.equal(row.uploaded_by_admin_user_id, 7);
  assert.equal(row.approved_by_admin_user_id, 7); assert.ok(row.approved_at);
  assert.equal(buildFinanceReport({ transactions: [row] }).summary.totalExpenses, 12.34);
  assert.ok(f.calls.some(call => call.sql === 'COMMIT')); assert.equal(f.released, 1);
});

for (const type of ['bank_statement','credit_card_statement']) test(`new ${type} entry is tied to that file and awaits review`, async () => {
  const f = fixture({ document_type: type }); const row = await f.create({ document_id: '12' });
  assert.equal(row.document_id, '12'); assert.equal(row.status, 'pending');
  assert.equal(row.approved_by_admin_user_id, null); assert.equal(row.approved_at, null);
  assert.equal(f.state.document.processing_status, 'needs_review');
  assert.equal(buildFinanceReport({ transactions: [row] }).summary.totalExpenses, 0);
  assert.equal(f.calls.filter(call => call.sql.startsWith('INSERT')).length, 1); assert.equal(f.released, 1);
});

test('missing, wrong-type and unprocessed statements are rejected without creating an entry', async () => {
  for (const [doc, id, code] of [[{},'13',404],[{document_type:'receipt'},'12',400],
    ...['queued','processing','failed','uploaded'].map(processing_status => [{processing_status},'12',409]),
    [{metadata:{ai_queued:true}},'12',409]]) {
    const f = fixture(doc);
    await assert.rejects(f.create({document_id:id}), error => error.statusCode === code);
    assert.deepEqual(f.state.transactions, []); assert.ok(!f.calls.some(call => call.sql === 'COMMIT')); assert.equal(f.released, 1);
  }
});

test('invalid dates, amounts and statement IDs never reach the database', async () => {
  for (const changes of [{transaction_date:'2026-02-30'},{total:0},{total:'bad'},{vendor:' '},{transaction_type:'fee'},
    {document_id:'bad'},{document_id:0},{document_id:'9223372036854775808'},{payment_account:'a'.repeat(201)}]) {
    const f = fixture(); await assert.rejects(f.create(changes), error => error.statusCode === 400); assert.equal(f.calls.length, 0);
  }
});

test('failed statement update rolls the insert back', async () => {
  const f = fixture(); f.failWrite();
  await assert.rejects(f.create({document_id:'12'}), /Statement update failed/);
  assert.deepEqual(f.state.transactions, []); assert.equal(f.state.document.processing_status, 'approved');
  assert.ok(f.calls.some(call => call.sql === 'ROLLBACK')); assert.equal(f.released, 1);
});

test('entry endpoint returns persisted provenance and only notifies after a successful commit', async () => {
  const routes = new Map(), calls = [], events = [];
  const app = Object.fromEntries(['get','post','patch','delete'].map(method => [method,(path,handler) => routes.set(`${method} ${path}`,handler)]));
  const client = { release() {}, async query(sql) {
    calls.push(sql);
    if (sql.startsWith('SELECT')) return { rows: [{id:12,document_type:'credit_card_statement',processing_status:'approved',metadata:{}}] };
    if (sql.startsWith('INSERT')) return { rows: [{id:99,document_id:12,payment_account:'Visa ending 5678',status:'pending'}] };
    return {rows:[]};
  } };
  registerFinanceRoutes(app,{pool:{connect:async () => client},notify:event => {assert.equal(calls.at(-1),'COMMIT');events.push(event);}});
  const request = async changes => {
    const res = {code:200,status(code){this.code=code;return this;},json(data){this.body=data;return this;}};
    await routes.get('post /api/bookkeeping/entries')({body:{...body,document_id:12,payment_account:'Visa ending 5678',...changes},adminUser:{id:7}},res);
    return res;
  };
  const success = await request({}); assert.equal(success.code,201);
  assert.equal(success.body.transaction.document_id,12); assert.equal(success.body.transaction.payment_account,'Visa ending 5678');
  assert.equal(events.length,1);
  const invalid = await request({document_id:'bad'}); assert.equal(invalid.code,400); assert.equal(events.length,1);
});
