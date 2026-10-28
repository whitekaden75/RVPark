import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { registerHistoricalDailyPaymentRoutes } from './historical-daily-payments.js';

const databaseUrl=process.env.RVPARK_TEST_DATABASE_URL;
if(databaseUrl && !['localhost','127.0.0.1','[::1]'].includes(new URL(databaseUrl).hostname))throw new Error('Historical payment tests require a disposable local database.');

test('historical backfill previews, applies atomically, preserves real payments and paid balances, and skips reruns', {skip:!databaseUrl},async()=>{
  const schema=`historical_test_${randomUUID().replaceAll('-','')}`;
  const pool=new pg.Pool({connectionString:databaseUrl,options:`-c search_path=${schema},public`}),events=[];
  const migration=await readFile(new URL('../../sql/2026-10-27_historical_daily_payments.sql',import.meta.url),'utf8');
  try {
    await pool.query(`CREATE SCHEMA ${schema};
      CREATE TABLE admin_users(id integer PRIMARY KEY);
      CREATE TABLE reservations(id integer PRIMARY KEY,status text DEFAULT 'active',billing_mode text DEFAULT 'standard',monthly_classification boolean DEFAULT false,amount_paid numeric,cash_price numeric);
      CREATE TABLE reservation_site_stays(id serial PRIMARY KEY,reservation_id integer,arrival_date date,leave_date date);
      CREATE TABLE pricing_rules(id integer PRIMARY KEY);
      CREATE TABLE public_booking_checkouts(id integer PRIMARY KEY,reservation_id integer,stripe_checkout_session_id text);
      CREATE TABLE stripe_payment_records(id bigserial PRIMARY KEY,reservation_id integer,payment_status text,currency text,amount_cents bigint,amount_received_cents bigint,paid_at timestamptz);
      CREATE TABLE reservation_payment_events(id bigserial PRIMARY KEY,reservation_id integer,stripe_payment_record_id bigint UNIQUE REFERENCES stripe_payment_records(id),amount numeric,payment_source text CHECK(payment_source IN ('stripe','office_card_reader')),note text,recorded_at timestamptz,created_at timestamptz DEFAULT now());
      INSERT INTO admin_users VALUES(7);
      INSERT INTO reservations(id,amount_paid,cash_price) VALUES(1,150,150),(2,0,150),(3,25,150),(4,0,700),(5,0,150);
      UPDATE reservations SET monthly_classification=true WHERE id=4;
      INSERT INTO reservation_site_stays(reservation_id,arrival_date,leave_date) SELECT id,'2026-07-10','2026-07-13' FROM reservations;
      INSERT INTO stripe_payment_records(reservation_id,payment_status,currency,amount_cents,amount_received_cents,paid_at) VALUES(2,'paid','usd',16000,16000,'2026-07-09T20:00:00Z'),(5,'failed','usd',15000,0,NULL);
      INSERT INTO reservation_payment_events(reservation_id,amount,payment_source,note,recorded_at) VALUES(3,25,'office_card_reader','Tender: cash. Price type: bank','2026-07-10T19:00:00Z');`);
    await pool.query(migration);await pool.query(migration);
    const getReservations=async client=>{
      const r=await client.query('SELECT * FROM reservations ORDER BY id');
      const s=await client.query('SELECT *,arrival_date::text,leave_date::text FROM reservation_site_stays ORDER BY id');
      const e=await client.query('SELECT * FROM reservation_payment_events ORDER BY id');
      return r.rows.map(row=>({...row,first_name:'Test',last_name:`Guest ${row.id}`,amountPaid:Number(row.amount_paid),bankTotalPrice:Number(row.cash_price),
        siteStays:s.rows.filter(stay=>stay.reservation_id===row.id).map(stay=>({...stay,site_number:'A'})),
        paymentEvents:e.rows.filter(event=>event.reservation_id===row.id).map(event=>({...event,paymentSource:event.payment_source,stripePaymentRecordId:event.stripe_payment_record_id,recordedAt:event.recorded_at}))}));
    };
    const routes=new Map(),app=Object.fromEntries(['get','post','patch','delete'].map(method=>[method,(path,handler)=>routes.set(`${method} ${path}`,handler)]));
    registerHistoricalDailyPaymentRoutes(app,{pool,getReservations,notify:event=>events.push(event)});
    const request=async(method,action,body={})=>{
      const res={code:200,status(code){this.code=code;return this;},json(data){this.body=data;return this;}};
      await routes.get(`${method} /api/bookkeeping/historical-daily-payments/${action}`)({query:{from:'2026-07-01',to:'2026-10-27'},body,adminUser:{id:7}},res);return res;
    };
    const preview=await request('get','preview');assert.equal(preview.code,200);assert.equal(preview.body.count,3);
    assert.equal(preview.body.assumedCashTotal,275);assert.equal(preview.body.stripeRecoveredTotal,160);
    assert.equal((await pool.query('SELECT count(*) FROM reservation_payment_events')).rows[0].count,'1');
    const confirm=data=>({from:data.from,to:data.to,snapshot:data.snapshot,confirmAssumedPaid:true});
    const missingConfirmation=await request('post','apply',{...confirm(preview.body),confirmAssumedPaid:false});assert.equal(missingConfirmation.code,400);
    await pool.query('UPDATE reservations SET cash_price=155 WHERE id=1');
    const stale=await request('post','apply',confirm(preview.body));assert.equal(stale.code,409);assert.equal(events.length,0);
    await pool.query('UPDATE reservations SET cash_price=150 WHERE id=1');
    const fresh=await request('get','preview');
    // A later insert failure must not leave earlier cash/Stripe rows or balances.
    await pool.query(`CREATE FUNCTION fail_test_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.reservation_id=3 THEN RAISE EXCEPTION 'Simulated final write failure'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER test_failure BEFORE INSERT ON reservation_payment_events FOR EACH ROW EXECUTE FUNCTION fail_test_insert();`);
    const failure=await request('post','apply',confirm(fresh.body));assert.equal(failure.code,500);
    assert.equal((await pool.query('SELECT count(*) FROM reservation_payment_events')).rows[0].count,'1');
    assert.equal((await pool.query('SELECT count(*) FROM bookkeeping_historical_payment_backfills')).rows[0].count,'0');assert.equal(events.length,0);
    await pool.query('DROP TRIGGER test_failure ON reservation_payment_events');
    const applied=await request('post','apply',confirm(fresh.body));assert.equal(applied.code,200);assert.equal(applied.body.createdCount,3);assert.equal(events.length,1);
    const balances=await pool.query('SELECT id,amount_paid FROM reservations ORDER BY id');
    assert.deepEqual(balances.rows.map(row=>Number(row.amount_paid)),[150,160,150,0,0]);
    const posted=await pool.query("SELECT *, (recorded_at AT TIME ZONE 'America/Los_Angeles')::date::text AS payment_date FROM reservation_payment_events ORDER BY reservation_id,id");
    const cash=posted.rows.find(row=>row.reservation_id===1),stripe=posted.rows.find(row=>row.reservation_id===2);
    assert.equal(cash.historical_assumption,true);assert.equal(cash.historical_date_assumed,true);assert.equal(cash.payment_date,'2026-07-10');
    assert.match(cash.note,/ASSUMED CASH/);assert.equal(stripe.historical_assumption,false);assert.equal(stripe.historical_date_assumed,false);
    assert.equal(stripe.recorded_at.toISOString(),'2026-07-09T20:00:00.000Z');assert.equal(stripe.payment_source,'stripe');
    const audit=await pool.query('SELECT * FROM bookkeeping_historical_payment_backfills ORDER BY id');assert.equal(audit.rowCount,3);
    assert.ok(audit.rows.every(row=>row.created_by_admin_user_id==='7'));assert.equal(audit.rows[0].previous_amount_paid,'150.00');
    assert.equal(audit.rows[0].updated_amount_paid,'150.00');
    const again=await request('get','preview');assert.equal(again.body.count,0);
    const replay=await request('post','apply',confirm(fresh.body));assert.equal(replay.code,409);
    assert.equal((await pool.query('SELECT count(*) FROM reservation_payment_events')).rows[0].count,'4');assert.equal(events.length,1);
  } finally {await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await pool.end();}
});
