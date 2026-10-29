import { useRef, useState } from 'react';
import { Alert, Button, Checkbox, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel } from '@mui/material';
import HistoricalPaymentHistory from './HistoricalPaymentHistory.jsx';

const money=value=>value==null?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(value);
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());

export default function HistoricalDailyPayments({apiRequest,onApplied,onUndone,disabled=false}) {
  const [open,setOpen]=useState(false),[from,setFrom]=useState('2026-07-01'),[to,setTo]=useState(today);
  const [plan,setPlan]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[applying,setApplying]=useState(false),[confirmed,setConfirmed]=useState(false);
  const inFlight=useRef(false),dateKey=useRef('');dateKey.current=`${from}:${to}`;
  function changeDate(set,value){set(value);setPlan(null);setConfirmed(false);setError('');}
  async function preview(){
    if(inFlight.current)return;
    const key=dateKey.current;inFlight.current=true;setBusy(true);setError('');setPlan(null);setConfirmed(false);
    try {const result=await apiRequest(`/bookkeeping/historical-daily-payments/preview?from=${from}&to=${to}`);if(dateKey.current===key)setPlan(result);}
    catch(err){setError(err.message);}finally{inFlight.current=false;setBusy(false);}
  }
  async function apply(){
    if(inFlight.current || !plan || !confirmed)return;
    inFlight.current=true;setBusy(true);setApplying(true);setError('');
    try {
      const result=await apiRequest('/bookkeeping/historical-daily-payments/apply',{method:'POST',body:JSON.stringify({from:plan.from,to:plan.to,snapshot:plan.snapshot,confirmAssumedPaid:true})});
      setOpen(false);setPlan(null);setConfirmed(false);onApplied(result);
    }catch(err){setError(err.message);setPlan(null);setConfirmed(false);}finally{inFlight.current=false;setBusy(false);setApplying(false);}
  }
  return <>
    <div className="fin-historical-payment-callout"><div><strong>Fill the paper-record gap</strong><p>Review completed daily stays, recover missing Stripe entries, and add assumed cash payments for stays without linked Stripe records.</p></div><div className="fin-backfill-actions"><Button variant="outlined" disabled={disabled} onClick={()=>{setOpen(true);setError('');setPlan(null);setConfirmed(false);}}>Backfill historical daily payments</Button><HistoricalPaymentHistory apiRequest={apiRequest} onUndone={onUndone} disabled={disabled}/></div></div>
    <Dialog open={open} onClose={()=>{if(!busy)setOpen(false);}} fullWidth maxWidth="lg" aria-labelledby="historical-payment-title">
      <DialogTitle id="historical-payment-title">Backfill completed daily stays</DialogTitle>
      <DialogContent className="fin-modal-content finance-dialog">
        <p>Daily stays only. Monthly guests, future stays, canceled bookings, and waived balances are left out. Linked Stripe records block an assumed cash payment; successful Stripe payments with missing entries can be recovered.</p>
        <div className="fin-form-grid"><label>First arrival on or after<input type="date" min="2026-07-01" max={to} value={from} disabled={busy} onChange={event=>changeDate(setFrom,event.target.value)}/></label><label>Completed by<input type="date" min={from} max={today()} value={to} disabled={busy} onChange={event=>changeDate(setTo,event.target.value)}/></label></div>
        <p className="fin-muted">Cash entries use the website’s cash price, less payments already recorded. Review the prices, especially if rates changed since the paper records. The arrival date is used when the original cash payment date is unknown. No billing texts are sent and no cards are charged.</p>
        {error?<Alert severity="error" sx={{my:2}}>{error}</Alert>:null}
        {busy?<p role="status"><CircularProgress size={16} sx={{mr:1,verticalAlign:'middle'}}/>{applying?'Recording historical entries…':'Checking stays and Stripe records…'}</p>:null}
        {plan?<>
          <div className="fin-document-counts"><span><strong>{plan.count}</strong> proposed entries</span><span>Assumed cash <strong>{money(plan.assumedCashTotal)}</strong></span><span>Recovered Stripe <strong>{money(plan.stripeRecoveredTotal)}</strong></span></div>
          {plan.count?<Alert severity="info">Cash rows will be labeled “Assumed historical cash” with an assumed date. Existing payments and booking paid totals are reconciled to avoid counting the same money twice. Review the exact amounts below.</Alert>:<Alert severity="success">No missing entries are eligible for this date range. Review the skipped bookings below if something is missing.</Alert>}
          <div className="fin-table-scroll fin-historical-payment-preview" role="region" aria-label="Proposed historical payments"><table className="fin-lodging-table"><thead><tr><th>Booking / guest</th><th>Stay / site</th><th>Type / payment date</th><th>Website cash price</th><th>Existing dated payments</th><th>Add entry</th><th>Booking paid total after</th></tr></thead><tbody>{plan.proposals.map(row=><tr key={row.key}><td><strong>#{row.reservationId} · {row.guestName}</strong></td><td>{row.arrival} – {row.departure}<small>Site {row.sites}</small></td><td>{row.kind==='assumed_cash'?'Assumed historical cash':'Recovered Stripe'}<small>{row.paymentDate}{row.dateAssumed?' · assumed arrival date':' · original Stripe date'}</small><small>{row.basis}</small></td><td>{money(row.cashPrice)}</td><td>{money(row.existingEventAmount)}</td><td><strong>{money(row.amount)}</strong></td><td>{money(row.updatedAmountPaid)}<small>Before: {money(row.previousAmountPaid)}</small></td></tr>)}</tbody></table></div>
          <details className="fin-historical-skipped"><summary>{plan.skipped.length} skipped or partially recovered bookings</summary><div className="fin-table-scroll"><table className="fin-lodging-table"><thead><tr><th>Booking</th><th>Reason</th></tr></thead><tbody>{plan.skipped.map(row=><tr key={row.reservationId}><td>#{row.reservationId} · {row.guestName}</td><td>{row.reason}</td></tr>)}</tbody></table></div></details>
          {plan.count?<FormControlLabel className="fin-backfill-confirm" control={<Checkbox checked={confirmed} disabled={busy} onChange={event=>setConfirmed(event.target.checked)}/>} label="Record these listed cash assumptions and recovered Stripe payments in the historical payment ledger."/>:null}
        </>:null}
      </DialogContent>
      <DialogActions><Button disabled={busy} onClick={()=>setOpen(false)}>Cancel</Button><Button disabled={busy||!from||!to||from>to} onClick={preview}>{plan?'Refresh preview':'Preview missing payments'}</Button>{plan?.count?<Button variant="contained" disabled={busy||!confirmed} onClick={apply}>Record {plan.count} entries</Button>:null}</DialogActions>
    </Dialog>
  </>;
}
