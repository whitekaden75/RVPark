import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLodgingReport, isMonthlyAccount, lodgingPeriod } from './bookkeeping-lodging.js';

const resident={id:1,status:'active',reservation_term:'yearly',billing_mode:'standard',monthly_rent_price:'700',monthly_billing_day:1,first_name:'Test',last_name:'Resident'};
const stay={reservation_id:1,site_number:'A',arrival_date:'2026-08-01',leave_date:'9999-12-31'};
const source={id:1,reservation_id:1,billing_month:'2026-09-01',source_kind:'rv_meter',meter_reading:54732,usage_kwh:625,electric_amount:'31.25',source_sheet:'September',source_row:5,site_number:'A'};
const report=changes=>buildLodgingReport({reservations:[resident],stays:[stay],sources:[source],from:'2026-09-01',to:'2026-09-30',asOf:'2026-10-27',...changes});

test('monthly estimates use saved rent plus listed bill and do not add recorded monthly payments',()=>{
  const data=report({payments:[{id:1,reservation_id:1,payment_date:'2026-09-02',amount:'731.25'}]});
  assert.equal(data.totals.monthlyRent,700);assert.equal(data.totals.monthlyElectric,31.25);
  assert.equal(data.totals.monthlyEstimatedCharges,731.25);assert.equal(data.totals.monthlyRecordedReceipts,731.25);
  assert.equal(data.totals.dailyReceipts,0);assert.equal(data.monthlyDetails.length,1);
});

test('adjusted spreadsheet bills override standard formula and zero is a real utility charge',()=>{
  const adjusted=report({sources:[{...source,usage_kwh:348,electric_amount:29.16}]});
  assert.equal(adjusted.totals.monthlyElectric,29.16);
  const zero=report({sources:[{...source,electric_amount:0}]});
  assert.equal(zero.monthlyDetails[0].total,700);assert.equal(zero.totals.monthlyIncomplete,0);
});

test('missing rent or utilities stays incomplete, with only known components in subtotals',()=>{
  const missingRent=report({reservations:[{...resident,monthly_rent_price:null}]});
  assert.equal(missingRent.monthlyDetails[0].rent,null);assert.equal(missingRent.monthlyDetails[0].total,null);
  assert.equal(missingRent.totals.monthlyIncomplete,1);assert.equal(missingRent.totals.monthlyEstimatedCharges,31.25);
  const missingUtilities=report({sources:[{...source,electric_amount:null}]});
  assert.equal(missingUtilities.monthlyDetails[0].electric,null);assert.equal(missingUtilities.totals.monthlyIncomplete,1);
  assert.equal(missingUtilities.totals.monthlyEstimatedCharges,700);
});

test('meters require a previous month baseline and never bill an accumulated reading as usage',()=>{
  const readings=[{id:1,reservation_id:1,reading:100000,reading_date:'2026-08-01'},{id:2,reservation_id:1,reading:100600,reading_date:'2026-09-01'}];
  const good=report({sources:[],readings});assert.equal(good.monthlyDetails[0].usage,600);assert.equal(good.totals.monthlyElectric,27);
  for(const bad of [[readings[1]],[{...readings[0],reading:101000},readings[1]],[{...readings[0],reading_date:'2026-07-01'},readings[1]]]) {
    const data=report({sources:[],readings:bad});assert.equal(data.monthlyDetails[0].electric,null);assert.equal(data.totals.monthlyIncomplete,1);
  }
});

test('multiple source rows count rent once and surface potential duplicate utility charges',()=>{
  const data=report({sources:[source,{...source,id:2,electric_amount:5}]});
  assert.equal(data.monthlyDetails.length,1);assert.equal(data.totals.monthlyRent,700);
  assert.equal(data.totals.monthlyElectric,36.25);assert.ok(data.monthlyDetails[0].issues.some(note=>note.startsWith('Multiple source')));
});

test('unassigned bills, deposit notes and blank November templates do not invent charges',()=>{
  const cabin={...source,id:9,reservation_id:null,source_kind:'cabin_bill',site_number:'Cabin',electric_amount:60,power_amount:42,gas_amount:18};
  const deposit={...source,id:10,source_kind:'deposit_note',electric_amount:200};
  const data=report({sources:[source,cabin,deposit]});
  assert.equal(data.totals.monthlyEstimatedCharges,731.25);assert.equal(data.cabinBills.length,1);assert.equal(data.unassignedSources.length,1);
});

test('daily and monthly dated receipts stay separate, with signed refund reversals and period boundaries',()=>{
  const daily={id:2,status:'active',first_name:'Daily',last_name:'Guest'};
  const data=report({reservations:[resident,daily],payments:[
    {id:1,reservation_id:2,payment_date:'2026-09-01',amount:100},{id:2,reservation_id:2,payment_date:'2026-09-30',amount:50},
    {id:3,reservation_id:1,payment_date:'2026-09-10',amount:700},{id:4,reservation_id:2,payment_date:'2026-10-01',amount:100},
    {id:5,reservation_id:999,payment_date:'2026-09-10',amount:25}],refunds:[
    {id:'r',reservation_id:2,payment_date:'2026-09-12',amount_cents:-2000},
    {id:'reversal',reservation_id:2,payment_date:'2026-09-13',amount_cents:500}]});
  assert.equal(data.totals.dailyReceipts,150);assert.equal(data.totals.dailyRefunds,15);assert.equal(data.totals.dailyNetReceipts,135);
  assert.equal(data.totals.monthlyRecordedReceipts,700);assert.equal(data.totals.unassignedReceipts,25);
});

test('billing day clamps to month end, partial month and future charges remain explicit',()=>{
  const data=report({reservations:[{...resident,monthly_billing_day:31}],asOf:'2026-09-15'});
  assert.equal(data.monthlyDetails[0].chargeDate,'2026-09-30');assert.equal(data.monthlyDetails[0].included,false);
  assert.equal(data.totals.monthlyEstimatedCharges,0);
  const partial=report({stays:[{...stay,arrival_date:'2026-09-15'}]});
  assert.equal(partial.monthlyDetails[0].chargeDate,'2026-09-15');assert.ok(partial.monthlyDetails[0].issues.some(note=>note.startsWith('Partial month')));
});

test('a future utility reading cannot enter current totals even when rent is already due',()=>{
  const data=report({sources:[{...source,reading_date:'2026-09-30'}],asOf:'2026-09-15'});
  assert.equal(data.totals.monthlyRent,700);assert.equal(data.totals.monthlyElectric,0);
  assert.equal(data.monthlyDetails[0].electric,null);assert.ok(data.monthlyDetails[0].issues.some(note=>note.includes('report cutoff')));
});

test('saved zero rent overrides are respected and merged/canceled records do not generate rent',()=>{
  assert.equal(report({sources:[{...source,rent_override:0}]}).totals.monthlyRent,0);
  assert.equal(report({reservations:[{...resident,merged_into_reservation_id:2}]}).monthlyDetails.length,0);
  assert.equal(report({reservations:[{...resident,status:'canceled'}],sources:[]}).monthlyDetails.length,0);
});

test('monthly classification covers legacy yearly and manual monthly guests',()=>{
  for(const row of [resident,{billing_mode:'monthly'},{monthly_classification:true}])assert.equal(isMonthlyAccount(row,[]),true);
  assert.equal(isMonthlyAccount({},[stay]),true);
  assert.equal(isMonthlyAccount({},[{arrival_date:'2026-09-01',leave_date:'2026-09-29'}]),true);
  assert.equal(isMonthlyAccount({},[{arrival_date:'2026-09-01',leave_date:'2026-09-05'}]),false);
});

test('report periods validate real dates and cap a year of history',()=>{
  assert.deepEqual(lodgingPeriod({},'2026-10-27'),{from:'2026-10-01',to:'2026-10-27',asOf:'2026-10-27'});
  for(const query of [{from:'2026-02-30'},{from:'2026-11-01',to:'2026-10-01'},{from:'2020-01-01',to:'2026-10-27'}])assert.throws(()=>lodgingPeriod(query));
});
