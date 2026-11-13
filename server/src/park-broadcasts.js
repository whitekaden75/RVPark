import { createHash } from 'node:crypto';

const problem = (message, status = 400) => Object.assign(new Error(message), { status });

// Dates are Pacific calendar dates, with checkout exclusive, just like occupancy.
export function buildParkAudience(rows, date, normalizePhone) {
  const recipients = rows.map(row => ({
    id: String(row.id), name: `${row.first_name || ''} ${row.last_name || ''}`.trim() || 'Guest',
    phone: normalizePhone(row.phone_number), sites: row.sites || [],
    stayType: row.reservation_term === 'yearly' ? 'Yearly' : row.is_monthly ? 'Monthly' : 'Daily',
    skipReason: String(row.notes || '').includes('Guest did not opt in to text messages.')
      ? 'Guest opted out of texts' : !normalizePhone(row.phone_number) ? 'No valid mobile number' : '',
  }));
  // A shared number must also respect an opt-out on another current booking.
  const optedOut = new Set(recipients.filter(row => row.skipReason === 'Guest opted out of texts' && row.phone).map(row => row.phone));
  const phones = new Set();
  for (const row of recipients) {
    if (row.phone && optedOut.has(row.phone)) row.skipReason = 'Guest opted out of texts';
    if (!row.skipReason && phones.has(row.phone)) row.skipReason = 'Shared number — included once';
    if (!row.skipReason) phones.add(row.phone);
    row.eligible = !row.skipReason;
  }
  const fingerprint = createHash('sha256').update(JSON.stringify({ date, recipients })).digest('hex');
  return { date, fingerprint, recipients, recipientCount: phones.size,
    skippedCount: recipients.filter(row => !row.eligible).length };
}

export function createParkBroadcasts({ pool, today, normalizePhone, addFooter, send, configured, logger = console }) {
  async function preview() {
    const date = today();
    const { rows } = await pool.query(`
      SELECT r.id, c.first_name, c.last_name, c.phone_number, r.notes,
        r.reservation_term,
        (r.billing_mode='monthly' OR coalesce((to_jsonb(r)->>'monthly_classification')::boolean,false)
          OR EXISTS (SELECT 1 FROM reservation_site_stays span WHERE span.reservation_id=r.id
            AND (span.leave_date='9999-12-31'::date OR span.leave_date-span.arrival_date>=28))) AS is_monthly,
        array_agg(DISTINCT s.site_number ORDER BY s.site_number) AS sites
      FROM reservations r JOIN customers c ON c.id=r.customer_id
      JOIN reservation_site_stays st ON st.reservation_id=r.id
      JOIN rv_sites s ON s.id=st.site_id
      WHERE r.status='active' AND to_jsonb(r)->>'merged_into_reservation_id' IS NULL
        AND st.arrival_date <= $1::date AND st.leave_date > $1::date
      GROUP BY r.id, c.id ORDER BY c.last_name, c.first_name, r.id`, [date]);
    return buildParkAudience(rows, date, normalizePhone);
  }

  function serialize(row) {
    return { id: row.id, date: row.park_date, body: row.body, state: row.state,
      results: row.results, createdAt: row.created_at };
  }

  async function get(id) {
    // An interrupted worker must never be presented as safe to resend.
    await pool.query(`UPDATE park_text_broadcasts SET state='review', updated_at=now(),
      results=(SELECT coalesce(jsonb_agg(CASE
        WHEN item->>'state'='sending' THEN item || jsonb_build_object('state','review','message','Delivery uncertain. Check Twilio history before resending.')
        WHEN item->>'state'='waiting' THEN item || jsonb_build_object('state','skipped','message','Sending was interrupted before this text was attempted.')
        ELSE item END ORDER BY ord),'[]'::jsonb)
        FROM jsonb_array_elements(results) WITH ORDINALITY AS entries(item,ord))
      WHERE id=$1::uuid AND state='sending' AND updated_at<now()-interval '2 minutes'`, [id]);
    const { rows } = await pool.query('SELECT *, park_date::text FROM park_text_broadcasts WHERE id=$1::uuid', [id]);
    if (!rows[0]) throw problem('Park announcement not found.', 404);
    return serialize(rows[0]);
  }

  async function updateResult(id, index, result) {
    return pool.query(`UPDATE park_text_broadcasts SET results=jsonb_set(results,ARRAY[$2::text],$3::jsonb),updated_at=now()
      WHERE id=$1::uuid AND state='sending' RETURNING id`, [id, String(index), JSON.stringify(result)]);
  }

  async function deliver(id, body, results) {
    // Recheck occupancy, phone numbers, and opt-outs when delivery starts.
    const current = await preview();
    const eligible = new Map(current.recipients.filter(row => row.eligible).map(row => [row.phone, row]));
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, results.length) }, async () => {
      while (next < results.length) {
        const index = next++;
        const recipient = results[index];
        if (!eligible.has(recipient.phone)) {
          await updateResult(id, index, { ...recipient, state: 'skipped', message: 'Guest is no longer eligible for this announcement.' });
          continue;
        }
        const claim = await updateResult(id, index, { ...recipient, state: 'sending' });
        if (!claim.rowCount) return;
        let result;
        try {
          const accepted = await send({ to: recipient.phone, body });
          result = { ...recipient, state: 'queued', sid: accepted.sid, message: accepted.storageWarning || '' };
        } catch (error) {
          const rejected = Number(error.status) >= 400 && Number(error.status) < 500;
          result = { ...recipient, state: rejected ? 'failed' : 'review', message: rejected
            ? error.message : 'Delivery uncertain. Check Twilio history before resending.' };
        }
        // If saving fails after acceptance, leave the sending claim in place.
        await updateResult(id, index, result);
      }
    }));
    await pool.query("UPDATE park_text_broadcasts SET state='complete',updated_at=now() WHERE id=$1::uuid AND state='sending'", [id]);
  }

  async function start({ id, fingerprint, body }) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id || '')) throw problem('A valid announcement ID is required.');
    if (typeof body !== 'string' || !body.trim()) throw problem('Write a message before sending.');
    body = body.trim();
    if (body.length > 1500 || addFooter(body).length > 1600) throw problem('Keep the message under 1,500 characters.');
    const existing = await pool.query('SELECT body, fingerprint FROM park_text_broadcasts WHERE id=$1::uuid', [id]);
    if (existing.rows[0]) {
      if (existing.rows[0].body !== body || existing.rows[0].fingerprint !== fingerprint) throw problem('This announcement ID was already used. Start a new announcement.', 409);
      return get(id);
    }
    if (!configured()) throw problem('Text messaging is not configured.', 503);
    const audience = await preview();
    if (fingerprint !== audience.fingerprint) throw problem('The guests in the park have changed. Refresh recipients and review the announcement again.', 409);
    if (!audience.recipientCount) throw problem('No current guests have an eligible mobile number.');
    await pool.query('SELECT sid FROM text_messages LIMIT 0');
    const results = audience.recipients.filter(row => row.eligible).map(row => ({ ...row, state: 'waiting', message: '' }));
    // The unique request ID claims the whole broadcast across double clicks,
    // lost responses, and multiple server instances. No automatic resend.
    const claimed = await pool.query(`INSERT INTO park_text_broadcasts(id,park_date,fingerprint,body,state,results)
      VALUES($1::uuid,$2::date,$3,$4,'sending',$5::jsonb) ON CONFLICT(id) DO NOTHING RETURNING id`,
    [id, audience.date, fingerprint, body, JSON.stringify(results)]);
    if (claimed.rowCount) {
      void deliver(id, body, results).catch(error => logger.error('Park announcement interrupted; retained send claims for review', id, error.code || error.message));
    } else {
      const concurrent = await pool.query('SELECT body,fingerprint FROM park_text_broadcasts WHERE id=$1::uuid', [id]);
      if (concurrent.rows[0].body !== body || concurrent.rows[0].fingerprint !== fingerprint) throw problem('This announcement ID was already used.', 409);
    }
    return get(id);
  }

  return { preview, start, get };
}
