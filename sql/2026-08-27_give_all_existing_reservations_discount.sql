-- Give every existing reservation the discounted nightly price.
-- Existing discount labels (AAA, Good Sam, Veterans, etc.) are preserved.
-- Safe to run more than once: only reservations with no discount are updated.

BEGIN;

UPDATE reservations
SET requested_discounts = ARRAY['Eligible discount']::text[]
WHERE COALESCE(cardinality(requested_discounts), 0) = 0;

COMMIT;

-- Verification: reservations_without_discount should be 0.
SELECT
  COUNT(*) AS total_reservations,
  COUNT(*) FILTER (
    WHERE COALESCE(cardinality(requested_discounts), 0) > 0
  ) AS reservations_with_discount,
  COUNT(*) FILTER (
    WHERE COALESCE(cardinality(requested_discounts), 0) = 0
  ) AS reservations_without_discount
FROM reservations;
