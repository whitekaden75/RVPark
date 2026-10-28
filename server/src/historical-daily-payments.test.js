import test from 'node:test';
import assert from 'node:assert/strict';
import { historicalDailyPeriod, planHistoricalDailyPayments } from './historical-daily-payments.js';
import { buildLodgingReport } from './bookkeeping-lodging.js';
import { buildFinanceReport } from './bookkeeping-finance.js';

const stay={site_number:'A',arrival_date:'2026-07-10',leave_date:'2026-07-13'};
const booking={id:1,first_name:'Test',last_name:'Guest',status:'active',billing_mode:'standard',bankTotalPrice:150,amountPaid:0,paymentEvents:[],siteStays:[stay]};
const scope={from:'2026-07-01',to:'2026-10-27',asOf:'2026-10-27'};
const plan=(changes={})=>planHistoricalDailyPayments({...scope,reservations:[booking],...changes});

test('untracked completed daily stay proposes cash price with explicit assumed date',()=>{
  const data=plan();assert.equal(data.count,1);assert.equal(data.assumedCashTotal,150);
  const row=data.proposals[0];assert.equal(row.amount,150);assert.equal(row.updatedAmountPaid,150);
  assert.equal(row.paymentDate,'2026-07-10');assert.equal(row.dateAssumed,true);assert.equal(row.recordedAt,null);
  assert.match(row.basis,/original payment date is unknown/);
});
test('legacy paid balances are reconstructed as dated events without doubling the booking paid total',()=>{
  const data=plan({reservations:[{...booking,amountPaid:150}]});
  assert.equal(data.proposals[0].amount,150);assert.equal(data.proposals[0].updatedAmountPaid,150);
  const partial=plan({reservations:[{...booking,amountPaid:150,paymentEvents:[{id:3,amount:25,paymentSource:'office_cash'}]}]});
  assert.equal(partial.proposals[0].amount,125);assert.equal(partial.proposals[0].updatedAmountPaid,150);
  const overpaid=plan({reservations:[{...booking,amountPaid:170}]});assert.equal(overpaid.proposals[0].updatedAmountPaid,170);
  assert.match(overpaid.proposals[0].basis,/excess is left untouched/);
});
test('only missing successful Stripe entries are recovered, with actual received amounts and original timestamps',()=>{
  const stripe={id:4,reservation_id:1,payment_status:'paid',currency:'usd',amount_cents:17000,amount_received_cents:16000,paid_at:'2026-07-08T01:00:00Z',stripe_payment_method_type:'us_bank_account'};
  const data=plan({stripeRecords:[stripe]});assert.equal(data.assumedCashTotal,0);assert.equal(data.stripeRecoveredTotal,160);
  assert.equal(data.proposals[0].paymentDate,'2026-07-07');assert.equal(data.proposals[0].recordedAt,stripe.paid_at.replace('Z','.000Z'));
  assert.equal(data.proposals[0].dateAssumed,false);assert.equal(data.proposals[0].priceType,'bank');
  assert.equal(plan({stripeRecords:[stripe],reservations:[{...booking,paymentEvents:[{id:1,amount:160,paymentSource:'stripe',stripePaymentRecordId:4}]}]}).count,0);
  assert.equal(plan({stripeRecords:[stripe],reservations:[{...booking,paymentEvents:[{id:1,amount:160,paymentSource:'stripe'}]}]}).count,0);
});
test('any linked Stripe evidence blocks guessed cash; failed, undated and non-USD Stripe records are not treated as paid',()=>{
  for(const changes of [{stripeRecords:[{id:4,reservation_id:1,payment_status:'failed'}]},
    {stripeCheckouts:[{reservation_id:1,stripe_checkout_session_id:'cs_test'}]},
    {stripeActivity:[{reservation_id:1}]},
    {stripeRecords:[{id:4,reservation_id:1,payment_status:'paid',currency:'usd',amount_cents:10000}]},
    {stripeRecords:[{id:4,reservation_id:1,payment_status:'paid',currency:'cad',amount_cents:10000,paid_at:'2026-07-10'}]}]){
    const data=plan(changes);assert.equal(data.count,0);assert.equal(data.assumedCashTotal,0);assert.match(data.skipped[0].reason,/Stripe/);
  }
});
test('monthly, canceled, pending, future, disjoint and unpriced stays cannot receive guessed daily payments',()=>{
  for(const changes of [{billing_mode:'monthly'},{monthly_classification:true},{reservation_term:'yearly'},
    {siteStays:[{...stay,leave_date:'2026-08-10'}]},{status:'canceled'},{status:'pending'},
    {siteStays:[{...stay,arrival_date:'2026-10-25',leave_date:'2026-10-30'}]},
    {siteStays:[{...stay,arrival_date:'2026-06-30',leave_date:'2026-07-02'}]},
    {siteStays:[stay,{...stay,arrival_date:'2026-08-01',leave_date:'2026-08-02'}]},
    {bankTotalPrice:null},{balanceWaiver:{active:true}},
    {notes:'AFTER-HOURS DRIVE-UP — not verified',after_hours_cash_received:false}]){
    assert.equal(plan({reservations:[{...booking,...changes}]}).count,0,JSON.stringify(changes));
  }
});
test('existing covered or imported entries are not added again and mixed reader pricing requires review',()=>{
  assert.equal(plan({reservations:[{...booking,paymentEvents:[{id:1,amount:150}]}]}).count,0);
  assert.equal(plan({existingBackfills:[{backfill_key:'assumed_cash:1'}]}).count,0);
  assert.equal(plan({reservations:[{...booking,paymentEvents:[{id:1,amount:25,paymentSource:'office_card_reader',note:'Price type: card'}]}]}).count,0);
  assert.equal(plan({reservations:[{...booking,paymentEvents:[{id:1,amount:25,paymentSource:'office_card_reader',note:'Tender: cash. Price type: bank'}]}]}).proposals[0].amount,125);
});
test('changed prices, balances, dates and Stripe timestamps invalidate the reviewed snapshot',()=>{
  const snapshot=plan().snapshot;
  for(const changes of [{bankTotalPrice:155},{amountPaid:10},{siteStays:[{...stay,arrival_date:'2026-07-09'}]}])assert.notEqual(plan({reservations:[{...booking,...changes}]}).snapshot,snapshot);
  assert.equal(plan().snapshot,snapshot);
});
test('reports expose assumed cash separately while including it once in daily and finance totals',()=>{
  const payments=[{id:1,reservation_id:1,payment_date:'2026-07-10',amount:100,historical_assumption:true,historical_date_assumed:true},
    {id:2,reservation_id:1,payment_date:'2026-07-11',amount:50}];
  const data=buildLodgingReport({...scope,reservations:[booking],stays:[{...stay,reservation_id:1}],payments});
  assert.equal(data.totals.dailyReceipts,150);assert.equal(data.totals.dailyAssumedCash,100);assert.equal(data.totals.dailyRecordedReceipts,50);
  assert.equal(data.receiptDetails[0].historicalAssumption,true);assert.equal(data.receiptDetails[0].dateAssumed,true);
  const report=buildFinanceReport({officeRows:[{id:1,amount:100,recorded_at:'2026-07-10T19:00:00Z',historical_assumption:true}]});
  assert.equal(report.summary.grossCollections,100);assert.equal(report.summary.historicalAssumedIncome,100);assert.equal(report.entries[0].historicalAssumption,true);
});
test('the period is bounded to the confirmed historical window',()=>{
  assert.deepEqual(historicalDailyPeriod({},'2026-10-27'),scope);
  for(const query of [{from:'2026-06-30'},{to:'2026-10-28'},{from:'2026-02-30'}])assert.throws(()=>historicalDailyPeriod(query,'2026-10-27'));
});
