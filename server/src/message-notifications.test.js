import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageNotifier } from './message-notifications.js';

test('only opted-in active admins receive incoming text alerts, stale endpoints are removed', async () => {
  const deliveries = [];
  const deletes = [];
  const notify = createMessageNotifier({
    configured: () => true,
    getClientUrl: path => `https://park.example${path}`,
    pool: { query: async (sql, params) => {
      if (sql.startsWith('DELETE')) { deletes.push(params[0]); return {}; }
      assert.match(sql, /FROM admin_push_subscriptions s/);
      assert.match(sql, /JOIN admin_users/);
      assert.match(sql, /a.is_active=TRUE/);
      return { rows: [1, 2, 3].map(id => ({ id, endpoint: `endpoint-${id}`, p256dh_key: 'key', auth_key: 'auth' })) };
    } },
    webPush: { sendNotification: async (subscription, payload, options) => {
      deliveries.push({ subscription, payload: JSON.parse(payload), options });
      if (subscription.endpoint === 'endpoint-2') throw { statusCode: 410 };
      if (subscription.endpoint === 'endpoint-3') throw { statusCode: 503 };
    } }
  });
  await notify({ sid: 'SM-test', from_number: '+15415551234', body: 'Arriving at 3 PM.' });
  assert.equal(deliveries.length, 3);
  assert.deepEqual(deletes, [2]);
  assert.equal(deliveries[0].payload.url, 'https://park.example/?admin=messages');
  assert.equal(deliveries[0].payload.tag, 'incoming-text-SM-test');
  assert.match(deliveries[0].payload.body, /Arriving at 3 PM/);
  assert.equal(deliveries[0].options.timeout, 5000);
});

test('disabled push does not query subscriptions or send notifications', async () => {
  const notify = createMessageNotifier({ configured: () => false,
    pool: { query() { assert.fail('No subscription lookup expected'); } },
    webPush: { sendNotification() { assert.fail('No delivery expected'); } }
  });
  await notify({ sid: 'SM-test' });
});

test('media-only messages have a useful alert preview', async () => {
  const notify = createMessageNotifier({ configured: () => true, getClientUrl: path => path,
    pool: { query: async () => ({ rows: [{ id: 1, endpoint: 'phone' }] }) },
    webPush: { sendNotification: async (_, payload) => assert.match(JSON.parse(payload).body, /Sent an attachment/) }
  });
  await notify({ sid: 'SM-media', from_number: '+15415551234', body: '', media_count: 1 });
});
