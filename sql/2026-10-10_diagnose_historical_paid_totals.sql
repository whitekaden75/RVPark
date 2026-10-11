-- Read-only diagnostics for the seven bookings reported by the paid migration.
-- Clear the failed migration's transaction before inspecting the bookings.
ROLLBACK;

WITH stays AS (
  SELECT st.reservation_id,st.site_id,st.arrival_date,st.leave_date
  FROM reservation_site_stays st JOIN reservations r ON r.id=st.reservation_id
  WHERE r.status <> 'canceled' AND r.id IN (31,129,232,351,541,691,925)
  UNION ALL
  SELECT r.id,(s->>'siteId')::bigint,(s->>'arrivalDate')::date,(s->>'leaveDate')::date
  FROM reservations r CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(to_jsonb(r.canceled_site_stays))='array'
      THEN to_jsonb(r.canceled_site_stays) ELSE '[]'::jsonb END) s
  WHERE r.status='canceled' AND r.id IN (31,129,232,351,541,691,925)
), priced AS (
  SELECT st.*,site.site_number,
    coalesce(r.pricing_category_override,CASE
      WHEN site.river_category IN ('prime_river','normal_river') THEN site.river_category
      WHEN site.is_big_rig THEN 'off_river_big_rig' ELSE 'off_river_small_rig' END) AS category,
    rule.normal_price,rule.discount_price
  FROM stays st JOIN reservations r ON r.id=st.reservation_id
  LEFT JOIN rv_sites site ON site.id=st.site_id
  LEFT JOIN pricing_rules rule ON rule.number_of_days=1 AND rule.site_category=coalesce(r.pricing_category_override,CASE
    WHEN site.river_category IN ('prime_river','normal_river') THEN site.river_category
    WHEN site.is_big_rig THEN 'off_river_big_rig' ELSE 'off_river_small_rig' END)
), summaries AS (
  SELECT reservation_id,min(arrival_date) AS first_arrival,max(leave_date) AS last_departure,
    sum(leave_date-arrival_date) AS total_nights,
    bool_or(leave_date='9999-12-31'::date) AS open_ended,
    bool_or(normal_price IS NULL AND discount_price IS NULL) AS missing_nightly_rate,
    jsonb_agg(jsonb_build_object('site',site_number,'arrival',arrival_date,'departure',leave_date,
      'category',category,'normal_daily',normal_price,'discount_daily',discount_price)
      ORDER BY arrival_date,site_id) AS site_pricing
  FROM priced GROUP BY reservation_id
)
SELECT r.id,r.status,r.billing_mode,r.reservation_term,r.amount_paid,r.total_price,
  r.monthly_rent_price,r.electric_meter_reading,r.requested_discounts,
  s.first_arrival,s.last_departure,s.total_nights,
  CASE
    WHEN r.billing_mode='monthly' AND r.monthly_rent_price IS NULL THEN 'Monthly rent is missing.'
    WHEN r.billing_mode='monthly' AND r.electric_meter_reading IS NULL THEN 'Monthly electric meter reading is missing.'
    WHEN s.open_ended AND r.total_price IS NULL THEN 'Open-ended stay has no stored total; nightly pricing cannot total it.'
    WHEN s.total_nights>28 AND r.total_price IS NULL THEN 'Stay exceeds the app 28-night pricing limit and has no stored total.'
    WHEN s.missing_nightly_rate AND r.total_price IS NULL THEN 'A site has no nightly rate and there is no stored total.'
    WHEN s.total_nights IS NULL THEN 'No stay dates were found.'
    WHEN s.total_nights<=0 THEN 'Stay dates do not contain payable nights.'
    ELSE 'Review the site pricing and saved checkout quote.' END AS pricing_issue,
  s.site_pricing,
  (SELECT jsonb_agg(jsonb_build_object('site_id',b.site_id,'arrival',b.arrival_date,'departure',b.leave_date,
     'base_total',b.booking_payload->'baseTotalPrice','card_total',b.booking_payload->'totalPrice',
     'payment_method',b.booking_payload->'paymentMethod','discounts',b.booking_payload->'discounts',
     'pricing_quote',b.booking_payload->'pricingQuote') ORDER BY b.id)
   FROM public_booking_checkouts b WHERE b.reservation_id=r.id) AS saved_checkout_pricing
FROM reservations r LEFT JOIN summaries s ON s.reservation_id=r.id
WHERE r.id IN (31,129,232,351,541,691,925) ORDER BY r.id;
