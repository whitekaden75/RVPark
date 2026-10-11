-- Historical paid-in-full adjustment. Run manually; this does not charge guests.
-- Default: first ARRIVAL before September 15, 2026 (September 15 is excluded).
-- Change cutoff_basis below to 'booked' to use reservations.booked_date instead.
-- Monthly accounts are excluded, including ongoing yearly/monthly residents.
-- Preserves overpayments, reservation status, payment method and payment history.
-- Finite standard stays over 28 nights without a total use discounted/regular
-- nightly rates and seventh-night-free rules, then store a manual billing total.
-- A separate audit table records old/new amounts; no cash/Stripe payment is invented.
-- Reruns skip previously adjusted rows, even if rates or later payments changed.
BEGIN;

CREATE TEMP TABLE historical_paid_settings ON COMMIT DROP AS
SELECT DATE '2026-09-15' AS cutoff_date, 'arrival'::text AS cutoff_basis;

-- Serialize this one-time adjustment with concurrent reservation/payment updates.
LOCK TABLE reservations IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE IF NOT EXISTS historical_paid_adjustments (
  reservation_id bigint NOT NULL,
  cutoff_date date NOT NULL,
  cutoff_basis text NOT NULL,
  old_amount_paid numeric,
  new_amount_paid numeric NOT NULL,
  old_billing_mode text,
  new_billing_mode text,
  old_total_price numeric,
  new_total_price numeric,
  adjusted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (reservation_id,cutoff_date,cutoff_basis)
);
-- Compatible with an earlier run of this migration's audit-table version.
ALTER TABLE historical_paid_adjustments
  ADD COLUMN IF NOT EXISTS old_billing_mode text,
  ADD COLUMN IF NOT EXISTS new_billing_mode text,
  ADD COLUMN IF NOT EXISTS old_total_price numeric,
  ADD COLUMN IF NOT EXISTS new_total_price numeric;

CREATE OR REPLACE FUNCTION pg_temp.historical_price(value text)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN value ~ '^-?[0-9]+([.][0-9]+)?$'
    THEN round(value::numeric, 2) END
$$;

CREATE TEMP TABLE historical_paid_plan ON COMMIT DROP AS
WITH stays AS (
  SELECT st.reservation_id, st.site_id, st.arrival_date, st.leave_date
  FROM reservation_site_stays st JOIN reservations r ON r.id=st.reservation_id
  WHERE r.status <> 'canceled'
  UNION ALL
  SELECT r.id, (s->>'siteId')::bigint, (s->>'arrivalDate')::date, (s->>'leaveDate')::date
  FROM reservations r CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(to_jsonb(r.canceled_site_stays))='array'
      THEN to_jsonb(r.canceled_site_stays) ELSE '[]'::jsonb END) s
  WHERE r.status='canceled'
), candidates AS (
  SELECT r.*, cfg.cutoff_date,
    EXISTS (SELECT 1 FROM jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(to_jsonb(r.requested_discounts))='array'
        THEN to_jsonb(r.requested_discounts) ELSE '[]'::jsonb END) d
      WHERE trim(d) <> '') AS discounted
  FROM reservations r CROSS JOIN historical_paid_settings cfg
  WHERE CASE cfg.cutoff_basis
    WHEN 'booked' THEN r.booked_date < cfg.cutoff_date
    WHEN 'arrival' THEN (SELECT min(st.arrival_date) FROM stays st WHERE st.reservation_id=r.id) < cfg.cutoff_date
    ELSE false END
    AND r.billing_mode <> 'monthly'
    AND NOT EXISTS (SELECT 1 FROM historical_paid_adjustments a
      WHERE a.reservation_id=r.id AND a.cutoff_date=cfg.cutoff_date AND a.cutoff_basis=cfg.cutoff_basis)
), ordered AS (
  SELECT st.*, st.leave_date-st.arrival_date AS nights,
    lag(st.leave_date) OVER (PARTITION BY st.reservation_id ORDER BY st.arrival_date, st.site_id) AS previous_leave,
    count(*) OVER (PARTITION BY st.reservation_id) AS segment_count
  FROM stays st JOIN candidates r ON r.id=st.reservation_id
), visits AS (
  SELECT st.*, sum(CASE WHEN previous_leave=arrival_date THEN 0 ELSE 1 END)
    OVER (PARTITION BY reservation_id ORDER BY arrival_date, site_id) AS visit_number
  FROM ordered st
), offsets AS (
  SELECT st.*, coalesce(sum(nights) OVER (PARTITION BY reservation_id, visit_number
    ORDER BY arrival_date, site_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)::numeric AS night_offset
  FROM visits st
), booked AS (
  SELECT DISTINCT ON (reservation_id) reservation_id, site_id, arrival_date, leave_date, booking_payload
  FROM public_booking_checkouts WHERE reservation_id IN (SELECT id FROM candidates)
  ORDER BY reservation_id, id
), priced AS (
  SELECT st.*, r.discounted,
    coalesce(r.pricing_category_override,
      CASE WHEN site.river_category IN ('prime_river','normal_river') THEN site.river_category
        WHEN site.is_big_rig THEN 'off_river_big_rig' ELSE 'off_river_small_rig' END) AS category,
    rule.normal_price::numeric AS normal_daily, rule.discount_price::numeric AS discount_daily,
    b.booking_payload,
    r.billing_mode='standard' AND r.reservation_term <> 'yearly' AND st.segment_count=1
      AND st.site_id=b.site_id AND st.arrival_date=b.arrival_date AND st.leave_date=b.leave_date
      AND r.discounted=EXISTS (SELECT 1 FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(b.booking_payload->'discounts')='array'
          THEN b.booking_payload->'discounts' ELSE '[]'::jsonb END) d WHERE trim(d)<>'')
      AND (r.pricing_category_override IS NULL OR r.pricing_category_override=b.booking_payload#>>'{pricingQuote,pricingCategory}')
      AS quote_matches
  FROM offsets st JOIN candidates r ON r.id=st.reservation_id
  LEFT JOIN rv_sites site ON site.id=st.site_id
  LEFT JOIN pricing_rules rule ON rule.number_of_days=1 AND rule.site_category=coalesce(r.pricing_category_override,
    CASE WHEN site.river_category IN ('prime_river','normal_river') THEN site.river_category
      WHEN site.is_big_rig THEN 'off_river_big_rig' ELSE 'off_river_small_rig' END)
  LEFT JOIN booked b ON b.reservation_id=st.reservation_id
), quotes AS (
  SELECT st.*,
    CASE WHEN quote_matches AND nights BETWEEN 1 AND 28 THEN
      CASE WHEN booking_payload#>>'{pricingQuote,version}'='1'
        AND booking_payload#>>'{pricingQuote,discountQualified}'=discounted::text
        AND pg_temp.historical_price(booking_payload#>>'{pricingQuote,bankDailyPrice}')>0
        AND pg_temp.historical_price(booking_payload#>>'{pricingQuote,cardDailyPrice}')>0
      THEN pg_temp.historical_price(booking_payload#>>'{pricingQuote,bankDailyPrice}')
      WHEN NOT coalesce(booking_payload#>>'{pricingQuote,version}'='1'
        AND booking_payload#>>'{pricingQuote,discountQualified}'=discounted::text,false) THEN
        pg_temp.historical_price(booking_payload->>'baseTotalPrice') /
          (nights-floor(nights::numeric/7)) END END AS quoted_daily
  FROM priced st
), valid_quotes AS (
  SELECT st.*,
    -- Historical legacy quotes must round back to their original bank/card totals.
    CASE WHEN quoted_daily>0 AND
      (booking_payload#>>'{pricingQuote,version}'='1' OR (
        abs(round(quoted_daily,2)*(nights-floor(nights::numeric/7))-
          pg_temp.historical_price(booking_payload->>'baseTotalPrice'))<=0.011
        AND (booking_payload->>'paymentMethod' IS DISTINCT FROM 'card' OR
          (pg_temp.historical_price(booking_payload->>'totalPrice')>0 AND
           abs(round(pg_temp.historical_price(booking_payload->>'totalPrice') /
             (nights-floor(nights::numeric/7)),2)*(nights-floor(nights::numeric/7))-
             pg_temp.historical_price(booking_payload->>'totalPrice'))<=0.011))))
      THEN round(quoted_daily,2)
      END AS locked_daily
  FROM quotes st
), rates AS (
  SELECT st.*,
    CASE WHEN NOT discounted THEN coalesce(locked_daily,normal_daily) ELSE normal_daily END AS normal_bank_daily,
    CASE WHEN discounted THEN coalesce(locked_daily,discount_daily) ELSE discount_daily END AS discount_bank_daily
  FROM valid_quotes st
), totals AS (
  SELECT reservation_id,
    sum(nights) AS total_nights,
    CASE WHEN sum(nights)>0 AND bool_and(nights>0 AND leave_date<>'9999-12-31'::date AND normal_bank_daily IS NOT NULL)
      THEN round(sum(normal_bank_daily * (nights -
        (floor((night_offset+nights)/7)-floor(night_offset/7)))),2) END AS normal_total,
    CASE WHEN sum(nights)>0 AND bool_and(nights>0 AND leave_date<>'9999-12-31'::date AND discount_bank_daily IS NOT NULL)
      THEN round(sum(discount_bank_daily * (nights -
        (floor((night_offset+nights)/7)-floor(night_offset/7)))),2) END AS discount_total
  FROM rates GROUP BY reservation_id
), amounts AS (
  SELECT r.id AS reservation_id,r.cutoff_date,cfg.cutoff_basis,r.booked_date,
    (SELECT min(st.arrival_date) FROM stays st WHERE st.reservation_id=r.id) AS first_arrival,
    r.amount_paid AS old_amount_paid,r.billing_mode::text AS old_billing_mode,
    r.total_price::numeric AS old_total_price,t.total_nights,
    CASE WHEN r.reservation_term='yearly' AND r.billing_mode='manual_total' THEN r.total_price::numeric
      WHEN t.total_nights>28 AND r.total_price IS NOT NULL THEN r.total_price::numeric
      WHEN r.discounted THEN coalesce(t.discount_total,t.normal_total,r.total_price::numeric)
      ELSE coalesce(t.normal_total,t.discount_total,r.total_price::numeric) END AS full_amount
  FROM candidates r CROSS JOIN historical_paid_settings cfg
  LEFT JOIN totals t ON t.reservation_id=r.id
)
SELECT a.*,
  CASE WHEN total_nights>28 AND old_billing_mode='standard' THEN 'manual_total'
    ELSE old_billing_mode END AS new_billing_mode,
  CASE WHEN total_nights>28 AND old_billing_mode='standard' THEN full_amount
    ELSE old_total_price END AS new_total_price
FROM amounts a;

-- Review the affected bookings and proposed amounts in the SQL results.
SELECT reservation_id, booked_date, first_arrival, old_amount_paid,
  greatest(coalesce(old_amount_paid,0),full_amount,0) AS new_amount_paid,
  old_billing_mode,new_billing_mode,old_total_price,new_total_price
FROM historical_paid_plan ORDER BY reservation_id;

-- These ongoing monthly accounts are intentionally left unchanged.
SELECT r.id,r.billing_mode,r.reservation_term,r.amount_paid,r.monthly_rent_price,
  'Monthly account left unchanged' AS result
FROM reservations r
WHERE r.billing_mode='monthly' AND r.id IN (232,351) ORDER BY r.id;

-- Fail the whole transaction rather than guessing if a booking has no usable price.
DO $$
DECLARE missing_ids text;
BEGIN
  IF (SELECT cutoff_basis NOT IN ('arrival','booked') FROM historical_paid_settings) THEN
    RAISE EXCEPTION 'cutoff_basis must be arrival or booked';
  END IF;
  SELECT string_agg(reservation_id::text,', ' ORDER BY reservation_id) INTO missing_ids
  FROM historical_paid_plan WHERE full_amount IS NULL;
  IF missing_ids IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot calculate paid-in-full totals for reservations: %. Nothing was changed; configure their pricing first.', missing_ids;
  END IF;
END $$;

INSERT INTO historical_paid_adjustments (reservation_id,cutoff_date,cutoff_basis,old_amount_paid,new_amount_paid,
  old_billing_mode,new_billing_mode,old_total_price,new_total_price)
SELECT reservation_id,cutoff_date,cutoff_basis,old_amount_paid,greatest(coalesce(old_amount_paid,0),full_amount,0),
  old_billing_mode,new_billing_mode,old_total_price,new_total_price
FROM historical_paid_plan WHERE coalesce(old_amount_paid,0)<greatest(full_amount,0)
  OR old_billing_mode IS DISTINCT FROM new_billing_mode OR old_total_price IS DISTINCT FROM new_total_price
ON CONFLICT (reservation_id,cutoff_date,cutoff_basis) DO NOTHING;

UPDATE reservations r SET amount_paid=greatest(coalesce(r.amount_paid,0),p.full_amount,0),
  billing_mode=p.new_billing_mode,total_price=p.new_total_price
FROM historical_paid_plan p WHERE r.id=p.reservation_id
  AND (coalesce(r.amount_paid,0)<greatest(p.full_amount,0)
    OR r.billing_mode::text IS DISTINCT FROM p.new_billing_mode OR r.total_price IS DISTINCT FROM p.new_total_price)
RETURNING r.id,r.amount_paid,r.billing_mode,r.total_price;

COMMIT;
