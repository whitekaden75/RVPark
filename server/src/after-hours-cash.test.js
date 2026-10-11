import test from 'node:test';
import assert from 'node:assert/strict';
import {expectedEnvelopeAmount,registerAfterHoursCashRoutes} from './after-hours-cash.js';
import {combinedBookingPlan} from './combined-bookings.js';

const booking={id:1,status:'pending',billing_mode:'standard',amountPaid:0,
  notes:'AFTER-HOURS DRIVE-UP — cash envelope payment awaiting office verification.\nExpected envelope amount: $180.00.',
  siteStays:[{site_id:2,arrival_date:'2026-10-09',leave_date:'2026-10-12'}]};

test('cash quotes use the amount captured at QR checkout and ignore notes inherited from combined bookings',()=>{
  assert.equal(expectedEnvelopeAmount(booking),180);
  assert.equal(expectedEnvelopeAmount({...booking,notes:booking.notes.replace('$180.00','$1,234.56')}),1234.56);
  for(const notes of ['Ordinary cash payment','AFTER-HOURS DRIVE-UP. Expected envelope amount: $invalid.',
    'From combined booking #2: '+booking.notes,'AFTER-HOURS DRIVE-UP. Expected envelope amount: $0.00.'])
    assert.equal(expectedEnvelopeAmount({...booking,notes}),null);
});

function fixture({row=booking,cashPaid=0,overlap=null,failPayment=false,missingMigration=false}={}) {
  let handler,stored=row?{...row}:null;const statements=[],events=[],notifications=[];
  const client={query:async(sql,values)=>{
    statements.push(sql);
    if(sql.startsWith('SELECT id'))return {rowCount:stored?1:0};
    if(sql.includes('AS cash_paid'))return {rows:[{cash_paid:cashPaid}]};
    if(sql.startsWith('UPDATE reservations')) {
      if(missingMigration)throw Object.assign(new Error('missing'),{code:'42703'});
      stored={...stored,status:'active',amountPaid:Number(stored.amountPaid)+values[1],after_hours_cash_received:JSON.parse(values[2]),
        ...(values[3] ? {billing_mode:'manual_total',manual_pricing_override:true,totalPrice:values[4]} : {})};
    }
    return {rowCount:1};
  },release(){statements.push('RELEASE');}};
  registerAfterHoursCashRoutes({post:(_,fn)=>handler=fn},{pool:{connect:async()=>client},
    getReservation:async()=>stored,insertPayment:async(_,event)=>{if(failPayment)throw Error('ledger');events.push(event);},
    findOverlap:async()=>overlap,notify:event=>notifications.push(event),now:()=>new Date('2026-10-10T15:00:00Z')});
  const call=async(body={amount:'180.00'})=>{const res={code:200,status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
    await handler({params:{id:'1'},body,adminUser:{id:8}},res);return res;};
  return {call,statements,events,notifications};
}

test('received cash activates a QR booking, fixes its accepted quote and records real money exactly once',async()=>{
  const f=fixture();const first=await f.call();
  assert.equal(first.code,200);assert.equal(first.body.status,'active');assert.equal(first.body.amountPaid,180);
  assert.equal(first.body.totalPrice,180);assert.equal(first.body.manual_pricing_override,true);
  assert.equal(first.body.after_hours_cash_received.adminUserId,8);
  assert.equal(f.events[0].amount,180);assert.match(f.events[0].note,/Tender: cash/);
  assert.equal((await f.call()).code,200);assert.equal(f.events.length,1);assert.equal(f.notifications.length,1);
  assert.ok(f.statements.includes('COMMIT'));assert.ok(f.statements.some(sql=>sql.includes('FOR UPDATE')));
});

test('short cash envelopes credit only the counted amount and preserve staff pricing adjustments',async()=>{
  const f=fixture({row:{...booking,billing_mode:'manual_total',manual_pricing_override:true,totalPrice:150}});
  const res=await f.call({amount:60});assert.equal(res.code,200);
  assert.equal(res.body.amountPaid,60);assert.equal(res.body.totalPrice,150);assert.equal(f.events[0].amount,60);
});

test('cash already recorded is verified without new money; existing card payments cannot be verified as cash',async()=>{
  const f=fixture({row:{...booking,amountPaid:180},cashPaid:180});
  assert.equal((await f.call()).code,409);
  const res=await f.call({amount:180,alreadyRecorded:true});assert.equal(res.code,200);
  assert.equal(res.body.amountPaid,180);assert.equal(res.body.after_hours_cash_received.creditedAmount,0);assert.equal(f.events.length,0);
  assert.equal((await fixture({row:{...booking,amountPaid:180}}).call({amount:180,alreadyRecorded:true})).code,409);
});

test('bad amounts, canceled or ordinary bookings, conflicts and ledger failures cannot confirm cash',async()=>{
  for(const amount of [0,-1,'',true,null,'1.234','Infinity'])assert.equal((await fixture().call({amount})).code,400);
  assert.equal((await fixture({row:null}).call()).code,404);
  for(const row of [{...booking,status:'canceled'},{...booking,notes:'Ordinary cash'},
    {...booking,merged_into_reservation_id:2},{...booking,id:2}])assert.equal((await fixture({row}).call()).code,409);
  const conflict=fixture({overlap:{message:'Site booked'}});assert.equal((await conflict.call()).code,409);assert.equal(conflict.events.length,0);
  const failure=fixture({failPayment:true});assert.equal((await failure.call()).code,500);assert.ok(failure.statements.includes('ROLLBACK'));
  assert.equal((await fixture({missingMigration:true}).call()).code,503);
});

test('unverified approved cash bookings must be reviewed before combining',()=>{
  const primary={...booking,status:'active',customer_id:3};
  const other={...primary,id:2,notes:'',siteStays:[{site_id:4,arrival_date:'2026-10-12',leave_date:'2026-10-14'}],bankTotalPrice:100};
  assert.throws(()=>combinedBookingPlan(primary,other,{totalPrice:280}),/Verify after-hours cash/);
  assert.equal(combinedBookingPlan({...primary,after_hours_cash_received:{amount:180}},other,{totalPrice:280}).totalPrice,280);
});
