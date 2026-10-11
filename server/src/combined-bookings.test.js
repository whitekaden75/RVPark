import test from 'node:test';
import assert from 'node:assert/strict';
import {sameBookingGuest,combinedBookingPlan} from './combined-bookings.js';
import {buildBillingSummary,sumReservationTotals} from './reservation-pricing.js';

const primary={id:1,customer_id:8,first_name:'Taylor',last_name:'Lee',email:'taylor@example.com',phone_number:'5415550101',
 status:'active',billing_mode:'standard',bankTotalPrice:1200,amountPaid:200,siteStays:[{site_id:1,arrival_date:'2026-10-01',leave_date:'2026-10-29'}]};
const source={...primary,id:2,bankTotalPrice:300,amountPaid:150,siteStays:[{site_id:2,arrival_date:'2026-10-29',leave_date:'2026-11-05'}]};

test('28-day stay plus site move becomes one monthly booking with agreed prices and combined payments',()=>{
 const plan=combinedBookingPlan(primary,source);
 assert.equal(plan.monthly,true);assert.equal(plan.billingMode,'manual_total');assert.equal(plan.manualOverride,true);
 assert.equal(plan.totalPrice,1500);assert.equal(plan.amountPaid,350);assert.equal(plan.stays.length,2);
 assert.equal(combinedBookingPlan(primary,source,{totalPrice:'1350.50'}).totalPrice,1350.5);
});
test('explicit combined totals are honored even when the combined stay is under 28 nights',()=>{
 const totals=sumReservationTotals([{numberOfNights:3,normalDailyPrice:75,discountDailyPrice:65,arrival_date:'2026-10-01',leave_date:'2026-10-04'}]);
 const result=buildBillingSummary({billing_mode:'manual_total',manual_pricing_override:true,total_price:100,amount_paid:0,requested_discounts:[]},totals,[]);
 assert.equal(result.effectiveBillingMode,'manual_total');assert.equal(result.bankTotalPrice,100);
});
test('duplicate guest records require matching name and contact details',()=>{
 assert.equal(sameBookingGuest(primary,{...source,customer_id:9,email:'TAYLOR@example.com'}),true);
 assert.equal(sameBookingGuest(primary,{...source,customer_id:9,email:'',phone_number:'+1 (541) 555-0101'}),true);
 assert.equal(sameBookingGuest(primary,{...source,customer_id:9,first_name:'Someone else'}),false);
 assert.equal(sameBookingGuest(primary,{...source,customer_id:9,email:'other@example.com',phone_number:''}),false);
});
test('overlaps, gaps, inactive bookings, unknown prices and invalid overrides cannot combine',()=>{
 for(const reservation of [{...source,status:'pending'},{...source,merged_into_reservation_id:3},
  {...source,siteStays:[{...source.siteStays[0],arrival_date:'2026-10-28'}]},
  {...source,siteStays:[{...source.siteStays[0],arrival_date:'2026-10-30'}]},
  {...source,siteStays:[{...source.siteStays[0],leave_date:'9999-12-31'}]}]) assert.throws(()=>combinedBookingPlan(primary,reservation));
 assert.throws(()=>combinedBookingPlan(primary,{...source,bankTotalPrice:null}),/agreed combined/);
 assert.equal(combinedBookingPlan(primary,{...source,bankTotalPrice:null},{totalPrice:0}).totalPrice,0);
 for(const totalPrice of ['',true,'NaN',-1]) assert.throws(()=>combinedBookingPlan(primary,source,{totalPrice}),/valid combined/);
});
test('an existing monthly account retains its rent billing settings when adding a site segment',()=>{
 const plan=combinedBookingPlan({...primary,billing_mode:'monthly',totalPrice:0,monthlyRentPrice:900},source);
 assert.equal(plan.billingMode,'monthly');assert.equal(plan.totalPrice,0);assert.equal(plan.monthly,true);
});

test('converting unpriced bookings to monthly rent needs no total and leaves the price unset',()=>{
 const unpricedPrimary={...primary,bankTotalPrice:null,totalPrice:1500,manual_pricing_override:true};
 const longSource={...source,bankTotalPrice:null,siteStays:[{site_id:2,arrival_date:'2026-10-29',leave_date:'2027-05-01'}]};
 const plan=combinedBookingPlan(unpricedPrimary,longSource,{billingMode:'monthly'});
 assert.equal(plan.billingMode,'monthly');assert.equal(plan.totalPrice,null);assert.equal(plan.manualOverride,false);
 assert.equal(plan.resetMonthlySettings,true);assert.equal(plan.monthly,true);assert.equal(plan.amountPaid,350);
 const billing=buildBillingSummary({billing_mode:plan.billingMode,total_price:plan.totalPrice,
  monthly_rent_price:null,electric_meter_reading:null,amount_paid:plan.amountPaid,requested_discounts:[]},sumReservationTotals([]),[]);
 assert.equal(billing.monthlyRentPrice,null);assert.equal(billing.bankTotalPrice,null);assert.equal(billing.amountPaid,350);
});

test('monthly rent keeps an existing account but a stay-total merge still requires an agreed price',()=>{
 const existing=combinedBookingPlan({...primary,billing_mode:'monthly',totalPrice:0,monthlyRentPrice:900},source,{billingMode:'monthly'});
 assert.equal(existing.resetMonthlySettings,false);assert.equal(existing.totalPrice,null);
 assert.throws(()=>combinedBookingPlan(primary,{...source,bankTotalPrice:null},{billingMode:'manual_total'}),/agreed combined/);
 assert.throws(()=>combinedBookingPlan(primary,source,{billingMode:'invalid'}),/Choose monthly rent/);
 assert.equal(combinedBookingPlan(primary,source,{billingMode:'manual_total',monthly:false,totalPrice:1400}).totalPrice,1400);
});
