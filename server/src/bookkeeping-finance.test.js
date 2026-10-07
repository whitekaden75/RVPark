import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFinanceReport, csvReport, financePeriod, registerFinanceRoutes } from './bookkeeping-finance.js';
import { reconcileTransactions } from './bookkeeping-reconciliation.js';

const stripe = (id,amount,fee,type='charge') => ({id,amount_cents:amount,fee_cents:fee,net_cents:amount-fee,reporting_category:type,activity_type:type,currency:'usd',occurred_at:'2026-10-06T20:00:00Z',balance_status:'available'});
const tx = (id,overrides={}) => ({id,status:'approved',transaction_date:'2026-10-06',vendor:'Chevron',transaction_type:'expense',total:'40.00',currency:'USD',category:'Fuel',...overrides});
test('Stripe gross, refunds, fees and payouts are distinct; pending expenses are excluded',()=>{
  const report=buildFinanceReport({stripeRows:[stripe('charge',10000,300),stripe('refund',-2000,0,'refund'),stripe('payout',-7700,0,'payout')],officeRows:[{id:1,amount:25,recorded_at:'2026-10-06T20:00:00Z'}],transactions:[tx(1),tx(2,{status:'pending',total:100}),tx(3,{transaction_type:'income',total:10})]});
  assert.equal(report.summary.grossCollections,135);assert.equal(report.summary.netRevenue,115);
  assert.equal(report.summary.totalExpenses,43);assert.equal(report.summary.netIncome,72);assert.equal(report.summary.payouts,77);
  assert.equal(report.categories.filter(row=>row.type==='expense').reduce((sum,row)=>sum+row.amount,0),43);
});
test('standalone fees, refund reversals and vendor credits preserve signed cash movements',()=>{
  const report=buildFinanceReport({stripeRows:[stripe('charge',10000,300),stripe('refund',-2000,0,'refund'),stripe('reversal',2000,0,'refund_failure'),stripe('fee',-500,0,'fee')],transactions:[tx(1),tx(2,{transaction_type:'refund',total:10})]});
  assert.equal(report.summary.refunds,0);assert.equal(report.summary.totalExpenses,38);assert.equal(report.summary.netIncome,62);
  assert.equal(report.categories.filter(row=>row.type==='expense').reduce((sum,row)=>sum+row.amount,0),38);
});
test('non-USD activity, transfers and adjustments do not pollute USD profit and loss',()=>{
  const report=buildFinanceReport({stripeRows:[{...stripe('euros',10000,300),currency:'eur'},stripe('transfer',50000,0,'transfer')],transactions:[tx(1,{currency:'CAD'}),tx(2,{transaction_type:'transfer',total:900}),tx(3,{transaction_type:'adjustment',total:500})]});
  assert.equal(report.summary.netIncome,0);assert.equal(report.summary.grossCollections,0);
});
test('finance periods validate real dates, ordering, and bounded history',()=>{
  assert.deepEqual(financePeriod({from:'2026-01-01',to:'2026-12-31'}),{from:'2026-01-01',to:'2026-12-31'});
  for(const query of [{from:'2026-02-30'},{from:'2026-12-31',to:'2026-01-01'},{from:'2020-01-01',to:'2026-01-01'}])assert.throws(()=>financePeriod(query));
});
test('CSV escapes formula-like vendor strings and quotes',()=>{
  const csv=csvReport([{vendor:'=HYPERLINK("evil")',amount:5}]);assert.match(csv,/"'=HYPERLINK\(""evil""\)"/);
});
test('same amount/date alone cannot establish a match; currencies and types must agree',()=>{
  const report=reconcileTransactions([tx(1)],[tx(2,{vendor:'Hardware store'}),tx(3,{currency:'CAD'}),tx(4,{transaction_type:'income'})]);
  assert.equal(report.matched.length,0);assert.equal(report.possibleMatches.length,1);assert.equal(report.possibleMatches[0].receiptTransaction.id,2);
});
test('ambiguous matches remain suggestions and duplicate detection never silently removes records',()=>{
  const report=reconcileTransactions([tx(1,{transaction_date:new Date('2026-10-06')}),tx(4)],[tx(2),tx(3)]);
  assert.equal(report.matched.length,0);assert.equal(report.consolidated.length,2);assert.equal(report.duplicates.length,2);assert.equal(report.unmatchedReceipts.length,2);
});
test('matches are one-to-one, ignore void records, and reject distant purchases',()=>{
  const report=reconcileTransactions([tx(1),tx(4,{vendor:'Other shop'})],[tx(2),tx(3,{status:'void'}),tx(5,{transaction_date:'2026-09-01'})]);
  assert.equal(report.matched.length,1);assert.equal(report.matched[0].receiptTransaction.id,2);assert.equal(report.unmatchedStatement.length,1);
});

test('Stripe sync uses unique balance IDs, an advisory lock, a transaction, and always releases the client',async()=>{
  const routes=new Map(),calls=[];
  const app=Object.fromEntries(['get','post','patch','delete'].map(method=>[method,(path,fn)=>routes.set(`${method} ${path}`,fn)]));
  const client={query:async(sql,params)=>{calls.push({sql,params});return {rows:sql.includes('AS locked')?[{locked:true}]:[],rowCount:1};},release(){calls.push({sql:'release'});}};
  const sdk={balanceTransactions:{list:()=>({async *[Symbol.asyncIterator](){yield {...stripe('txn_1',10000,300),created:1791316800,available_on:1791316800,source:'ch_1',type:'charge',status:'available',amount:10000,fee:300,net:9700};}})},balance:{retrieve:async()=>({available:[{currency:'usd',amount:9700}],pending:[]})}};
  registerFinanceRoutes(app,{pool:{connect:async()=>client},stripe:sdk});
  const res={status(code){this.code=code;return this;},json(body){this.body=body;}};
  for(let i=0;i<2;i++)await routes.get('post /api/bookkeeping/stripe/sync')({body:{from:'2026-10-01',to:'2026-10-06'}},res);
  assert.equal(res.body.imported,1);
  assert.equal(calls.filter(row=>row.sql.includes('INSERT INTO bookkeeping_stripe_activity')).length,2);
  assert.ok(calls.filter(row=>row.sql.includes('INSERT INTO bookkeeping_stripe_activity')).every(row=>row.sql.includes('ON CONFLICT (id) DO UPDATE')));
  assert.equal(calls.filter(row=>row.sql==='COMMIT').length,2);assert.equal(calls.filter(row=>row.sql==='release').length,2);assert.equal(calls.filter(row=>row.sql.includes('pg_advisory_unlock')).length,2);
});
