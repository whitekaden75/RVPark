import { bookkeepingRoutes } from './bookkeeping-http.js';

const dateText = value => value instanceof Date ? value.toISOString().slice(0,10) : String(value || '').slice(0,10);
const amount = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Math.round(Number(value)*100)/100;
const add = values => Math.round(values.reduce((sum,value) => sum + Math.round((value || 0)*100),0))/100;
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
const nextMonth = month => new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),1)).toISOString().slice(0,10);
const monthDate = (month,day) => `${month.slice(0,7)}-${String(Math.min(Math.max(Number(day) || 1,1),new Date(Date.parse(nextMonth(month))-86400000).getUTCDate())).padStart(2,'0')}`;
const overlaps = (stay,from,to) => dateText(stay.arrival_date) <= to && dateText(stay.leave_date) > from;
const fail = (message,statusCode=400) => Object.assign(new Error(message),{statusCode});

export function lodgingPeriod(query={},today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())) {
  const from = String(query.from || `${today.slice(0,7)}-01`), to = String(query.to || today);
  if (!validDate(from) || !validDate(to) || from>to || (Date.parse(to)-Date.parse(from))/86400000>366) throw fail('Choose a valid report period of one year or less.');
  return {from,to,asOf:today};
}

export function isMonthlyAccount(reservation,stays=[]) {
  return Boolean(reservation.monthly_classification || reservation.billing_mode==='monthly' || reservation.reservation_term==='yearly' ||
    stays.some(stay => dateText(stay.leave_date)==='9999-12-31') ||
    stays.reduce((sum,stay) => sum + Math.max((Date.parse(dateText(stay.leave_date))-Date.parse(dateText(stay.arrival_date)))/86400000 || 0,0),0)>=28);
}

export function buildLodgingReport({reservations=[],stays=[],sources=[],readings=[],payments=[],refunds=[],from,to,asOf}) {
  const grouped = new Map();
  for (const stay of stays) { const id=String(stay.reservation_id); grouped.set(id,[...(grouped.get(id) || []),stay]); }
  const byId = new Map(reservations.map(row => [String(row.id),row]));
  const linkedIds = new Set(sources.filter(row => row.reservation_id && row.source_kind!=='deposit_note').map(row => String(row.reservation_id)));
  const monthly = row => isMonthlyAccount(row,grouped.get(String(row.id)) || []) || linkedIds.has(String(row.id));
  const months = [];
  for (let month=`${from.slice(0,7)}-01`;month<=to;month=nextMonth(month)) months.push(month);
  const details=[],unassigned=[],cabinBills=[],receiptDetails=[];
  const cutoff = to < asOf ? to : asOf;
  for (const source of sources) {
    if (dateText(source.billing_month)<`${from.slice(0,7)}-01` || dateText(source.billing_month)>to) continue;
    if (source.source_kind==='cabin_bill') cabinBills.push(source);
    if (!source.reservation_id) unassigned.push(source);
  }
  for (const month of months) {
    const end=new Date(Date.parse(nextMonth(month))-86400000).toISOString().slice(0,10);
    for (const reservation of reservations) {
      if (reservation.merged_into_reservation_id || !monthly(reservation)) continue;
      const id=String(reservation.id), allStays=grouped.get(id) || [];
      const activeStays=allStays.filter(stay => overlaps(stay,month,end));
      const imported=sources.filter(row => String(row.reservation_id)===id && dateText(row.billing_month)===month && row.source_kind!=='deposit_note');
      if (!imported.length && (reservation.status!=='active' || !activeStays.length)) continue;
      const issues=[];
      const firstArrival=allStays.map(row => dateText(row.arrival_date)).sort()[0];
      const sourceDay=imported.find(row => row.reading_day)?.reading_day;
      let chargeDate=monthDate(month,reservation.monthly_billing_day || sourceDay || firstArrival?.slice(8,10) || 1);
      if (firstArrival?.slice(0,7)===month.slice(0,7) && chargeDate<firstArrival) chargeDate=firstArrival;
      const occupied=activeStays.some(stay => dateText(stay.arrival_date)<=chargeDate && dateText(stay.leave_date)>chargeDate);
      if (!imported.length && !occupied) continue;
      // Billing date anchors the full rent estimate; no undocumented proration.
      if (!occupied) issues.push('Billing date is outside the saved stay; verify rent for this month.');
      if (activeStays.some(stay => dateText(stay.arrival_date)>month || dateText(stay.leave_date)<nextMonth(month))) issues.push('Partial month or site move: verify the full monthly rent estimate.');
      if (!reservation.monthly_billing_day) issues.push('Billing day inferred from spreadsheet or arrival date.');
      const overrides=imported.filter(row => row.rent_override!=null).map(row => amount(row.rent_override));
      let rent=overrides.length ? overrides[0] : amount(reservation.monthly_rent_price);
      if (new Set(overrides).size>1) {rent=null;issues.push('Conflicting rent overrides.');}
      if (rent==null) issues.push('Saved monthly rent is missing.');
      if (!occupied && !overrides.length) rent=null;
      const sourceNotes=imported.map(row => row.source_note).filter(Boolean);
      issues.push(...sourceNotes);
      let electric=null,electricSource='',usage=null;
      if (imported.length) {
        const futureUtility=imported.some(row => dateText(row.reading_date)>cutoff);
        const known=imported.map(row => futureUtility ? null : amount(row.electric_amount));
        if (futureUtility) issues.push('Utility bill date is beyond the report cutoff; excluded until that date.');
        if (known.every(value => value!=null)) {electric=add(known);electricSource=imported.some(row => row.source_kind==='cabin_bill') ? 'Cabin utility bills' : 'Spreadsheet bill';}
        else issues.push('Spreadsheet electric charge is missing; do not assume zero.');
        usage=imported.length===1 ? amount(imported[0].usage_kwh) : null;
        if (imported.length>1) issues.push('Multiple source rows for this guest/month; confirm they are separate charges.');
      } else {
        const ordered=readings.filter(row => String(row.reservation_id)===id).sort((a,b) => dateText(a.reading_date).localeCompare(dateText(b.reading_date)) || Number(a.id)-Number(b.id));
        const current=ordered.filter(row => dateText(row.reading_date)>=month && dateText(row.reading_date)<=end && dateText(row.reading_date)<=cutoff);
        if (current.length===1) {
          const reading=current[0], previous=ordered.filter(row => dateText(row.reading_date)<dateText(reading.reading_date)).at(-1);
          if (previous && dateText(previous.reading_date).slice(0,7)===new Date(Date.parse(month)-86400000).toISOString().slice(0,7)) {
            usage=Number(reading.reading)-Number(previous.reading);
            if (usage>=0) {electric=amount(Math.max(usage*.17-75,0));electricSource='Meter estimate';}
            else {usage=null;issues.push('Meter decreased; verify rollover or replacement.');}
          } else issues.push('Previous month meter baseline is missing.');
        } else issues.push(current.length>1 ? 'Multiple meter readings in this month; review the billing interval.' : 'No meter reading or electric bill for this month.');
      }
      const outsideRange=chargeDate<from || chargeDate>to || chargeDate>asOf;
      if (outsideRange) issues.push(chargeDate>asOf ? 'Future billing date; excluded from totals.' : 'Billing date is outside the selected dates; excluded from totals.');
      details.push({key:`${id}:${month}`,reservationId:reservation.id,guestName:`${reservation.first_name || ''} ${reservation.last_name || ''}`.trim(),
        siteNumbers:[...new Set([...activeStays.map(row => row.site_number),...imported.map(row => row.site_number)].filter(Boolean))].join(', '),
        month:month.slice(0,7),chargeDate,rent,electric,usage,electricSource,total:rent!=null && electric!=null ? add([rent,electric]) : null,
        included:!outsideRange,issues:[...new Set(issues)],sources:imported});
    }
  }
  for (const payment of payments) {
    const date=dateText(payment.payment_date || payment.recorded_at), reservation=byId.get(String(payment.reservation_id));
    if (date<from || date>cutoff) continue;
    receiptDetails.push({...payment,date,amount:amount(payment.amount),group:reservation ? monthly(reservation) ? 'monthly' : 'daily' : 'unassigned',guestName:reservation ? `${reservation.first_name || ''} ${reservation.last_name || ''}`.trim() : 'Unassigned reservation'});
  }
  const refundDetails=refunds.map(row => {
    const reservation=byId.get(String(row.reservation_id));
    return {...row,date:dateText(row.payment_date),amount:-Number(row.amount_cents)/100,guestName:reservation ? `${reservation.first_name || ''} ${reservation.last_name || ''}`.trim() : 'Unassigned reservation',group:reservation ? monthly(reservation) ? 'monthly' : 'daily' : 'unassigned'};
  }).filter(row => row.date>=from && row.date<=cutoff);
  const summaries=months.map(month => {
    const key=month.slice(0,7), rows=details.filter(row => row.month===key && row.included);
    const receipts=receiptDetails.filter(row => row.date.slice(0,7)===key), returned=refundDetails.filter(row => row.date.slice(0,7)===key);
    return {month:key,monthlyRent:add(rows.map(row => row.rent)),monthlyElectric:add(rows.map(row => row.electric)),
      monthlyEstimatedCharges:add(rows.flatMap(row => [row.rent,row.electric])),monthlyIncomplete:rows.filter(row => row.total==null).length,
      monthlyGuestCount:rows.length,dailyReceipts:add(receipts.filter(row => row.group==='daily').map(row => row.amount)),
      dailyRefunds:add(returned.filter(row => row.group==='daily').map(row => row.amount)),
      monthlyRecordedReceipts:add(receipts.filter(row => row.group==='monthly').map(row => row.amount)),
      monthlyRecordedRefunds:add(returned.filter(row => row.group==='monthly').map(row => row.amount)),
      unassignedReceipts:add(receipts.filter(row => row.group==='unassigned').map(row => row.amount)),
      unassignedRefunds:add(returned.filter(row => row.group==='unassigned').map(row => row.amount)),
      unresolvedSources:unassigned.filter(row => dateText(row.billing_month).slice(0,7)===key).length};
  }).map(row => ({...row,dailyNetReceipts:add([row.dailyReceipts,-row.dailyRefunds])}));
  return {from,to,asOf,months:summaries,monthlyDetails:details,receiptDetails,refundDetails,unassignedSources:unassigned,cabinBills,
    totals:Object.fromEntries(['monthlyRent','monthlyElectric','monthlyEstimatedCharges','monthlyIncomplete','monthlyGuestCount','dailyReceipts','dailyRefunds','dailyNetReceipts','monthlyRecordedReceipts','monthlyRecordedRefunds','unassignedReceipts','unassignedRefunds','unresolvedSources'].map(key => [key,add(summaries.map(row => row[key]))])),
    reservationOptions:reservations.filter(row => !row.merged_into_reservation_id).map(row => ({id:row.id,name:`${row.first_name || ''} ${row.last_name || ''}`.trim(),rent:amount(row.monthly_rent_price),sites:[...new Set((grouped.get(String(row.id)) || []).map(stay => stay.site_number))].join(', ')}))};
}

export function registerLodgingRoutes(app,{pool,notify=()=>{}}) {
  const routes=bookkeepingRoutes(app);
  routes.get('/api/bookkeeping/lodging-tax',async(req,res) => {
    const period=lodgingPeriod(req.query),client=await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const reservations=await client.query(`SELECT r.id,r.status,r.reservation_term,r.billing_mode,r.monthly_rent_price,r.monthly_billing_day,
        coalesce((to_jsonb(r)->>'monthly_classification')::boolean,false) AS monthly_classification,
        to_jsonb(r)->>'merged_into_reservation_id' AS merged_into_reservation_id,c.first_name,c.last_name
        FROM reservations r LEFT JOIN customers c ON c.id=r.customer_id`);
      const stays=await client.query('SELECT st.reservation_id,st.arrival_date::text,st.leave_date::text,s.site_number FROM reservation_site_stays st LEFT JOIN rv_sites s ON s.id=st.site_id');
      const sources=await client.query('SELECT * FROM bookkeeping_monthly_utility_sources ORDER BY billing_month,site_number,id');
      const readings=await client.query('SELECT id,reservation_id,reading,reading_date::text FROM monthly_meter_readings WHERE reading_date<=$1 ORDER BY reservation_id,reading_date,id',[period.to]);
      // Payment events are the canonical dated collections, including Stripe.
      // Do not add amount_paid or imported bank/receipt transactions a second time.
      const payments=await client.query(`SELECT e.id,e.reservation_id,e.amount,e.payment_source,
        (e.recorded_at AT TIME ZONE 'America/Los_Angeles')::date::text AS payment_date
        FROM reservation_payment_events e WHERE e.recorded_at>=($1::date::timestamp AT TIME ZONE 'America/Los_Angeles')
        AND e.recorded_at<(($2::date+1)::timestamp AT TIME ZONE 'America/Los_Angeles') ORDER BY e.recorded_at,e.id`,[period.from,period.to]);
      const refunds=await client.query(`SELECT id,reservation_id,amount_cents,currency,description,
        (occurred_at AT TIME ZONE 'America/Los_Angeles')::date::text AS payment_date FROM bookkeeping_stripe_activity
        WHERE (reporting_category IN ('refund','refund_failure') OR activity_type IN ('refund','payment_refund','refund_failure','payment_failure_refund','payment_reversal'))
        AND currency='usd' AND livemode=$3
        AND occurred_at>=($1::date::timestamp AT TIME ZONE 'America/Los_Angeles') AND occurred_at<(($2::date+1)::timestamp AT TIME ZONE 'America/Los_Angeles')`,[period.from,period.to,!String(process.env.STRIPE_SECRET_KEY || '').includes('_test_')]);
      await client.query('COMMIT');
      res.json(buildLodgingReport({...period,reservations:reservations.rows,stays:stays.rows,sources:sources.rows,readings:readings.rows,payments:payments.rows,refunds:refunds.rows}));
    } catch(error) {
      await client.query('ROLLBACK').catch(()=>{});
      if (['42P01','42703'].includes(error.code)) return res.status(503).json({message:'Run sql/2026-10-27_import_meter_readings_2026.sql to set up the lodging report and import the spreadsheet.'});
      throw error;
    } finally {client.release();}
  });
  routes.patch('/api/bookkeeping/lodging-tax/sources/:id',async(req,res) => {
    if (!/^[1-9]\d*$/.test(String(req.params.id))) throw fail('Choose a source row.');
    const body=req.body || {}, hasReservation=Object.hasOwn(body,'reservationId'), hasRent=Object.hasOwn(body,'rentOverride');
    if (!hasReservation && !hasRent) throw fail('Choose a reservation or a rent override.');
    if (hasReservation && !/^[1-9]\d*$/.test(String(body.reservationId || ''))) throw fail('Choose a reservation.');
    const rent=hasRent && body.rentOverride!=='' && body.rentOverride!=null ? amount(body.rentOverride) : null;
    if (hasRent && body.rentOverride!=='' && body.rentOverride!=null && (rent==null || rent<0)) throw fail('Enter a non-negative rent override, or leave it blank to use saved rent.');
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='5s'");
      const source=(await client.query('SELECT * FROM bookkeeping_monthly_utility_sources WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];
      if (!source) throw fail('Source row not found.',404);
      if (hasReservation) {
        if (source.reservation_id && String(source.reservation_id)!==String(body.reservationId)) throw fail('This source already has a reservation. Review its existing link before changing it.',409);
        const reservation=await client.query("SELECT id FROM reservations r WHERE id=$1 AND to_jsonb(r)->>'merged_into_reservation_id' IS NULL FOR UPDATE",[body.reservationId]);
        if (!reservation.rowCount) throw fail('Reservation not found.',404);
      }
      const result=await client.query(`UPDATE bookkeeping_monthly_utility_sources SET
        reservation_id=CASE WHEN $2::boolean THEN $3::bigint ELSE reservation_id END,
        rent_override=CASE WHEN $4::boolean THEN $5::numeric ELSE rent_override END,updated_at=now() WHERE id=$1 RETURNING *`,
      [source.id,hasReservation,hasReservation ? body.reservationId : null,hasRent,rent]);
      const reservationId=result.rows[0].reservation_id;
      if (reservationId) await client.query('SELECT sync_imported_monthly_meters($1::bigint)',[reservationId]);
      await client.query('COMMIT');notify({reason:'bookkeeping_changed'});res.json({source:result.rows[0]});
    } catch(error) {await client.query('ROLLBACK').catch(()=>{});throw error;} finally {client.release();}
  });
}
