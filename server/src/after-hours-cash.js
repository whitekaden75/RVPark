export function expectedEnvelopeAmount(reservation) {
  if (!/^AFTER-HOURS DRIVE-UP\b/m.test(String(reservation.notes || ''))) return null;
  const match = String(reservation.notes).match(/Expected envelope amount:\s*\$([\d,]+\.\d{2})(?:\.|\s|$)/);
  const amount = match ? Number(match[1].replaceAll(',', '')) : NaN;
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

export function registerAfterHoursCashRoutes(app, {pool,getReservation,insertPayment,findOverlap,notify,now=()=>new Date()}) {
  app.post('/api/reservations/:id/receive-after-hours-cash', async (req,res) => {
    const {amount,alreadyRecorded=false} = req.body || {};
    if (!/^[1-9]\d*$/.test(String(req.params.id)) || typeof alreadyRecorded !== 'boolean' ||
        !['string','number'].includes(typeof amount) || !/^\d+(?:\.\d{1,2})?$/.test(String(amount)) ||
        !Number.isFinite(Number(amount)) || Number(amount)<=0) {
      return res.status(400).json({message:'Enter the cash actually received, greater than zero, with up to two decimal places.'});
    }
    let client;
    try {
      client=await pool.connect();await client.query('BEGIN');
      const locked=await client.query('SELECT id FROM reservations WHERE id=$1 FOR UPDATE',[req.params.id]);
      if (!locked.rowCount) {
        await client.query('ROLLBACK');return res.status(404).json({message:'Reservation not found.'});
      }
      const booking=await getReservation(client,req.params.id);
      if (String(booking.id)!==String(req.params.id) || !['pending','active'].includes(booking.status) || booking.merged_into_reservation_id ||
          expectedEnvelopeAmount(booking)===null) {
        await client.query('ROLLBACK');return res.status(409).json({message:'Open an active or pending after-hours cash booking with an expected envelope amount.'});
      }
      // A durable receipt and row lock make retries and concurrent staff clicks safe.
      if (booking.after_hours_cash_received) {
        await client.query('COMMIT');return res.json(booking);
      }
      const counted=Number(amount), paid=Number(booking.amountPaid || 0);
      if (alreadyRecorded) {
        const events=await client.query(`SELECT coalesce(sum(amount),0) AS cash_paid FROM reservation_payment_events
          WHERE reservation_id=$1 AND stripe_payment_record_id IS NULL
            AND (note ILIKE '%Tender: cash%' OR payment_source='cash')`,[req.params.id]);
        if (Number(events.rows[0]?.cash_paid || 0)<counted || paid<counted) {
          await client.query('ROLLBACK');return res.status(409).json({message:'The payment history does not show this much cash already recorded. Review the booking before verifying the envelope.'});
        }
      } else if (paid>0) {
        await client.query('ROLLBACK');return res.status(409).json({message:'This booking already has payments. Review them or verify cash already recorded to avoid counting it twice.'});
      }
      const overlap=await findOverlap(client,(booking.siteStays || []).map(stay=>({siteId:stay.site_id,
        arrivalDate:stay.arrival_date,leaveDate:stay.leave_date})),booking.id);
      if (overlap) {await client.query('ROLLBACK');return res.status(409).json(overlap);}
      const receipt={amount:counted,creditedAmount:alreadyRecorded?0:counted,
        receivedAt:now().toISOString(),adminUserId:req.adminUser?.id || null};
      // Keep the quote accepted at the QR checkout when rates have since changed.
      // Preserve an explicit price adjustment made by staff before verification.
      const freezeQuote=booking.billing_mode==='standard' && !booking.manual_pricing_override;
      await client.query(`UPDATE reservations SET status='active',amount_paid=coalesce(amount_paid,0)+$2,
        payment_method='bank',after_hours_cash_received=$3::jsonb,
        billing_mode=CASE WHEN $4 THEN 'manual_total' ELSE billing_mode END,
        total_price=CASE WHEN $4 THEN $5 ELSE total_price END,
        manual_pricing_override=CASE WHEN $4 THEN true ELSE manual_pricing_override END
        WHERE id=$1`,[req.params.id,receipt.creditedAmount,JSON.stringify(receipt),freezeQuote,expectedEnvelopeAmount(booking)]);
      if (!alreadyRecorded) await insertPayment(client,{reservationId:Number(req.params.id),amount:counted,
        paymentSource:'office_card_reader',note:'After-hours cash envelope received and verified. Tender: cash. Price type: bank',
        recordedAt:receipt.receivedAt});
      const updated=await getReservation(client,req.params.id);
      await client.query('COMMIT');
      notify({reason:'after_hours_cash_received',reservationId:Number(req.params.id)});
      return res.json(updated);
    } catch(error) {
      if(client)await client.query('ROLLBACK').catch(()=>{});
      const migrationMissing=['42703','42P01'].includes(error.code);
      return res.status(migrationMissing?503:error.code==='23P01'?409:500).json({message:migrationMissing
        ? 'Run sql/2026-10-10_after_hours_cash_verification.sql first.'
        : error.code==='23P01' ? 'This site is already booked. Review the booking before recording cash.'
        : 'Unable to verify cash. Refresh and try again.'});
    } finally {client?.release();}
  });
}
