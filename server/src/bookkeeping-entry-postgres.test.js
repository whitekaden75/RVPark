import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createBookkeepingEntry } from './bookkeeping-entry.js';

// Use a disposable local database only. Mocks cannot exercise PostgreSQL's
// parameter inference, which caused the production INSERT to fail with 42P08.
const databaseUrl = process.env.RVPARK_TEST_DATABASE_URL;
if (databaseUrl && !['localhost','127.0.0.1','[::1]'].includes(new URL(databaseUrl).hostname)) {
  throw new Error('Bookkeeping PostgreSQL tests require a disposable local database.');
}

test('PostgreSQL accepts new standalone and statement entries without parameter type conflicts', { skip: !databaseUrl }, async t => {
  for (const [uploaderType, approverType] of [['integer','integer'],['integer','bigint'],['bigint','integer'],['bigint','bigint']]) {
    await t.test(`${uploaderType} uploader / ${approverType} approver`, async () => {
      const schema = `entry_test_${randomUUID().replaceAll('-','')}`;
      const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
      const body = { transaction_date: '2026-10-27', transaction_type: 'expense', vendor: 'Test purchase', total: '42.50', payment_account: 'Test checking ending 1234' };
      try {
        await pool.query(`CREATE SCHEMA ${schema};
          CREATE TABLE bookkeeping_documents (id bigint PRIMARY KEY,document_type text,processing_status varchar(20),metadata jsonb);
          CREATE TABLE bookkeeping_transactions (
            id bigserial PRIMARY KEY,uploaded_by_admin_user_id ${uploaderType},transaction_date date,vendor text,description text,
            total numeric(14,2),currency varchar(3),category text,payment_account text,transaction_type varchar(20),status varchar(20),notes text,
            document_id bigint REFERENCES bookkeeping_documents(id),approved_by_admin_user_id ${approverType},approved_at timestamptz);
          INSERT INTO bookkeeping_documents VALUES (12,'bank_statement','approved','{}'),(13,'credit_card_statement','approved','{}');`);
        // Confirm this database reproduces the exact SQL failure reported.
        await assert.rejects(pool.query(`INSERT INTO bookkeeping_transactions
          (uploaded_by_admin_user_id,transaction_date,vendor,description,total,currency,category,payment_account,transaction_type,status,notes,document_id,approved_by_admin_user_id,approved_at)
          VALUES ($1,$2,$3,$4,$5,'USD',$6,$7,$8,$9,$10,$11,CASE WHEN $9='approved' THEN $1 ELSE NULL END,CASE WHEN $9='approved' THEN now() ELSE NULL END) RETURNING *`,
        [7,body.transaction_date,body.vendor,'',42.50,null,body.payment_account,'expense','approved','Manual entry',null]),
        error => error.code === '42P08' && error.message.includes('parameter $1'));

        const standalone = await createBookkeepingEntry({pool,body,adminUserId:7});
        assert.equal(standalone.status,'approved'); assert.equal(standalone.document_id,null);
        assert.equal(String(standalone.approved_by_admin_user_id),'7'); assert.ok(standalone.approved_at instanceof Date);
        for (const documentId of ['12','13']) {
          const row = await createBookkeepingEntry({pool,body:{...body,document_id:documentId},adminUserId:7});
          assert.equal(row.document_id,documentId); assert.equal(row.status,'pending');
          assert.equal(row.approved_by_admin_user_id,null); assert.equal(row.approved_at,null);
          assert.equal(row.payment_account,body.payment_account); assert.equal(row.total,'42.50');
          const document = await pool.query('SELECT processing_status FROM bookkeeping_documents WHERE id=$1',[documentId]);
          assert.equal(document.rows[0].processing_status,'needs_review');
        }
        assert.equal((await pool.query('SELECT count(*) FROM bookkeeping_transactions')).rows[0].count,'3');
      } finally {
        await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await pool.end();
      }
    });
  }
});
