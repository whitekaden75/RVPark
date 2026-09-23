import express from 'express';
import twilio from 'twilio';

export function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length === 10 ? `+1${digits}` : digits ? `+${digits}` : '';
}

export function createMessaging({ pool, accountSid, authToken, webhookBaseUrl, notify, onIncomingMessage = async () => {} }) {
  const base = String(webhookBaseUrl || '').replace(/\/+$/, '');
  const router = express.Router();
  router.use(express.urlencoded({ extended: false, limit: '64kb' }));
  router.use((req, res, next) => {
    if (!authToken || !base) return res.status(503).send('Messaging webhooks are not configured.');
    if (!twilio.validateRequest(authToken, req.get('X-Twilio-Signature') || '', `${base}${req.originalUrl}`, req.body || {}) || req.body.AccountSid !== accountSid) {
      return res.status(403).send('Invalid Twilio signature or account.');
    }
    next();
  });

  async function save(message) {
    // Status callbacks can arrive before the send response; never regress a terminal status.
    const result = await pool.query(`
      INSERT INTO text_messages (sid,direction,from_number,to_number,body,status,error_code,media_count,message_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::timestamptz,now()))
      ON CONFLICT (sid) DO UPDATE SET
        from_number=COALESCE(NULLIF(EXCLUDED.from_number,''),text_messages.from_number),
        to_number=COALESCE(NULLIF(EXCLUDED.to_number,''),text_messages.to_number),
        body=COALESCE(NULLIF(EXCLUDED.body,''),text_messages.body),
        status=CASE
          WHEN text_messages.status IN ('delivered','read','failed','undelivered','received') THEN text_messages.status
          WHEN text_messages.status='sent' AND EXCLUDED.status IN ('accepted','queued','sending') THEN text_messages.status
          WHEN text_messages.status='sending' AND EXCLUDED.status IN ('accepted','queued') THEN text_messages.status
          ELSE EXCLUDED.status END,
        error_code=COALESCE(EXCLUDED.error_code,text_messages.error_code),
        media_count=GREATEST(EXCLUDED.media_count,text_messages.media_count),updated_at=now()
      RETURNING *, (xmax = 0) AS newly_inserted`, [message.sid, message.direction || 'outbound-api', message.from || '', message.to || '',
      message.body || '', message.status || 'queued', message.error_code || null,
      Number(message.num_media) || 0, message.date_sent || message.date_created || null]);
    notify({ reason: 'messages_changed' });
    return result.rows[0];
  }

  router.post('/incoming', async (req, res) => {
    if (!/^(SM|MM)[0-9a-f]{32}$/i.test(req.body.MessageSid || '') || !req.body.From || !req.body.To) return res.sendStatus(400);
    try {
      const message = await save({ sid: req.body.MessageSid, direction: 'inbound', from: req.body.From, to: req.body.To,
        body: req.body.Body, status: 'received', num_media: req.body.NumMedia });
      // Acknowledge storage even if push delivery fails. Only a new live inbound
      // message triggers alerts; webhook retries and history imports do not.
      if (message.newly_inserted) {
        try { await onIncomingMessage(message); }
        catch (error) { console.error('Unable to prepare incoming-text notifications', error.code || error.message); }
      }
      return res.type('text/xml').send('<Response/>');
    } catch (error) {
      console.error('Unable to store incoming SMS', error.code);
      return res.sendStatus(503);
    }
  });
  router.post('/status', async (req, res) => {
    if (!/^(SM|MM)[0-9a-f]{32}$/i.test(req.body.MessageSid || '') || !req.body.MessageStatus) return res.sendStatus(400);
    try {
      await save({ sid: req.body.MessageSid, from: req.body.From, to: req.body.To,
        status: req.body.MessageStatus, error_code: req.body.ErrorCode });
      return res.sendStatus(204);
    } catch (error) {
      console.error('Unable to store SMS delivery status', error.code);
      return res.sendStatus(503);
    }
  });

  async function history(offset = 0) {
    const result = await pool.query(`SELECT * FROM text_messages ORDER BY message_at DESC,sid DESC LIMIT 101 OFFSET $1`, [offset]);
    const rows = result.rows.slice(0, 100);
    const phones = [...new Set(rows.map(row => normalizePhone(row.direction === 'inbound' ? row.from_number : row.to_number)))];
    const matches = await pool.query(`
      SELECT c.id AS customer_id,c.first_name,c.last_name,c.phone_number,
        r.id AS reservation_id,r.status,r.total_price,r.amount_paid,
        (SELECT json_agg(json_build_object('site',s.site_number,'arrival',st.arrival_date::text,'departure',st.leave_date::text) ORDER BY st.arrival_date)
         FROM reservation_site_stays st JOIN rv_sites s ON s.id=st.site_id WHERE st.reservation_id=r.id) AS stays
      FROM customers c LEFT JOIN reservations r ON r.customer_id=c.id
      WHERE (CASE WHEN length(regexp_replace(c.phone_number,'[^0-9]','','g'))=10 THEN '+1' ELSE '+' END || regexp_replace(c.phone_number,'[^0-9]','','g')) = ANY($1::text[])
      ORDER BY r.id DESC`, [phones]);
    return { hasMore: result.rows.length > 100, messages: rows.map(row => ({
      sid: row.sid, direction: row.direction, from: row.from_number, to: row.to_number,
      body: row.body, status: row.status, dateSent: row.message_at, errorCode: row.error_code, mediaCount: row.media_count,
      bookings: matches.rows.filter(match => normalizePhone(match.phone_number) === normalizePhone(row.direction === 'inbound' ? row.from_number : row.to_number))
    })) };
  }
  async function markConversationRead(phone) {
    const normalized = normalizePhone(phone);
    if (!normalized) return;
    await pool.query(`UPDATE text_messages SET status='read', updated_at=now() WHERE direction='inbound' AND status <> 'read' AND regexp_replace(from_number,'[^0-9]','','g') = regexp_replace($1,'[^0-9]','','g')`, [normalized]);
  }
  return { router, save, history, markConversationRead, statusUrl: authToken && base ? `${base}/api/twilio/status` : '' };
}
