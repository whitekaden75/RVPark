import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createTerminalCardStorage } from './terminal-card-storage.js';
import { storageConsentText } from './saved-payment-methods.js';

const runtime = process.env.RVPARK_TEST_PGLITE_MODULE;
test('terminal consent, generated-card persistence, retries and unsupported cards use a real PostgreSQL ledger', { skip: !runtime }, async () => {
  const { PGlite } = await import(runtime);
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE reservations(id bigint PRIMARY KEY,customer_id bigint,amount_paid numeric);
      CREATE TABLE customers(id bigint PRIMARY KEY);
      CREATE TABLE admin_users(id bigint PRIMARY KEY);
      CREATE TABLE methods(method_id text PRIMARY KEY,customer_id bigint,source text,consent_text text);
      INSERT INTO customers VALUES(30); INSERT INTO reservations VALUES(42,30,140); INSERT INTO admin_users VALUES(7);`);
    const migration = await readFile(new URL('../../sql/2026-11-04_terminal_card_storage.sql', import.meta.url), 'utf8');
    await db.exec(migration); await db.exec(migration);
    const query = async (...args) => { const result = await db.query(...args); return { ...result, rowCount: result.rows.length || result.affectedRows || 0 }; };
    const pool = { query, connect: async () => ({ query, release() {} }) };
    let customerCalls = 0, providerFails = false;
    const intent = { id: 'pi_terminal', status: 'processing', customer: 'cus_guest', setup_future_usage: 'off_session', payment_method_types: ['card_present'],
      payment_method: { id: 'pm_raw_reader', type: 'card_present' }, latest_charge: { payment_method_details: { card_present: { generated_card: 'pm_reusable' } } } };
    const method = { id: 'pm_reusable', type: 'card', customer: 'cus_guest', card: { brand: 'visa', last4: '4242' } };
    const service = createTerminalCardStorage({ pool,
      stripe: { paymentIntents: { retrieve: async () => { if (providerFails) throw new Error('Stripe unavailable'); return intent; } },
        paymentMethods: { retrieve: async id => { assert.equal(id, 'pm_reusable'); return method; } } },
      savedMethods: { customerFor: async () => { customerCalls++; return 'cus_guest'; },
        saveMethod: async (client, details) => {
          assert.equal(details.method.type, 'card'); assert.equal(details.consentText, storageConsentText);
          await client.query('INSERT INTO methods VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
            [details.method.id, details.reservation.customer_id, details.source, details.consentText]); return true;
        } }, getReservation: async () => ({ id: 42, customer_id: 30 }), now: () => new Date('2026-11-04T20:00:00Z'), logger: { error() {} },
    });
    assert.equal(await service.prepare({}, { id: 42 }, 7), null);
    assert.equal(customerCalls, 0);
    await assert.rejects(service.prepare({ rememberCard: 'true', storageAccepted: true }, { id: 42 }, 7));
    await assert.rejects(service.prepare({ rememberCard: true, storageAccepted: false }, { id: 42 }, 7));
    const consent = await service.prepare({ rememberCard: true, storageAccepted: true }, { id: 42 }, 7);
    const reservation = { id: 42, customer_id: 30 };
    await service.remember(intent, reservation, consent);
    await service.remember(intent, reservation, consent);
    assert.equal((await db.query('SELECT * FROM terminal_card_save_requests')).rows.length, 1);
    assert.deepEqual(await service.complete(intent.id), { status: 'pending' });
    assert.equal((await db.query('SELECT * FROM methods')).rows.length, 0);
    intent.status = 'succeeded'; providerFails = true;
    await service.refresh();
    assert.equal((await db.query('SELECT completed_at FROM terminal_card_save_requests')).rows[0].completed_at, null);
    providerFails = false;
    assert.deepEqual(await service.complete(intent.id), { status: 'saved' });
    assert.deepEqual(await service.complete(intent.id), { status: 'saved' });
    const saved = (await db.query('SELECT * FROM methods')).rows;
    assert.equal(saved.length, 1); assert.equal(saved[0].method_id, 'pm_reusable'); assert.equal(saved[0].source, 'terminal_payment');
    assert.equal(Number((await db.query('SELECT amount_paid FROM reservations')).rows[0].amount_paid), 140);
    assert.equal((await db.query('SELECT admin_user_id FROM terminal_card_save_requests')).rows[0].admin_user_id, 7);
    await db.exec("DELETE FROM terminal_card_save_requests; DELETE FROM methods;");
    intent.customer = 'cus_other'; await service.remember(intent, reservation, consent);
    await assert.rejects(service.complete(intent.id), /customer or setup mismatch/);
    assert.equal((await db.query('SELECT * FROM methods')).rows.length, 0);
    intent.customer = 'cus_guest'; intent.latest_charge.payment_method_details.card_present.generated_card = null;
    assert.deepEqual(await service.complete(intent.id), { status: 'unavailable' });
    assert.equal((await db.query('SELECT * FROM methods')).rows.length, 0);
    assert.equal(await service.complete('pi_unrequested'), null);
  } finally { await db.close(); }
});
