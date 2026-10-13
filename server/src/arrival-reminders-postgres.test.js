import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createArrivalReminders} from './arrival-reminders.js';
import {createLateArrivalTexts} from './late-arrivals.js';

// An isolated schema on a disposable local DB exercises PostgreSQL's actual
// parameter inference and unique claims, which a mocked query cannot verify.
const databaseUrl=process.env.RVPARK_TEST_DATABASE_URL;
if(databaseUrl && !['localhost','127.0.0.1','[::1]'].includes(new URL(databaseUrl).hostname)) {
  throw new Error('SMS PostgreSQL regression tests require a disposable local database.');
}
test('preset SMS claims accept both integer/bigint reservation IDs and concurrent sends claim once',
  {skip:!databaseUrl},async()=>{
  let reproducedTypingError=false;
  for(const [idType,logIdType] of [['integer','integer'],['integer','bigint'],['bigint','integer'],['bigint','bigint']]) {
    const schema=`sms_test_${randomUUID().replaceAll('-','')}`;
    const pool=new pg.Pool({connectionString:databaseUrl,options:`-c search_path=${schema},public`});
    try {
      await pool.query(`CREATE SCHEMA ${schema};
        CREATE TABLE customers(id ${idType} PRIMARY KEY,first_name text,last_name text,phone_number text);
        CREATE TABLE reservations(id ${idType} PRIMARY KEY,customer_id ${idType},status text,created_at timestamptz,notes text);
        CREATE TABLE reservation_site_stays(id bigint PRIMARY KEY,reservation_id bigint,arrival_date date,leave_date date);
        CREATE TABLE reservation_check_ins(reservation_id bigint,reservation_site_stay_id bigint);
        CREATE TABLE text_messages(sid text);
        CREATE TABLE arrival_text_reminders(reservation_id ${logIdType},arrival_date date,state text,message_sid text,error_message text,updated_at timestamptz DEFAULT now(),PRIMARY KEY(reservation_id,arrival_date));
        CREATE TABLE late_arrival_texts(reservation_id ${logIdType},arrival_date date,state text,automatic bool,attempts int,retryable bool DEFAULT false,message_sid text,error_message text,updated_at timestamptz DEFAULT now(),PRIMARY KEY(reservation_id,arrival_date));
        INSERT INTO customers VALUES(1,'Test','Guest','5415550101');
        INSERT INTO reservations VALUES(1,1,'active','2026-10-14T01:05:00Z',''),(2,1,'active','2026-10-14T01:05:00Z','');
        INSERT INTO reservation_site_stays VALUES(1,1,'2026-10-13','2026-10-14'),(2,2,'2026-10-13','2026-10-14');`);
      // Reproduce the original error before exercising the fixed production SQL.
      try {
        await pool.query(`INSERT INTO arrival_text_reminders(reservation_id,arrival_date,state)
          SELECT $1,$2,'sending' FROM reservations r
          WHERE r.id=$1 AND to_jsonb(r)->>'merged_into_reservation_id' IS NULL
          ON CONFLICT(reservation_id,arrival_date) DO UPDATE SET state='sending',error_message=NULL,updated_at=now()
            WHERE arrival_text_reminders.state='failed' RETURNING reservation_id`,[1,'2026-10-13']);
        await pool.query('DELETE FROM arrival_text_reminders');
      } catch(error) {assert.equal(error.code,'42P08');reproducedTypingError=true;}
      const booking=id=>({id,status:'active',first_name:'Test',last_name:'Guest',phone_number:'5415550101',
        created_at:'2026-10-14T01:05:00Z',siteStays:[{id:Number(id),site_number:'5',arrival_date:'2026-10-13',leave_date:'2026-10-14'}]});
      const sent=[];
      const dependencies={pool,getReservation:async id=>booking(id),normalizePhone:p=>`+1${p}`,
        configured:()=>true,send:async message=>{sent.push(message);return {sid:`SMtest${sent.length}`};}};
      const reminders=createArrivalReminders({...dependencies,today:()=> '2026-10-13',tomorrow:()=> '2026-10-14',formatDate:d=>d});
      const results=await Promise.all(Array.from({length:6},()=>reminders.sendBatch('2026-10-13',[1],{'1':'Custom preset draft'})));
      assert.equal(results.flatMap(r=>r.results).filter(r=>r.state==='sent').length,1);
      assert.equal(sent.length,1);assert.equal(sent[0].body,'Custom preset draft');
      assert.equal((await pool.query('SELECT state FROM arrival_text_reminders WHERE reservation_id=1')).rows[0].state,'sent');
      const late=createLateArrivalTexts({...dependencies,now:()=>new Date('2026-10-14T01:10:00Z')});
      const lateResults=await Promise.all(Array.from({length:6},()=>late.sendReservation('2',{automatic:false,customBody:'Custom late arrival draft'})));
      assert.equal(lateResults.filter(r=>r.state==='sent').length,1);
      assert.equal(sent.length,2);assert.equal(sent[1].body,'Custom late arrival draft');
      assert.equal((await pool.query('SELECT state FROM late_arrival_texts WHERE reservation_id=2')).rows[0].state,'sent');
      assert.equal((await late.sendReservation('2',{automatic:true})).state,'skipped');assert.equal(sent.length,2);
    } finally {await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await pool.end();}
  }
  assert.equal(reproducedTypingError,true,'Original mixed ID types did not reproduce the reported SQL error');
});
