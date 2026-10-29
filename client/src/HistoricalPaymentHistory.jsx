import { useRef, useState } from 'react';
import { Alert, Button, Checkbox, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel } from '@mui/material';

const money=value=>value==null?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(value);
const when=value=>new Date(value).toLocaleString('en-US',{timeZone:'America/Los_Angeles'});

export default function HistoricalPaymentHistory({apiRequest,onUndone,disabled=false}) {
  const [open,setOpen]=useState(false),[batches,setBatches]=useState(null),[plan,setPlan]=useState(null);
  const [busy,setBusy]=useState(''),[error,setError]=useState(''),[confirmed,setConfirmed]=useState(false);
  const inFlight=useRef(false);
  async function run(label,action){
    if(inFlight.current)return;
    inFlight.current=true;setBusy(label);setError('');setConfirmed(false);
    try{await action();}catch(err){setError(err.message);setPlan(null);}finally{inFlight.current=false;setBusy('');}
  }
  function load(){setPlan(null);return run('Loading backfill history…',async()=>{setBatches((await apiRequest('/bookkeeping/historical-daily-payments/batches')).batches);});}
  function preview(batchId){return run('Checking this batch and its bookings…',async()=>{setPlan(await apiRequest(`/bookkeeping/historical-daily-payments/undo-preview?batchId=${encodeURIComponent(batchId)}`));});}
  function undo(){
    if(!confirmed || !plan?.canUndo)return;
    return run('Undoing historical entries…',async()=>{
      const result=await apiRequest('/bookkeeping/historical-daily-payments/undo',{method:'POST',body:JSON.stringify({batchId:plan.batchId,snapshot:plan.snapshot,confirmUndo:true})});
      setOpen(false);setPlan(null);setBatches(null);onUndone(result);
    });
  }
  return <>
    <Button variant="outlined" disabled={disabled} onClick={()=>{setOpen(true);setBatches(null);load();}}>Backfill history / Undo</Button>
    <Dialog open={open} onClose={()=>{if(!busy)setOpen(false);}} fullWidth maxWidth="md" aria-labelledby="historical-undo-title">
      <DialogTitle id="historical-undo-title">{plan?'Review backfill undo':'Historical payment batches'}</DialogTitle>
      <DialogContent className="fin-modal-content finance-dialog">
        <p>These are the batches recorded through the historical daily payment tool. Undo removes that batch’s added ledger entries and restores each booking’s original paid total. It sends no messages and does not charge or refund a card. Original Stripe payment records stay in place.</p>
        {error?<Alert severity="error" sx={{my:2}}>{error}</Alert>:null}
        {busy?<p role="status"><CircularProgress size={16} sx={{mr:1,verticalAlign:'middle'}}/>{busy}</p>:null}
        {!plan && batches?.length===0?<Alert severity="info">No historical payment batches have been recorded through this tool.</Alert>:null}
        {!plan && batches?.length>0?<div className="fin-table-scroll"><table className="fin-lodging-table"><thead><tr><th>Recorded / stay dates</th><th>Entries</th><th>Assumed cash</th><th>Recovered Stripe</th><th>Action</th></tr></thead><tbody>{batches.map(batch=><tr key={batch.batchId}><td>{when(batch.createdAt)}<small>{batch.from} – {batch.to}</small><small>Batch {batch.batchId}</small></td><td>{batch.createdCount}</td><td>{money(batch.assumedCashTotal)}</td><td>{money(batch.stripeRecoveredTotal)}</td><td>{batch.reversedAt?<span>Undone {when(batch.reversedAt)}</span>:<Button disabled={!!busy} onClick={()=>preview(batch.batchId)}>Review undo</Button>}</td></tr>)}</tbody></table></div>:null}
        {plan?<>
          <p><strong>{plan.entryCount} entries</strong> · {money(plan.assumedCashTotal)} assumed cash · {money(plan.stripeRecoveredTotal)} recovered Stripe</p>
          <p className="fin-muted">Batch {plan.batchId} · {plan.from} – {plan.to}</p>
          {plan.blocked.map(reason=><Alert severity="warning" key={reason} sx={{my:1}}>{reason}</Alert>)}
          <div className="fin-table-scroll fin-historical-payment-preview"><table className="fin-lodging-table"><thead><tr><th>Booking / guest</th><th>Remove ledger entries</th><th>Current paid total</th><th>Restore paid total</th></tr></thead><tbody>{plan.rows.map(row=><tr key={row.reservationId}><td>#{row.reservationId} · {row.guestName}</td><td>{money(row.removedAmount)}</td><td>{money(row.currentAmountPaid)}</td><td><strong>{row.restoredAmountPaid==null?'Not recorded':money(row.restoredAmountPaid)}</strong></td></tr>)}</tbody></table></div>
          {plan.canUndo?<FormControlLabel className="fin-backfill-confirm" control={<Checkbox checked={confirmed} disabled={!!busy} onChange={event=>setConfirmed(event.target.checked)}/>} label="Undo only this backfill batch and restore the original booking paid totals shown above."/>:<p>Undo is blocked to protect changed records. No entries have been removed.</p>}
        </>:null}
      </DialogContent>
      <DialogActions><Button disabled={!!busy} onClick={()=>setOpen(false)}>Close</Button><Button disabled={!!busy} onClick={load}>{plan?'Back to history':'Refresh history'}</Button>{plan?<Button disabled={!!busy} onClick={()=>preview(plan.batchId)}>Refresh undo preview</Button>:null}{plan?.canUndo?<Button color="error" variant="contained" disabled={!!busy||!confirmed} onClick={undo}>Undo {plan.entryCount} entries</Button>:null}</DialogActions>
    </Dialog>
  </>;
}
