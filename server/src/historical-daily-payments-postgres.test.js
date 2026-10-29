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
      await routes.get(`${method} /api/bookkeeping/historical-daily-payments/${action}`)({query:{from:'2026-07-01',to:'2026-10-27',...(method==='get'?body:{})},body,adminUser:{id:7}},res);return res;
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
    assert.equal((await request('get','batches')).code,503);
    const undoMigration=await readFile(new URL('../../sql/2026-10-27_undo_historical_daily_payments.sql',import.meta.url),'utf8');
    await pool.query(undoMigration);await pool.query(undoMigration);
    const batchId=applied.body.batchId;
    const history=await request('get','batches');assert.equal(history.body.batches.length,1);assert.equal(history.body.batches[0].createdCount,3);
    const undoPreview=()=>request('get','undo-preview',{batchId});
    const undoBody=plan=>({batchId:plan.batchId,snapshot:plan.snapshot,confirmUndo:true});
    // Existing batches without state snapshots remain reversible if provenance
    // and the original payment history still match.
    const legacy=await undoPreview();assert.equal(legacy.body.canUndo,true,JSON.stringify(legacy.body));
    assert.equal(legacy.body.rows[0].restoredAmountPaid,150);
    await pool.query("UPDATE reservation_payment_events SET note='Edited' WHERE id=$1",[cash.id]);
    assert.equal((await undoPreview()).body.canUndo,false);
    await pool.query('UPDATE reservation_payment_events SET note=$2 WHERE id=$1',[cash.id,cash.note]);
    assert.equal((await request('post','undo',{...undoBody(legacy.body),confirmUndo:false})).code,400);
    const legacyUndone=await request('post','undo',undoBody(legacy.body));assert.equal(legacyUndone.code,200,JSON.stringify(legacyUndone.body));
    assert.equal(legacyUndone.body.undoneCount,3);
    assert.deepEqual((await pool.query('SELECT amount_paid FROM reservations ORDER BY id')).rows.map(row=>Number(row.amount_paid)),[150,0,25,0,0]);
    assert.equal((await pool.query('SELECT count(*) FROM reservation_payment_events')).rows[0].count,'1');
    assert.equal((await pool.query('SELECT count(*) FROM stripe_payment_records')).rows[0].count,'2');
    assert.equal((await pool.query('SELECT count(*) FROM bookkeeping_historical_payment_backfills WHERE reversed_at IS NOT NULL AND reversed_by_admin_user_id=7 AND reversal_snapshot IS NOT NULL AND payment_event_id IS NULL')).rows[0].count,'3');
    assert.equal((await request('get','batches')).body.batches[0].reversedAt!=null,true);
    assert.equal((await request('post','undo',undoBody(legacy.body))).code,409);
    // Re-applying after undo is allowed; the original reversed audit is retained.
    const redo=await request('get','preview');assert.equal(redo.body.count,3);
    const redone=await request('post','apply',confirm(redo.body));assert.equal(redone.code,200);
    const newBatch=redone.body.batchId;
    const freshUndo=()=>request('get','undo-preview',{batchId:newBatch});
    const beforeChange=(await freshUndo()).body;assert.equal(beforeChange.canUndo,true);
    assert.equal((await pool.query('SELECT count(*) FROM bookkeeping_historical_payment_backfills WHERE batch_id=$1 AND undo_state IS NOT NULL',[newBatch])).rows[0].count,'3');
    const later=await pool.query("INSERT INTO reservation_payment_events(reservation_id,amount,payment_source,note,recorded_at) VALUES(1,10,'office_card_reader','Tender: cash',now()) RETURNING id");
    await pool.query('UPDATE reservations SET amount_paid=160 WHERE id=1');
    const changed=(await freshUndo()).body;assert.equal(changed.canUndo,false);
    assert.equal((await request('post','undo',undoBody(beforeChange))).code,409);
    assert.equal((await request('post','undo',undoBody(changed))).code,409);
    assert.equal((await pool.query('SELECT amount_paid FROM reservations WHERE id=1')).rows[0].amount_paid,'160');
    await pool.query('DELETE FROM reservation_payment_events WHERE id=$1',[later.rows[0].id]);
    await pool.query('UPDATE reservations SET amount_paid=150 WHERE id=1');
    assert.equal((await freshUndo()).body.canUndo,true);
    // Same-dollar edits to older events and changed booking details also block undo.
    await pool.query("UPDATE reservation_payment_events SET note='changed old cash note' WHERE reservation_id=3 AND historical_assumption=false");
    assert.equal((await freshUndo()).body.canUndo,false);
    await pool.query("UPDATE reservation_payment_events SET note='Tender: cash. Price type: bank' WHERE reservation_id=3 AND historical_assumption=false");
    await pool.query('UPDATE reservations SET cash_price=155 WHERE id=1');assert.equal((await freshUndo()).body.canUndo,false);
    await pool.query('UPDATE reservations SET cash_price=150 WHERE id=1');
    const finalPreview=(await freshUndo()).body;assert.equal(finalPreview.canUndo,true);
    await pool.query(`CREATE FUNCTION fail_test_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.reservation_id=3 THEN RAISE EXCEPTION 'Simulated undo failure'; END IF; RETURN OLD; END; $$;
      CREATE TRIGGER test_undo_failure BEFORE DELETE ON reservation_payment_events FOR EACH ROW EXECUTE FUNCTION fail_test_delete();`);
    assert.equal((await request('post','undo',undoBody(finalPreview))).code,500);
    assert.equal((await pool.query('SELECT count(*) FROM reservation_payment_events')).rows[0].count,'4');
    assert.equal((await pool.query('SELECT count(*) FROM bookkeeping_historical_payment_backfills WHERE batch_id=$1 AND reversed_at IS NULL',[newBatch])).rows[0].count,'3');
    await pool.query('DROP TRIGGER test_undo_failure ON reservation_payment_events');
    assert.equal((await request('post','undo',undoBody(finalPreview))).code,200);
    assert.deepEqual((await pool.query('SELECT amount_paid FROM reservations ORDER BY id')).rows.map(row=>Number(row.amount_paid)),[150,0,25,0,0]);
    // Multiple recovered Stripe rows on one reservation share the final state;
    // an originally unknown paid total must return to NULL, rather than zero.
    await pool.query(`INSERT INTO reservations(id,amount_paid,cash_price) VALUES(6,NULL,80),(7,0,200);
      INSERT INTO reservation_site_stays(reservation_id,arrival_date,leave_date) VALUES(6,'2026-07-10','2026-07-13'),(7,'2026-07-10','2026-07-13');
      INSERT INTO stripe_payment_records(reservation_id,payment_status,currency,amount_cents,amount_received_cents,paid_at) VALUES(7,'paid','usd',10000,10000,'2026-07-09T20:00:00Z'),(7,'paid','usd',10000,10000,'2026-07-10T20:00:00Z');`);
    const multi=await request('get','preview');assert.equal(multi.body.count,6);
    const appliedMulti=await request('post','apply',confirm(multi.body));assert.equal(appliedMulti.code,200);
    const multiUndo=(await request('get','undo-preview',{batchId:appliedMulti.body.batchId})).body;assert.equal(multiUndo.canUndo,true);
    assert.equal(multiUndo.rows.find(row=>row.reservationId==='6').restoredAmountPaid,null);
    assert.equal(multiUndo.rows.find(row=>row.reservationId==='7').restoredAmountPaid,0);
    assert.equal((await request('post','undo',undoBody(multiUndo))).code,200);
    assert.equal((await pool.query('SELECT amount_paid FROM reservations WHERE id=6')).rows[0].amount_paid,null);
    assert.equal((await pool.query('SELECT amount_paid FROM reservations WHERE id=7')).rows[0].amount_paid,'0');
    assert.equal((await pool.query('SELECT count(*) FROM reservation_payment_events')).rows[0].count,'1');
  } finally {await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await pool.end();}
});
