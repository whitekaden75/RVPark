import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { createParkBroadcasts } from './park-broadcasts.js';

const databaseUrl = process.env.RVPARK_TEST_DATABASE_URL;
if (databaseUrl && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl).hostname)) {
  throw new Error('Park SMS tests require a disposable local database.');
}

test('park announcements use actual occupancy and durable send claims', { skip: !databaseUrl }, async t => {
  const schema = `park_sms_${randomUUID().replaceAll('-', '')}`;
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
  const logs = [];
  let date = '2026-11-12';
  let sent = [];
  let configured = true;
  let send = async message => { sent.push(message); return { sid: `SM${sent.length}` }; };
  const create = () => createParkBroadcasts({ pool, today: () => date,
    normalizePhone: phone => /^\d{10}$/.test(phone || '') ? `+1${phone}` : '',
    addFooter: body => `${body}\n\nReply STOP to unsubscribe or HELP for assistance.`,
    configured: () => configured, send: message => send(message), logger: { error: (...args) => logs.push(args) } });
  const service = create();
  async function waitFor(id) {
    for (let tries = 0; tries < 100; tries++) {
      const result = await service.get(id);
      if (result.state !== 'sending') return result;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Announcement did not complete');
  }
  const request = async (body = 'Park update') => ({ id: randomUUID(), fingerprint: (await service.preview()).fingerprint, body });
  try {
    await pool.query(`CREATE SCHEMA ${schema};
      CREATE TABLE customers(id integer PRIMARY KEY,first_name text,last_name text,phone_number text);
      CREATE TABLE reservations(id integer PRIMARY KEY,customer_id integer,status text,notes text,
        reservation_term text DEFAULT 'standard',billing_mode text DEFAULT 'automatic',monthly_classification boolean DEFAULT false,merged_into_reservation_id integer);
      CREATE TABLE rv_sites(id integer PRIMARY KEY,site_number text);
      CREATE TABLE reservation_site_stays(id integer PRIMARY KEY,reservation_id integer,site_id integer,arrival_date date,leave_date date);
      CREATE TABLE text_messages(sid text);
      INSERT INTO rv_sites VALUES(1,'1'),(2,'2');
      INSERT INTO customers SELECT i,'Guest',lpad(i::text,2,'0'),'54155501'||lpad(i::text,2,'0') FROM generate_series(1,12) i;
      INSERT INTO reservations(id,customer_id,status) SELECT i,i,'active' FROM generate_series(1,12) i;
      UPDATE reservations SET billing_mode='monthly' WHERE id=2;
      UPDATE reservations SET reservation_term='yearly' WHERE id=3;
      UPDATE reservations SET status='canceled' WHERE id=7;
      UPDATE reservations SET status='pending' WHERE id=8;
      UPDATE reservations SET notes='Guest did not opt in to text messages.' WHERE id=9;
      UPDATE reservations SET merged_into_reservation_id=1 WHERE id=10;
      UPDATE customers SET phone_number='5415550101' WHERE id=11;
      UPDATE customers SET phone_number=NULL WHERE id=12;
      INSERT INTO reservation_site_stays VALUES
        (1,1,1,'2026-11-10','2026-11-14'),
        (2,2,1,'2026-10-01','9999-12-31'),
        (3,3,2,'2026-01-01','9999-12-31'),
        (4,4,1,'2026-11-13','2026-11-14'),
        (5,5,1,'2026-11-10','2026-11-12'),
        (6,6,1,'2026-10-01','2026-10-04'),(16,6,1,'2026-11-14','2026-11-16'),
        (7,7,1,'2026-11-10','2026-11-14'),(8,8,1,'2026-11-10','2026-11-14'),
        (9,9,1,'2026-11-10','2026-11-14'),(10,10,1,'2026-11-10','2026-11-14'),
        (11,11,1,'2026-11-10','2026-11-14'),(12,12,1,'2026-11-10','2026-11-14'),
        (17,1,2,'2026-11-12','2026-11-14');`);
    await pool.query(await readFile(new URL('../../sql/2026-11-12_park_text_broadcasts.sql', import.meta.url), 'utf8'));

    await t.test('today includes open-ended monthly/yearly, excludes checkout, future, canceled, pending, merged and return-visit gaps', async () => {
      const audience = await service.preview();
      assert.deepEqual(audience.recipients.map(row => row.id), ['1', '2', '3', '9', '11', '12']);
      assert.equal(audience.recipientCount, 3);
      assert.equal(audience.skippedCount, 3);
      assert.deepEqual(audience.recipients[0].sites, ['1', '2']);
      assert.deepEqual(audience.recipients.slice(0, 3).map(row => row.stayType), ['Daily', 'Monthly', 'Yearly']);
      await pool.query("UPDATE reservation_site_stays SET arrival_date='2026-11-12' WHERE id=1");
      assert.equal((await service.preview()).recipients[0].id, '1', 'Today’s arrivals are included');
    });

    await t.test('six concurrent requests and a replay from a new server send once per number', async () => {
      const input = await request();
      await Promise.all(Array.from({ length: 6 }, () => service.start(input)));
      const result = await waitFor(input.id);
      assert.equal(result.state, 'complete');
      assert.equal(result.results.filter(row => row.state === 'queued').length, 3);
      assert.equal(sent.length, 3);
      assert.equal(new Set(sent.map(row => row.to)).size, 3);
      assert.equal(sent[0].body, input.body);
      date = '2026-11-13';
      assert.equal((await create().start(input)).id, input.id);
      assert.equal(sent.length, 3);
      await assert.rejects(service.start({ ...input, body: 'Different update' }), { status: 409 });
      date = '2026-11-12';
    });

    await t.test('changed audience, blank/oversized text and missing configuration fail before delivery', async () => {
      const input = await request();
      await pool.query("UPDATE customers SET phone_number='5415550198' WHERE id=2");
      await assert.rejects(service.start(input), { status: 409 });
      await assert.rejects(service.start({ ...await request(), body: ' ' }), { status: 400 });
      await assert.rejects(service.start({ ...await request(), body: 'x'.repeat(1501) }), { status: 400 });
      configured = false;
      await assert.rejects(service.start(await request()), { status: 503 });
      configured = true;
      assert.equal(sent.length, 3);
    });

    await t.test('provider failures and uncertain responses are reported individually without resending', async () => {
      sent = [];
      send = async message => {
        sent.push(message);
        if (message.to.endsWith('01')) throw Object.assign(new Error('Number blocked'), { status: 400 });
        if (message.to.endsWith('98')) throw new Error('Response lost');
        return { sid: 'SMaccepted', storageWarning: 'Accepted, but inbox storage needs review. Do not resend.' };
      };
      const input = await request('Water update');
      await service.start(input);
      const result = await waitFor(input.id);
      assert.deepEqual(result.results.map(row => row.state), ['failed', 'review', 'queued']);
      assert.match(result.results[1].message, /uncertain/);
      assert.match(result.results[2].message, /Do not resend/);
      await service.start(input);
      assert.equal(sent.length, 3);
    });

    await t.test('interrupted sends retain uncertainty and never resend from a retry', async () => {
      const input = await request('Interrupted update');
      const results = [{ id: '1', phone: '+15415550101', state: 'sending' }, { id: '2', phone: '+15415550198', state: 'waiting' }];
      await pool.query(`INSERT INTO park_text_broadcasts(id,park_date,fingerprint,body,state,results,updated_at)
        VALUES($1,'2026-11-12',$2,$3,'sending',$4::jsonb,now()-interval '3 minutes')`, [input.id, input.fingerprint, input.body, JSON.stringify(results)]);
      const result = await service.get(input.id);
      assert.equal(result.state, 'review');
      assert.deepEqual(result.results.map(row => row.state), ['review', 'skipped']);
      await create().start(input);
      assert.equal(sent.length, 3);
    });
    assert.deepEqual(logs, []);
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  }
});
