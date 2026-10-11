import {expectedEnvelopeAmount} from './after-hours-cash.js';
const identifier=value=>`"${String(value).replaceAll('"','""')}"`;
const completedPayments=new Set(['paid','canceled','failed','expired','refunded','partially_refunded']);
const fault=(message,status=409)=>Object.assign(new Error(message),{status});

export function sameBookingGuest(primary,source) {
  if(Number(primary.customer_id)===Number(source.customer_id)) return true;
  const name=r=>`${r.first_name || ''} ${r.last_name || ''}`.trim().toLowerCase();
  const email=r=>String(r.email || '').trim().toLowerCase();
  const phone=r=>String(r.phone_number || '').replace(/\D/g,'').replace(/^1(?=\d{10}$)/,'');
  return Boolean(name(primary) && name(primary)===name(source) &&
    (email(primary) && email(primary)===email(source) || phone(primary) && phone(primary)===phone(source)));
}

export function combinedBookingPlan(primary,source,{monthly=true,totalPrice}={}) {
  if(primary.status!=='active' || source.status!=='active') throw fault('Only active bookings can be combined.');
  if(primary.merged_into_reservation_id || source.merged_into_reservation_id) throw fault('A booking was already combined. Refresh and use its current booking.');
  if([primary,source].some(booking=>expectedEnvelopeAmount(booking)!==null && !booking.after_hours_cash_received)) throw fault('Verify after-hours cash before combining these bookings.');
  if(!sameBookingGuest(primary,source)) throw fault('Choose another booking for the same guest.');
  const stays=[...(primary.siteStays || []),...(source.siteStays || [])].sort((a,b)=>a.arrival_date.localeCompare(b.arrival_date));
  if(!primary.siteStays?.length || !source.siteStays?.length || stays.some(st=>st.leave_date==='9999-12-31' || st.leave_date<=st.arrival_date)) {
    throw fault('Both bookings need finite arrival and departure dates before combining.');
  }
  if(stays.some((stay,index)=>index && stays[index-1].leave_date!==stay.arrival_date)) {
    throw fault('Choose consecutive bookings with no date gaps or overlapping nights.');
  }
  let billingMode=primary.billing_mode,price=primary.totalPrice ?? null,manualOverride=Boolean(primary.manual_pricing_override);
  if(billingMode!=='monthly') {
    if(totalPrice!==undefined) {
      if(totalPrice==='' || typeof totalPrice==='boolean' || !Number.isFinite(Number(totalPrice)) || Number(totalPrice)<0) throw fault('Enter a valid combined stay total.',400);
      price=Math.round(Number(totalPrice)*100)/100;
    } else {
      if(primary.bankTotalPrice==null || source.bankTotalPrice==null) throw fault('Enter the agreed combined stay total because a booking has no calculated price.',400);
      price=Math.round((Number(primary.bankTotalPrice)+Number(source.bankTotalPrice))*100)/100;
    }
    billingMode='manual_total';manualOverride=true;
  }
  return {stays,billingMode,totalPrice:price,manualOverride,
    monthly:Boolean(monthly),
    amountPaid:Math.round((Number(primary.amountPaid || 0)+Number(source.amountPaid || 0))*100)/100};
}

export function registerCombinedBookingRoutes(app,{pool,getReservation,notify}) {
  app.post('/api/reservations/:id/monthly-classification',async(req,res)=>{
    if(!/^[1-9]\d*$/.test(String(req.params.id)) || typeof req.body?.monthly!=='boolean') return res.status(400).json({message:'Choose monthly or automatic classification.'});
    try {
      const result=await pool.query(`UPDATE reservations SET monthly_classification=$2
        WHERE id=$1 AND status='active' AND merged_into_reservation_id IS NULL RETURNING id`,[req.params.id,req.body.monthly]);
      if(!result.rowCount) return res.status(409).json({message:'Only active, separate bookings can be marked monthly.'});
      const reservation=await getReservation(pool,req.params.id);
      notify({reason:'reservation_monthly_classification_updated',reservationId:Number(req.params.id)});
      return res.json(reservation);
    } catch(error) {
      return res.status(['42703','42P01'].includes(error.code)?503:500).json({message:['42703','42P01'].includes(error.code)
        ? 'Run sql/2026-10-10_monthly_and_combined_bookings.sql first.' : 'Unable to change monthly classification. Refresh and try again.'});
    }
  });

  app.post('/api/reservations/:id/combine',async(req,res)=>{
    const primaryId=String(req.params.id),sourceId=String(req.body?.sourceReservationId);
    if(![primaryId,sourceId].every(id=>/^[1-9]\d*$/.test(id)) || primaryId===sourceId ||
      req.body?.monthly!==undefined && typeof req.body.monthly!=='boolean') return res.status(400).json({message:'Choose two different bookings and a monthly classification.'});
    let client;
    try {
      client=await pool.connect();await client.query('BEGIN');
      // Briefly pause Stripe writes/row locks, including records being created,
      // before taking reservation locks. Webhooks resume after this transaction.
      await client.query('LOCK TABLE stripe_payment_records IN EXCLUSIVE MODE');
      // Stripe settles by locking its payment record before the reservation.
      const payments=await client.query(`SELECT id,payment_status FROM stripe_payment_records
        WHERE reservation_id=ANY($1::bigint[]) ORDER BY id FOR UPDATE`,[[primaryId,sourceId]]);
      if(payments.rows.some(payment=>!completedPayments.has(payment.payment_status))) throw fault('Finish or cancel pending payments before combining bookings.');
      const locked=await client.query(`SELECT id,to_jsonb(r)->>'merged_into_reservation_id' AS merged_into_reservation_id
        FROM reservations r WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE`,[[primaryId,sourceId]]);
      if(locked.rowCount!==2) throw fault('One of these bookings no longer exists.',404);
      if(locked.rows.some(r=>r.merged_into_reservation_id)) throw fault('One booking was already combined. Refresh and use its current booking.');
      const primary=await getReservation(client,primaryId),source=await getReservation(client,sourceId);
      const plan=combinedBookingPlan(primary,source,{monthly:req.body.monthly ?? true,totalPrice:req.body.totalPrice});
      // Capture both originals before moving children or suppressing the source row.
      await client.query(`INSERT INTO reservation_merge_events
        (primary_reservation_id,source_reservation_id,primary_before,source_before,admin_user_id)
        VALUES($1,$2,$3::jsonb,$4::jsonb,$5)`,[primaryId,sourceId,JSON.stringify(primary),JSON.stringify(source),req.adminUser?.id || null]);
      // Reparent existing stays/check-ins/payments without recreating IDs or collecting money.
      // Discover real FK dependents so future reservation-linked tables are not overlooked.
      const references=await client.query(`SELECT DISTINCT ns.nspname AS schema_name,cl.relname AS table_name,a.attname AS column_name
        FROM pg_constraint co JOIN pg_class cl ON cl.oid=co.conrelid JOIN pg_namespace ns ON ns.oid=cl.relnamespace
        JOIN pg_attribute a ON a.attrelid=cl.oid AND a.attnum=co.conkey[1]
        WHERE co.contype='f' AND co.confrelid='reservations'::regclass AND cardinality(co.conkey)=1
          AND a.attname='reservation_id' ORDER BY schema_name,table_name`);
      const preserved=new Set(['arrival_text_reminders','late_arrival_texts','reservation_balance_waiver_events']);
      const transferred=new Set();
      for(const ref of references.rows) {
        if(preserved.has(ref.table_name)) continue;
        await client.query(`UPDATE ${identifier(ref.schema_name)}.${identifier(ref.table_name)} SET ${identifier(ref.column_name)}=$1 WHERE ${identifier(ref.column_name)}=$2`,[primaryId,sourceId]);
        transferred.add(ref.table_name);
      }
      // Older optional tables may have reservation_id without a declared FK.
      for(const table of ['reservation_site_stays','reservation_check_ins','reservation_payment_events','stripe_payment_records','public_booking_checkouts','monthly_meter_readings','monthly_recurring_charges','bookkeeping_stripe_activity']) {
        if(transferred.has(table)) continue;
        const exists=await client.query('SELECT to_regclass($1) AS table_name',[table]);
        if(exists.rows[0]?.table_name) await client.query(`UPDATE ${identifier(table)} SET reservation_id=$1 WHERE reservation_id=$2`,[primaryId,sourceId]);
      }
      // Keep delivery history under the source ID too, and copy blocked-send states
      // onto the primary so neither a manual nor automatic retry duplicates texts.
      for(const table of ['arrival_text_reminders','late_arrival_texts']) {
        const exists=await client.query('SELECT to_regclass($1) AS table_name',[table]);
        if(!exists.rows[0]?.table_name) continue;
        const lateFields=table==='late_arrival_texts'?',automatic,attempts':'';
        await client.query(`INSERT INTO ${identifier(table)} (reservation_id,arrival_date,state,message_sid,error_message${lateFields})
          SELECT $1,arrival_date,CASE WHEN state='sending' THEN 'review' ELSE state END,message_sid,error_message${lateFields} FROM ${identifier(table)} WHERE reservation_id=$2
          ON CONFLICT(reservation_id,arrival_date) DO UPDATE SET state=CASE
            WHEN ${identifier(table)}.state='sent' OR EXCLUDED.state='sent' THEN 'sent'
            WHEN ${identifier(table)}.state IN ('review','sending') OR EXCLUDED.state IN ('review','sending') THEN 'review'
            ELSE ${identifier(table)}.state END,
            message_sid=coalesce(${identifier(table)}.message_sid,EXCLUDED.message_sid)`,[primaryId,sourceId]);
      }
      const notes=[primary.notes || '',source.notes ? `From combined booking #${sourceId}: ${source.notes}` : '',`Combined booking #${sourceId} into #${primaryId}.`].filter(Boolean).join('\n\n');
      await client.query(`UPDATE reservations SET amount_paid=$2,monthly_classification=$3,
        billing_mode=$4,total_price=$5,manual_pricing_override=$6,notes=$7 WHERE id=$1`,
        [primaryId,plan.amountPaid,plan.monthly,plan.billingMode,plan.totalPrice,plan.manualOverride,notes]);
      await client.query(`UPDATE reservations SET merged_into_reservation_id=$2,status='canceled',
        canceled_at=now(),canceled_site_stays='[]'::jsonb,amount_paid=0 WHERE id=$1`,[sourceId,primaryId]);
      // Flatten older aliases if the source itself was a primary of an earlier merge.
      await client.query('UPDATE reservations SET merged_into_reservation_id=$1 WHERE merged_into_reservation_id=$2',[primaryId,sourceId]);
      const updated=await getReservation(client,primaryId);await client.query('COMMIT');
      notify({reason:'reservations_combined',reservationId:Number(primaryId),sourceReservationId:Number(sourceId)});
      return res.json(updated);
    } catch(error) {
      if(client) await client.query('ROLLBACK').catch(()=>{});
      const migrationMissing=['42703','42P01'].includes(error.code);
      return res.status(migrationMissing?503:error.status || 409).json({message:migrationMissing
        ? 'Run sql/2026-10-10_monthly_and_combined_bookings.sql first.'
        : error.status ? error.message : 'Bookings could not be combined. Their records were preserved; refresh and try again.'});
    } finally {client?.release();}
  });
}
