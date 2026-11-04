import { storageConsentText, storageConsentVersion } from './saved-payment-methods.js';

const objectId = value => typeof value === 'string' ? value : value?.id;
const fail = message => Object.assign(new Error(message), { status: 400 });

export function createTerminalCardStorage({ pool, stripe, savedMethods, getReservation, now = () => new Date(), logger = console }) {
  async function prepare(body, reservation, adminUserId) {
    if (body.rememberCard !== undefined && typeof body.rememberCard !== 'boolean') throw fail('Choose whether to remember this card.');
    if (body.rememberCard !== true) return null;
    if (body.storageAccepted !== true) throw fail('Confirm the guest agreed to remember this card.');
    // Check storage before creating an intent or handing anything to the reader.
    await pool.query('SELECT stripe_payment_intent_id FROM terminal_card_save_requests LIMIT 0');
    return { customer: await savedMethods.customerFor(reservation), at: now().toISOString(),
      version: storageConsentVersion, text: storageConsentText, adminUserId };
  }

  async function remember(intent, reservation, consent) {
    if (!consent) return;
    await pool.query(`INSERT INTO terminal_card_save_requests
      (stripe_payment_intent_id,reservation_id,customer_id,stripe_customer_id,consent_at,consent_version,consent_text,admin_user_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
    [intent.id, reservation.id, reservation.customer_id, consent.customer, consent.at, consent.version, consent.text, consent.adminUserId]);
  }

  async function complete(intentId) {
    const result = await pool.query('SELECT * FROM terminal_card_save_requests WHERE stripe_payment_intent_id=$1', [intentId]);
    const request = result.rows[0];
    if (!request) return null;
    if (request.completed_at) return { status: request.status };
    const intent = await stripe.paymentIntents.retrieve(intentId, { expand: ['latest_charge', 'payment_method'] });
    if (intent.status !== 'succeeded') return { status: 'pending' };
    if (objectId(intent.customer) !== request.stripe_customer_id || intent.setup_future_usage !== 'off_session') {
      throw new Error('Remembered card customer or setup mismatch.');
    }
    const cardPresent = intent.payment_method_types.includes('card_present');
    const methodId = cardPresent
      ? intent.latest_charge?.payment_method_details?.card_present?.generated_card
      : objectId(intent.payment_method);
    const method = methodId ? await stripe.paymentMethods.retrieve(methodId) : null;
    // A wallet or unsupported card may pay successfully without a reusable card.
    // Never store the card_present method itself or attach an unrelated card.
    const available = method?.type === 'card' && objectId(method.customer) === request.stripe_customer_id;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = (await client.query('SELECT * FROM terminal_card_save_requests WHERE stripe_payment_intent_id=$1 FOR UPDATE', [intentId])).rows[0];
      if (locked.completed_at) { await client.query('COMMIT'); return { status: locked.status }; }
      const reservation = await getReservation(client, locked.reservation_id);
      if (!reservation || String(reservation.customer_id) !== String(locked.customer_id)) throw new Error('Remembered card reservation customer mismatch.');
      const saved = available && await savedMethods.saveMethod(client, { reservation, method,
        stripeCustomerId: locked.stripe_customer_id, consentAt: locked.consent_at,
        consentVersion: locked.consent_version, consentText: locked.consent_text, source: 'terminal_payment' });
      const status = saved ? 'saved' : 'unavailable';
      await client.query(`UPDATE terminal_card_save_requests SET status=$2,completed_at=NOW(),stripe_payment_method_id=$3
        WHERE stripe_payment_intent_id=$1`, [intentId, status, saved ? method.id : null]);
      await client.query('COMMIT');
      return { status };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async function refresh({ reservationId = null, customerId = null } = {}) {
    try {
      const requests = await pool.query(`SELECT stripe_payment_intent_id FROM terminal_card_save_requests
        WHERE completed_at IS NULL AND ($1::bigint IS NULL OR reservation_id=$1)
          AND ($2::bigint IS NULL OR customer_id=$2) AND created_at>NOW()-INTERVAL '90 days'
        ORDER BY created_at LIMIT 20`, [reservationId, customerId]);
      for (const row of requests.rows) {
        try { await complete(row.stripe_payment_intent_id); }
        catch (error) { logger.error('Terminal card storage is pending', row.stripe_payment_intent_id, error.code || error.message); }
      }
    } catch (error) {
      // Card-storage recovery never rolls back or hides a successful payment.
      if (error.code !== '42P01') logger.error('Unable to refresh terminal card storage', error.code || error.message);
    }
  }
  return { prepare, remember, complete, refresh };
}
