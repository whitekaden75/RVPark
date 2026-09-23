import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { pool } from './db.js';
import { createMessaging } from './messaging.js';

const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query(await readFile(new URL('../../sql/2026-09-21_text_messages.sql', import.meta.url), 'utf8'));
  await client.query('COMMIT');
  console.log('Message table migration applied.');

  // Exercise real PostgreSQL conflict handling without leaving test messages behind.
  await client.query('BEGIN');
  const messaging = createMessaging({ pool: client, notify() {} });
  const sid = `SM${randomBytes(16).toString('hex')}`;
  const incoming = { sid, direction: 'inbound', from: '+15415550101', to: '+15415550102', body: 'Storage verification', status: 'received' };
  await messaging.save(incoming);
  await messaging.save(incoming);
  const duplicateCheck = await client.query('SELECT count(*)::int AS count FROM text_messages WHERE sid=$1', [sid]);
  assert.equal(duplicateCheck.rows[0].count, 1);
  const outbound = { ...incoming, sid: `SM${randomBytes(16).toString('hex')}`, direction: 'outbound-api', status: 'delivered' };
  await messaging.save({ ...outbound, body: '' });
  await messaging.save({ ...outbound, status: 'queued' });
  const statusCheck = await client.query('SELECT body,status FROM text_messages WHERE sid=$1', [outbound.sid]);
  assert.equal(statusCheck.rows[0].status, 'delivered');
  assert.equal(statusCheck.rows[0].body, incoming.body);
  await messaging.history();
  await client.query('ROLLBACK');
  console.log('Database verification passed: duplicate delivery, status ordering, body recovery, and booking history query. Test records rolled back.');
} catch (error) {
  await client.query('ROLLBACK');
  console.error('Messaging setup failed:', error.code || error.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
