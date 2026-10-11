import {useEffect,useRef,useState} from 'react';
import {sameBookingGuest} from './admin-ui.js';

const money=value=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(value || 0));
const dates=stays=>stays.map(stay=>`Site ${stay.site_number}: ${stay.arrival_date} → ${stay.leave_date}`).join(' · ');

export default function ReservationTools({reservation,reservations,request,onSaved,onRefresh}) {
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
    if(pending.current) return;
    pending.current=true;setBusy(true);setError('');setNotice('');
    try {
      const updated=await request(`/reservations/${reservation.id}/${path}`,{method:'POST',body:JSON.stringify(body)});
      onSaved(updated);setSourceId('');setReview(false);setNotice(message);
      try {await onRefresh();} catch {setNotice(`${message} Refresh the list to see all changes.`);}
    } catch(error){setError(error.message);}
    finally {pending.current=false;setBusy(false);}
  }
  function reviewCombination(){
    setError('');
    if(!source) return;
    if(reservation.billing_mode!=='monthly' && (total.trim()==='' || !Number.isFinite(Number(total)) || Number(total)<0)) {
      setError('Enter the agreed combined stay total before reviewing.');return;
    }
    setReview(true);
  }
  return <details className="booking-tools">
    <summary>Monthly & combined bookings</summary>
    <div className="booking-tools-body">
      <div className="booking-monthly-action"><div><h4>Monthly guest</h4><p>Show this booking on the Monthly page, including trips that move between sites. Monthly rates and recurring charges can be edited there.</p>
        {reservation.monthly_classification ? <strong className="booking-monthly-label">Marked monthly by the office</strong> : null}</div>
        <button type="button" className="ghost-button" disabled={busy} onClick={()=>save('monthly-classification',{monthly:!reservation.monthly_classification},reservation.monthly_classification?'Automatic monthly classification restored.':'Booking marked as monthly.')}>
          {reservation.monthly_classification?'Use automatic classification':'Mark as monthly'}
        </button>
      </div>
      <div className="booking-combine-action"><h4>Combine another booking</h4><p>Choose this guest’s next or previous booking. The stays must connect without gaps or overlapping nights.</p>
        <label>Booking to combine<select aria-label="Booking to combine" value={sourceId} disabled={busy} onChange={event=>setSourceId(event.target.value)}>
          <option value="">Choose another booking</option>{candidates.map(other=><option key={other.id} value={other.id}>#{other.id} · {dates(other.siteStays || [])}</option>)}
        </select></label>
        {!candidates.length?<p className="muted">No other active bookings were found for this guest.</p>:null}
        {source?<>
          <p className="booking-combine-dates">{dates(source.siteStays || [])}</p>
          {reservation.billing_mode!=='monthly'?<label>Combined stay total ($)<input aria-label="Combined stay total" type="number" min="0" step="0.01" value={total} disabled={busy || review} onChange={event=>{setTotal(event.target.value);setReview(false);}}/><small>The default adds both agreed stay prices. Enter a different agreed total if needed.</small></label>:null}
          <label className="checkbox-row"><input type="checkbox" checked={monthly} disabled={busy || review} onChange={event=>setMonthly(event.target.checked)}/><span>Mark the combined booking as monthly, even if under 28 nights</span></label>
          {review?<div className="booking-combine-review">
            <h4>Review combined booking #{reservation.id}</h4>
            <p>{reservation.first_name} {reservation.last_name} · {dates([...(reservation.siteStays || []),...(source.siteStays || [])].sort((a,b)=>a.arrival_date.localeCompare(b.arrival_date)))}</p>
            <p><strong>Payments already collected: {money(Number(reservation.amountPaid || 0)+Number(source.amountPaid || 0))}</strong></p>
            <p>{reservation.billing_mode==='monthly'?`Keep this booking’s monthly rate of ${money(reservation.monthlyRentPrice)}.`:`Agreed stay total: ${money(total)}.`} Guest details come from booking #{reservation.id}. Payment and check-in histories from both bookings are kept.</p>
            <p>Booking #{source.id} will move into this booking. Recurring charges from both records are kept; review them afterward. Any existing balance waiver needs review for the combined stay.</p>
            <div className="button-row"><button type="button" className="ghost-button" disabled={busy} onClick={()=>setReview(false)}>Back</button><button type="button" className="primary-button" disabled={busy} onClick={()=>save('combine',{sourceReservationId:source.id,monthly,...(reservation.billing_mode!=='monthly'?{totalPrice:total}:{})},`Booking #${source.id} combined into #${reservation.id}.`)}>{busy?'Combining…':`Combine into booking #${reservation.id}`}</button></div>
          </div>:<button type="button" className="ghost-button" disabled={busy} onClick={reviewCombination}>Review combination</button>}
        </>:null}
      </div>
      {error?<div className="message error" role="alert">{error}</div>:null}
      {notice?<div className="message success" role="status">{notice}</div>:null}
    </div>
  </details>;
}
