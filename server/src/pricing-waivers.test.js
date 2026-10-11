import test from 'node:test';
import assert from 'node:assert/strict';
import {applyBalanceWaiver,getBalanceWaiverScope,registerBalanceWaiverRoutes} from './pricing-waivers.js';
import {buildBillingSummary,sumReservationTotals} from './reservation-pricing.js';

const stays=[{id:3,site_id:2,arrival_date:'2026-10-09',leave_date:'2026-10-12',numberOfNights:3,normalDailyPrice:75,discountDailyPrice:65}];
const row={id:1,status:'active',billing_mode:'standard',reservation_term:'standard',deposit_amount:75,
  amount_paid:75,payment_method:'bank',requested_discounts:[],siteStays:stays};
const totals=sumReservationTotals(stays);
const withWaiver=reservation=>({...reservation,balance_waiver:{scope:getBalanceWaiverScope(reservation),reason:'Courtesy adjustment',waivedAt:'2026-10-10T20:00:00Z'}});
const summary=reservation=>applyBalanceWaiver(reservation,reservation.siteStays,buildBillingSummary(reservation,totals,[]));

test('waivers clear bank/card balances and nights due while preserving money, prices and booked deposits',()=>{
  const original=buildBillingSummary(row,totals,[]);
  const waived=summary(withWaiver(row));
  assert.equal(waived.balanceWaiver.active,true);
  assert.equal(waived.unpaidStayNights,0);assert.equal(waived.paidStayNights,3);
  for(const key of ['remainingBalance','bankRemainingBalance','cardRemainingBalance']) assert.equal(waived[key],0);
  for(const key of ['amountPaid','bankTotalPrice','cardTotalPrice','depositAmount','requiredDepositAmount','requiredCardDepositAmount']) assert.equal(waived[key],original[key],key);
  assert.deepEqual(waived.cardPaymentOptions,[]);
  assert.equal(summary({...withWaiver(row),balance_waiver:null}).bankRemainingBalance,150);
});

test('unpriced long stays and monthly balances can be waived without inventing totals or meter readings',()=>{
  for(const reservation of [{...row,total_price:null},{...row,billing_mode:'monthly',reservation_term:'yearly',monthly_rent_price:1100,electric_meter_reading:null}]){
    const base=buildBillingSummary(reservation,{normalPrice:null,discountPrice:null,numberOfNights:null,chargeableNights:null},[]);
    const waived=applyBalanceWaiver(withWaiver(reservation),stays,base);
    assert.equal(base.remainingBalance,null);assert.equal(waived.remainingBalance,0);
    assert.equal(waived.amountPaid,75);assert.equal(waived.electricMeterReading,null);
    assert.equal(waived.bankTotalPrice,null);
  }
});

test('waivers survive contact edits, new stay IDs, payment updates and JSONB key reordering',()=>{
  const waived=withWaiver(row);
  waived.balance_waiver.scope=Object.fromEntries(Object.entries(waived.balance_waiver.scope).reverse());
  waived.balance_waiver.scope.stays=waived.balance_waiver.scope.stays.map(stay=>Object.fromEntries(Object.entries(stay).reverse()));
  assert.equal(summary({...waived,amount_paid:100,first_name:'Updated',notes:'Edited',siteStays:stays.map(stay=>({...stay,id:500,normalDailyPrice:90}))}).balanceWaiver.active,true);
});

test('extensions, return visits, rate choices and monthly charge changes invalidate the current waiver',()=>{
  const waived=withWaiver(row);
  for(const changed of [
    {siteStays:stays.map(stay=>({...stay,leave_date:'2026-10-13'}))},
    {siteStays:[...stays,{site_id:2,arrival_date:'2026-11-01',leave_date:'2026-11-03'}]},
    {siteStays:stays.map(stay=>({...stay,site_id:9}))},
    {requested_discounts:['AAA']},{pricing_category_override:'prime_river'},
    {billing_mode:'manual_total',total_price:100},{monthly_rent_price:900},{electric_meter_reading:1000},
    {monthly_summer_rate:1100},{status:'canceled'},
  ]){
    const result=summary({...waived,...changed});
    assert.equal(result.balanceWaiver.active,false,JSON.stringify(changed));
    assert.equal(result.balanceWaiver.scopeChanged,true);
    assert.equal(result.bankRemainingBalance,buildBillingSummary({...waived,...changed},totals,[]).bankRemainingBalance);
  }
});

function routeFixture({reservation=row,missingSchema=false,failAudit=false}={}){
  let handler,stored={...reservation},queries=[],events=[],notifications=[],released=false;
  const client={query:async(sql,params)=>{
    queries.push(sql);
    if(sql.startsWith('SELECT id')) return {rowCount:stored?1:0};
    if(sql.startsWith('UPDATE reservations')){
      if(missingSchema)throw Object.assign(new Error('missing column'),{code:'42703'});
      stored={...stored,balance_waiver:params[1]?JSON.parse(params[1]):null};
    }
    if(sql.includes('INSERT INTO reservation_balance_waiver_events')){
      if(failAudit)throw new Error('audit failure');events.push(params);
    }
    return {rowCount:1};
  },release:()=>{released=true;}};
  registerBalanceWaiverRoutes({post:(_path,fn)=>{handler=fn;}},{pool:{connect:async()=>client},
    getReservation:async()=>({...stored,...summary(stored)}),notify:event=>notifications.push(event),now:()=>new Date('2026-10-10T20:00:00Z')});
  const call=async(body,params={id:'1'})=>{
    const res={code:200,status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
    await handler({params,body,adminUser:{id:8}},res);return res;
  };
  return {call,queries,events,notifications,get released(){return released;},get stored(){return stored;}};
}

test('admin waive/restore is serialized, idempotent, audited and notifies only after commit',async()=>{
  const f=routeFixture();
  const result=await f.call({waive:true,reason:' Courtesy adjustment '});
  assert.equal(result.code,200);assert.equal(result.body.balanceWaiver.active,true);
  assert.equal(result.body.amountPaid,75);assert.equal(f.events[0][1],'waive');assert.equal(f.events[0][2],'Courtesy adjustment');
  assert.equal(f.events[0][4],8);assert.match(f.queries[1],/FOR UPDATE/);
  assert.equal(f.queries.at(-1),'COMMIT');assert.equal(f.notifications.length,1);assert.equal(f.released,true);
  await f.call({waive:true,reason:'Repeat'});assert.equal(f.events.length,1);
  const restored=await f.call({waive:false});assert.equal(restored.body.balanceWaiver,null);
  assert.equal(restored.body.bankRemainingBalance,150);assert.equal(f.events[1][1],'restore');
  await f.call({waive:false});assert.equal(f.events.length,2);
});

test('invalid requests, inactive bookings, missing migration and audit failure do not report success',async()=>{
  for(const body of [{waive:'yes'},{waive:true,reason:123},{waive:true,reason:'a'.repeat(501)}]){
    const f=routeFixture();assert.equal((await f.call(body)).code,400);assert.equal(f.queries.length,0);
  }
  assert.equal((await routeFixture().call({waive:true},{id:'0'})).code,400);
  const inactive=routeFixture({reservation:{...row,status:'pending'}});
  assert.equal((await inactive.call({waive:true})).code,409);assert.equal(inactive.events.length,0);
  for(const options of [{missingSchema:true},{failAudit:true}]){
    const f=routeFixture(options);const result=await f.call({waive:true});
    assert.equal(result.code,options.missingSchema?503:500);assert.equal(f.queries.at(-1),'ROLLBACK');
    assert.equal(f.notifications.length,0);assert.equal(f.released,true);
  }
});
