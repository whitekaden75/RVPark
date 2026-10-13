import {useEffect,useRef,useState} from 'react';
import {sameBookingGuest} from './admin-ui.js';

const money=value=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(value || 0));
const dates=stays=>stays.map(stay=>`Site ${stay.site_number}: ${stay.arrival_date} → ${stay.leave_date}`).join(' · ');

export default function ReservationTools({reservation,reservations,request,onSaved,onRefresh,disabled=false,onBusyChange}) {
  const [sourceId,setSourceId]=useState('');
  const [monthly,setMonthly]=useState(true);
  const [total,setTotal]=useState('');
  const [review,setReview]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const pending=useRef(false);
  const candidates=reservations.filter(other=>other.id!==reservation.id && other.status==='active' && !other.merged_into_reservation_id && sameBookingGuest(reservation,other));
  const source=candidates.find(other=>String(other.id)===sourceId);
  useEffect(()=>{
    setReview(false);
    const source=reservations.find(other=>String(other.id)===sourceId);
    setTotal(source && reservation.bankTotalPrice!=null && source.bankTotalPrice!=null
      ? (Number(reservation.bankTotalPrice)+Number(source.bankTotalPrice)).toFixed(2) : '');
  },[sourceId,reservation.id]);
  useEffect(()=>{setSourceId('');setError('');setNotice('');setReview(false);},[reservation.id]);
  if(reservation.status!=='active') return null;

  async function save(path,body,message) {
    if(pending.current || disabled) return;
    pending.current=true;setBusy(true);setError('');setNotice('');
    onBusyChange?.(true);
    try {
      const updated=await request(`/reservations/${reservation.id}/${path}`,{method:'POST',body:JSON.stringify(body)});
      onSaved(updated);setSourceId('');setReview(false);setNotice(message);
      try {await onRefresh();} catch {setNotice(`${message} Refresh the list to see all changes.`);}
    } catch(error){setError(error.message);}
    finally {pending.current=false;setBusy(false);onBusyChange?.(false);}
  }
  function reviewCombination(){
    if(disabled || busy) return;
    setError('');
    if(!source) return;
    if(!monthly && (total.trim()==='' || !Number.isFinite(Number(total)) || Number(total)<0)) {
      setError('Enter the agreed combined stay total before reviewing.');return;
    }
    setReview(true);
  }
  return <details className="booking-tools">
    <summary>Monthly & combined bookings</summary>
    <div className="booking-tools-body">
      {disabled ? <p className="muted">Save your date/site changes before changing monthly classification or combining bookings.</p> : null}
      <div className="booking-monthly-action"><div><h4>Monthly guest</h4><p>Show this booking on the Monthly page, including trips that move between sites. Monthly rates and recurring charges can be edited there.</p>
        {reservation.monthly_classification ? <strong className="booking-monthly-label">Marked monthly by the office</strong> : null}</div>
        <button type="button" className="ghost-button" disabled={busy || disabled} onClick={()=>save('monthly-classification',{monthly:!reservation.monthly_classification},reservation.monthly_classification?'Automatic monthly classification restored.':'Booking marked as monthly.')}>
          {reservation.monthly_classification?'Use automatic classification':'Mark as monthly'}
        </button>
      </div>
      <div className="booking-combine-action"><h4>Combine another booking</h4><p>Choose this guest’s next or previous booking. The stays must connect without gaps or overlapping nights.</p>
        <label>Booking to combine<select aria-label="Booking to combine" value={sourceId} disabled={busy || disabled} onChange={event=>setSourceId(event.target.value)}>
          <option value="">Choose another booking</option>{candidates.map(other=><option key={other.id} value={other.id}>#{other.id} · {dates(other.siteStays || [])}</option>)}
        </select></label>
        {!candidates.length?<p className="muted">No other active bookings were found for this guest.</p>:null}
        {source?<>
          <p className="booking-combine-dates">{dates(source.siteStays || [])}</p>
          <label className="checkbox-row compact-checkbox"><input type="checkbox" checked={monthly} disabled={busy || review || disabled} onChange={event=>{setMonthly(event.target.checked);setReview(false);}}/><span>Use monthly rent pricing — no whole-trip total</span></label>
          {monthly ? <p className="muted">{reservation.billing_mode==='monthly' ? 'Keep the existing monthly billing settings. Rent can be changed on the Monthly page.' : 'No price is set when you combine these bookings. Set the rent, billing day and electricity details later on the Monthly page.'}</p> : <label>Combined stay total ($)<input aria-label="Combined stay total" type="number" min="0" step="0.01" value={total} disabled={busy || review || disabled} onChange={event=>{setTotal(event.target.value);setReview(false);}}/><small>The default adds both agreed stay prices. Enter a different agreed total if needed.</small></label>}
          {review?<div className="booking-combine-review">
            <h4>Review combined booking #{reservation.id}</h4>
            <p>{reservation.first_name} {reservation.last_name} · {dates([...(reservation.siteStays || []),...(source.siteStays || [])].sort((a,b)=>a.arrival_date.localeCompare(b.arrival_date)))}</p>
            <p><strong>Payments already collected: {money(Number(reservation.amountPaid || 0)+Number(source.amountPaid || 0))}</strong></p>
            <p>{monthly ? reservation.billing_mode==='monthly' ? 'Keep the existing monthly billing settings; no whole-trip total is set.' : 'Monthly rent pricing. No price is set yet; configure rent later on the Monthly page.' : `Agreed stay total: ${money(total)}.`} Guest details come from booking #{reservation.id}. Payment and check-in histories from both bookings are kept.</p>
            <p>Booking #{source.id} will move into this booking. Recurring charges from both records are kept; review them afterward. Any existing balance waiver needs review for the combined stay.</p>
            <div className="button-row"><button type="button" className="ghost-button" disabled={busy || disabled} onClick={()=>setReview(false)}>Back</button><button type="button" className="primary-button" disabled={busy || disabled} onClick={()=>save('combine',{sourceReservationId:source.id,monthly,billingMode:monthly?'monthly':'manual_total',...(!monthly?{totalPrice:total}:{})},`Booking #${source.id} combined into #${reservation.id}.`)}>{busy?'Combining…':`Combine into booking #${reservation.id}`}</button></div>
          </div>:<button type="button" className="ghost-button" disabled={busy || disabled} onClick={reviewCombination}>Review combination</button>}
        </>:null}
      </div>
      {error?<div className="message error" role="alert">{error}</div>:null}
      {notice?<div className="message success" role="status">{notice}</div>:null}
    </div>
  </details>;
}
