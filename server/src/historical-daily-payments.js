import { createHash, randomUUID } from 'node:crypto';
import { bookkeepingRoutes } from './bookkeeping-http.js';
import { isMonthlyAccount, lodgingPeriod } from './bookkeeping-lodging.js';

const cents=value=>value==null || value==='' || !Number.isFinite(Number(value)) ? null : Math.round(Number(value)*100);
const date=value=>value instanceof Date ? value.toISOString().slice(0,10) : String(value || '').slice(0,10);
const sum=rows=>rows.reduce((total,row)=>total+(cents(row.amount) || 0),0);
const fail=(message,statusCode=409)=>Object.assign(new Error(message),{statusCode});
const timestamp=value=>value && Number.isFinite(new Date(value).valueOf()) ? new Date(value).toISOString() : null;
const parkDate=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));

export function historicalDailyPeriod(query={},today) {
  const period=lodgingPeriod({from:query.from || '2026-07-01',to:query.to || today},today);
  if(period.from<'2026-07-01' || period.to>period.asOf)throw fail('Choose completed stays from July 1, 2026 through today.',400);
  return period;
}

export function planHistoricalDailyPayments({reservations=[],stripeRecords=[],stripeCheckouts=[],stripeActivity=[],existingBackfills=[],from,to,asOf}) {
  const proposals=[],skipped=[],previousKeys=new Set(existingBackfills.map(row=>row.backfill_key));
  const skippedRow=(reservation,reason)=>skipped.push({reservationId:reservation.id,guestName:`${reservation.first_name || ''} ${reservation.last_name || ''}`.trim(),reason});
  for(const reservation of [...reservations].sort((a,b)=>Number(a.id)-Number(b.id))) {
    if(reservation.merged_into_reservation_id)continue;
    const id=String(reservation.id),stays=[...(reservation.siteStays || [])].sort((a,b)=>a.arrival_date.localeCompare(b.arrival_date));
    const arrival=stays[0]?.arrival_date,departure=stays.map(stay=>stay.leave_date).sort().at(-1);
    if(!arrival || !departure || departure<from || arrival>to)continue;
    if(isMonthlyAccount(reservation,stays) || reservation.effectiveBillingMode==='monthly') {skippedRow(reservation,'Monthly account: left in the separate monthly estimate report.');continue;}
    if(reservation.status!=='active') {skippedRow(reservation,'Canceled or pending booking: payment is not assumed.');continue;}
    if(arrival<from || departure>to || departure>asOf) {skippedRow(reservation,'Stay crosses the selected dates or is not completed yet.');continue;}
    if(stays.some((stay,index)=>!/^\d{4}-\d{2}-\d{2}$/.test(stay.arrival_date) || !/^\d{4}-\d{2}-\d{2}$/.test(stay.leave_date) || stay.leave_date<=stay.arrival_date || index && stays[index-1].leave_date!==stay.arrival_date)) {
      skippedRow(reservation,'Overlapping stays or separate visits: review dates individually.');continue;
    }
    if(reservation.balanceWaiver?.active || reservation.balance_waiver?.active) {skippedRow(reservation,'Balance was waived: no payment is assumed.');continue;}
    if(/^AFTER-HOURS DRIVE-UP\b/m.test(reservation.notes || '') && !reservation.after_hours_cash_received) {skippedRow(reservation,'After-hours cash has not been verified.');continue;}
    const events=reservation.paymentEvents || [],eventTotal=sum(events),oldPaid=cents(reservation.amountPaid ?? reservation.amount_paid ?? 0);
    if(oldPaid==null || oldPaid<0 || events.some(event=>cents(event.amount)==null || cents(event.amount)<0)) {skippedRow(reservation,'Invalid or negative payment history: review manually.');continue;}
    const records=stripeRecords.filter(row=>String(row.reservation_id)===id);
    const checkouts=stripeCheckouts.filter(row=>String(row.reservation_id)===id && (row.stripe_checkout_session_id || row.stripe_payment_intent_id));
    const activity=stripeActivity.filter(row=>String(row.reservation_id)===id);
    const stripeEvents=events.filter(row=>row.paymentSource==='stripe' || row.stripePaymentRecordId);
    const base={reservationId:reservation.id,guestName:`${reservation.first_name || ''} ${reservation.last_name || ''}`.trim(),
      sites:[...new Set(stays.map(stay=>stay.site_number))].join(', '),arrival,departure,cashPrice:cents(reservation.bankTotalPrice)==null ? null : cents(reservation.bankTotalPrice)/100,
      previousAmountPaid:oldPaid/100,existingEventAmount:eventTotal/100};
    if(records.length || checkouts.length || activity.length || stripeEvents.length) {
      let added=0;
      const linked=new Set(events.filter(row=>row.stripePaymentRecordId).map(row=>String(row.stripePaymentRecordId)));
      // An unlinked Stripe event might already represent one of these records.
      // Do not add a second event merely because its FK is missing.
      const ambiguous=stripeEvents.some(row=>!row.stripePaymentRecordId);
      for(const record of records) {
        const key=`stripe_record:${record.id}`,paidAt=timestamp(record.paid_at);
        if(record.payment_status!=='paid' || linked.has(String(record.id)) || previousKeys.has(key) || ambiguous)continue;
        const received=cents(Number(record.amount_received_cents ?? record.amount_cents)/100);
        if((record.currency || '').toLowerCase()!=='usd' || !paidAt || received==null || received<=0)continue;
        added+=received;
        proposals.push({...base,key,kind:'stripe_record',stripePaymentRecordId:record.id,amount:received/100,recordedAt:paidAt,
          priceType:record.stripe_payment_method_type==='us_bank_account' ? 'bank' : record.stripe_payment_method_type==='card' ? 'card' : null,
          paymentDate:parkDate(paidAt),dateAssumed:false,updatedAmountPaid:Math.max(oldPaid,eventTotal+added)/100,
          basis:'Successful Stripe record with its original payment timestamp.'});
      }
      skippedRow(reservation,added ? 'Missing successful Stripe entries proposed; no additional cash balance is assumed.' : 'Stripe evidence exists: no cash payment is assumed. Existing, incomplete, or ambiguous Stripe entries need no duplicate or require review.');
      continue;
    }
    const key=`assumed_cash:${id}`;
    if(previousKeys.has(key)) {skippedRow(reservation,'Historical cash entry already processed; reruns leave it alone.');continue;}
    const price=cents(reservation.bankTotalPrice);
    if(price==null || price<0) {skippedRow(reservation,'Website cash price is missing; configure or review pricing first.');continue;}
    const missing=price-eventTotal;
    if(missing<=0) {skippedRow(reservation,'Dated payments already cover the cash price.');continue;}
    if(events.some(event=>/Price type:\s*card/i.test(event.note || '') || event.paymentSource==='office_card_reader' && !/Price type:\s*bank|Tender:\s*(cash|check)/i.test(event.note || ''))) {
      skippedRow(reservation,'Existing office card or untyped reader payment: review mixed cash/card pricing before adding a balance.');continue;
    }
    proposals.push({...base,key,kind:'assumed_cash',stripePaymentRecordId:null,amount:missing/100,paymentDate:arrival,
      recordedAt:null,dateAssumed:true,updatedAmountPaid:Math.max(oldPaid,price,eventTotal)/100,
      basis:`Assumed paid at website cash price. Arrival date is a reporting proxy; original payment date is unknown.${oldPaid>price?' Existing booking paid total exceeds cash price; excess is left untouched.':''}`});
  }
  const total=kind=>proposals.filter(row=>row.kind===kind).reduce((total,row)=>total+Math.round(row.amount*100),0)/100;
  const plan={from,to,asOf,proposals,skipped,assumedCashTotal:total('assumed_cash'),stripeRecoveredTotal:total('stripe_record'),count:proposals.length};
  // Includes every proposed amount, payment timestamp and old balance. A changed
  // Stripe record, payment, stay or quote requires a new review before applying.
  return {...plan,snapshot:createHash('sha256').update(JSON.stringify(plan)).digest('hex')};
}

async function loadPlan(client,getReservations,period) {
  const reservations=await getReservations(client);
  const stripeRecords=await client.query("SELECT id,reservation_id,payment_status,currency,amount_received_cents,amount_cents,paid_at,to_jsonb(s)->>'stripe_payment_method_type' AS stripe_payment_method_type FROM stripe_payment_records s ORDER BY id");
  const stripeCheckouts=await client.query('SELECT reservation_id,stripe_checkout_session_id,to_jsonb(b)->>\'stripe_payment_intent_id\' AS stripe_payment_intent_id FROM public_booking_checkouts b WHERE reservation_id IS NOT NULL ORDER BY id');
  const exists=await client.query("SELECT to_regclass('bookkeeping_stripe_activity') AS relation");
  const stripeActivity=exists.rows[0]?.relation ? await client.query('SELECT DISTINCT reservation_id FROM bookkeeping_stripe_activity WHERE reservation_id IS NOT NULL') : {rows:[]};
  const existingBackfills=await client.query('SELECT backfill_key FROM bookkeeping_historical_payment_backfills ORDER BY backfill_key');
  return planHistoricalDailyPayments({...period,reservations,stripeRecords:stripeRecords.rows,stripeCheckouts:stripeCheckouts.rows,stripeActivity:stripeActivity.rows,existingBackfills:existingBackfills.rows});
}

export function registerHistoricalDailyPaymentRoutes(app,{pool,getReservations,notify=()=>{}}) {
  const routes=bookkeepingRoutes(app);
  const schemaError=(res,error)=>{
    if(['42P01','42703'].includes(error.code)) {res.status(503).json({message:'Run sql/2026-10-27_historical_daily_payments.sql first. It only enables this reviewed backfill tool.'});return true;}
    return false;
  };
  routes.get('/api/bookkeeping/historical-daily-payments/preview',async(req,res)=>{
    const period=historicalDailyPeriod(req.query),client=await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const plan=await loadPlan(client,getReservations,period);
      await client.query('COMMIT');res.json(plan);
    } catch(error) {await client.query('ROLLBACK').catch(()=>{});if(!schemaError(res,error))throw error;} finally {client.release();}
  });
  routes.post('/api/bookkeeping/historical-daily-payments/apply',async(req,res)=>{
    const body=req.body || {},period=historicalDailyPeriod(body);
    if(body.confirmAssumedPaid!==true || !/^[a-f0-9]{64}$/.test(body.snapshot || ''))throw fail('Review the exact proposed entries and confirm the historical payment assumption.',400);
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='5s'");
      // Match the payment writer order (Stripe then reservations then events).
      // Block new payments as well as edits while rechecking and writing a batch.
      await client.query('LOCK TABLE stripe_payment_records,reservations,reservation_payment_events,reservation_site_stays,pricing_rules,public_booking_checkouts,bookkeeping_historical_payment_backfills IN SHARE ROW EXCLUSIVE MODE');
      const plan=await loadPlan(client,getReservations,period);
      if(plan.snapshot!==body.snapshot)throw fail('Payments, dates, or prices changed. Refresh the preview and review the new list.');
      if(!plan.count)throw fail('There are no missing entries in this preview.');
      const batchId=randomUUID();
      for(const row of plan.proposals) {
        const priceType=row.kind==='assumed_cash'?'bank':row.priceType;
        const note=`Historical backfill (${row.kind==='assumed_cash'?'ASSUMED CASH — not independently verified':'recovered Stripe payment'}). ${row.basis} Batch: ${batchId}.${priceType?` Price type: ${priceType}`:''}`;
        const event=await client.query(`INSERT INTO reservation_payment_events
          (reservation_id,stripe_payment_record_id,amount,payment_source,note,recorded_at,historical_assumption,historical_date_assumed)
          VALUES($1,$2,$3,$4,$5,COALESCE($6::timestamptz,($7::date+time '12:00') AT TIME ZONE 'America/Los_Angeles'),$8,$9) RETURNING id`,
        [row.reservationId,row.stripePaymentRecordId,row.amount,row.kind==='assumed_cash'?'office_card_reader':'stripe',note,row.recordedAt,row.paymentDate,row.kind==='assumed_cash',row.dateAssumed]);
        // Historical amount_paid can already include the paper payment. Adding
        // the event amount to it again would double the booking balance.
        await client.query('UPDATE reservations SET amount_paid=GREATEST(COALESCE(amount_paid,0),$2::numeric) WHERE id=$1',[row.reservationId,row.updatedAmountPaid]);
        await client.query(`INSERT INTO bookkeeping_historical_payment_backfills
          (batch_id,backfill_key,reservation_id,payment_event_id,kind,amount,previous_amount_paid,updated_amount_paid,period_start,period_end,payment_date_assumed,proposal,created_by_admin_user_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)`,
        [batchId,row.key,row.reservationId,event.rows[0].id,row.kind,row.amount,row.previousAmountPaid,row.updatedAmountPaid,period.from,period.to,row.dateAssumed,JSON.stringify(row),req.adminUser.id]);
      }
      await client.query('COMMIT');notify({reason:'bookkeeping_changed'});
      res.json({batchId,from:period.from,to:period.to,createdCount:plan.count,assumedCashTotal:plan.assumedCashTotal,stripeRecoveredTotal:plan.stripeRecoveredTotal});
    } catch(error) {
      await client.query('ROLLBACK').catch(()=>{});
      if(['55P03','40P01'].includes(error.code))throw fail('A booking or payment is being updated. Refresh the preview and try again.');
      if(!schemaError(res,error))throw error;
    } finally {client.release();}
  });
}
