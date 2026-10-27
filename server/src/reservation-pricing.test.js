import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBillingSummary, buildPricingRuleLookup, getPricingForSiteAndNights, sumReservationTotals } from './reservation-pricing.js';

const bill = ({bank=50,nights=2,paid=100,method='bank',events=[]}={}) => {
  const lookup=buildPricingRuleLookup([{site_category:'off_river_small_rig',number_of_days:1,normal_price:bank,discount_price:bank}]);
  const totals=sumReservationTotals([{site_id:1,arrival_date:'2026-07-01',leave_date:`2026-07-${String(nights+1).padStart(2,'0')}`,...getPricingForSiteAndNights({is_big_rig:false},nights,lookup)}]);
  return buildBillingSummary({billing_mode:'standard',reservation_term:'standard',payment_method:method,amount_paid:paid,deposit_amount:0,requested_discounts:[]},totals,events);
};

test('untyped historical payments cannot create a card fee after the saved aggregate exactly pays the bank total',()=>{
  for(const method of ['bank','card']) for(const events of [
    [{id:'1',amount:'60.00',note:'Office card reader payment'}],
    [{id:'1',amount:'60.00',note:'Office card reader payment'},{id:'2',amount:'40.00',note:'Imported payment'}],
    [{id:'1',amount:'40.00',note:'Imported payment'},{id:'2',amount:'60.00',note:'Office card reader payment'}],
  ]) {
    const result=bill({method,events});
    assert.equal(result.amountPaid,100);
    assert.equal(result.bankRemainingBalance,0);
    assert.equal(result.cardRemainingBalance,0);
    assert.equal(result.remainingBalance,0);
    assert.equal(result.paidStayNights,2);
    assert.equal(result.unpaidStayNights,0);
    assert.deepEqual(result.cardPaymentOptions,[]);
  }
});

test('untyped history consistently applies an exactly paid card total',()=>{
  const result=bill({paid:103.98,method:'card',events:[{id:1,amount:60,note:'Old payment'},{id:2,amount:43.98,note:'Old payment'}]});
  assert.equal(result.cardRemainingBalance,0);
  assert.equal(result.unpaidStayNights,0);
});

test('explicit card-priced history preserves a genuine balance even when the cash total is covered',()=>{
  const result=bill({bank:60,nights:1,paid:60,method:'card',events:[{amount:60,note:'Office card payment. Tender: card. Price type: card'}]});
  assert.equal(result.cardRemainingBalance,1.99);
  assert.equal(result.remainingBalance,1.99);
  assert.equal(result.unpaidStayNights,1);
});

test('untyped partial payments do not receive a blanket small-balance write-off',()=>{
  const result=bill({paid:99,method:'card',events:[{id:1,amount:60,note:'Old payment'},{id:2,amount:39,note:'Old payment'}]});
  assert.ok(result.cardRemainingBalance>0);
  assert.ok(result.unpaidStayNights>0);
});
