import { lateArrivalText } from './arrival-reminders.js';

const parkClock = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function getParkClock(value = new Date()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = Object.fromEntries(parkClock.formatToParts(date).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

export function isAfterHoursCashReservation(reservation) {
  return reservation.status === 'pending' && String(reservation.notes || '').includes('AFTER-HOURS DRIVE-UP');
}

export function getAutomaticLateArrivalDate(reservation) {
  if (!reservation || (reservation.status !== 'active' && !isAfterHoursCashReservation(reservation))) return null;
  const booked = reservation.created_at == null ? null : getParkClock(reservation.created_at);
  const arrival = (reservation.siteStays || []).reduce((first, stay) =>
    !first || stay.arrival_date < first ? stay.arrival_date : first, '');
  return booked && booked.hour >= 17 && arrival === booked.date ? arrival : null;
}

export function buildLateArrivalMessage(reservation, date, payment = null) {
  const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value));
  const body = lateArrivalText({ ...reservation, lateArrivalDate: date });
  if (!payment?.url) return body;
  return `${body}\n\n${[
    `Card payment (secure link): ${money(payment.cardAmount)} — ${payment.url}`,
    `Cash or check: ${money(payment.bankAmount)} (lower price). Put cash or check in an envelope and place it in the mail slot.`,
  ].join('\n')}`;
}

export function createLateArrivalTexts({ pool, getReservation, normalizePhone, createPaymentLink,
  send, configured, notify = () => {}, now = () => new Date(), logger = console }) {
  let scanning = false;

  async function sendReservation(id, { automatic = true, customBody = '' } = {}) {
    if (!configured()) return { id, state: 'skipped', message: 'Text messaging is not configured.' };
    const reservation = await getReservation(id);
    if (!reservation) return { id, state: 'skipped', message: 'Reservation not found.' };
    const date = getParkClock(now()).date;
    const eligibleStatus = reservation.status === 'active' || (automatic && isAfterHoursCashReservation(reservation));
    const arriving = reservation.siteStays?.filter(stay => stay.arrival_date === date) || [];
    if (!eligibleStatus || !arriving.length ||
        (automatic && getAutomaticLateArrivalDate(reservation) !== date)) {
      return { id, state: 'skipped', message: 'This booking does not qualify for a late-arrival text today.' };
    }
    if (String(reservation.notes || '').includes('Guest did not opt in to text messages.')) {
      return { id, state: 'skipped', message: 'Guest opted out of text messages.' };
    }
    const checkIns = reservation.checkIns || (reservation.checkIn ? [reservation.checkIn] : []);
    if (checkIns.some(checkIn => arriving.some(stay => Number(stay.id) === Number(checkIn.reservationSiteStayId)))) {
      return { id, state: 'skipped', message: 'Guest is already checked in for this arrival.' };
    }
    const to = normalizePhone(reservation.phone_number);
    if (!to) return { id, state: 'skipped', message: 'Add a valid mobile phone number first.' };

    // Fail before claiming or contacting the provider if inbox storage is unavailable.
    await pool.query('SELECT sid FROM text_messages LIMIT 0');
    const payment = createPaymentLink ? await createPaymentLink(reservation, date) : null;
    const body = !automatic && customBody.trim() ? customBody.trim() : buildLateArrivalMessage(reservation, date, payment);
    // A unique claim coordinates admin sends, webhook retries and multiple servers.
    const claim = await pool.query(`
      INSERT INTO late_arrival_texts (reservation_id, arrival_date, state, automatic, attempts)
      SELECT $1, $2, 'sending', $3, 1 FROM reservations r
      WHERE r.id=$1 AND to_jsonb(r)->>'merged_into_reservation_id' IS NULL
      ON CONFLICT (reservation_id, arrival_date) DO UPDATE
        SET state='sending', automatic=EXCLUDED.automatic, attempts=late_arrival_texts.attempts+1,
            error_message=NULL, retryable=false, updated_at=now()
        WHERE late_arrival_texts.state='failed' AND (
          NOT $3::boolean OR (late_arrival_texts.retryable AND late_arrival_texts.attempts<3
            AND late_arrival_texts.updated_at<now()-interval '5 minutes'))
      RETURNING reservation_id`, [id, date, automatic]);
    if (!claim.rowCount) return { id, state: 'skipped', message: 'Already sent, in progress or awaiting delivery review.' };

    let accepted;
    try {
      accepted = await send({ to, body });
    } catch (error) {
      // Lost responses may hide an accepted SMS. Never automatically resend those.
      const rejected = Number(error.status) >= 400 && Number(error.status) < 500;
      const state = rejected ? 'failed' : 'review';
      const message = rejected ? error.message : 'Delivery is uncertain. Check Twilio history before sending again.';
      await pool.query(`UPDATE late_arrival_texts SET state=$3, error_message=$4, retryable=$5, updated_at=now()
        WHERE reservation_id=$1 AND arrival_date=$2`, [id, date, state, message, Number(error.status) === 429]);
      notify({ reason: 'late_arrival_text_updated', reservationId: Number(id) });
      return { id, state, message };
    }
    try {
      await pool.query(`UPDATE late_arrival_texts SET state='sent', message_sid=$3, error_message=$4,
        retryable=false, updated_at=now() WHERE reservation_id=$1 AND arrival_date=$2`,
      [id, date, accepted.sid, accepted.storageWarning || null]);
    } catch (error) {
      logger.error('Late-arrival SMS accepted but its delivery record could not be saved', id, accepted.sid, error.message);
      // Leave the durable claim in place so a retry cannot send a duplicate.
      return { id, state: 'review', message: 'Text accepted; check Twilio history before sending again.' };
    }
    notify({ reason: 'late_arrival_text_updated', reservationId: Number(id) });
    return { id, state: 'sent', message: accepted.storageWarning || '', sid: accepted.sid };
  }

  async function scan() {
    const clock = getParkClock(now());
    if (scanning || !configured() || clock.hour < 17) return [];
    scanning = true;
    try {
      // Interrupted or timed-out sends require review, never a blind resend.
      await pool.query(`UPDATE late_arrival_texts SET state='review', retryable=false,
        error_message='Sending was interrupted. Check Twilio history before sending again.', updated_at=now()
        WHERE state='sending' AND updated_at<now()-interval '10 minutes'`);
      const candidates = await pool.query(`
        SELECT r.id FROM reservations r
        JOIN customers c ON c.id=r.customer_id
        LEFT JOIN late_arrival_texts log ON log.reservation_id=r.id AND log.arrival_date=$1::date
        WHERE (r.status='active' OR (r.status='pending' AND r.notes LIKE '%AFTER-HOURS DRIVE-UP%'))
          AND r.created_at >= ($1::date + time '17:00') AT TIME ZONE 'America/Los_Angeles'
          AND r.created_at < ($1::date + interval '1 day') AT TIME ZONE 'America/Los_Angeles'
          AND coalesce(r.notes,'') NOT LIKE '%Guest did not opt in to text messages.%'
          AND length(regexp_replace(coalesce(c.phone_number,''),'[^0-9]','','g')) BETWEEN 8 AND 15
          AND EXISTS (SELECT 1 FROM reservation_site_stays st WHERE st.reservation_id=r.id AND st.arrival_date=$1::date)
          AND NOT EXISTS (SELECT 1 FROM reservation_site_stays st WHERE st.reservation_id=r.id AND st.arrival_date<$1::date)
          AND NOT EXISTS (SELECT 1 FROM reservation_check_ins ci JOIN reservation_site_stays st ON st.id=ci.reservation_site_stay_id
            WHERE ci.reservation_id=r.id AND st.arrival_date=$1::date)
          AND (log.reservation_id IS NULL OR (log.state='failed' AND log.retryable AND log.attempts<3
            AND log.updated_at<now()-interval '5 minutes'))
        ORDER BY r.created_at, r.id LIMIT 100`, [clock.date]);
      const results = [];
      for (const candidate of candidates.rows) {
        try { results.push(await sendReservation(candidate.id)); }
        catch (error) { logger.error('Unable to prepare automatic late-arrival text', candidate.id, error.message); }
      }
      return results;
    } catch (error) {
      logger.error('Unable to scan automatic late-arrival texts', error.code === '42P01'
        ? 'Run sql/2026-10-10_late_arrival_texts.sql before enabling automatic texts.' : error.message);
      return [];
    } finally { scanning = false; }
  }

  function start() {
    void scan();
    const timer = setInterval(() => void scan(), 60000);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  return { sendReservation, scan, start };
}
