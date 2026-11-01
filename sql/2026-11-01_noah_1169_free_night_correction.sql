-- Deploy the server/client pricing support in this change before running this file.
-- Booking #1169: nine stay nights, seven chargeable nights, two paid, FIVE left to pay.
-- The ordinary seventh-night-free rule already removes one charge. This office
-- correction adds ONE extra free date for the previously missed weekly credit.
-- Expected remaining amounts at the existing $55 / $56.99 nightly prices:
--   cash/check $275.00; card $284.95. Actual money received remains $113.98.
-- This changes no payment, Stripe transaction, nightly rate, stay date, or other booking.
-- The correction stops applying if this booking's sites/dates change again.
BEGIN;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS nightly_price_adjustment jsonb;
CREATE TABLE IF NOT EXISTS reservation_nightly_price_adjustment_events (
  id bigserial PRIMARY KEY,
  adjustment_key text NOT NULL UNIQUE,
  reservation_id bigint NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  previous_adjustment jsonb,
  applied_adjustment jsonb NOT NULL,
  previous_amount_paid numeric(14,2) NOT NULL,
  applied_by text NOT NULL DEFAULT current_user,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $correction$
DECLARE
  target record;
  stays jsonb;
  adjustment jsonb;
  payment_count integer;
  payment_total numeric;
BEGIN
  SELECT r.*, c.first_name, c.last_name, c.email INTO target
  FROM reservations r JOIN customers c ON c.id = r.customer_id
  WHERE r.id = 1169 FOR UPDATE OF r;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking #1169 was not found. Nothing changed.'; END IF;
  IF lower(trim(target.first_name)) IS DISTINCT FROM 'noah' OR lower(trim(target.last_name)) IS DISTINCT FROM 'atkins'
     OR lower(trim(target.email)) IS DISTINCT FROM 'noaheatkins@gmail.com' THEN
    RAISE EXCEPTION 'Booking #1169 does not match Noah Atkins. Nothing changed.';
  END IF;
  IF target.nightly_price_adjustment->>'key' = '2026-11-01-noah-1169-weekly-credit' THEN
    RAISE NOTICE 'This free-night correction is already applied; no payment or price was changed again.';
    RETURN;
  END IF;
  IF target.nightly_price_adjustment IS NOT NULL THEN
    RAISE EXCEPTION 'Booking #1169 already has another pricing adjustment. Review it first.';
  END IF;
  IF target.status <> 'active' OR target.billing_mode <> 'standard'
     OR coalesce((to_jsonb(target)->>'manual_pricing_override')::boolean,false)
     OR coalesce((to_jsonb(target)->>'monthly_classification')::boolean,false)
     OR to_jsonb(target)->>'merged_into_reservation_id' IS NOT NULL
     OR coalesce(to_jsonb(target)->'balance_waiver','null'::jsonb) <> 'null'::jsonb THEN
    RAISE EXCEPTION 'Booking #1169 pricing/status changed. Review it before applying this correction.';
  END IF;
  IF coalesce(target.amount_paid,0) <> 113.98 THEN
    RAISE EXCEPTION 'Booking #1169 no longer shows $113.98 received. Review its current payments first.';
  END IF;
  SELECT count(*), coalesce(sum(amount),0) INTO payment_count, payment_total
  FROM reservation_payment_events WHERE reservation_id = 1169;
  IF payment_count <> 2 OR payment_total <> 113.98 OR EXISTS (
    SELECT 1 FROM reservation_payment_events
    WHERE reservation_id = 1169 AND (payment_source <> 'stripe' OR amount <> 56.99)
  ) THEN
    RAISE EXCEPTION 'Booking #1169 payment history no longer matches the two $56.99 payments. Nothing changed.';
  END IF;
  PERFORM id FROM reservation_site_stays WHERE reservation_id = 1169 FOR UPDATE;
  SELECT jsonb_agg(jsonb_build_object('site', st.site_id, 'arrival', st.arrival_date::text,
    'departure', st.leave_date::text) ORDER BY st.arrival_date, st.site_id, st.leave_date) INTO stays
  FROM reservation_site_stays st WHERE st.reservation_id = 1169;
  IF jsonb_array_length(coalesce(stays,'[]'::jsonb)) <> 1 OR NOT EXISTS (
    SELECT 1 FROM reservation_site_stays st JOIN rv_sites s ON s.id = st.site_id
    WHERE st.reservation_id = 1169 AND st.arrival_date = DATE '2026-10-30'
      AND st.leave_date = DATE '2026-11-08' AND s.site_number = 'A'
  ) THEN
    RAISE EXCEPTION 'Booking #1169 no longer matches Site A, October 30–November 8. Nothing changed.';
  END IF;
  adjustment := jsonb_build_object('version',1,'key','2026-11-01-noah-1169-weekly-credit',
    'reason','Office correction for a previously missed weekly free-night credit: five more paid nights remain.',
    'scopeStays',stays,'complimentaryDates',jsonb_build_array('2026-11-07'),'appliedAt',now());
  INSERT INTO reservation_nightly_price_adjustment_events
    (adjustment_key,reservation_id,previous_adjustment,applied_adjustment,previous_amount_paid)
    VALUES ('2026-11-01-noah-1169-weekly-credit',1169,target.nightly_price_adjustment,adjustment,target.amount_paid);
  UPDATE reservations SET nightly_price_adjustment = adjustment WHERE id = 1169;
END
$correction$;
COMMIT;

SELECT id AS reservation_id, amount_paid AS actual_payments_received,
  nightly_price_adjustment->>'reason' AS correction,
  nightly_price_adjustment->'complimentaryDates' AS additional_free_dates
FROM reservations WHERE id = 1169;
