import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { registerLodgingRoutes } from './bookkeeping-lodging.js';

const databaseUrl=process.env.RVPARK_TEST_DATABASE_URL;
if(databaseUrl && !['localhost','127.0.0.1','[::1]'].includes(new URL(databaseUrl).hostname))throw new Error('Lodging tests require a disposable local database.');

test('spreadsheet SQL imports idempotently and lodging endpoints run against PostgreSQL', {skip:!databaseUrl},async()=>{
  const schema=`lodging_test_${randomUUID().replaceAll('-','')}`;
  const pool=new pg.Pool({connectionString:databaseUrl,options:`-c search_path=${schema},public`});
  const sql=await readFile(new URL('../../sql/2026-10-27_import_meter_readings_2026.sql',import.meta.url),'utf8');
  try {
    await pool.query(`CREATE SCHEMA ${schema};
      CREATE TABLE customers(id integer PRIMARY KEY,first_name text,last_name text);
      CREATE TABLE reservations(id integer PRIMARY KEY,customer_id integer,status text DEFAULT 'active',reservation_term text DEFAULT 'standard',
        billing_mode text DEFAULT 'standard',monthly_rent_price numeric,monthly_billing_day integer,monthly_classification boolean DEFAULT false,
        electric_meter_reading numeric,merged_into_reservation_id bigint);
      CREATE TABLE rv_sites(id integer PRIMARY KEY,site_number text);
      CREATE TABLE reservation_site_stays(id serial PRIMARY KEY,reservation_id integer,site_id integer,arrival_date date,leave_date date);
      CREATE TABLE monthly_meter_readings(id bigserial PRIMARY KEY,reservation_id integer,reading numeric,reading_date date,note text,created_at timestamptz DEFAULT now());
      CREATE TABLE reservation_payment_events(id bigserial PRIMARY KEY,reservation_id integer,amount numeric,payment_source text,recorded_at timestamptz);
      CREATE TABLE bookkeeping_stripe_activity(id text PRIMARY KEY,reservation_id bigint,amount_cents bigint,currency text,description text,occurred_at timestamptz,livemode boolean,reporting_category text,activity_type text);
      INSERT INTO customers VALUES(1,'Test','Edwards'),(2,'Test','Haag'),(3,'Test','Voss'),(4,'Daily','Guest'),(5,'Other','Unrelated');
      INSERT INTO reservations(id,customer_id,monthly_rent_price,monthly_billing_day,reservation_term) VALUES(1,1,700,1,'yearly'),(2,2,600,16,'standard'),(3,2,600,16,'standard'),(4,3,900,1,'yearly'),(5,4,NULL,NULL,'standard'),(6,5,500,1,'standard');
      INSERT INTO rv_sites VALUES(1,'1'),(2,'2'),(3,'Cabin'),(4,'99'),(5,'7');
      INSERT INTO reservation_site_stays(reservation_id,site_id,arrival_date,leave_date) VALUES(1,1,'2026-07-01','9999-12-31'),(2,2,'2026-07-01','9999-12-31'),(3,2,'2026-07-01','9999-12-31'),(4,3,'2026-07-01','9999-12-31'),(5,4,'2026-09-01','2026-09-05'),(6,5,'2026-07-01','9999-12-31');
      INSERT INTO monthly_meter_readings(reservation_id,reading,reading_date,note) VALUES(1,5000,'2026-10-20','Existing newer manual reading');
      INSERT INTO reservation_payment_events(reservation_id,amount,payment_source,recorded_at) VALUES(5,100,'office_cash','2026-09-01 23:00:00-07'),(5,50,'stripe','2026-10-01 00:30:00+00'),(1,700,'office_cash','2026-09-03 12:00:00-07');`);
    await pool.query(sql);
    assert.equal((await pool.query('SELECT count(*) FROM bookkeeping_monthly_utility_sources')).rows[0].count,'62');

    await pool.query(`INSERT INTO bookkeeping_monthly_utility_sources
      (source_key,source_filename,source_sheet,source_row,source_kind,site_number,guest_name,billing_month,reading_date,meter_reading,reservation_id)
      VALUES ('future-test','Test only','Test',1,'rv_meter','1','Test Edwards',date_trunc('month',CURRENT_DATE)::date,CURRENT_DATE+1,999999,1);
      SELECT sync_imported_monthly_meters();`);
    assert.equal((await pool.query("SELECT count(*) FROM monthly_meter_readings WHERE import_source_key='future-test'")).rows[0].count,'0');
    await pool.query("DELETE FROM bookkeeping_monthly_utility_sources WHERE source_key='future-test'");
    assert.equal((await pool.query("SELECT count(*) FROM bookkeeping_monthly_utility_sources WHERE source_sheet='November'")).rows[0].count,'0');
    const assigned=await pool.query('SELECT * FROM bookkeeping_monthly_utility_sources WHERE reservation_id IS NOT NULL');
    assert.equal(assigned.rows.length,6); // Unique surname/site match plus cabin; ambiguous Haag stays unlinked.
    assert.ok(assigned.rows.every(row=>['1','4'].includes(row.reservation_id)));
    assert.equal((await pool.query('SELECT electric_meter_reading FROM reservations WHERE id=1')).rows[0].electric_meter_reading,'5000');
    assert.equal((await pool.query('SELECT monthly_classification FROM reservations WHERE id=1')).rows[0].monthly_classification,true);
    assert.equal((await pool.query('SELECT count(*) FROM monthly_meter_readings')).rows[0].count,'4');
    await pool.query(sql);
    assert.equal((await pool.query('SELECT count(*) FROM monthly_meter_readings')).rows[0].count,'4');
    assert.equal((await pool.query('SELECT count(*) FROM bookkeeping_monthly_utility_sources')).rows[0].count,'62');

    const routes=new Map(),events=[];
    const app=Object.fromEntries(['get','post','patch','delete'].map(method=>[method,(path,handler)=>routes.set(`${method} ${path}`,handler)]));
    registerLodgingRoutes(app,{pool,notify:event=>events.push(event)});
    const request=async(method,path,{query={},params={},body={}}={})=>{
      const res={code:200,status(code){this.code=code;return this;},json(data){this.body=data;return this;}};
      await routes.get(`${method} ${path}`)({query,params,body,adminUser:{id:7}},res);return res;
    };
    const before=await request('get','/api/bookkeeping/lodging-tax',{query:{from:'2026-09-01',to:'2026-09-30'}});
    assert.equal(before.code,200);assert.equal(before.body.totals.dailyReceipts,150);assert.equal(before.body.totals.monthlyRecordedReceipts,700);
    assert.equal(before.body.monthlyDetails.find(row=>String(row.reservationId)==='1').total,893.26);
    assert.equal(before.body.cabinBills[0].power_amount,'42.00');
    const source=await pool.query("SELECT id FROM bookkeeping_monthly_utility_sources WHERE source_key='meter-readings-2026:september:H4'");
    const params={id:source.rows[0].id};
    const linked=await request('patch','/api/bookkeeping/lodging-tax/sources/:id',{params,body:{reservationId:2,rentOverride:0}});
    assert.equal(linked.code,200);assert.equal(linked.body.source.reservation_id,'2');assert.equal(linked.body.source.rent_override,'0.00');
    assert.equal(events.length,1);
    assert.equal((await pool.query('SELECT count(*) FROM monthly_meter_readings WHERE reservation_id=2')).rows[0].count,'1');
    const changed=await request('patch','/api/bookkeeping/lodging-tax/sources/:id',{params,body:{reservationId:3}});
    assert.equal(changed.code,409);assert.equal(events.length,1);
    const bad=await request('patch','/api/bookkeeping/lodging-tax/sources/:id',{params,body:{rentOverride:-1}});
    assert.equal(bad.code,400);assert.equal(events.length,1);
    const after=await request('get','/api/bookkeeping/lodging-tax',{query:{from:'2026-09-01',to:'2026-09-30'}});
    assert.equal(after.body.monthlyDetails.find(row=>String(row.reservationId)==='2').rent,0);
    assert.equal((await pool.query('SELECT count(*) FROM reservation_payment_events')).rows[0].count,'3');
    await pool.query('ALTER TABLE bookkeeping_monthly_utility_sources RENAME TO test_hidden_sources');
    const unavailable=await request('get','/api/bookkeeping/lodging-tax',{query:{from:'2026-09-01',to:'2026-09-30'}});
    assert.equal(unavailable.code,503);assert.match(unavailable.body.message,/2026-10-27_import_meter_readings_2026.sql/);
  } finally {await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await pool.end();}
});
