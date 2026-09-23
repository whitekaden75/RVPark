export function arrivalReminderText(reservation, date, formatDate, reference = 'tomorrow') {
  const stays = reservation.siteStays || [];
  const departure = stays.reduce((latest, stay) => stay.leave_date > latest ? stay.leave_date : latest, '');
  const name = `${reservation.first_name || ''} ${reservation.last_name || ''}`.trim() || 'Guest';
  return [
    'Riverpark RV Resort', '', `Hello ${name},`, '',
    `We're looking forward to your arrival ${reference}!`, '', 'Reservation Details',
    `Arrival: ${formatDate(date)}`, `Departure: ${departure === '9999-12-31' ? 'Open-ended' : departure ? formatDate(departure) : 'Not set'}`,
    'Check-in: 1:00 PM',
    ...(Number(reservation.unpaidStayNights) > 0 ? [`${reservation.unpaidStayNights} ${Number(reservation.unpaidStayNights) === 1 ? 'night remains' : 'nights remain'} to be paid`] : []),
    '', 'Payment Information', 'Card payments use the displayed card price.',
    'Cash and checks use the displayed bank price.', '',
    'Please reply to this message to confirm your arrival and provide your approximate arrival time. Any questions? Call (541) 295-1269',
    '', 'Thank you!', '', 'Makayla', 'Riverpark RV Resort', '2956 Rogue River Hwy', 'Grants Pass, OR 97527'
  ].join('\n');
}

export function createArrivalReminders({ pool, tomorrow, getReservation, normalizePhone, formatDate, send, configured }) {
  async function preview() {
    const date = tomorrow();
    const result = await pool.query(`
      SELECT r.id,c.first_name,c.last_name,c.phone_number,
        log.state,log.message_sid,log.error_message
      FROM reservations r JOIN customers c ON c.id=r.customer_id
      LEFT JOIN arrival_text_reminders log ON log.reservation_id=r.id AND log.arrival_date=$1::date
      WHERE r.status='active'
        AND (SELECT min(st.arrival_date) FROM reservation_site_stays st WHERE st.reservation_id=r.id)=$1::date
      ORDER BY c.last_name,c.first_name,r.id`, [date]);
    return { date, recipients: result.rows.map(row => ({
      ...row, phone: normalizePhone(row.phone_number),
      eligible: Boolean(normalizePhone(row.phone_number)) && (!row.state || row.state === 'failed')
    })) };
  }

  async function draft(id, date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('Choose a valid arrival date.');
    const reservation = await getReservation(id);
    if (!reservation || reservation.status !== 'active' || !reservation.siteStays?.some(stay => stay.arrival_date === date)) {
      throw new Error('This active reservation does not arrive on the selected date.');
    }
    const to = normalizePhone(reservation.phone_number);
    if (!to) throw new Error('Add a valid mobile phone number to this guest first.');
    return { to, body: arrivalReminderText(reservation, date, formatDate, date === tomorrow() ? 'tomorrow' : `on ${formatDate(date)}`) };
  }

  async function sendBatch(date, requestedIds) {
    if (!configured()) throw new Error('Twilio is not configured.');
    if (date !== tomorrow()) throw new Error('The arrival date changed. Refresh tomorrow’s arrivals before sending.');
    // Ensure storage is available before accepting any sends.
    await pool.query('SELECT sid FROM text_messages LIMIT 0');
    const current = await preview();
    const ids = new Set(requestedIds.map(String));
    const results = [];
    for (const recipient of current.recipients.filter(row => ids.has(String(row.id)))) {
      if (!recipient.eligible) {
        results.push({ id: recipient.id, state: 'skipped', message: recipient.state || 'Missing valid phone number' });
        continue;
      }
      let message;
      try { message = await draft(recipient.id, date); }
      catch (error) { results.push({ id: recipient.id, state: 'failed', message: error.message }); continue; }
      // A durable claim protects against double clicks and simultaneous staff sessions.
      const claim = await pool.query(`
        INSERT INTO arrival_text_reminders (reservation_id,arrival_date,state) VALUES ($1,$2,'sending')
        ON CONFLICT (reservation_id,arrival_date) DO UPDATE SET state='sending',error_message=NULL,updated_at=now()
          WHERE arrival_text_reminders.state='failed'
        RETURNING reservation_id`, [recipient.id, date]);
      if (!claim.rowCount) { results.push({ id: recipient.id, state: 'skipped', message: 'Already sent or in progress' }); continue; }
      let accepted;
      try {
        accepted = await send(message);
      } catch (error) {
        // Only explicit provider rejections are safe to retry. A lost response may hide an accepted SMS.
        const state = error.status >= 400 && error.status < 500 ? 'failed' : 'review';
        await pool.query(`UPDATE arrival_text_reminders SET state=$3,error_message=$4,updated_at=now() WHERE reservation_id=$1 AND arrival_date=$2`,
          [recipient.id, date, state, state === 'review' ? 'Delivery is uncertain. Check Twilio history before retrying.' : error.message]);
        results.push({ id: recipient.id, state, message: error.message });
        continue;
      }
      await pool.query(`UPDATE arrival_text_reminders SET state='sent',message_sid=$3,error_message=$4,updated_at=now() WHERE reservation_id=$1 AND arrival_date=$2`,
        [recipient.id, date, accepted.sid, accepted.storageWarning || null]);
      results.push({ id: recipient.id, state: 'sent', message: accepted.storageWarning || '' });
    }
    return { date, results };
  }
  return { preview, draft, sendBatch };
}
