// A waiver settles the current booking without claiming that money was collected.
// Its scope excludes contact details, payment history and changing rate tables.
export function getBalanceWaiverScope(reservation, stays = reservation.siteStays || []) {
  const number = value => value == null || value === '' ? null : Number(value);
  const discounts = reservation.requested_discounts ?? reservation.requestedDiscounts ?? [];
  return {
    billingMode: reservation.billing_mode,
    manualPricingOverride: Boolean(reservation.manual_pricing_override),
    reservationTerm: reservation.reservation_term,
    totalPrice: number(reservation.total_price ?? reservation.totalPrice),
    monthlyRent: number(reservation.monthly_rent_price ?? reservation.monthlyRentPrice),
    meter: number(reservation.electric_meter_reading ?? reservation.electricMeterReading),
    summerRate: number(reservation.monthly_summer_rate ?? reservation.monthlySummerRate),
    winterRate: number(reservation.monthly_winter_rate ?? reservation.monthlyWinterRate),
    category: reservation.pricing_category_override ?? reservation.pricingCategoryOverride ?? null,
    discounts: [...new Set(discounts.map(value => String(value).trim()).filter(Boolean))].sort(),
    stays: stays.map(stay => ({ site: Number(stay.site_id), arrival: stay.arrival_date, departure: stay.leave_date }))
      .sort((a,b) => a.arrival.localeCompare(b.arrival) || a.site-b.site || a.departure.localeCompare(b.departure)),
  };
}

// JSONB may reorder object keys; compare canonical scope values rather than JSON key order.
function sameScope(left, right) {
  return Boolean(left && right && Object.keys(right).every(key =>
    key === 'stays' ? Array.isArray(left.stays) && left.stays.length === right.stays.length &&
      left.stays.every((stay,index) => Object.keys(right.stays[index]).every(field => stay[field] === right.stays[index][field]))
    : JSON.stringify(left[key]) === JSON.stringify(right[key])));
}

export function applyBalanceWaiver(reservation, stays, billing) {
  const waiver = reservation.balance_waiver;
  if (!waiver) return { ...billing, balanceWaiver: null };
  const applies = reservation.status === 'active' && sameScope(waiver.scope,getBalanceWaiverScope(reservation,stays));
  const balanceWaiver = { active: applies, waivedAt: waiver.waivedAt, reason: waiver.reason || '',
    scopeChanged: !applies };
  if (!applies) return { ...billing, balanceWaiver };
  return { ...billing, balanceWaiver,
    remainingBalance: 0, bankRemainingBalance: 0, cardRemainingBalance: 0, cardPaymentOptions: [],
    paidChargeableNights: billing.totalChargeableNights ?? null,
    unpaidChargeableNights: billing.totalChargeableNights == null ? null : 0,
    paidStayNights: billing.totalStayNights ?? null,
    unpaidStayNights: billing.totalStayNights == null ? null : 0,
  };
}

export function registerBalanceWaiverRoutes(app, {pool,getReservation,notify,now=()=>new Date()}) {
  app.post('/api/reservations/:id/balance-waiver',async (req,res) => {
    const {waive,reason=''}=req.body || {};
    if (!/^[1-9]\d*$/.test(String(req.params.id)) || typeof waive !== 'boolean' ||
        typeof reason !== 'string' || reason.trim().length>500) {
      return res.status(400).json({message:'Choose waive or restore and a note of 500 characters or less.'});
    }
    let client;
    let changed=false;
    try {
      client=await pool.connect();
      await client.query('BEGIN');
      const lock=await client.query('SELECT id FROM reservations WHERE id=$1 FOR UPDATE',[req.params.id]);
      if (!lock.rowCount) {await client.query('ROLLBACK');return res.status(404).json({message:'Reservation not found.'});}
      const reservation=await getReservation(client,req.params.id);
      if (String(reservation.id)!==String(req.params.id)) {
        await client.query('ROLLBACK');return res.status(409).json({message:'This booking was combined. Open the combined booking to change its balance.'});
      }
      if (waive && reservation.status!=='active') {
        await client.query('ROLLBACK');return res.status(409).json({message:'Only active reservations can have their remaining balance waived.'});
      }
      if (waive ? !reservation.balanceWaiver?.active : Boolean(reservation.balance_waiver)) {
        const scope=getBalanceWaiverScope(reservation);
        const waiver=waive ? {scope,reason:reason.trim(),waivedAt:now().toISOString(),adminUserId:req.adminUser?.id || null} : null;
        await client.query('UPDATE reservations SET balance_waiver=$2::jsonb WHERE id=$1',[req.params.id,waiver ? JSON.stringify(waiver) : null]);
        await client.query(`INSERT INTO reservation_balance_waiver_events
          (reservation_id,action,reason,scope,admin_user_id)
          VALUES ($1,$2,$3,$4::jsonb,$5)`,[req.params.id,waive?'waive':'restore',
          waive ? reason.trim() : reservation.balance_waiver.reason || '',
          JSON.stringify(waive ? scope : reservation.balance_waiver.scope),req.adminUser?.id || null]);
        changed=true;
      }
      const updated=await getReservation(client,req.params.id);
      await client.query('COMMIT');
      if (changed) notify({reason:'reservation_balance_waiver_updated',reservationId:Number(req.params.id)});
      return res.json(updated);
    } catch(error) {
      if (client) await client.query('ROLLBACK').catch(()=>{});
      const migrationMissing=['42703','42P01'].includes(error.code);
      return res.status(migrationMissing?503:500).json({message:migrationMissing
        ? 'Run sql/2026-10-10_reservation_balance_waivers.sql to enable balance waivers.'
        : 'Unable to update the balance waiver. Please refresh and try again.'});
    } finally {client?.release();}
  });
}
