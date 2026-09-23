export function createMessageNotifier({ pool, webPush, configured, getClientUrl }) {
  return async function notifyIncomingMessage(message) {
    if (!configured()) return;
    const subscriptions = await pool.query(`
      SELECT s.id,s.endpoint,s.p256dh_key,s.auth_key
      FROM admin_push_subscriptions s
      JOIN admin_users a ON a.id=s.admin_user_id
      WHERE a.is_active=TRUE`);
    const notification = JSON.stringify({
      title: 'New guest text message',
      body: `${message.from_number}: ${String(message.body || (message.media_count > 0 ? 'Sent an attachment.' : 'New message.')).slice(0, 140)}`,
      tag: `incoming-text-${message.sid}`,
      url: getClientUrl('/?admin=messages')
    });
    await Promise.allSettled(subscriptions.rows.map(async subscription => {
      try {
        await webPush.sendNotification({ endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh_key, auth: subscription.auth_key }
        }, notification, { timeout: 5000 });
      } catch (error) {
        if (error?.statusCode === 404 || error?.statusCode === 410) {
          await pool.query('DELETE FROM admin_push_subscriptions WHERE id=$1', [subscription.id]);
        } else {
          console.error('Unable to send incoming-text notification', subscription.id, error?.statusCode);
        }
      }
    }));
  };
}
