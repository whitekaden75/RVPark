-- Correct reservations whose stored amount paid is lower than the amount
-- Stripe actually collected. This preserves any larger amount already entered.
-- Safe to run more than once.

WITH paid_stripe_totals AS (
  SELECT
    reservation_id,
    ROUND(
      SUM(COALESCE(amount_received_cents, amount_cents))::numeric / 100,
      2
    ) AS actual_amount_paid
  FROM stripe_payment_records
  WHERE payment_status = 'paid'
  GROUP BY reservation_id
)
UPDATE reservations AS reservation
SET amount_paid = GREATEST(
  COALESCE(reservation.amount_paid, 0),
  paid_stripe_totals.actual_amount_paid
)
FROM paid_stripe_totals
WHERE reservation.id = paid_stripe_totals.reservation_id
  AND COALESCE(reservation.amount_paid, 0) < paid_stripe_totals.actual_amount_paid;
