import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import twilio from 'twilio';
import { createMessaging, normalizePhone } from './messaging.js';

test('phone matching normalizes US formatting and keeps international country codes', () => {
  assert.equal(normalizePhone('(541) 555-1234'), '+15415551234');
  assert.equal(normalizePhone('+1 541 555 1234'), '+15415551234');
  assert.equal(normalizePhone('+44 20 7946 0000'), '+442079460000');
  assert.equal(normalizePhone(null), '');
});

test('signed incoming and delivery webhooks, invalid signatures, wrong accounts, and database failure', async t => {
  const writes = [];
  let fail = false;
  let notifications = 0;
  let pushNotifications = 0;
  const savedSids = new Set();
  const accountSid = `AC${'1'.repeat(32)}`;
  const authToken = 'test-token';
  const base = 'https://park.example';
  const messaging = createMessaging({
    pool: { query: async (sql, values) => {
      if (fail) throw new Error('Database unavailable');
      writes.push({ sql, values });
      const newlyInserted = !savedSids.has(values[0]);
      savedSids.add(values[0]);
      return { rows: [{ sid: values[0], newly_inserted: newlyInserted }] };
    } }, accountSid, authToken, webhookBaseUrl: base, notify: () => notifications++,
    onIncomingMessage: async () => { pushNotifications++; throw new Error('Push service unavailable'); }
  });
  const app = express();
  app.use('/api/twilio', messaging.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  async function post(path, params, signature) {
    return fetch(`http://127.0.0.1:${server.address().port}/api/twilio/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': signature ?? twilio.getExpectedTwilioSignature(authToken, `${base}/api/twilio/${path}`, params) },
      body: new URLSearchParams(params)
    });
  }
  const params = { AccountSid: accountSid, MessageSid: `SM${'2'.repeat(32)}`,
    From: '+15415551234', To: '+15415554321', Body: 'Hello & thanks!', NumMedia: '0' };
  assert.equal((await post('incoming', params, 'invalid')).status, 403);
  assert.equal(writes.length, 0);
  assert.equal((await post('incoming', { ...params, AccountSid: `AC${'3'.repeat(32)}` })).status, 403);
  const response = await post('incoming', params);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '<Response/>');
  assert.deepEqual(writes[0].values.slice(0, 6), [params.MessageSid, 'inbound', params.From, params.To, params.Body, 'received']);
  assert.match(writes[0].sql, /ON CONFLICT \(sid\) DO UPDATE/);
  assert.equal(notifications, 1);
  assert.equal(pushNotifications, 1, 'push failure must not reject the saved message');
  assert.equal((await post('status', { AccountSid: accountSid, MessageSid: params.MessageSid, MessageStatus: 'delivered' })).status, 204);
  assert.equal(writes[1].values[5], 'delivered');
  assert.equal(pushNotifications, 1, 'delivery status must not send a push alert');
  assert.equal((await post('incoming', params)).status, 200);
  assert.equal(pushNotifications, 1, 'a duplicate webhook must not alert twice');
  await messaging.save({ sid: `SM${'4'.repeat(32)}`, direction: 'inbound', status: 'received' });
  assert.equal(pushNotifications, 1, 'a history import must not send an alert');
  assert.equal((await post('incoming', { ...params, MessageSid: 'invalid' })).status, 400);
  fail = true;
  assert.equal((await post('incoming', params)).status, 503);
  assert.equal(messaging.statusUrl, `${base}/api/twilio/status`);
});

test('history attaches all matching bookings without attaching unrelated guests', async () => {
  let calls = 0;
  const messaging = createMessaging({ pool: { query: async () => ++calls === 1
    ? { rows: [{ sid: 'SM1', direction: 'inbound', from_number: '+15415551234', to_number: '+15415554321', body: 'Hello' }] }
    : { rows: [
      { customer_id: 1, reservation_id: 10, phone_number: '(541) 555-1234' },
      { customer_id: 1, reservation_id: 11, phone_number: '(541) 555-1234' },
      { customer_id: 2, reservation_id: 12, phone_number: '(541) 555-9999' }
    ] } }, notify() {} });
  const history = await messaging.history();
  assert.deepEqual(history.messages[0].bookings.map(booking => booking.reservation_id), [10, 11]);
  assert.equal(history.hasMore, false);
});
